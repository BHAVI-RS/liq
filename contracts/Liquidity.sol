// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

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

    struct User {
        address userAddress;
        address referrer;
        address[] referrals;
        bool isRegistered;
        uint256 registeredAt;
    }

    struct Token {
        address tokenAddress;
        string name;
        string symbol;
        uint256 addedAt;
        bool removed;
        string inProgressLabel;
    }

    // address (20 bytes) + claimed (1 byte) + removed (1 byte) packed into slot 0 — saves 2 slots vs original.
    // uint8[6] restakeCounts packs all 6 counters into 1 slot — saves 5 slots vs uint256[6].
    struct LPLock {
        address token;              // slot 0: 20 bytes
        bool claimed;               //         +1 byte
        bool removed;               //         +1 byte  (22 bytes total, slot 0)
        uint256 lpAmount;           // slot 1
        uint256 unlockTime;         // slot 2
        uint256 ethInvested;        // slot 3
        uint256 lockedAt;           // slot 4
        uint256 rewardClaimedETH;   // slot 5
        uint256 tokensAccumulated;  // slot 6
        uint256 totalTokensClaimed; // slot 7
        uint256 rewardRatePPM;      // slot 8
        uint8[6] restakeCounts;     // slot 9  (6 bytes — was 6 full slots)
        uint256 streakBaseEth;      // slot 10
        uint256 commissionsCapUsed; // slot 11
    }

    mapping(address => User) public users;
    mapping(address => Token) public tokens;
    mapping(address => uint256) public userTotalInvested;
    mapping(address => LPLock[]) public userLPLocks;
    mapping(address => uint256) public userCommissionsEarned;
    mapping(address => mapping(address => bytes)) private _refLabels;

    uint256 public totalRegisteredUsers;
    uint256 public totalEthInvested;
    uint256 public totalStakingRewardsPaidETH;

    address[] public registeredTokens;
    address public featuredToken;
    address public owner;

    address public immutable UNISWAP_ROUTER;
    address public immutable UNISWAP_FACTORY;
    address public immutable WETH;
    address public immutable platformToken;

    // 10 x uint16 = 20 bytes = 1 storage slot  (was 10 slots as uint256[10])
    uint16[10] public referralCommissionRates = [5000, 2500, 1000, 300, 250, 225, 200, 200, 175, 150];
    uint256 public minDirectReferralInvestment;

    uint256 public constant LP_LOCK_DURATION = 90;
    uint256 public constant USDT_PER_ETH     = 1000;

    // 12 x uint32 = 48 bytes = 2 storage slots  (was 12 slots as uint256[12])
    uint32[12] public investmentTiers;
    // 6 x uint16 = 12 bytes = 1 storage slot   (was 6 slots as uint256[6])
    uint16[6]  public stakingDurations;
    // Flat array: slot lookup via arithmetic, not 3 nested keccak hashes  (was 3D mapping)
    uint256[4][12][6] public stakingRates;

    mapping(uint256 => bool) public validPackageAmounts;

    bool private _locked;

    event UserRegistered(address indexed user, address indexed referrer);
    event CommissionPaid(address indexed recipient, address indexed from, uint256 amount, uint256 level);
    event TokenRegistered(address indexed tokenAddress, string name, string symbol);
    event TokenRemoved(address indexed tokenAddress);
    event TokenFeatured(address indexed tokenAddress);
    event TokenInProgressSet(address indexed tokenAddress, string label);
    event Invested(address indexed user, address indexed token, uint256 ethAmount, uint256 lpTokens);
    event LPClaimed(address indexed user, address indexed token, uint256 lpAmount);
    event LPRemoved(address indexed user, address indexed token, uint256 lpAmount, uint256 ethReturned, uint256 tokensReturned);
    event PoolSeeded(address indexed token, uint256 ethAmount, uint256 tokenAmount, uint256 lpReceived);
    event LPRestaked(address indexed user, address indexed token, uint256 lpAmount, uint256 newUnlockTime, uint256 durationDays);
    event StakingRewardClaimed(address indexed user, uint256 tokensAmount, uint256 ethEquivalent);

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

    function _getTierIndex(uint256 ethInvestedWei) internal view returns (uint256 best) {
        uint256 usdtAmt = ethInvestedWei * USDT_PER_ETH / 1e18;
        uint256 t0 = investmentTiers[0];
        uint256 bestDiff = usdtAmt >= t0 ? usdtAmt - t0 : t0 - usdtAmt;
        for (uint256 i = 1; i < 12; ) {
            uint256 ti = investmentTiers[i];
            uint256 d  = usdtAmt >= ti ? usdtAmt - ti : ti - usdtAmt;
            if (d < bestDiff) { bestDiff = d; best = i; }
            unchecked { i++; }
        }
    }

    function _getDurationIndex(uint256 durationDays) internal view returns (uint256 best) {
        uint256 s0 = stakingDurations[0];
        uint256 bestDiff = durationDays >= s0 ? durationDays - s0 : s0 - durationDays;
        for (uint256 i = 1; i < 6; ) {
            uint256 si = stakingDurations[i];
            uint256 d  = durationDays >= si ? durationDays - si : si - durationDays;
            if (d < bestDiff) { bestDiff = d; best = i; }
            unchecked { i++; }
        }
    }

    function _getRewardRatePPM(uint256 ethInvestedWei, uint256 durationDays, uint256 streakLevel) internal view returns (uint256) {
        if (ethInvestedWei * USDT_PER_ETH / 1e18 < 100) return 0;
        uint256 sIdx = streakLevel > 3 ? 3 : streakLevel;
        return stakingRates[_getDurationIndex(durationDays)][_getTierIndex(ethInvestedWei)][sIdx];
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

    function invest(address _token) external payable onlyRegistered nonReentrant {
        if (!validPackageAmounts[msg.value]) revert InvalidPackageAmount();
        if (tokens[_token].tokenAddress == address(0)) revert TokenNotRegistered();
        if (tokens[_token].removed) revert TokenDelisted();
        if (bytes(tokens[_token].inProgressLabel).length != 0) revert TokenInProgress();
        if (IERC20(_token).balanceOf(address(this)) == 0) revert InsufficientContractTokenBalance();

        uint256 T   = msg.value;
        uint256 A   = T / 2;
        uint256 B   = T - A;
        uint256 A60 = (A * 60) / 100;
        uint256 A40 = A - A60;

        // ── Pool buy: A60 ETH → _token via Uniswap ───────────────────────
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = _token;

        uint256 balanceBefore = IERC20(_token).balanceOf(address(this));

        IUniswapV2Router02(UNISWAP_ROUTER).swapExactETHForTokens{value: A60}(
            0, path, address(this), block.timestamp + 300
        );

        uint256 poolBuyTokens = IERC20(_token).balanceOf(address(this)) - balanceBefore;

        // ── Platform buy: A40 ETH → _token from contract at post-pool-buy price ─
        // Read reserves after the pool buy so price reflects its impact.
        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(_token, WETH);
        if (pair == address(0)) revert PoolNotFound();

        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
        address t0 = IUniswapV2Pair(pair).token0();
        uint256 resToken = t0 == _token ? uint256(r0) : uint256(r1);
        uint256 resETH   = t0 == _token ? uint256(r1) : uint256(r0);
        if (resETH == 0) revert PriceUnavailable();

        // Tokens the contract sells to itself at current market rate for A40 ETH.
        // A40 ETH is retained by the contract and later distributed as referral commissions.
        uint256 platformBuyTokens = A40 * resToken / resETH;

        uint256 totalTokens = poolBuyTokens + platformBuyTokens;

        // Contract must hold enough reserve tokens to cover the platform buy portion.
        if (IERC20(_token).balanceOf(address(this)) < totalTokens) revert InsufficientContractTokenBalance();

        // ── Pair poolBuyTokens + platformBuyTokens with B ETH ────────────
        IERC20(_token).approve(UNISWAP_ROUTER, totalTokens);

        (,, uint256 lpReceived) = IUniswapV2Router02(UNISWAP_ROUTER).addLiquidityETH{value: B}(
            _token, totalTokens, 0, 0, address(this), block.timestamp + 300
        );

        IERC20(_token).approve(UNISWAP_ROUTER, 0);

        // Surplus ETH returned by addLiquidityETH goes to owner; A40 stays for commissions.
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

        userTotalInvested[msg.sender] += T;
        totalEthInvested += T;

        // A40 ETH (earned from platform buy) is distributed to eligible upline referrers.
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

        emit LPClaimed(msg.sender, lock.token, lock.lpAmount);
    }

    function removeLP(uint256 _lockIndex) external nonReentrant {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        if (!lock.claimed) revert ClaimLPFirst();
        if (lock.lpAmount == 0) revert NoLPTokens();

        _settleStakingReward(msg.sender, _lockIndex);

        uint256 lpAmount    = lock.lpAmount;
        uint256 ethInvested = lock.ethInvested;
        lock.lpAmount = 0;
        lock.removed  = true;

        if (userTotalInvested[msg.sender] >= ethInvested)
            userTotalInvested[msg.sender] -= ethInvested;

        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(lock.token, WETH);
        if (pair == address(0)) revert PoolNotFound();

        if (!IERC20(pair).transferFrom(msg.sender, address(this), lpAmount)) revert LPPullFailed();
        IERC20(pair).approve(UNISWAP_ROUTER, lpAmount);

        (uint256 tokensReturned, uint256 ethReturned) = IUniswapV2Router02(UNISWAP_ROUTER)
            .removeLiquidityETH(lock.token, lpAmount, 0, 0, address(this), block.timestamp + 300);

        if (tokensReturned > 0) {
            if (!IERC20(lock.token).transfer(msg.sender, tokensReturned)) revert TokenReturnFailed();
        }
        if (ethReturned > 0) {
            (bool ok,) = payable(msg.sender).call{value: ethReturned}("");
            if (!ok) revert ETHReturnFailed();
        }

        emit LPRemoved(msg.sender, lock.token, lpAmount, ethReturned, tokensReturned);
    }

    function removeLPDirect(uint256 _lockIndex) external nonReentrant {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        if (lock.removed) revert AlreadyRemoved();
        if (lock.claimed) revert LPAlreadyClaimed();
        if (block.timestamp < lock.unlockTime) revert LPStillLocked();
        if (lock.lpAmount == 0) revert NoLPTokens();

        _settleStakingReward(msg.sender, _lockIndex);

        uint256 lpAmount    = lock.lpAmount;
        uint256 ethInvested = lock.ethInvested;
        lock.lpAmount = 0;
        lock.claimed  = true;
        lock.removed  = true;

        if (userTotalInvested[msg.sender] >= ethInvested)
            userTotalInvested[msg.sender] -= ethInvested;

        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(lock.token, WETH);
        if (pair == address(0)) revert PoolNotFound();

        IERC20(pair).approve(UNISWAP_ROUTER, lpAmount);

        (uint256 tokensReturned, uint256 ethReturned) = IUniswapV2Router02(UNISWAP_ROUTER)
            .removeLiquidityETH(lock.token, lpAmount, 0, 0, address(this), block.timestamp + 300);

        if (tokensReturned > 0) {
            if (!IERC20(lock.token).transfer(msg.sender, tokensReturned)) revert TokenReturnFailed();
        }
        if (ethReturned > 0) {
            (bool ok,) = payable(msg.sender).call{value: ethReturned}("");
            if (!ok) revert ETHReturnFailed();
        }

        emit LPRemoved(msg.sender, lock.token, lpAmount, ethReturned, tokensReturned);
    }

    function restakeLP(uint256 _lockIndex, uint256 _durationSecs) external nonReentrant {
        if (
            _durationSecs != 7 && _durationSecs != 30 && _durationSecs != 60 &&
            _durationSecs != 90 && _durationSecs != 180 && _durationSecs != 360
        ) revert InvalidDuration();
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        if (lock.claimed) revert LPAlreadyClaimed();
        if (lock.removed) revert AlreadyRemoved();
        if (block.timestamp < lock.unlockTime) revert LPStillLocked();
        if (lock.lpAmount == 0) revert NoLPTokens();

        uint256 price = _tokenPriceInETH();
        if (price > 0) {
            uint256 pendingETH = _calcPendingRewardETH(lock);
            if (pendingETH > 0) lock.tokensAccumulated += (pendingETH * 1e18) / price;
        }

        uint256 dIdx = _getDurationIndex(_durationSecs);

        if (lock.streakBaseEth != 0 && lock.ethInvested != lock.streakBaseEth) {
            for (uint256 i = 0; i < 6; ) {
                lock.restakeCounts[i] = 0;
                unchecked { i++; }
            }
            lock.streakBaseEth = lock.ethInvested;
        }

        uint256 prevDurSecs = lock.unlockTime > lock.lockedAt ? lock.unlockTime - lock.lockedAt : LP_LOCK_DURATION;
        uint256 prevDIdx    = _getDurationIndex(prevDurSecs);
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
        lock.unlockTime       = block.timestamp + _durationSecs;
        lock.rewardClaimedETH = 0;
        lock.rewardRatePPM    = _getRewardRatePPM(lock.ethInvested, _durationSecs, sIdx);

        emit LPRestaked(msg.sender, lock.token, lock.lpAmount, lock.unlockTime, _durationSecs);
    }

    // O(1) single storage read replacing the original O(n locks) loop.
    // userTotalInvested tracks the same sum (incremented in invest, decremented in removeLP/removeLPDirect).
    function _hasActiveInvestment(address _user) internal view returns (bool) {
        uint256 total = userTotalInvested[_user];
        return total > 0 && (minDirectReferralInvestment == 0 || total >= minDirectReferralInvestment);
    }

    function getActiveDirectReferralCount(address _user) public view returns (uint256 count) {
        address[] storage refs = users[_user].referrals;
        uint256 len = refs.length;
        for (uint256 i = 0; i < len; ) {
            if (_hasActiveInvestment(refs[i])) count++;
            unchecked { i++; }
        }
    }

    function setMinDirectReferralInvestment(uint256 _amount) external onlyOwner {
        minDirectReferralInvestment = _amount;
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

    function _payCommission(address recipient, address from, uint256 amount, uint256 level) internal {
        userCommissionsEarned[recipient] += amount;
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert CommissionTransferFailed();
        emit CommissionPaid(recipient, from, amount, level);
    }

    function distributeReferralCommissions(address _from, uint256 _amount, address _token) internal {
        address current = users[_from].referrer;

        for (uint256 i = 0; i < 10; ) {
            uint256 toDistribute = (_amount * referralCommissionRates[i]) / 10000;
            if (toDistribute == 0) { unchecked { i++; } continue; }

            address search = current;

            while (toDistribute > 0) {
                // cachedCap holds the result of _getAvailableCapForToken when the inner
                // loop breaks on a qualifying recipient — avoids calling it twice.
                uint256 cachedCap = 0;
                while (search != address(0) && users[search].isRegistered) {
                    bool enoughReferrals = getActiveDirectReferralCount(search) > i;
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

    function _calcPendingRewardETH(LPLock storage lock) internal view returns (uint256) {
        if (lock.rewardRatePPM == 0) return 0;
        uint256 lockDur = lock.unlockTime > lock.lockedAt
            ? lock.unlockTime - lock.lockedAt : LP_LOCK_DURATION;
        uint256 elapsed = block.timestamp > lock.lockedAt
            ? block.timestamp - lock.lockedAt : 0;
        if (elapsed > lockDur) elapsed = lockDur;
        uint256 totalEarned = (lock.ethInvested * lock.rewardRatePPM * elapsed) / (1_000_000 * lockDur);
        return totalEarned > lock.rewardClaimedETH ? totalEarned - lock.rewardClaimedETH : 0;
    }

    function _settleStakingReward(address _user, uint256 _lockIndex) internal {
        LPLock storage lock = userLPLocks[_user][_lockIndex];
        if (lock.removed) return;
        uint256 price = _tokenPriceInETH();
        if (price == 0) return;
        uint256 pendingETH = _calcPendingRewardETH(lock);
        uint256 carry      = lock.tokensAccumulated;
        uint256 newTokens  = (pendingETH * 1e18) / price;
        uint256 total      = newTokens + carry;
        if (total == 0) return;
        uint256 available = IERC20(platformToken).balanceOf(address(this));
        if (available < total) return;
        lock.rewardClaimedETH  += pendingETH;
        lock.tokensAccumulated  = 0;
        lock.totalTokensClaimed += total;
        if (!IERC20(platformToken).transfer(_user, total)) revert StakingRewardTransferFailed();
        emit StakingRewardClaimed(_user, total, pendingETH);
    }

    function _tokenPriceInETH() internal view returns (uint256) {
        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(platformToken, WETH);
        if (pair == address(0)) return 0;
        IUniswapV2Pair p = IUniswapV2Pair(pair);
        (uint112 r0, uint112 r1,) = p.getReserves();
        address t0 = p.token0();
        uint256 resToken = t0 == platformToken ? uint256(r0) : uint256(r1);
        uint256 resETH   = t0 == platformToken ? uint256(r1) : uint256(r0);
        if (resToken == 0) return 0;
        return (resETH * 1e18) / resToken;
    }

    function getStakingReward(address _user) external view returns (
        uint256 totalAccumulated,
        uint256 previewNewTokens,
        uint256 lifetimeClaimed
    ) {
        uint256 price = _tokenPriceInETH();
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        for (uint256 i = 0; i < len; ) {
            totalAccumulated += locks[i].tokensAccumulated;
            lifetimeClaimed  += locks[i].totalTokensClaimed;
            if (price > 0) {
                uint256 pendingETH = _calcPendingRewardETH(locks[i]);
                if (pendingETH > 0) previewNewTokens += (pendingETH * 1e18) / price;
            }
            unchecked { i++; }
        }
    }

    function claimStakingReward() external nonReentrant onlyRegistered {
        uint256 price = _tokenPriceInETH();
        if (price == 0) revert PriceUnavailable();
        LPLock[] storage locks = userLPLocks[msg.sender];
        uint256 len = locks.length;
        uint256 totalTokens = 0;
        uint256 totalPendingETH = 0;
        for (uint256 i = 0; i < len; ) {
            uint256 pendingETH = _calcPendingRewardETH(locks[i]);
            uint256 carry      = locks[i].tokensAccumulated;
            uint256 lockTokens = (pendingETH * 1e18) / price + carry;
            if (lockTokens == 0) { unchecked { i++; } continue; }
            locks[i].rewardClaimedETH  += pendingETH;
            locks[i].tokensAccumulated  = 0;
            locks[i].totalTokensClaimed += lockTokens;
            totalTokens     += lockTokens;
            totalPendingETH += pendingETH;
            unchecked { i++; }
        }
        if (totalTokens == 0) revert NothingToClaim();
        if (IERC20(platformToken).balanceOf(address(this)) < totalTokens) revert InsufficientTokenBalance();
        totalStakingRewardsPaidETH += totalPendingETH;
        if (!IERC20(platformToken).transfer(msg.sender, totalTokens)) revert TokenTransferFailed();
        emit StakingRewardClaimed(msg.sender, totalTokens, totalPendingETH);
    }

    function claimStakingRewardForLock(uint256 _lockIndex) external nonReentrant onlyRegistered {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        uint256 price = _tokenPriceInETH();
        if (price == 0) revert PriceUnavailable();
        uint256 pendingETH   = _calcPendingRewardETH(lock);
        uint256 carry        = lock.tokensAccumulated;
        uint256 tokensToSend = (pendingETH * 1e18) / price + carry;
        if (tokensToSend == 0) revert NothingToClaim();
        if (IERC20(platformToken).balanceOf(address(this)) < tokensToSend) revert InsufficientTokenBalance();
        lock.rewardClaimedETH  += pendingETH;
        lock.tokensAccumulated  = 0;
        lock.totalTokensClaimed += tokensToSend;
        totalStakingRewardsPaidETH += pendingETH;
        if (!IERC20(platformToken).transfer(msg.sender, tokensToSend)) revert TokenTransferFailed();
        emit StakingRewardClaimed(msg.sender, tokensToSend, pendingETH);
    }

    function getPlatformStats() external view returns (
        uint256 _totalUsers,
        uint256 _totalEthInvested,
        uint256 _totalStakingRewardsPaidETH
    ) {
        return (totalRegisteredUsers + 1, totalEthInvested, totalStakingRewardsPaidETH);
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

    function getUserCommissionStats(address _user) external view returns (
        uint256 earned,
        uint256 /*missed*/,
        uint256 totalCap,
        uint256 remainingCap,
        uint256 active
    ) {
        earned = userCommissionsEarned[_user];
        uint256 activeCap = 0;
        uint256 pausedCap = 0;
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        for (uint256 i = 0; i < len; ) {
            LPLock storage l = locks[i];
            if (l.removed) { unchecked { i++; } continue; }
            uint256 cap     = l.ethInvested * 5;
            uint256 capLeft = l.commissionsCapUsed < cap ? cap - l.commissionsCapUsed : 0;
            if (capLeft == 0) { unchecked { i++; } continue; }
            if (block.timestamp < l.unlockTime) {
                activeCap += capLeft;
            } else {
                pausedCap += capLeft;
            }
            unchecked { i++; }
        }
        totalCap     = activeCap + pausedCap;
        remainingCap = activeCap;
        active       = userTotalInvested[_user];
    }

    struct LockCapInfo {
        address token;
        uint256 ethInvested;
        uint256 totalCap;
        uint256 capUsed;
        uint256 capRemaining;
        bool    isActive;
        bool    isRemoved;
    }

    function getLockCapInfo(address _user) external view returns (LockCapInfo[] memory) {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        LockCapInfo[] memory info = new LockCapInfo[](len);
        for (uint256 i = 0; i < len; ) {
            LPLock storage l = locks[i];
            uint256 cap  = l.ethInvested * 5;
            uint256 used = l.commissionsCapUsed;
            info[i] = LockCapInfo({
                token:        l.token,
                ethInvested:  l.ethInvested,
                totalCap:     cap,
                capUsed:      used,
                capRemaining: cap > used ? cap - used : 0,
                isActive:     !l.removed && block.timestamp < l.unlockTime,
                isRemoved:    l.removed
            });
            unchecked { i++; }
        }
        return info;
    }

    struct WealthLockParam {
        uint256 ethInvested;
        uint256 rewardRatePPM;
        uint256 lockedAt;
        uint256 unlockTime;
        bool    removed;
        uint256 tokensAccumulated;
        uint256 lpAmount;
        uint256 reserveETH;
        uint256 totalLPSupply;
    }

    struct WealthParams {
        uint256            refEarnings;
        uint256            platformTokenPriceEth;
        uint256            lpLockDuration;
        WealthLockParam[]  locks;
    }

    function getWealthParams(address _user) external view returns (WealthParams memory p) {
        p.refEarnings           = userCommissionsEarned[_user];
        p.platformTokenPriceEth = _tokenPriceInETH();
        p.lpLockDuration        = LP_LOCK_DURATION;

        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        p.locks = new WealthLockParam[](len);
        for (uint256 i = 0; i < len; ) {
            LPLock storage l = locks[i];
            p.locks[i].ethInvested       = l.ethInvested;
            p.locks[i].rewardRatePPM     = l.rewardRatePPM;
            p.locks[i].lockedAt          = l.lockedAt;
            p.locks[i].unlockTime        = l.unlockTime;
            p.locks[i].removed           = l.removed;
            p.locks[i].tokensAccumulated = l.tokensAccumulated;
            p.locks[i].lpAmount          = l.lpAmount;
            if (!l.removed && l.lpAmount > 0) {
                address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(WETH, l.token);
                if (pair != address(0)) {
                    (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
                    address t0 = IUniswapV2Pair(pair).token0();
                    p.locks[i].reserveETH    = (t0 == WETH) ? uint256(r0) : uint256(r1);
                    p.locks[i].totalLPSupply = IUniswapV2Pair(pair).totalSupply();
                }
            }
            unchecked { i++; }
        }
    }

    struct LockStakingSnapshot {
        uint256 earnedETH;
        uint256 claimedETH;
        uint256 tokensAccumulated;
        bool    isActive;
        uint256 lockDur;
        uint256 elapsed;
    }

    function getLockStakingSnapshots(address _user) external view returns (LockStakingSnapshot[] memory snaps) {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        snaps = new LockStakingSnapshot[](len);
        for (uint256 i = 0; i < len; ) {
            LPLock storage l = locks[i];
            uint256 dur = l.unlockTime > l.lockedAt ? l.unlockTime - l.lockedAt : LP_LOCK_DURATION;
            uint256 el  = block.timestamp > l.lockedAt ? block.timestamp - l.lockedAt : 0;
            if (el > dur) el = dur;
            uint256 earned = (l.removed || l.rewardRatePPM == 0 || dur == 0)
                ? l.rewardClaimedETH
                : (l.ethInvested * l.rewardRatePPM * el) / (1_000_000 * dur);
            snaps[i] = LockStakingSnapshot({
                earnedETH:         earned,
                claimedETH:        l.rewardClaimedETH,
                tokensAccumulated: l.tokensAccumulated,
                isActive:          !l.removed && block.timestamp < l.unlockTime,
                lockDur:           dur,
                elapsed:           el
            });
            unchecked { i++; }
        }
    }

    function getLockTimesLeft(address _user) external view returns (uint256[] memory) {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        uint256[] memory times = new uint256[](len);
        for (uint256 i = 0; i < len; ) {
            if (locks[i].claimed || locks[i].removed || block.timestamp >= locks[i].unlockTime) {
                times[i] = 0;
            } else {
                times[i] = locks[i].unlockTime - block.timestamp;
            }
            unchecked { i++; }
        }
        return times;
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
        uint256 tierIdx = hasReward ? _getTierIndex(ethInvestedWei) : 0;
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

    function getRestakePreview(address _user, uint256 _lockIndex, uint256 _durationSecs)
        external view returns (
            uint256 nextRestakeCount,
            uint256 streakBonusPPM,
            uint256 baseRatePPM,
            uint256 totalRatePPM
        )
    {
        LPLock storage lock = userLPLocks[_user][_lockIndex];
        uint256 dIdx        = _getDurationIndex(_durationSecs);
        uint256 prevDurSecs = lock.unlockTime > lock.lockedAt ? lock.unlockTime - lock.lockedAt : LP_LOCK_DURATION;
        uint256 prevDIdx    = _getDurationIndex(prevDurSecs);
        bool willReset      = lock.streakBaseEth != 0 && lock.ethInvested != lock.streakBaseEth;
        bool sameDur        = dIdx == prevDIdx && !willReset;
        uint256 sIdx;
        if (sameDur) {
            uint256 cnt = lock.restakeCounts[dIdx] + 1;
            sIdx = cnt > 3 ? 3 : cnt;
            nextRestakeCount = sIdx;
        } else {
            sIdx = 0;
            nextRestakeCount = 0;
        }
        baseRatePPM    = _getRewardRatePPM(lock.ethInvested, _durationSecs, 0);
        totalRatePPM   = _getRewardRatePPM(lock.ethInvested, _durationSecs, sIdx);
        streakBonusPPM = totalRatePPM - baseRatePPM;
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

    receive() external payable {}
}
