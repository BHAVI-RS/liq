// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./LiquidityMath.sol";
import "./LiquidityTypes.sol";
import "./LiquidityViewLib.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IUniswapV2Router02 {
    function swapExactETHForTokens(
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external payable returns (uint[] memory amounts);

    function addLiquidityETH(
        address token,
        uint amountTokenDesired,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external payable returns (uint amountToken, uint amountETH, uint liquidity);

    function removeLiquidityETH(
        address token,
        uint liquidity,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external returns (uint amountToken, uint amountETH);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function totalSupply() external view returns (uint256);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

contract Liquidity {

    // ── Custom errors ────────────────────────────────────────────────────────
    error NotOwner();
    error AlreadyRegistered();
    error NotRegistered();
    error Reentrant();
    error CannotReferSelf();
    error ReferrerNotRegistered();
    error MustSendETH();
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

    // Public getters used directly by the frontend
    mapping(address => User) public users;
    mapping(address => uint256) public userTotalInvested;
    address public featuredToken;
    address public owner;
    address public immutable platformToken;
    uint16[10] public referralCommissionRates = [5000, 2500, 1000, 300, 250, 225, 200, 200, 175, 150];
    uint256 public minDirectReferralInvestment;

    // Internal state — accessed via explicit getter functions (getToken, getUserLPLocks, etc.)
    mapping(address => Token) private tokens;
    mapping(address => LPLock[]) private userLPLocks;
    mapping(address => uint256) private userCommissionsEarned;
    mapping(address => uint256) private activeReferralCount;
    mapping(address => mapping(address => bytes)) private _refLabels;
    uint256 private totalRegisteredUsers;
    uint256 private totalEthInvested;
    uint256 private totalStakingRewardsPaidETH;
    address[] private registeredTokens;
    address[] private allRegisteredUsers;
    mapping(uint256 => bool) private validPackageAmounts;

    // Immutables (not called by frontend; used internally and passed to libraries)
    address private immutable UNISWAP_ROUTER;
    address private immutable UNISWAP_FACTORY;
    address private immutable WETH;

    // Constants (not exposed to frontend; inlined by optimizer)
    uint256 private constant LP_LOCK_DURATION  = 90 days;
    uint256 private constant USDT_PER_ETH      = 1000;
    uint256 private constant TWAP_PERIOD       = 30 seconds; // testing — change to 30 minutes for mainnet
    uint256 private constant TWAP_MAX_STALE    = 2 hours;
    uint256 private constant MAX_REFERRAL_HOPS = 15;
    uint256 private constant MAX_SLIPPAGE_BPS  = 200; // 2 % — swap / LP execution tolerance
    uint256 private constant TWAP_GUARD_BPS    = 500; // 5 % — max spot-vs-TWAP deviation before sandwich revert

    // Staking config (accessed via getStakingRatesForAmount, not directly by frontend)
    uint32[12] private investmentTiers;
    uint16[6]  private stakingDurations;
    uint256[4][12][6] private stakingRates;

    bool private _locked;

    // On-chain price and trade history for frontend charting (avoids unreliable eth_getLogs)
    mapping(address => PriceSnap[]) private _priceHistory;
    mapping(address => TradeSnap[])  private _tradeHistory;

    // On-chain per-user history records (avoids unreliable eth_getLogs on Amoy RPC)
    mapping(address => CommissionRecord[]) private _commissionRecords;
    mapping(address => InvestRecord[])     private _investRecords;
    mapping(address => ClaimRecord[])      private _claimRecords;
    mapping(address => LPEventRecord[])    private _lpEventRecords;

    // Unified TWAP storage for all tokens (platform token uses platformToken as key)
    mapping(address => TwapObs) private _tokenTwapObs0;
    mapping(address => TwapObs) private _tokenTwapObs1;
    mapping(address => uint256) private _tokenTwapPrice;
    mapping(address => uint256) private _tokenTwapLastUpdated;
    mapping(address => bool)    private _tokenTwapReady;

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
    event TWAPUpdated(uint256 price, uint256 timestamp);

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

    constructor(address _router, address _factory, address _weth, address _platformToken) {
        owner = msg.sender;
        users[owner].userAddress = owner;
        users[owner].isRegistered = true;
        users[owner].registeredAt = block.timestamp;
        allRegisteredUsers.push(owner);
        UNISWAP_ROUTER  = _router;
        UNISWAP_FACTORY = _factory;
        WETH            = _weth;
        platformToken   = _platformToken;
        _initStakingRates();
        _initPackages();
    }

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
            2500, 5000, 10000, 25000,
            50000, 100000, 250000, 500000
        ];
        for (uint256 i = 0; i < 14; ) {
            validPackageAmounts[usdtAmounts[i] * 1e18 / USDT_PER_ETH] = true;
            unchecked { i++; }
        }
    }

    function setValidPackage(uint256 ethWei, bool valid) external onlyOwner {
        validPackageAmounts[ethWei] = valid;
    }

    function _getRewardRatePPM(uint256 ethInvestedWei, uint256 durationDays, uint256 streakLevel) internal view returns (uint256) {
        if (ethInvestedWei * USDT_PER_ETH / 1e18 < 100) return 0;
        uint256 sIdx = streakLevel > 3 ? 3 : streakLevel;
        return stakingRates
            [LiquidityMath.getDurationIndex(stakingDurations, durationDays)]
            [LiquidityMath.getTierIndex(investmentTiers, ethInvestedWei)]
            [sIdx];
    }

    function register(address _referrer) external notRegistered {
        if (_referrer == msg.sender) revert CannotReferSelf();
        if (!users[_referrer].isRegistered) revert ReferrerNotRegistered();

        User storage user = users[msg.sender];
        user.userAddress = msg.sender;
        user.referrer = _referrer;
        user.isRegistered = true;
        user.registeredAt = block.timestamp;

        users[_referrer].referrals.push(msg.sender);

        totalRegisteredUsers++;
        allRegisteredUsers.push(msg.sender);
        emit UserRegistered(msg.sender, _referrer);
    }

    function seedPool(address _token, uint256 _tokenAmount) external payable onlyOwner nonReentrant {
        if (msg.value == 0) revert MustSendETH();
        if (_tokenAmount == 0) revert MustSpecifyTokenAmount();
        if (IERC20(_token).balanceOf(address(this)) < _tokenAmount) revert InsufficientContractTokenBalance();

        IERC20(_token).approve(UNISWAP_ROUTER, _tokenAmount);

        (,, uint256 lpReceived) = IUniswapV2Router02(UNISWAP_ROUTER).addLiquidityETH{value: msg.value}(
            _token,
            _tokenAmount,
            0,
            0,
            owner,
            block.timestamp + 300
        );

        IERC20(_token).approve(UNISWAP_ROUTER, 0);

        // Capture on-chain price snapshot for frontend chart
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

        uint256 remaining = address(this).balance;
        if (remaining > 0) {
            (bool ok,) = payable(owner).call{value: remaining}("");
            if (!ok) revert ETHReturnFailed();
        }

        emit PoolSeeded(_token, msg.value, _tokenAmount, lpReceived);
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


    function invest(address _token) external payable onlyRegistered nonReentrant {
        if (!validPackageAmounts[msg.value]) revert InvalidPackageAmount();
        if (tokens[_token].tokenAddress == address(0)) revert TokenNotRegistered();
        if (tokens[_token].removed) revert TokenDelisted();
        if (bytes(tokens[_token].inProgressLabel).length != 0) revert TokenInProgress();
        if (IERC20(_token).balanceOf(address(this)) == 0) revert InsufficientContractTokenBalance();

        updateTWAP();
        _updateTokenTWAP(_token);

        // Require a valid, fresh per-token TWAP before any swap so that the
        // swapAmountOutMin is anchored to the time-weighted price, not the
        // manipulatable spot price (sandwich protection).
        if (!_tokenTwapReady[_token]) revert PriceUnavailable();
        if (block.timestamp - _tokenTwapLastUpdated[_token] > TWAP_MAX_STALE) revert TokenTWAPStale();

        uint256 T   = msg.value;
        uint256 A   = T / 2;
        uint256 B   = T - A;
        uint256 A60 = (A * 60) / 100;
        uint256 A40 = A - A60;

        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(_token, WETH);
        if (pair == address(0)) revert PoolNotFound();

        uint256 platformBuyTokens;
        uint256 swapAmountOutMin;
        {
            (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
            address t0 = IUniswapV2Pair(pair).token0();
            uint256 resToken = t0 == _token ? uint256(r0) : uint256(r1);
            uint256 resETH   = t0 == _token ? uint256(r1) : uint256(r0);
            if (resETH == 0) revert PriceUnavailable();

            // Spot-based amounts: exact AMM formula guarantees the swap succeeds
            // regardless of how far spot has drifted from TWAP over time.
            uint256 spotExpected;
            (platformBuyTokens, spotExpected) = LiquidityMath.calcInvestAmounts(
                A60, A40, resToken, resETH, 0
            );

            // Sandwich guard: reject if spot output is more than TWAP_GUARD_BPS below
            // the TWAP-derived expectation.  Legitimate long-term drift stays within
            // this window; a same-block front-run moves it well beyond.
            uint256 twapFloor = A60 * 1e18 / _tokenTwapPrice[_token]
                                * (10000 - TWAP_GUARD_BPS) / 10000;
            if (spotExpected < twapFloor) revert PriceDeviationTooHigh();

            // Execution slippage: 2 % below the live spot output.
            swapAmountOutMin = spotExpected * (10000 - MAX_SLIPPAGE_BPS) / 10000;
        }

        if (IERC20(_token).balanceOf(address(this)) < platformBuyTokens) revert InsufficientContractTokenBalance();

        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = _token;

        uint256 balanceBefore = IERC20(_token).balanceOf(address(this));

        IUniswapV2Router02(UNISWAP_ROUTER).swapExactETHForTokens{value: A60}(
            swapAmountOutMin, path, address(this), block.timestamp + 300
        );

        uint256 poolBuyTokens = IERC20(_token).balanceOf(address(this)) - balanceBefore;
        uint256 totalTokens   = poolBuyTokens + platformBuyTokens;

        if (IERC20(_token).balanceOf(address(this)) < totalTokens) revert InsufficientContractTokenBalance();

        IERC20(_token).approve(UNISWAP_ROUTER, totalTokens);

        (,, uint256 lpReceived) = IUniswapV2Router02(UNISWAP_ROUTER).addLiquidityETH{value: B}(
            _token,
            totalTokens,
            totalTokens * (10000 - MAX_SLIPPAGE_BPS) / 10000,
            B           * (10000 - MAX_SLIPPAGE_BPS) / 10000,
            address(this),
            block.timestamp + 300
        );

        IERC20(_token).approve(UNISWAP_ROUTER, 0);

        if (lpReceived == 0) revert NoLPTokens();

        // Capture on-chain trade and price snapshots for frontend
        {
            (uint112 pr0, uint112 pr1,) = IUniswapV2Pair(pair).getReserves();
            address pt0 = IUniswapV2Pair(pair).token0();
            _tradeHistory[_token].push(TradeSnap({
                ts:     uint64(block.timestamp),
                isBuy:  true,
                ethAmt: uint128(A60),
                tokAmt: uint128(poolBuyTokens)
            }));
            _priceHistory[_token].push(PriceSnap({
                ts:       uint64(block.timestamp),
                resETH:   uint112(pt0 == _token ? pr1 : pr0),
                resToken: uint112(pt0 == _token ? pr0 : pr1)
            }));
        }

        uint256 surplus = address(this).balance > A40 ? address(this).balance - A40 : 0;
        if (surplus > 0) {
            (bool ok,) = payable(owner).call{value: surplus}("");
            if (!ok) revert SurplusTransferFailed();
        }

        userLPLocks[msg.sender].push(LPLock({
            token:              _token,
            claimed:            false,
            removed:            false,
            lpAmount:           lpReceived,
            unlockTime:         block.timestamp + LP_LOCK_DURATION,
            ethInvested:        T,
            lockedAt:           block.timestamp,
            rewardClaimedETH:   0,
            tokensAccumulated:  0,
            totalTokensClaimed: 0,
            rewardRatePPM:      _getRewardRatePPM(T, 90, 0),
            restakeCounts:      [uint8(0), 0, 0, 0, 0, 0],
            streakBaseEth:      T,
            commissionsCapUsed: 0
        }));

        _investRecords[msg.sender].push(InvestRecord({
            token:         _token,
            ts:            uint64(block.timestamp),
            ethAmount:     uint128(T),
            lpTokens:      uint128(lpReceived),
            poolBuyTokens: uint128(poolBuyTokens),
            totalTokens:   uint128(totalTokens)
        }));

        bool wasQualifying = _qualifies(msg.sender);
        userTotalInvested[msg.sender] += T;
        totalEthInvested += T;
        if (!wasQualifying && _qualifies(msg.sender)) {
            address ref = users[msg.sender].referrer;
            if (ref != address(0)) activeReferralCount[ref]++;
        }

        distributeReferralCommissions(msg.sender, A40, _token);

        emit Invested(msg.sender, _token, T, lpReceived);
    }

    function claimLP(uint256 _lockIndex) external nonReentrant {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        if (lock.claimed) revert AlreadyClaimed();
        if (block.timestamp < lock.unlockTime) revert LPStillLocked();
        if (lock.lpAmount == 0) revert NoLPTokens();

        lock.claimed = true;

        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(lock.token, WETH);
        if (pair == address(0)) revert PoolNotFound();
        if (!IERC20(pair).transfer(msg.sender, lock.lpAmount)) revert LPTransferFailed();

        _lpEventRecords[msg.sender].push(LPEventRecord({
            token:       lock.token,
            ts:          uint64(block.timestamp),
            isClaim:     true,
            lpAmount:    uint128(lock.lpAmount),
            ethReturned: 0
        }));

        emit LPClaimed(msg.sender, lock.token, lock.lpAmount);
    }

    // ── Shared LP-removal logic ──────────────────────────────────────────────
    // direct=false → removeLP    (user already claimed LP to wallet; pull it back)
    // direct=true  → removeLPDirect (LP still held by contract; remove without claim step)
    function _removeLPCore(uint256 _lockIndex, bool direct) internal {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        if (direct) {
            if (lock.removed) revert AlreadyRemoved();
            if (lock.claimed) revert LPAlreadyClaimed();
            if (block.timestamp < lock.unlockTime) revert LPStillLocked();
        } else {
            if (!lock.claimed) revert ClaimLPFirst();
        }
        if (lock.lpAmount == 0) revert NoLPTokens();

        _settleStakingReward(msg.sender, _lockIndex);

        uint256 lpAmount    = lock.lpAmount;
        uint256 ethInvested = lock.ethInvested;
        lock.lpAmount = 0;
        if (direct) lock.claimed = true;
        lock.removed = true;

        bool wasQualifying = _qualifies(msg.sender);
        if (userTotalInvested[msg.sender] >= ethInvested) {
            userTotalInvested[msg.sender] -= ethInvested;
            if (wasQualifying && !_qualifies(msg.sender)) {
                address ref = users[msg.sender].referrer;
                if (ref != address(0)) activeReferralCount[ref]--;
            }
        }

        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(lock.token, WETH);
        if (pair == address(0)) revert PoolNotFound();

        if (!direct) {
            if (!IERC20(pair).transferFrom(msg.sender, address(this), lpAmount)) revert LPPullFailed();
        }
        IERC20(pair).approve(UNISWAP_ROUTER, lpAmount);

        uint256 minTokenOut;
        uint256 minETHOut;
        {
            IUniswapV2Pair p = IUniswapV2Pair(pair);
            (uint112 r0, uint112 r1,) = p.getReserves();
            address t0     = p.token0();
            uint256 resTok = t0 == lock.token ? uint256(r0) : uint256(r1);
            uint256 resETH = t0 == lock.token ? uint256(r1) : uint256(r0);
            uint256 supply = p.totalSupply();
            (minTokenOut, minETHOut) = LiquidityMath.calcRemoveLPAmounts(resTok, resETH, supply, lpAmount, MAX_SLIPPAGE_BPS);
        }

        (uint256 tokensReturned, uint256 ethReturned) = IUniswapV2Router02(UNISWAP_ROUTER)
            .removeLiquidityETH(lock.token, lpAmount, minTokenOut, minETHOut, address(this), block.timestamp + 300);

        if (tokensReturned > 0) {
            if (!IERC20(lock.token).transfer(msg.sender, tokensReturned)) revert TokenReturnFailed();
        }
        if (ethReturned > 0) {
            (bool ok,) = payable(msg.sender).call{value: ethReturned}("");
            if (!ok) revert ETHReturnFailed();
        }

        _lpEventRecords[msg.sender].push(LPEventRecord({
            token:       lock.token,
            ts:          uint64(block.timestamp),
            isClaim:     false,
            lpAmount:    uint128(lpAmount),
            ethReturned: uint128(ethReturned)
        }));

        emit LPRemoved(msg.sender, lock.token, lpAmount, ethReturned, tokensReturned);
    }

    function removeLP(uint256 _lockIndex) external nonReentrant {
        _removeLPCore(_lockIndex, false);
    }

    function removeLPDirect(uint256 _lockIndex) external nonReentrant {
        _removeLPCore(_lockIndex, true);
    }

    function restakeLP(uint256 _lockIndex, uint256 _durationDays) external nonReentrant {
        if (
            _durationDays != 7 && _durationDays != 30 && _durationDays != 60 &&
            _durationDays != 90 && _durationDays != 180 && _durationDays != 360
        ) revert InvalidDuration();
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        if (lock.claimed) revert LPAlreadyClaimed();
        if (lock.removed) revert AlreadyRemoved();
        if (block.timestamp < lock.unlockTime) revert LPStillLocked();
        if (lock.lpAmount == 0) revert NoLPTokens();

        updateTWAP();
        // getTWAPPrice() reverts if stale — prevents silent reward loss when rewardClaimedETH is reset below
        uint256 price = getTWAPPrice();
        uint256 pendingETH = LiquidityMath.calcPendingRewardETH(
            lock.rewardRatePPM, lock.ethInvested, lock.lockedAt, lock.unlockTime, lock.rewardClaimedETH
        );
        if (pendingETH > 0) lock.tokensAccumulated += (pendingETH * 1e18) / price;

        uint256 dIdx = LiquidityMath.getDurationIndex(stakingDurations, _durationDays);

        if (lock.streakBaseEth != 0 && lock.ethInvested != lock.streakBaseEth) {
            for (uint256 i = 0; i < 6; ) {
                lock.restakeCounts[i] = 0;
                unchecked { i++; }
            }
            lock.streakBaseEth = lock.ethInvested;
        }

        uint256 prevDurDays = lock.unlockTime > lock.lockedAt ? (lock.unlockTime - lock.lockedAt) / 1 days : 90;
        uint256 prevDIdx    = LiquidityMath.getDurationIndex(stakingDurations, prevDurDays);
        uint256 sIdx;
        if (dIdx == prevDIdx) {
            lock.restakeCounts[dIdx] += 1;
            uint256 cnt = lock.restakeCounts[dIdx];
            sIdx = cnt > 3 ? 3 : cnt;
        } else {
            lock.restakeCounts[dIdx] = 0;
            sIdx = 0;
        }
        lock.lockedAt         = block.timestamp;
        lock.unlockTime       = block.timestamp + _durationDays * 1 days;
        lock.rewardClaimedETH = 0;
        lock.rewardRatePPM    = _getRewardRatePPM(lock.ethInvested, _durationDays, sIdx);

        emit LPRestaked(msg.sender, lock.token, lock.lpAmount, lock.unlockTime, _durationDays);
    }


    function _getAvailableCapForToken(address _user, address _token) internal view returns (uint256 available) {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        for (uint256 j = 0; j < len; ) {
            LPLock storage l = locks[j];
            if (l.removed)                        { unchecked { j++; } continue; }
            if (l.token != _token)                { unchecked { j++; } continue; }
            if (block.timestamp >= l.unlockTime)  { unchecked { j++; } continue; }
            uint256 cap = l.ethInvested * 5;
            if (l.commissionsCapUsed < cap) available += cap - l.commissionsCapUsed;
            unchecked { j++; }
        }
    }

    function _chargeCapForToken(address _user, address _token, uint256 _amount) internal {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        uint256 remaining = _amount;
        for (uint256 j = 0; j < len && remaining > 0; ) {
            LPLock storage l = locks[j];
            if (l.removed)                        { unchecked { j++; } continue; }
            if (l.token != _token)                { unchecked { j++; } continue; }
            if (block.timestamp >= l.unlockTime)  { unchecked { j++; } continue; }
            uint256 cap = l.ethInvested * 5;
            if (l.commissionsCapUsed >= cap)      { unchecked { j++; } continue; }
            uint256 space    = cap - l.commissionsCapUsed;
            uint256 toCharge = remaining < space ? remaining : space;
            l.commissionsCapUsed += toCharge;
            remaining -= toCharge;
            unchecked { j++; }
        }
    }

    function getActiveDirectReferralCount(address _user) public view returns (uint256) {
        return activeReferralCount[_user];
    }

    function _qualifies(address _user) internal view returns (bool) {
        uint256 total = userTotalInvested[_user];
        return total > 0 && (minDirectReferralInvestment == 0 || total >= minDirectReferralInvestment);
    }

    function setMinDirectReferralInvestment(uint256 _amount) external onlyOwner {
        minDirectReferralInvestment = _amount;
    }

    function _payCommission(address recipient, address from, uint256 amount, uint256 level) internal {
        uint256 toRecipient = amount;
        if (recipient != owner) {
            uint256 deployerCut = amount * 5 / 100;
            toRecipient = amount - deployerCut;
            if (deployerCut > 0) {
                (bool ok,) = payable(owner).call{value: deployerCut}("");
                if (!ok) revert CommissionTransferFailed();
            }
        }
        (bool success,) = payable(recipient).call{value: toRecipient}("");
        if (!success) {
            (bool ok,) = payable(owner).call{value: toRecipient}("");
            if (!ok) revert CommissionTransferFailed();
        } else {
            // Only credit the recipient when they actually received the funds
            userCommissionsEarned[recipient] += toRecipient;
            _commissionRecords[recipient].push(CommissionRecord({
                from:   from,
                ts:     uint64(block.timestamp),
                level:  uint8(level),
                amount: uint128(toRecipient)
            }));
        }
        emit CommissionPaid(recipient, from, toRecipient, level);
    }

    function distributeReferralCommissions(address _from, uint256 _amount, address _token) internal {
        address current = users[_from].referrer;

        for (uint256 i = 0; i < 10; ) {
            uint256 toDistribute = (_amount * referralCommissionRates[i]) / 10000;
            if (toDistribute == 0) { unchecked { i++; } continue; }

            address search = current;

            while (toDistribute > 0) {
                uint256 cachedCap = 0;
                uint256 hops = 0;
                while (search != address(0) && users[search].isRegistered) {
                    if (hops >= MAX_REFERRAL_HOPS) { search = address(0); break; }
                    unchecked { hops++; }
                    bool enoughReferrals = activeReferralCount[search] > i;
                    if (!enoughReferrals) { search = users[search].referrer; continue; }
                    if (search == owner) break;
                    cachedCap = _getAvailableCapForToken(search, _token);
                    if (cachedCap > 0) break;
                    search = users[search].referrer;
                }

                if (search == address(0) || !users[search].isRegistered) {
                    _payCommission(owner, _from, toDistribute, i + 1);
                    current = address(0);
                    break;
                }

                uint256 toPay;
                if (search == owner) {
                    toPay = toDistribute;
                } else {
                    toPay = toDistribute < cachedCap ? toDistribute : cachedCap;
                    _chargeCapForToken(search, _token, toPay);
                }

                _payCommission(search, _from, toPay, i + 1);
                toDistribute -= toPay;

                current = users[search].referrer;
                search  = current;
            }
            unchecked { i++; }
        }
    }

    function _settleStakingReward(address _user, uint256 _lockIndex) internal {
        LPLock storage lock = userLPLocks[_user][_lockIndex];
        if (lock.removed) return;

        uint256 pendingETH = LiquidityMath.calcPendingRewardETH(
            lock.rewardRatePPM, lock.ethInvested, lock.lockedAt, lock.unlockTime, lock.rewardClaimedETH
        );
        uint256 carry = lock.tokensAccumulated;

        // Always advance rewardClaimedETH and zero carry so this period cannot
        // be double-counted even if we can't transfer tokens right now.
        lock.rewardClaimedETH += pendingETH;
        lock.tokensAccumulated = 0;

        uint256 price     = _twapTokenPrice();
        uint256 newTokens = price > 0 ? (pendingETH * 1e18) / price : 0;
        uint256 total     = newTokens + carry;

        if (total == 0) return;
        uint256 available = IERC20(platformToken).balanceOf(address(this));
        if (available < total) return;

        lock.totalTokensClaimed += total;
        if (!IERC20(platformToken).transfer(_user, total)) revert StakingRewardTransferFailed();
        emit StakingRewardClaimed(_user, total, pendingETH);
    }

    function updateTWAP() public {
        uint256 priceBefore = _tokenTwapPrice[platformToken];
        _updateTokenTWAP(platformToken);
        uint256 priceAfter = _tokenTwapPrice[platformToken];
        if (priceAfter > 0 && priceAfter != priceBefore) {
            emit TWAPUpdated(priceAfter, block.timestamp);
        }
    }

    function getTWAPPrice() public view returns (uint256) {
        if (!_tokenTwapReady[platformToken]) revert PriceUnavailable();
        if (block.timestamp - _tokenTwapLastUpdated[platformToken] > TWAP_MAX_STALE) revert TWAPStale();
        return _tokenTwapPrice[platformToken];
    }

    function _twapTokenPrice() private view returns (uint256) {
        if (!_tokenTwapReady[platformToken]) return 0;
        if (block.timestamp - _tokenTwapLastUpdated[platformToken] > TWAP_MAX_STALE) return 0;
        return _tokenTwapPrice[platformToken];
    }

    function _updateTokenTWAP(address _token) internal {
        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(_token, WETH);
        if (pair == address(0)) return;

        (uint256 cumulative, uint32 ts) = LiquidityMath.pairCumulative(pair, _token);

        if (_tokenTwapLastUpdated[_token] == 0) {
            _tokenTwapObs0[_token] = TwapObs({ priceCumulative: cumulative, timestamp: ts });
            _tokenTwapObs1[_token] = TwapObs({ priceCumulative: cumulative, timestamp: ts });
            _tokenTwapLastUpdated[_token] = block.timestamp;
            return;
        }

        unchecked {
            uint32 elapsedSinceLast = ts - _tokenTwapObs1[_token].timestamp;
            if (elapsedSinceLast == 0) return;
            if (elapsedSinceLast >= uint32(TWAP_PERIOD)) {
                _tokenTwapObs0[_token] = _tokenTwapObs1[_token];
            }
        }

        _tokenTwapObs1[_token] = TwapObs({ priceCumulative: cumulative, timestamp: ts });
        _tokenTwapLastUpdated[_token] = block.timestamp;

        unchecked {
            uint32 span = _tokenTwapObs1[_token].timestamp - _tokenTwapObs0[_token].timestamp;
            if (span >= uint32(TWAP_PERIOD)) {
                uint256 cumDiff = _tokenTwapObs1[_token].priceCumulative - _tokenTwapObs0[_token].priceCumulative;
                uint256 rawAvg  = cumDiff / uint256(span);
                _tokenTwapPrice[_token] = (rawAvg * 1e18) >> 112;
                _tokenTwapReady[_token] = true;
            }
        }
    }

    function updateTokenTWAP(address _token) public {
        _updateTokenTWAP(_token);
    }

    function getStakingReward(address _user) external view returns (
        uint256 totalAccumulated,
        uint256 previewNewTokens,
        uint256 lifetimeClaimed
    ) {
        uint256 price = LiquidityMath.tokenPriceInETH(UNISWAP_FACTORY, platformToken, WETH);
        LPLock[] memory locks = userLPLocks[_user];
        return LiquidityViewLib.computeStakingReward(locks, price);
    }

    // Calculates tokens due, updates lock state, returns amounts for the caller to transfer.
    function _computeLockReward(LPLock storage lock, uint256 price)
        internal returns (uint256 lockTokens, uint256 pendingETH)
    {
        pendingETH = LiquidityMath.calcPendingRewardETH(
            lock.rewardRatePPM, lock.ethInvested, lock.lockedAt, lock.unlockTime, lock.rewardClaimedETH
        );
        uint256 carry = lock.tokensAccumulated;
        lockTokens = (pendingETH * 1e18) / price + carry;
        if (lockTokens > 0) {
            lock.rewardClaimedETH  += pendingETH;
            lock.tokensAccumulated  = 0;
            lock.totalTokensClaimed += lockTokens;
        }
    }

    function claimStakingReward() external nonReentrant onlyRegistered {
        updateTWAP();
        uint256 price = _twapTokenPrice();
        if (price == 0) revert PriceUnavailable();
        LPLock[] storage locks = userLPLocks[msg.sender];
        uint256 len = locks.length;
        uint256 totalTokens;
        uint256 totalPendingETH;
        for (uint256 i = 0; i < len; ) {
            (uint256 lockTokens, uint256 pendingETH) = _computeLockReward(locks[i], price);
            totalTokens     += lockTokens;
            totalPendingETH += pendingETH;
            unchecked { i++; }
        }
        if (totalTokens == 0) revert NothingToClaim();
        if (IERC20(platformToken).balanceOf(address(this)) < totalTokens) revert InsufficientTokenBalance();
        totalStakingRewardsPaidETH += totalPendingETH;
        if (!IERC20(platformToken).transfer(msg.sender, totalTokens)) revert TokenTransferFailed();
        _claimRecords[msg.sender].push(ClaimRecord({
            tokensAmount:  uint128(totalTokens),
            ethEquivalent: uint128(totalPendingETH),
            ts:            uint64(block.timestamp)
        }));
        emit StakingRewardClaimed(msg.sender, totalTokens, totalPendingETH);
    }

    function claimStakingRewardForLock(uint256 _lockIndex) external nonReentrant onlyRegistered {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        if (lock.removed) revert AlreadyRemoved();
        updateTWAP();
        uint256 price = _twapTokenPrice();
        if (price == 0) revert PriceUnavailable();
        (uint256 tokensToSend, uint256 pendingETH) = _computeLockReward(lock, price);
        if (tokensToSend == 0) revert NothingToClaim();
        if (IERC20(platformToken).balanceOf(address(this)) < tokensToSend) revert InsufficientTokenBalance();
        totalStakingRewardsPaidETH += pendingETH;
        if (!IERC20(platformToken).transfer(msg.sender, tokensToSend)) revert TokenTransferFailed();
        _claimRecords[msg.sender].push(ClaimRecord({
            tokensAmount:  uint128(tokensToSend),
            ethEquivalent: uint128(pendingETH),
            ts:            uint64(block.timestamp)
        }));
        emit StakingRewardClaimed(msg.sender, tokensToSend, pendingETH);
    }

    function getPlatformStats() external view returns (
        uint256 _totalUsers,
        uint256 _totalEthInvested,
        uint256 _totalStakingRewardsPaidETH
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

    // Batch getter: returns stats for all direct referrals of `user` in one call.
    // Replaces N×3 individual calls (userTotalInvested, getReferrals, getUserCommissionStats)
    // with a single view call, dramatically reducing RPC pressure on the dashboard.
    function getDirectRefsInfo(address user) external view returns (DirectRefInfo[] memory result) {
        address[] memory refs = users[user].referrals;
        uint256 len = refs.length;
        result = new DirectRefInfo[](len);
        for (uint256 i = 0; i < len; ) {
            address ref = refs[i];
            result[i].addr = ref;
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

    function getReferrer(address _user) external view returns (address) {
        return users[_user].referrer;
    }

    function getUserCommissionStats(address _user) external view returns (
        uint256 earned,
        uint256 /*missed*/,
        uint256 totalCap,
        uint256 remainingCap,
        uint256 active
    ) {
        LPLock[] memory locks = userLPLocks[_user];
        return LiquidityViewLib.computeCommissionStats(
            locks,
            userCommissionsEarned[_user],
            userTotalInvested[_user],
            block.timestamp
        );
    }

    function getWealthParams(address _user) external view returns (WealthParams memory p) {
        LPLock[] memory locks = userLPLocks[_user];
        return LiquidityViewLib.computeWealthParams(
            locks,
            userCommissionsEarned[_user],
            LiquidityMath.tokenPriceInETH(UNISWAP_FACTORY, platformToken, WETH),
            LP_LOCK_DURATION,
            UNISWAP_FACTORY,
            WETH
        );
    }

    function getContractTokenBalance(address _token) external view returns (uint256) {
        return IERC20(_token).balanceOf(address(this));
    }

    function getStakingRatesForAmount(uint256 ethInvestedWei) external view returns (
        uint256[6] memory durSecs,
        uint256[6] memory ratesPPM
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

    function setStakingRates(uint256 durationIdx, uint256 tierIdx, uint256 streakLevel, uint256 rate) external onlyOwner {
        if (durationIdx >= 6) revert InvalidDurationIndex();
        if (tierIdx >= 12) revert InvalidTierIndex();
        if (streakLevel >= 4) revert InvalidStreakLevel();
        stakingRates[durationIdx][tierIdx][streakLevel] = rate;
    }

    function setRefLabel(address _ref, bytes calldata _label) external {
        _refLabels[msg.sender][_ref] = _label;
    }

    function getRefLabel(address _owner, address _ref) external view returns (bytes memory) {
        return _refLabels[_owner][_ref];
    }

    function withdrawETH(uint256 amount) external onlyOwner nonReentrant {
        uint256 bal = address(this).balance;
        uint256 toSend = amount == 0 ? bal : (amount > bal ? bal : amount);
        if (toSend == 0) revert NoETHToWithdraw();
        (bool ok,) = payable(owner).call{value: toSend}("");
        if (!ok) revert ETHWithdrawFailed();
    }

    function withdrawToken(address _token, uint256 amount) external onlyOwner nonReentrant {
        uint256 bal = IERC20(_token).balanceOf(address(this));
        uint256 toSend = amount == 0 ? bal : (amount > bal ? bal : amount);
        if (toSend == 0) revert NoTokensToWithdraw();
        if (!IERC20(_token).transfer(owner, toSend)) revert TokenWithdrawFailed();
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

    function getInvestRecords(address _user) external view returns (InvestRecord[] memory) {
        return _investRecords[_user];
    }

    function getClaimRecords(address _user) external view returns (ClaimRecord[] memory) {
        return _claimRecords[_user];
    }

    function getLPEventRecords(address _user) external view returns (LPEventRecord[] memory) {
        return _lpEventRecords[_user];
    }

    receive() external payable {}
}
