// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./LiquidityStorage.sol";
import "./LiquidityMath.sol";
import "./LiquidityViewLib.sol";
import "./LiquidityFacet.sol";
import "./LiquidityROIFacet.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function totalSupply() external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

contract Liquidity is LiquidityStorage {

    // ── Immutables (NOT storage slots) ───────────────────────────────────────
    address public  immutable platformToken;
    address private immutable UNISWAP_ROUTER;
    address private immutable UNISWAP_FACTORY;
    address private immutable WETH;
    address private immutable _facet;
    address private immutable _roiFacet;

    uint256 private constant LP_LOCK_DURATION = 180; // 90 days scaled: 1 day = 2 s (testing)
    uint256 private constant USDT_PER_ETH     = 1;
    uint256 private constant TWAP_MAX_STALE   = 2 hours;

    // ── Errors ────────────────────────────────────────────────────────────────
    error NotOwner();
    error AlreadyRegistered();
    error NotRegistered();
    error Reentrant();
    error CannotReferSelf();
    error ReferrerNotRegistered();
    error MustSendETH();
    error MustSendUSDT();
    error USDTTransferFailed();
    error MustSpecifyTokenAmount();
    error InsufficientContractTokenBalance();
    error ETHReturnFailed();
    error InvalidTokenAddress();
    error TokenAlreadyRegistered();
    error TokenNotRegistered();
    error TokenDelisted();
    error AlreadyRemoved();
    error InvalidPackageAmount();
    error TokenInProgress();
    error SurplusTransferFailed();
    error AlreadyClaimed();
    error LPStillLocked();
    error NoLPTokens();
    error PoolNotFound();
    error LPTransferFailed();
    error ClaimLPFirst();
    error LPPullFailed();
    error TokenReturnFailed();
    error LPAlreadyClaimed();
    error InvalidDuration();
    error CommissionTransferFailed();
    error StakingRewardTransferFailed();
    error PriceUnavailable();
    error PriceDeviationTooHigh();
    error NothingToClaim();
    error InsufficientTokenBalance();
    error TokenTransferFailed();
    error InvalidDurationIndex();
    error InvalidTierIndex();
    error InvalidStreakLevel();
    error NoETHToWithdraw();
    error ETHWithdrawFailed();
    error NoTokensToWithdraw();
    error TokenWithdrawFailed();
    error TWAPStale();
    error TokenTWAPStale();

    // ── Events ────────────────────────────────────────────────────────────────
    event UserRegistered(address indexed user, address indexed referrer);
    event CommissionPaid(address indexed recipient, address indexed from, uint256 amount, uint256 level);
    event TokenRegistered(address indexed tokenAddress, string name, string symbol);
    event TokenUpdated(address indexed tokenAddress, string name, string symbol);
    event TokenRemoved(address indexed tokenAddress);
    event TokenFeatured(address indexed tokenAddress);
    event TokenInProgressSet(address indexed tokenAddress, string label);
    event Invested(address indexed user, address indexed token, uint256 ethAmount, uint256 lpTokens);
    event LPClaimed(address indexed user, address indexed token, uint256 lpAmount);
    event LPRemoved(address indexed user, address indexed token, uint256 lpAmount, uint256 ethReturned, uint256 tokensReturned);
    event PoolSeeded(address indexed token, uint256 ethAmount, uint256 tokenAmount, uint256 lpReceived);
    event LPRestaked(address indexed user, address indexed token, uint256 lpAmount, uint256 newUnlockTime, uint256 durationDays);
    event StakingRewardClaimed(address indexed user, uint256 tokensAmount, uint256 ethEquivalent);
    event ROIClaimed(address indexed user, uint256 tokensAmount, uint256 ethEquivalent);
    event TWAPUpdated(uint256 price, uint256 timestamp);

    // ── Modifiers ─────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
    modifier notRegistered() {
        if (users[msg.sender].isRegistered) revert AlreadyRegistered();
        _;
    }
    modifier onlyRegistered() {
        if (!users[msg.sender].isRegistered) revert NotRegistered();
        _;
    }
    modifier nonReentrant() {
        if (_locked) revert Reentrant();
        _locked = true;
        _;
        _locked = false;
    }

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(
        address _router,
        address _factory,
        address _weth,
        address _platformToken,
        address facet_,
        address roiFacet_
    ) {
        owner = msg.sender;
        users[owner].userAddress  = owner;
        users[owner].isRegistered = true;
        users[owner].registeredAt = block.timestamp;
        allRegisteredUsers.push(owner);
        UNISWAP_ROUTER  = _router;
        UNISWAP_FACTORY = _factory;
        WETH            = _weth;
        platformToken   = _platformToken;
        _facet          = facet_;
        _roiFacet       = roiFacet_;
        referralCommissionRates = [5000, 2500, 1000, 300, 250, 225, 200, 200, 175, 150];
        _initStakingRates();
        _initPackages();
    }

    // ── DELEGATECALL helpers ──────────────────────────────────────────────────
    function _callFacet(bytes memory data) internal {
        (bool ok,) = _facet.delegatecall(data);
        if (!ok) assembly { returndatacopy(0, 0, returndatasize()) revert(0, returndatasize()) }
    }
    function _callROI(bytes memory data) internal {
        (bool ok,) = _roiFacet.delegatecall(data);
        if (!ok) assembly { returndatacopy(0, 0, returndatasize()) revert(0, returndatasize()) }
    }

    // ── Init helpers ──────────────────────────────────────────────────────────
    function _initStakingRates() internal {
        investmentTiers  = [uint32(100), 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000];
        stakingDurations = [uint16(7), 30, 60, 90, 180, 360];
        _setTieredRates(0, [uint256(10_000), 10_000, 11_000, 11_000, 12_000, 12_000, 13_000, 13_000, 14_000, 14_000, 15_000, 15_000], 0);
        _setTieredRates(1, [uint256(60_000), 60_000, 62_500, 62_500, 65_000, 65_000, 67_500, 67_500, 70_000, 70_000, 72_500, 75_000], 5_000);
        _setTieredRates(2, [uint256(140_000), 145_000, 150_000, 150_000, 155_000, 160_000, 165_000, 170_000, 170_000, 175_000, 180_000, 180_000], 26_000);
        _setTieredRates(3, [uint256(250_000), 255_000, 260_000, 260_000, 265_000, 270_000, 275_000, 280_000, 285_000, 290_000, 295_000, 300_000], 30_000);
        _setTieredRates(4, [uint256(680_000), 690_000, 700_000, 700_000, 710_000, 720_000, 730_000, 740_000, 750_000, 750_000, 760_000, 770_000], 50_000);
        _setTieredRates(5, [uint256(1_680_000), 1_690_000, 1_700_000, 1_700_000, 1_720_000, 1_740_000, 1_750_000, 1_770_000, 1_790_000, 1_800_000, 1_820_000, 1_840_000], 100_000);
    }
    function _setTieredRates(uint256 dIdx, uint256[12] memory bases, uint256 incrPPM) internal {
        for (uint256 t = 0; t < 12; ) {
            stakingRates[dIdx][t][0] = bases[t];
            stakingRates[dIdx][t][1] = bases[t] + incrPPM;
            stakingRates[dIdx][t][2] = bases[t] + 2 * incrPPM;
            stakingRates[dIdx][t][3] = bases[t] + 3 * incrPPM;
            unchecked { t++; }
        }
    }
    function _initPackages() internal {
        uint256[14] memory usdtAmounts = [
            uint256(25), 50, 100, 250, 500, 1000,
            2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000
        ];
        for (uint256 i = 0; i < 14; ) {
            validPackageAmounts[usdtAmounts[i] * 1e18 / USDT_PER_ETH] = true;
            unchecked { i++; }
        }
    }

    function _getRewardRatePPM(uint256 ethInvestedWei, uint256 durationDays, uint256 streakLevel)
        internal view returns (uint256)
    {
        if (ethInvestedWei * USDT_PER_ETH / 1e18 < 100) return 0;
        uint256 sIdx = streakLevel > 3 ? 3 : streakLevel;
        return stakingRates
            [LiquidityMath.getDurationIndex(stakingDurations, durationDays)]
            [LiquidityMath.getTierIndex(investmentTiers, ethInvestedWei)]
            [sIdx];
    }

    // ── Registration ──────────────────────────────────────────────────────────
    function register(address _referrer) external notRegistered {
        if (_referrer == msg.sender) revert CannotReferSelf();
        if (!users[_referrer].isRegistered) revert ReferrerNotRegistered();
        User storage user = users[msg.sender];
        user.userAddress  = msg.sender;
        user.referrer     = _referrer;
        user.isRegistered = true;
        user.registeredAt = block.timestamp;
        users[_referrer].referrals.push(msg.sender);
        totalRegisteredUsers++;
        allRegisteredUsers.push(msg.sender);
        emit UserRegistered(msg.sender, _referrer);
    }

    // ── Token management ──────────────────────────────────────────────────────
    function seedPool(address _token, uint256 _tokenAmount, uint256 _usdtAmount) external onlyOwner nonReentrant {
        if (_usdtAmount == 0) revert MustSendUSDT();
        if (_tokenAmount == 0) revert MustSpecifyTokenAmount();
        if (IERC20(_token).balanceOf(address(this)) < _tokenAmount) revert InsufficientContractTokenBalance();
        if (IERC20(WETH).balanceOf(address(this)) < _usdtAmount) revert InsufficientContractTokenBalance();
        IERC20(_token).approve(UNISWAP_ROUTER, _tokenAmount);
        IERC20(WETH).approve(UNISWAP_ROUTER, _usdtAmount);
        (,, uint256 lpReceived) = IUniswapV2Router02(UNISWAP_ROUTER).addLiquidity(
            _token, WETH, _tokenAmount, _usdtAmount, 0, 0, owner, block.timestamp + 300
        );
        IERC20(_token).approve(UNISWAP_ROUTER, 0);
        IERC20(WETH).approve(UNISWAP_ROUTER, 0);
        {
            address _pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(_token, WETH);
            if (_pair != address(0)) {
                (uint112 sr0, uint112 sr1,) = IUniswapV2Pair(_pair).getReserves();
                address st0 = IUniswapV2Pair(_pair).token0();
                _priceHistory[_token].push(PriceSnap({
                    ts:       uint64(block.timestamp),
                    resETH:   st0 == _token ? sr1 : sr0,
                    resToken: st0 == _token ? sr0 : sr1
                }));
            }
        }
        emit PoolSeeded(_token, _usdtAmount, _tokenAmount, lpReceived);
    }

    function addToken(address _tokenAddress, string calldata _name, string calldata _symbol) external onlyOwner {
        if (_tokenAddress == address(0)) revert InvalidTokenAddress();
        if (tokens[_tokenAddress].tokenAddress != address(0)) revert TokenAlreadyRegistered();
        tokens[_tokenAddress] = Token({
            tokenAddress: _tokenAddress,
            name: _name,
            symbol: _symbol,
            addedAt: block.timestamp,
            removed: false,
            inProgressLabel: ""
        });
        registeredTokens.push(_tokenAddress);
        emit TokenRegistered(_tokenAddress, _name, _symbol);
    }

    function setFeaturedToken(address _tokenAddress) external onlyOwner {
        if (tokens[_tokenAddress].tokenAddress == address(0)) revert TokenNotRegistered();
        if (tokens[_tokenAddress].removed) revert TokenDelisted();
        featuredToken = _tokenAddress;
        emit TokenFeatured(_tokenAddress);
    }

    function removeToken(address _tokenAddress) external onlyOwner {
        if (tokens[_tokenAddress].tokenAddress == address(0)) revert TokenNotRegistered();
        if (tokens[_tokenAddress].removed) revert AlreadyRemoved();
        tokens[_tokenAddress].removed = true;
        if (featuredToken == _tokenAddress) featuredToken = address(0);
        emit TokenRemoved(_tokenAddress);
    }

    function setTokenInProgress(address _tokenAddress, string calldata _label) external onlyOwner {
        if (tokens[_tokenAddress].tokenAddress == address(0)) revert TokenNotRegistered();
        if (tokens[_tokenAddress].removed) revert TokenDelisted();
        tokens[_tokenAddress].inProgressLabel = _label;
        emit TokenInProgressSet(_tokenAddress, _label);
    }

    function updateToken(address _tokenAddress, string calldata _name, string calldata _symbol) external onlyOwner {
        if (tokens[_tokenAddress].tokenAddress == address(0)) revert TokenNotRegistered();
        tokens[_tokenAddress].name   = _name;
        tokens[_tokenAddress].symbol = _symbol;
        emit TokenUpdated(_tokenAddress, _name, _symbol);
    }

    // ── Invest ────────────────────────────────────────────────────────────────
    function invest(address _token, uint256 _usdtAmount) external onlyRegistered nonReentrant {
        if (!validPackageAmounts[_usdtAmount]) revert InvalidPackageAmount();
        if (tokens[_token].tokenAddress == address(0)) revert TokenNotRegistered();
        if (tokens[_token].removed) revert TokenDelisted();
        if (bytes(tokens[_token].inProgressLabel).length != 0) revert TokenInProgress();
        if (IERC20(_token).balanceOf(address(this)) == 0) revert InsufficientContractTokenBalance();

        if (!IERC20(WETH).transferFrom(msg.sender, address(this), _usdtAmount)) revert USDTTransferFailed();

        _callFacet(abi.encodeCall(LiquidityFacet.updateTWAPExt, ()));
        _callFacet(abi.encodeCall(LiquidityFacet.updateTokenTWAPExt, (_token)));
        if (!_tokenTwapReady[_token]) revert PriceUnavailable();
        if (block.timestamp - _tokenTwapLastUpdated[_token] > TWAP_MAX_STALE) revert TokenTWAPStale();

        uint256 T         = _usdtAmount;
        uint256 rewardPPM = _getRewardRatePPM(T, 90, 0);
        bool wasQualifying = _qualifies(msg.sender);

        _callFacet(abi.encodeCall(LiquidityFacet.investExt, (_token, rewardPPM, T)));

        userTotalInvested[msg.sender] += T;
        totalEthInvested              += T;

        // Increment referrer's active count BEFORE distributing commissions and
        // initialising ROI streams, so both see the correct eligibility immediately.
        // onGainReferralExt is still called afterwards to redirect any streams that
        // were skipped during *previous* investments (before ref had enough referrals).
        bool justQualified = !wasQualifying && _qualifies(msg.sender);
        address ref = users[msg.sender].referrer;
        if (justQualified && ref != address(0)) {
            activeReferralCount[ref]++;
        }

        uint256 lockIndex = userLPLocks[msg.sender].length - 1;
        _callROI(abi.encodeCall(LiquidityROIFacet.initROIStreamsExt, (msg.sender, lockIndex)));

        uint256 A   = T / 2;
        uint256 A40 = A - (A * 60 / 100);
        _callFacet(abi.encodeCall(LiquidityFacet.distributeCommissionsExt, (msg.sender, A40, _token)));

        if (justQualified && ref != address(0)) {
            _callROI(abi.encodeCall(LiquidityROIFacet.onGainReferralExt, (ref)));
        }
    }

    // ── Claim LP ──────────────────────────────────────────────────────────────
    function claimLP(uint256 _lockIndex) external nonReentrant {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        if (lock.claimed) revert AlreadyClaimed();
        if (block.timestamp < lock.unlockTime) revert LPStillLocked();
        if (lock.lpAmount == 0) revert NoLPTokens();
        lock.claimed = true;
        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(lock.token, WETH);
        if (pair == address(0)) revert PoolNotFound();
        if (_totalLockedLP[pair] >= lock.lpAmount) _totalLockedLP[pair] -= lock.lpAmount;
        if (!IUniswapV2Pair(pair).transfer(msg.sender, lock.lpAmount)) revert LPTransferFailed();
        _lpEventRecords[msg.sender].push(LPEventRecord({
            token:       lock.token,
            ts:          uint64(block.timestamp),
            isClaim:     true,
            lpAmount:    uint128(lock.lpAmount),
            ethReturned: 0
        }));
        emit LPClaimed(msg.sender, lock.token, lock.lpAmount);
    }

    // ── Remove LP ─────────────────────────────────────────────────────────────
    function _removeLPCore(uint256 _lockIndex, bool direct) internal {
        bool wasQualifying = _qualifies(msg.sender);
        _callFacet(abi.encodeCall(LiquidityFacet.removeLPCoreExt, (_lockIndex, direct)));
        bool nowQualifying = _qualifies(msg.sender);

        _callROI(abi.encodeCall(LiquidityROIFacet.endROIStreamsExt, (msg.sender, _lockIndex)));

        if (wasQualifying && !nowQualifying) {
            address ref = users[msg.sender].referrer;
            if (ref != address(0)) {
                _callROI(abi.encodeCall(LiquidityROIFacet.onLossReferralExt, (ref)));
            }
        }
    }

    function removeLP(uint256 _lockIndex) external nonReentrant {
        _removeLPCore(_lockIndex, false);
    }
    function removeLPDirect(uint256 _lockIndex) external nonReentrant {
        _removeLPCore(_lockIndex, true);
    }

    // ── Restake ───────────────────────────────────────────────────────────────
    function restakeLP(uint256 _lockIndex, uint256 _durationDays) external nonReentrant {
        if (
            _durationDays != 7 && _durationDays != 30 && _durationDays != 60 &&
            _durationDays != 90 && _durationDays != 180 && _durationDays != 360
        ) revert InvalidDuration();

        // End old ROI streams before restakeLPExt updates the lock
        _callROI(abi.encodeCall(LiquidityROIFacet.endROIStreamsExt, (msg.sender, _lockIndex)));

        _callFacet(abi.encodeCall(LiquidityFacet.restakeLPExt, (_lockIndex, _durationDays)));

        // Init new ROI streams with updated lock (new rewardRatePPM written by restakeLPExt)
        _callROI(abi.encodeCall(LiquidityROIFacet.initROIStreamsExt, (msg.sender, _lockIndex)));
    }

    // ── Staking reward claims ─────────────────────────────────────────────────
    function claimStakingReward() external nonReentrant onlyRegistered {
        _callFacet(abi.encodeCall(LiquidityFacet.claimStakingRewardExt, ()));
    }
    function claimStakingRewardForLock(uint256 _lockIndex) external nonReentrant onlyRegistered {
        _callFacet(abi.encodeCall(LiquidityFacet.claimStakingRewardForLockExt, (_lockIndex)));
    }

    // ── ROI claims ────────────────────────────────────────────────────────────
    function claimAllROI() external nonReentrant onlyRegistered {
        _callROI(abi.encodeCall(LiquidityROIFacet.settleAllStreamsExt, (msg.sender)));
        uint256 ethAmount = _roiPendingETH[msg.sender];
        if (ethAmount == 0) revert NothingToClaim();
        _roiPendingETH[msg.sender] = 0;
        _callFacet(abi.encodeCall(LiquidityFacet.updateTWAPExt, ()));
        uint256 price = getTWAPPrice();
        uint256 roiTokens = (ethAmount * 1e18) / price;
        if (IERC20(platformToken).balanceOf(address(this)) < roiTokens) revert InsufficientTokenBalance();
        if (!IERC20(platformToken).transfer(msg.sender, roiTokens)) revert TokenTransferFailed();
        _roiClaimRecords[msg.sender].push(ClaimRecord({
            tokensAmount:  uint128(roiTokens),
            ethEquivalent: uint128(ethAmount),
            ts:            uint64(block.timestamp)
        }));
        emit ROIClaimed(msg.sender, roiTokens, ethAmount);
    }

    function claimROIFromStream(address investor, uint256 lockIndex, uint8 level)
        external nonReentrant onlyRegistered
    {
        // Snapshot pending before settling so we can isolate this stream's contribution.
        uint256 pendingBefore = _roiPendingETH[msg.sender];
        _callROI(abi.encodeCall(LiquidityROIFacet.settleStreamExt, (investor, lockIndex, level)));
        // Only the delta belongs to this stream; leave any pre-existing pending untouched.
        uint256 streamEth = _roiPendingETH[msg.sender] - pendingBefore;
        if (streamEth == 0) revert NothingToClaim();
        _roiPendingETH[msg.sender] = pendingBefore;
        _callFacet(abi.encodeCall(LiquidityFacet.updateTWAPExt, ()));
        uint256 price = getTWAPPrice();
        uint256 roiTokens = (streamEth * 1e18) / price;
        if (IERC20(platformToken).balanceOf(address(this)) < roiTokens) revert InsufficientTokenBalance();
        if (!IERC20(platformToken).transfer(msg.sender, roiTokens)) revert TokenTransferFailed();
        _roiClaimRecords[msg.sender].push(ClaimRecord({
            tokensAmount:  uint128(roiTokens),
            ethEquivalent: uint128(streamEth),
            ts:            uint64(block.timestamp)
        }));
        emit ROIClaimed(msg.sender, roiTokens, streamEth);
    }

    // ── TWAP ─────────────────────────────────────────────────────────────────
    function updateTWAP() public {
        _callFacet(abi.encodeCall(LiquidityFacet.updateTWAPExt, ()));
    }
    function updateTokenTWAP(address _token) public {
        _callFacet(abi.encodeCall(LiquidityFacet.updateTokenTWAPExt, (_token)));
    }
    function getTWAPPrice() public view returns (uint256) {
        if (!_tokenTwapReady[platformToken]) revert PriceUnavailable();
        if (block.timestamp - _tokenTwapLastUpdated[platformToken] > TWAP_MAX_STALE) revert TWAPStale();
        return _tokenTwapPrice[platformToken];
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    function setValidPackage(uint256 ethWei, bool valid) external onlyOwner {
        validPackageAmounts[ethWei] = valid;
    }
    function setMinDirectReferralInvestment(uint256 _amount) external onlyOwner {
        minDirectReferralInvestment = _amount;
    }
    function setStakingRates(uint256 durationIdx, uint256 tierIdx, uint256 streakLevel, uint256 rate) external onlyOwner {
        if (durationIdx >= 6) revert InvalidDurationIndex();
        if (tierIdx >= 12) revert InvalidTierIndex();
        if (streakLevel >= 4) revert InvalidStreakLevel();
        stakingRates[durationIdx][tierIdx][streakLevel] = rate;
    }
    function withdrawETH(uint256 amount) external onlyOwner nonReentrant {
        uint256 bal = address(this).balance;
        uint256 toSend = amount == 0 ? bal : (amount > bal ? bal : amount);
        if (toSend == 0) revert NoETHToWithdraw();
        (bool ok,) = payable(owner).call{value: toSend}("");
        if (!ok) revert ETHWithdrawFailed();
    }
    function withdrawToken(address _token, uint256 amount) external onlyOwner nonReentrant {
        uint256 bal    = IERC20(_token).balanceOf(address(this));
        uint256 locked = _totalLockedLP[_token];
        uint256 free   = bal > locked ? bal - locked : 0;
        uint256 toSend = amount == 0 ? free : (amount > free ? free : amount);
        if (toSend == 0) revert NoTokensToWithdraw();
        if (!IERC20(_token).transfer(owner, toSend)) revert TokenWithdrawFailed();
    }

    // ── View functions ────────────────────────────────────────────────────────
    function getActiveDirectReferralCount(address _user) public view returns (uint256) {
        return activeReferralCount[_user];
    }
    function getPlatformStats() external view returns (
        uint256 _totalUsers, uint256 _totalEthInvested, uint256 _totalStakingRewardsPaidETH
    ) {
        return (totalRegisteredUsers + 1, totalEthInvested, totalStakingRewardsPaidETH);
    }
    function getAllRegisteredUsers() external view returns (address[] memory) {
        return allRegisteredUsers;
    }
    function getUserLPLocks(address _user) external view returns (LPLock[] memory) {
        return userLPLocks[_user];
    }
    function getRegisteredTokens() external view returns (address[] memory) {
        return registeredTokens;
    }
    function getToken(address _tokenAddress) external view returns (Token memory) {
        return tokens[_tokenAddress];
    }
    function getReferrals(address _user) external view returns (address[] memory) {
        return users[_user].referrals;
    }
    function getReferrer(address _user) external view returns (address) {
        return users[_user].referrer;
    }
    function getContractTokenBalance(address _token) external view returns (uint256) {
        return IERC20(_token).balanceOf(address(this));
    }
    function getStakingReward(address _user) external view returns (
        uint256 totalAccumulated, uint256 previewNewTokens, uint256 lifetimeClaimed
    ) {
        uint256 price = LiquidityMath.tokenPriceInETH(UNISWAP_FACTORY, platformToken, WETH);
        LPLock[] memory locks = userLPLocks[_user];
        return LiquidityViewLib.computeStakingReward(locks, price);
    }
    function getUserCommissionStats(address _user) external view returns (
        uint256 earned, uint256, uint256 totalCap, uint256 remainingCap, uint256 active
    ) {
        LPLock[] memory locks = userLPLocks[_user];
        return LiquidityViewLib.computeCommissionStats(
            locks, userCommissionsEarned[_user], userTotalInvested[_user], block.timestamp
        );
    }
    function getDirectRefsInfo(address user) external view returns (DirectRefInfo[] memory result) {
        address[] memory refs = users[user].referrals;
        uint256 len = refs.length;
        result = new DirectRefInfo[](len);
        for (uint256 i = 0; i < len; ) {
            address ref = refs[i];
            result[i].addr          = ref;
            result[i].totalInvested = userTotalInvested[ref];
            result[i].directRefCount = users[ref].referrals.length;
            (,, uint256 tc, uint256 rc,) = LiquidityViewLib.computeCommissionStats(
                userLPLocks[ref], userCommissionsEarned[ref], userTotalInvested[ref], block.timestamp
            );
            result[i].remainingCap = rc;
            result[i].totalCap     = tc;
            unchecked { i++; }
        }
    }
    function getWealthParams(address _user) external view returns (WealthParams memory p) {
        LPLock[] memory locks = userLPLocks[_user];
        return LiquidityViewLib.computeWealthParams(
            locks, userCommissionsEarned[_user],
            LiquidityMath.tokenPriceInETH(UNISWAP_FACTORY, platformToken, WETH),
            LP_LOCK_DURATION, UNISWAP_FACTORY, WETH
        );
    }
    function getStakingRatesForAmount(uint256 ethInvestedWei) external view returns (
        uint256[6] memory durSecs, uint256[6] memory ratesPPM
    ) {
        uint256 investUSDT = ethInvestedWei * USDT_PER_ETH / 1e18;
        bool hasReward = investUSDT >= 100;
        uint256 tierIdx = hasReward ? LiquidityMath.getTierIndex(investmentTiers, ethInvestedWei) : 0;
        for (uint256 i = 0; i < 6; ) {
            durSecs[i]  = stakingDurations[i];
            ratesPPM[i] = hasReward ? stakingRates[i][tierIdx][0] : 0;
            unchecked { i++; }
        }
    }
    function setRefLabel(address _ref, bytes calldata _label) external {
        _refLabels[msg.sender][_ref] = _label;
    }
    function getRefLabel(address _owner, address _ref) external view returns (bytes memory) {
        return _refLabels[_owner][_ref];
    }
    function getPriceHistory(address _token) external view returns (PriceSnap[] memory) {
        return _priceHistory[_token];
    }
    function getTradeHistory(address _token) external view returns (TradeSnap[] memory) {
        return _tradeHistory[_token];
    }
    function getCommissionRecords(address _user) external view returns (CommissionRecord[] memory) {
        return _commissionRecords[_user];
    }
    function getMissedRecords(address _user) external view returns (MissedRecord[] memory) {
        return _missedRecords[_user];
    }
    function getInvestRecords(address _user) external view returns (InvestRecord[] memory) {
        return _investRecords[_user];
    }
    function getClaimRecords(address _user) external view returns (ClaimRecord[] memory) {
        return _claimRecords[_user];
    }
    function getROIClaimRecords(address _user) external view returns (ClaimRecord[] memory) {
        return _roiClaimRecords[_user];
    }
    function getLPEventRecords(address _user) external view returns (LPEventRecord[] memory) {
        return _lpEventRecords[_user];
    }

    // ── ROI view functions (read directly from inherited storage) ────────────
    // These MUST NOT delegate to the ROI facet via a regular CALL — that would
    // read the facet's own empty storage instead of Liquidity.sol's storage.
    function getROIPending(address recipient) external view returns (uint256 total) {
        total = _roiPendingETH[recipient];
        StreamRef[] storage arr = _activeROIStreams[recipient];
        for (uint256 i = 0; i < arr.length; ) {
            StreamRef storage ref = arr[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];
            if (!stream.ended) total += _calcAccrued(stream, ref.investor, ref.lockIndex, ref.level);
            unchecked { i++; }
        }
    }
    // Returns settled pending and live (unsettled) accrued separately — used by the frontend
    // dashboard and rewards tab to display and tick the ROI commission counters.
    function getROIData(address recipient) external view returns (uint256 liveETH, uint256 pendingETH) {
        pendingETH = _roiPendingETH[recipient];
        StreamRef[] storage arr = _activeROIStreams[recipient];
        for (uint256 i = 0; i < arr.length; ) {
            StreamRef storage ref = arr[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];
            if (!stream.ended) liveETH += _calcAccrued(stream, ref.investor, ref.lockIndex, ref.level);
            unchecked { i++; }
        }
    }
    function getActiveROIStreams(address recipient) external view returns (StreamRef[] memory) {
        return _activeROIStreams[recipient];
    }
    function getROIStreamInfo(address investor, uint256 lockIndex, uint8 level)
        external view returns (ROIStream memory)
    {
        return _roiStreams[investor][lockIndex][level];
    }
    function getROIAccrued(address investor, uint256 lockIndex, uint8 level)
        external view returns (uint256)
    {
        ROIStream storage stream = _roiStreams[investor][lockIndex][level];
        return _calcAccrued(stream, investor, lockIndex, level);
    }

    // ── Direct swap functions (records every trade in _tradeHistory) ─────────
    function swapBuy(address _token, uint256 _usdtIn, uint256 _minTokensOut) external nonReentrant {
        if (_usdtIn == 0) revert MustSendUSDT();
        if (!IERC20(WETH).transferFrom(msg.sender, address(this), _usdtIn)) revert USDTTransferFailed();
        IERC20(WETH).approve(UNISWAP_ROUTER, _usdtIn);
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = _token;
        uint256[] memory amounts = IUniswapV2Router02(UNISWAP_ROUTER)
            .swapExactTokensForTokens(
                _usdtIn, _minTokensOut, path, msg.sender, block.timestamp + 300
            );
        IERC20(WETH).approve(UNISWAP_ROUTER, 0);
        _tradeHistory[_token].push(TradeSnap({
            ts:     uint64(block.timestamp),
            isBuy:  true,
            ethAmt: uint128(_usdtIn),
            tokAmt: uint128(amounts[1])
        }));
    }

    function swapSell(address _token, uint256 _tokensIn, uint256 _minUsdtOut) external nonReentrant {
        if (_tokensIn == 0) revert MustSpecifyTokenAmount();
        IERC20(_token).transferFrom(msg.sender, address(this), _tokensIn);
        IERC20(_token).approve(UNISWAP_ROUTER, _tokensIn);
        address[] memory path = new address[](2);
        path[0] = _token;
        path[1] = WETH;
        uint256[] memory amounts = IUniswapV2Router02(UNISWAP_ROUTER)
            .swapExactTokensForTokens(
                _tokensIn, _minUsdtOut, path, msg.sender, block.timestamp + 300
            );
        IERC20(_token).approve(UNISWAP_ROUTER, 0);
        _tradeHistory[_token].push(TradeSnap({
            ts:     uint64(block.timestamp),
            isBuy:  false,
            ethAmt: uint128(amounts[1]),
            tokAmt: uint128(_tokensIn)
        }));
    }

    receive() external payable {}
}

interface IUniswapV2Router02 {
    function addLiquidity(
        address tokenA, address tokenB,
        uint amountADesired, uint amountBDesired,
        uint amountAMin, uint amountBMin,
        address to, uint deadline
    ) external returns (uint amountA, uint amountB, uint liquidity);
    function swapExactTokensForTokens(
        uint amountIn, uint amountOutMin,
        address[] calldata path, address to, uint deadline
    ) external returns (uint[] memory amounts);
    function removeLiquidity(
        address tokenA, address tokenB, uint liquidity,
        uint amountAMin, uint amountBMin,
        address to, uint deadline
    ) external returns (uint amountA, uint amountB);
}
