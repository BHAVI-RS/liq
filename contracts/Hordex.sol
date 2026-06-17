// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HordexStorage.sol";
import "./HordexMath.sol";
import "./HordexFacet.sol";
import "./HordexROIFacet.sol";

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

contract Hordex is HordexStorage {

    // ── Immutables (NOT storage slots) ───────────────────────────────────────
    address public  immutable platformToken;
    address private immutable UNISWAP_ROUTER;
    address private immutable UNISWAP_FACTORY;
    address private immutable WETH;
    address private immutable _facet;
    address private immutable _roiFacet;

    // Read-only view/getter facet. All getX()/batch views were moved out of this contract
    // (to keep it under the 24 KB mainnet limit) into HordexViewFacet; unknown selectors
    // are forwarded there via fallback(). Stored (not a constructor immutable) so the existing
    // deploy flow / constructor signature is unchanged — owner wires it once with setViewFacet().
    address private _viewFacet;

    uint256 private constant LP_LOCK_DURATION  = 540; // 90 days scaled: 1 day = 6 s (testing)
    uint256 private constant USDT_PER_ETH      = 1;
    uint256 private constant TWAP_MAX_STALE    = 2 hours;
    uint256 private constant REGISTRATION_FEE  = 1e18 / USDT_PER_ETH; // 1 USDT legitimacy check

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
    error RegistrationFeeFailed();

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
        roiCommissionRates      = [25000, 5000, 2500, 1000, 300, 250, 225, 200, 200, 175];
        // Level-eligibility gates (USDT), per 0-indexed level. To earn level i a recipient needs
        // active self-stake >= selfStakeGate[i] AND cumulative team business >= businessGate[i].
        selfStakeGate = [uint32(25), 50, 100, 250, 500, 1000, 1000, 1000, 1000, 1000];
        businessGate  = [uint32(0),  0,  500, 2500, 5000, 10000, 10000, 10000, 10000, 10000];
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
            [HordexMath.getDurationIndex(stakingDurations, durationDays)]
            [HordexMath.getTierIndex(investmentTiers, ethInvestedWei)]
            [sIdx];
    }

    // ── Registration ──────────────────────────────────────────────────────────
    function register(address _referrer) external notRegistered {
        if (_referrer == msg.sender) revert CannotReferSelf();
        if (!users[_referrer].isRegistered) revert ReferrerNotRegistered();
        // 1 USDT legitimacy check — sent directly to the deployer wallet
        if (!IERC20(WETH).transferFrom(msg.sender, owner, REGISTRATION_FEE)) revert RegistrationFeeFailed();
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

        _callFacet(abi.encodeCall(HordexFacet.updateTWAPExt, ()));
        _callFacet(abi.encodeCall(HordexFacet.updateTokenTWAPExt, (_token)));
        if (!_tokenTwapReady[_token]) revert PriceUnavailable();
        if (block.timestamp - _tokenTwapLastUpdated[_token] > TWAP_MAX_STALE) revert TokenTWAPStale();

        uint256 T         = _usdtAmount;
        uint256 rewardPPM = _getRewardRatePPM(T, 90, 0);

        // Snapshot cap state BEFORE the new lock is added by investExt.
        bool hadNoActiveCap = _getRawAvailableCap(msg.sender) == 0;
        uint256 _lastExpiry = 0;
        if (hadNoActiveCap) {
            LPLock[] storage _lockArr = userLPLocks[msg.sender];
            uint256 _ll = _lockArr.length;
            for (uint256 _j = 0; _j < _ll; ) {
                LPLock storage _lk = _lockArr[_j];
                if (!_lk.removed && _lk.unlockTime <= block.timestamp && _lk.unlockTime > _lastExpiry)
                    _lastExpiry = _lk.unlockTime;
                unchecked { _j++; }
            }
            // Retained-after-exit users have no non-removed lock; resume from the retention time
            // so _handleNaturalExpiryResume preserves the earned ROI and excludes the no-stake gap.
            if (_roiRetainedAt[msg.sender] != 0 && _roiRetainedAt[msg.sender] > _lastExpiry)
                _lastExpiry = _roiRetainedAt[msg.sender];
        }

        _callFacet(abi.encodeCall(HordexFacet.investExt, (_token, rewardPPM, T)));

        userTotalInvested[msg.sender] += T;
        totalEthInvested              += T;

        // Roll this package up to 10 ancestors as cumulative team business (USDT, sticky/lifetime).
        // Bounded at 10 hops — the levels you can ever earn from — so invest stays O(1) in chain
        // depth and a long referral chain can never push it past the block gas limit.
        {
            uint256 _bizUSDT = T * USDT_PER_ETH / 1e18;
            if (_bizUSDT > 0) {
                address _up = users[msg.sender].referrer;
                for (uint256 _d = 0; _d < 10 && _up != address(0); ) {
                    _teamBusinessUSDT[_up] += _bizUSDT;
                    _up = users[_up].referrer;
                    unchecked { _d++; }
                }
            }
        }

        // Reconcile the referrer's active count BEFORE distributing commissions so the
        // eligibility check in _distributeReferralCommissions sees the correct count.
        // Idempotent + clamped, so a changed minDirectReferralInvestment can't make it drift.
        _syncReferralCount(msg.sender);

        uint256 lockIndex = userLPLocks[msg.sender].length - 1;

        // Restore ROI accrual now that this new lock supplies fresh cap. ROI that accrued during a
        // NO-AVAILABLE-CAP period is FORFEITED (missed) and is NOT recovered by re-investing: when the
        // cap was exhausted while staked (_capPausedAt set), the gap (_capPausedAt → now) is forfeited
        // exactly like the post-natural-expiry no-stake gap. Pre-gap earned ROI is preserved; accrual
        // resumes against the fresh cap from now. O(1) checkpoint (see _handleNaturalExpiryResume) —
        // no per-stream loop, unbounded-stream safe.
        if (_capPausedAt[msg.sender] > 0) {
            uint256 _resumeFrom = _capPausedAt[msg.sender] > _lastExpiry ? _capPausedAt[msg.sender] : _lastExpiry;
            _capPausedAt[msg.sender] = 0;
            _handleNaturalExpiryResume(msg.sender, _resumeFrom);
        } else if (hadNoActiveCap) {
            _handleNaturalExpiryResume(msg.sender, _lastExpiry);
        }

        // The earned ROI has now been preserved into pending by the resume above (if any); clear
        // any retention so the new lock's fresh cap governs future accrual from here on.
        if (_roiRetainedAt[msg.sender] != 0) {
            _roiRetainedCap[msg.sender] = 0;
            _roiRetainedAt[msg.sender]  = 0;
        }

        _callROI(abi.encodeCall(HordexROIFacet.initROIStreamsExt, (msg.sender, lockIndex)));

        uint256 A   = T / 2;
        uint256 A40 = A - (A * 60 / 100);
        _callFacet(abi.encodeCall(HordexFacet.distributeCommissionsExt, (msg.sender, A40)));
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
        _callFacet(abi.encodeCall(HordexFacet.removeLPCoreExt, (_lockIndex, direct)));
        _callROI(abi.encodeCall(HordexROIFacet.endROIStreamsExt, (msg.sender, _lockIndex)));
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

        // Snapshot cap state BEFORE restakeLPExt extends the lock's unlockTime in-place.
        // (For invest() this snapshot happens before investExt; here we must do it first
        //  because the restaked lock IS the one whose unlockTime changes.)
        bool hadNoActiveCap = _getRawAvailableCap(msg.sender) == 0;
        uint256 _lastExpiry = 0;
        if (hadNoActiveCap) {
            LPLock[] storage _lockArr = userLPLocks[msg.sender];
            uint256 _ll = _lockArr.length;
            for (uint256 _j = 0; _j < _ll; ) {
                LPLock storage _lk = _lockArr[_j];
                if (!_lk.removed && _lk.unlockTime <= block.timestamp && _lk.unlockTime > _lastExpiry)
                    _lastExpiry = _lk.unlockTime;
                unchecked { _j++; }
            }
        }

        // End old ROI streams before restakeLPExt updates the lock
        _callROI(abi.encodeCall(HordexROIFacet.endROIStreamsExt, (msg.sender, _lockIndex)));

        _callFacet(abi.encodeCall(HordexFacet.restakeLPExt, (_lockIndex, _durationDays)));

        // Resume ROI accrual if re-locking this lock reactivated dormant unused cap.
        // NOTE: commissionsCapUsed is deliberately NOT reset — restaking carries cap forward
        // unchanged (consumed stays consumed, unused stays usable); only invest() grants new cap.
        // ROI that accrued during a NO-AVAILABLE-CAP period is FORFEITED (missed): when cap was
        // exhausted while staked (_capPausedAt set), the gap (_capPausedAt → now) is forfeited like
        // the post-natural-expiry no-stake gap. Pre-gap earned ROI preserved. O(1), no per-stream loop.
        if (_capPausedAt[msg.sender] > 0) {
            uint256 _resumeFrom = _capPausedAt[msg.sender] > _lastExpiry ? _capPausedAt[msg.sender] : _lastExpiry;
            _capPausedAt[msg.sender] = 0;
            _handleNaturalExpiryResume(msg.sender, _resumeFrom);
        } else if (hadNoActiveCap) {
            _handleNaturalExpiryResume(msg.sender, _lastExpiry);
        }

        // Init new ROI streams with updated lock (new rewardRatePPM written by restakeLPExt)
        _callROI(abi.encodeCall(HordexROIFacet.initROIStreamsExt, (msg.sender, _lockIndex)));
    }

    // ── Staking reward claims ─────────────────────────────────────────────────
    function claimStakingReward() external nonReentrant onlyRegistered {
        _callFacet(abi.encodeCall(HordexFacet.claimStakingRewardExt, ()));
    }
    function claimStakingRewardForLock(uint256 _lockIndex) external nonReentrant onlyRegistered {
        _callFacet(abi.encodeCall(HordexFacet.claimStakingRewardForLockExt, (_lockIndex)));
    }

    // ── ROI claims ────────────────────────────────────────────────────────────
    function claimAllROI() external nonReentrant onlyRegistered {
        _callROI(abi.encodeCall(HordexROIFacet.settleAllStreamsExt, (msg.sender)));
        uint256 ethAmount = _roiPendingETH[msg.sender];
        if (ethAmount == 0) revert NothingToClaim();
        uint256 rawCap = _getRawAvailableCap(msg.sender);
        uint256 toClaim;
        if (rawCap > 0) {
            // Normal path: claim up to raw cap and charge commissionsCapUsed.
            toClaim = ethAmount < rawCap ? ethAmount : rawCap;
            _chargeCap(msg.sender, toClaim);
        } else {
            // rawCap = 0: either cap paused (_capPausedAt > 0) or active locks all expired.
            // Paused: _chargeCap already pre-settled streams and charged active commissionsCapUsed;
            //   post-exhaustion accrual is not settled (settleAllStreamsExt used active-only cap = 0).
            //   Pay only what is in _roiPendingETH; no additional cap charge needed.
            // Expired (not paused): expired locks still have remaining cap; settleAllStreamsExt
            //   settled using that cap above, so commit the charge now to prevent re-claiming.
            toClaim = ethAmount;
            if (_capPausedAt[msg.sender] == 0) {
                uint256 settleCap = _getRawAvailableCapInclExpired(msg.sender);
                if (settleCap > 0 && toClaim > 0) {
                    _chargeCapInclExpired(msg.sender, toClaim < settleCap ? toClaim : settleCap);
                }
            }
        }
        _roiPendingETH[msg.sender] = 0;
        _callFacet(abi.encodeCall(HordexFacet.updateTWAPExt, ()));
        uint256 price = getTWAPPrice();
        uint256 roiTokens = (toClaim * 1e18) / price;
        if (IERC20(platformToken).balanceOf(address(this)) < roiTokens) revert InsufficientTokenBalance();
        if (!IERC20(platformToken).transfer(msg.sender, roiTokens)) revert TokenTransferFailed();
        _roiClaimRecords[msg.sender].push(ClaimRecord({
            tokensAmount:  uint128(roiTokens),
            ethEquivalent: uint128(toClaim),
            ts:            uint64(block.timestamp)
        }));
        emit ROIClaimed(msg.sender, roiTokens, toClaim);
    }

    function claimROIFromStream(address investor, uint256 lockIndex, uint8 level)
        external nonReentrant onlyRegistered
    {
        uint256 pendingBefore = _roiPendingETH[msg.sender];
        _callROI(abi.encodeCall(HordexROIFacet.settleStreamExt, (investor, lockIndex, level)));
        uint256 streamEth = _roiPendingETH[msg.sender] - pendingBefore;
        if (streamEth == 0) revert NothingToClaim();
        uint256 rawCap = _getRawAvailableCap(msg.sender);
        uint256 toClaim = rawCap > 0 ? (streamEth < rawCap ? streamEth : rawCap) : streamEth;
        if (rawCap > 0) _chargeCap(msg.sender, toClaim);
        else if (_capPausedAt[msg.sender] == 0) {
            // Expired (not paused): commit the charge on expired lock cap.
            uint256 settleCap = _getRawAvailableCapInclExpired(msg.sender);
            if (settleCap > 0 && toClaim > 0) {
                _chargeCapInclExpired(msg.sender, toClaim < settleCap ? toClaim : settleCap);
            }
        }
        // This stream's over-cap excess is discarded; other streams' settled pending is preserved.
        _roiPendingETH[msg.sender] = pendingBefore;
        _callFacet(abi.encodeCall(HordexFacet.updateTWAPExt, ()));
        uint256 price = getTWAPPrice();
        uint256 roiTokens = (toClaim * 1e18) / price;
        if (IERC20(platformToken).balanceOf(address(this)) < roiTokens) revert InsufficientTokenBalance();
        if (!IERC20(platformToken).transfer(msg.sender, roiTokens)) revert TokenTransferFailed();
        _roiClaimRecords[msg.sender].push(ClaimRecord({
            tokensAmount:  uint128(roiTokens),
            ethEquivalent: uint128(toClaim),
            ts:            uint64(block.timestamp)
        }));
        emit ROIClaimed(msg.sender, roiTokens, toClaim);
    }

    // Settles a batch of ROI streams [fromIndex, fromIndex+count) into _roiPendingETH
    // without claiming. For users whose _activeROIStreams is too large for claimAllROI
    // to fit in one block: call this repeatedly until all streams are covered, then
    // call claimPendingROI() once to receive the accumulated tokens.
    function settleROIStreams(uint256 fromIndex, uint256 count) external nonReentrant onlyRegistered {
        _callROI(abi.encodeCall(HordexROIFacet.settleStreamsRangeExt, (msg.sender, fromIndex, count)));
    }

    // Claims whatever has accumulated in _roiPendingETH[msg.sender] without settling
    // any additional streams. Use after one or more settleROIStreams() calls.
    function claimPendingROI() external nonReentrant onlyRegistered {
        uint256 ethAmount = _roiPendingETH[msg.sender];
        if (ethAmount == 0) revert NothingToClaim();
        uint256 rawCap = _getRawAvailableCap(msg.sender);
        uint256 toClaim;
        if (rawCap > 0) {
            toClaim = ethAmount < rawCap ? ethAmount : rawCap;
            _chargeCap(msg.sender, toClaim);
        } else {
            toClaim = ethAmount;
            // Expired (not paused): commit the charge on expired lock cap.
            if (_capPausedAt[msg.sender] == 0) {
                uint256 settleCap = _getRawAvailableCapInclExpired(msg.sender);
                if (settleCap > 0 && toClaim > 0) {
                    _chargeCapInclExpired(msg.sender, toClaim < settleCap ? toClaim : settleCap);
                }
            }
        }
        _roiPendingETH[msg.sender] = 0;
        _callFacet(abi.encodeCall(HordexFacet.updateTWAPExt, ()));
        uint256 price = getTWAPPrice();
        uint256 roiTokens = (toClaim * 1e18) / price;
        if (IERC20(platformToken).balanceOf(address(this)) < roiTokens) revert InsufficientTokenBalance();
        if (!IERC20(platformToken).transfer(msg.sender, roiTokens)) revert TokenTransferFailed();
        _roiClaimRecords[msg.sender].push(ClaimRecord({
            tokensAmount:  uint128(roiTokens),
            ethEquivalent: uint128(toClaim),
            ts:            uint64(block.timestamp)
        }));
        emit ROIClaimed(msg.sender, roiTokens, toClaim);
    }

    // ── TWAP ─────────────────────────────────────────────────────────────────
    function updateTWAP() public {
        _callFacet(abi.encodeCall(HordexFacet.updateTWAPExt, ()));
    }
    function updateTokenTWAP(address _token) public {
        _callFacet(abi.encodeCall(HordexFacet.updateTokenTWAPExt, (_token)));
    }
    function getTWAPPrice() public view returns (uint256) {
        if (!_tokenTwapReady[platformToken]) revert PriceUnavailable();
        if (block.timestamp - _tokenTwapLastUpdated[platformToken] > TWAP_MAX_STALE) revert TWAPStale();
        return _tokenTwapPrice[platformToken];
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    function setROICommissionRates(uint16[10] calldata rates) external onlyOwner {
        roiCommissionRates = rates;
    }
    // Level-eligibility gates (USDT), 0-indexed by level. Earning level i requires active
    // self-stake >= selfStakeGate[i] AND cumulative team business >= businessGate[i].
    function setSelfStakeGates(uint32[10] calldata gates) external onlyOwner {
        selfStakeGate = gates;
    }
    function setBusinessGates(uint32[10] calldata gates) external onlyOwner {
        businessGate = gates;
    }
    function setValidPackage(uint256 ethWei, bool valid) external onlyOwner {
        validPackageAmounts[ethWei] = valid;
    }
    function setMinDirectReferralInvestment(uint256 _amount) external onlyOwner {
        minDirectReferralInvestment = _amount;
    }
    function setLockCapPaused(address _user, uint256 _lockIndex, bool _paused) external onlyOwner {
        userLPLocks[_user][_lockIndex].capPaused = _paused;
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
        uint256 toSend = amount == 0 ? bal : (amount > bal ? bal : amount);
        if (toSend == 0) revert NoTokensToWithdraw();
        if (!IERC20(_token).transfer(owner, toSend)) revert TokenWithdrawFailed();
    }

    // ── View functions ────────────────────────────────────────────────────────
    // All read-only getters and batch/aggregation views live in HordexViewFacet and are
    // reached through fallback() below. getTWAPPrice() stays here because it is called
    // internally by the ROI claim functions.

    // ── Direct swap functions (records every trade in _tradeHistory) ─────────
    // Hybrid buy: route only the slippage-capped portion through the Uniswap pool (so the pool
    // price never moves more than SWAP_SLIPPAGE_BPS) and fill the remainder from the platform's
    // own token inventory at the post-pool spot price. If inventory runs out the buy is partially
    // filled and the unspent USDT is refunded (see calcHybridBuy).
    uint256 private constant SWAP_SLIPPAGE_BPS = 200; // pool leg capped at 2% slippage

    function swapBuy(address _token, uint256 _usdtIn, uint256 _minTokensOut) external nonReentrant {
        if (_usdtIn == 0) revert MustSendUSDT();
        // Only platform-registered, live tokens may be traded through the contract — prevents
        // arbitrary tokens from polluting _tradeHistory and keeps recorded trades meaningful.
        if (tokens[_token].tokenAddress == address(0)) revert TokenNotRegistered();
        if (tokens[_token].removed) revert TokenDelisted();

        // Pool reserves drive both the slippage cap and the inventory price.
        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(_token, WETH);
        if (pair == address(0)) revert PriceUnavailable();
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
        address t0     = IUniswapV2Pair(pair).token0();
        uint256 resTok = t0 == _token ? uint256(r0) : uint256(r1);
        uint256 resETH = t0 == _token ? uint256(r1) : uint256(r0);
        if (resTok == 0 || resETH == 0) revert PriceUnavailable();

        if (!IERC20(WETH).transferFrom(msg.sender, address(this), _usdtIn)) revert USDTTransferFailed();

        uint256 invBal = IERC20(_token).balanceOf(address(this));
        (uint256 poolUsdt, uint256 poolTokensOut, uint256 invTokensOut, uint256 usdtSpent) =
            HordexMath.calcHybridBuy(resTok, resETH, _usdtIn, invBal, SWAP_SLIPPAGE_BPS);

        uint256 totalOut = poolTokensOut + invTokensOut;
        if (totalOut < _minTokensOut) revert InsufficientTokenBalance();

        // 1) Pool leg — swapped through Uniswap straight to the buyer.
        if (poolUsdt > 0) {
            IERC20(WETH).approve(UNISWAP_ROUTER, poolUsdt);
            address[] memory path = new address[](2);
            path[0] = WETH;
            path[1] = _token;
            IUniswapV2Router02(UNISWAP_ROUTER).swapExactTokensForTokens(
                poolUsdt, poolTokensOut, path, msg.sender, block.timestamp + 300
            );
            IERC20(WETH).approve(UNISWAP_ROUTER, 0);
        }

        // 2) Inventory leg — contract sells its own tokens at the post-pool spot price.
        if (invTokensOut > 0) {
            if (!IERC20(_token).transfer(msg.sender, invTokensOut)) revert TokenTransferFailed();
        }

        // 3) Refund USDT that could not be filled because inventory ran out.
        uint256 refund = _usdtIn - usdtSpent;
        if (refund > 0) {
            if (!IERC20(WETH).transfer(msg.sender, refund)) revert USDTTransferFailed();
        }

        _tradeHistory[_token].push(TradeSnap({
            ts:     uint64(block.timestamp),
            isBuy:  true,
            ethAmt: uint128(usdtSpent),
            tokAmt: uint128(totalOut)
        }));
    }

    function swapSell(address _token, uint256 _tokensIn, uint256 _minUsdtOut) external nonReentrant {
        if (_tokensIn == 0) revert MustSpecifyTokenAmount();
        // Must be a platform-registered token (delisted tokens are still allowed here so holders
        // can always exit a position that was later removed).
        if (tokens[_token].tokenAddress == address(0)) revert TokenNotRegistered();
        if (!IERC20(_token).transferFrom(msg.sender, address(this), _tokensIn)) revert TokenTransferFailed();
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

    // One-time wiring of the read-only view facet (see _viewFacet docs above).
    function setViewFacet(address facet_) external onlyOwner {
        _viewFacet = facet_;
    }

    receive() external payable {}

    // Forward every selector this contract does not implement to the view facet via
    // DELEGATECALL so the moved getters/batch views execute in this contract's storage.
    // Reads come in as eth_call (frontend), so although delegatecall is not `view` the call
    // never persists state; ethers decodes the returned ABI data exactly as before.
    fallback() external payable {
        address vf = _viewFacet;
        require(vf != address(0));
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), vf, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
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
