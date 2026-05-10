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
    }

    struct Investment {
        address token;
        uint256 ethInvested;
        uint256 lpTokens;
        uint256 lpUnlockTime;
    }

    struct LPLock {
        address token;
        uint256 lpAmount;
        uint256 unlockTime;
        bool claimed;
        uint256 ethInvested;
        uint256 lockedAt;
        bool removed;
        uint256 rewardClaimedETH;   // ETH-denominated reward already claimed in current period (wei)
        uint256 tokensAccumulated;  // tokens carried from previous restake period; reset to 0 on claim
        uint256 totalTokensClaimed; // lifetime tokens claimed from this lock
        uint256 rewardRatePPM;         // total reward as PPM of invested ETH, locked in at staking time
        uint256[6] restakeCounts;      // per-duration restake streak; index matches stakingDurations[]
        uint256 streakBaseEth;         // ethInvested when the streak was established; if it diverges, all streaks reset
        uint256 commissionsCapUsed;    // referral commissions charged against this lock's 5x cap (per-token FIFO)
    }

    mapping(address => User) public users;
    mapping(address => Token) public tokens;
    mapping(address => Investment[]) public userInvestments;
    mapping(address => uint256) public userTotalInvested;
    mapping(address => LPLock[]) public userLPLocks;
    mapping(address => uint256) public userCommissionsEarned;
    mapping(address => uint256) public lastStakingClaim;
    mapping(address => uint256) public stakingRewardPaid;
    // Encrypted referral labels: owner => ref => AES-GCM ciphertext (iv + ciphertext)
    mapping(address => mapping(address => bytes)) private _refLabels;

    // ── Platform-wide aggregate counters (instant view without event scans) ──
    uint256 public totalRegisteredUsers;
    uint256 public totalEthInvested;
    uint256 public totalStakingRewardsPaidETH;

    address[] public registeredTokens;
    address public owner;

    address public immutable UNISWAP_ROUTER;
    address public immutable UNISWAP_FACTORY;
    address public immutable WETH;
    address public immutable platformToken;

    uint256[10] public referralCommissionRates = [5000, 2500, 1000, 300, 250, 225, 200, 200, 175, 150];
    uint256 public minDirectReferralInvestment;

    uint256 public constant LP_LOCK_DURATION = 90; // 90 seconds default lock-in (testnet)
    uint256 public constant USDT_PER_ETH     = 1000; // testnet fixed rate

    // ── Staking reward table ─────────────────────────────────────────────────
    // investmentTiers[t]       = USDT amount for tier t (12 tiers)
    // stakingDurations[d]      = lock duration in days for row d (6 durations)
    // stakingRates[d][t][s]    = reward PPM for duration d, tier t, streak level s
    //                            s=0 base, s=1 streak1, s=2 streak2, s=3 streak3+
    uint256[12] public investmentTiers;
    uint256[6]  public stakingDurations;
    mapping(uint256 => mapping(uint256 => mapping(uint256 => uint256))) public stakingRates;

    mapping(uint256 => bool) public validPackageAmounts;

    bool private _locked;

    event UserRegistered(address indexed user, address indexed referrer);
    event CommissionPaid(address indexed recipient, address indexed from, uint256 amount, uint256 level);
    event TokenRegistered(address indexed tokenAddress, string name, string symbol);
    event Invested(address indexed user, address indexed token, uint256 ethAmount, uint256 lpTokens);
    event LPClaimed(address indexed user, address indexed token, uint256 lpAmount);
    event LPRemoved(address indexed user, address indexed token, uint256 lpAmount, uint256 ethReturned, uint256 tokensReturned);
    event PoolSeeded(address indexed token, uint256 ethAmount, uint256 tokenAmount, uint256 lpReceived);
    event LPRestaked(address indexed user, address indexed token, uint256 lpAmount, uint256 newUnlockTime, uint256 durationDays);
    event StakingRewardClaimed(address indexed user, uint256 tokensAmount, uint256 ethEquivalent);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not the owner");
        _;
    }

    modifier notRegistered() {
        require(!users[msg.sender].isRegistered, "Already registered");
        _;
    }

    modifier onlyRegistered() {
        require(users[msg.sender].isRegistered, "Not registered");
        _;
    }

    modifier nonReentrant() {
        require(!_locked, "Reentrant call");
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
        investmentTiers  = [uint256(100), 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000];
        stakingDurations = [uint256(7), 30, 60, 90, 180, 360];
        // 7 days — tiered base 1.0%–1.5% ($100–$500k); no streak bonus
        _setTieredRates(0, [uint256(10_000), 10_000, 11_000, 11_000, 12_000, 12_000, 13_000, 13_000, 14_000, 14_000, 15_000, 15_000], 0);
        // 30 days — tiered base 6.0%–7.5% ($100–$500k); +5k/streak per level
        _setTieredRates(1, [uint256(60_000), 60_000, 62_500, 62_500, 65_000, 65_000, 67_500, 67_500, 70_000, 70_000, 72_500, 75_000], 5_000);
        // 60 days — tiered base 14.0%–18.0%; +26k/streak per level
        _setTieredRates(2, [uint256(140_000), 145_000, 150_000, 150_000, 155_000, 160_000, 165_000, 170_000, 170_000, 175_000, 180_000, 180_000], 26_000);
        // 90 days — tiered base 25.0%–30.0%; +30k/streak per level
        _setTieredRates(3, [uint256(250_000), 255_000, 260_000, 260_000, 265_000, 270_000, 275_000, 280_000, 285_000, 290_000, 295_000, 300_000], 30_000);
        // 180 days — tiered base 68%–77%; +50k/streak per level
        _setTieredRates(4, [uint256(680_000), 690_000, 700_000, 700_000, 710_000, 720_000, 730_000, 740_000, 750_000, 750_000, 760_000, 770_000], 50_000);
        // 360 days — tiered base 168%–184%; +100k/streak per level
        _setTieredRates(5, [uint256(1_680_000), 1_690_000, 1_700_000, 1_700_000, 1_720_000, 1_740_000, 1_750_000, 1_770_000, 1_790_000, 1_800_000, 1_820_000, 1_840_000], 100_000);
    }

    // Stores all 4 streak levels for a duration row; all tiers share the same rate.
    function _setRates(uint256 dIdx, uint256 base, uint256 s1, uint256 s2, uint256 s3) internal {
        for (uint256 t = 0; t < 12; t++) {
            stakingRates[dIdx][t][0] = base;
            stakingRates[dIdx][t][1] = s1;
            stakingRates[dIdx][t][2] = s2;
            stakingRates[dIdx][t][3] = s3;
        }
    }

    // Stores per-tier base rates for a duration row; streak levels derived as base + n*incrPPM.
    function _setTieredRates(uint256 dIdx, uint256[12] memory bases, uint256 incrPPM) internal {
        for (uint256 t = 0; t < 12; t++) {
            stakingRates[dIdx][t][0] = bases[t];
            stakingRates[dIdx][t][1] = bases[t] + incrPPM;
            stakingRates[dIdx][t][2] = bases[t] + 2 * incrPPM;
            stakingRates[dIdx][t][3] = bases[t] + 3 * incrPPM;
        }
    }

    // Packages stored as exact ETH wei amounts (USDT / USDT_PER_ETH * 1e18).
    // Basic: 25, 50, 100, 250, 500, 1000 USDT
    // Elite: 2500, 5000, 10000, 25000 USDT
    // Institutional: 50000, 100000, 250000, 500000 USDT
    function _initPackages() internal {
        uint256[14] memory usdtAmounts = [
            uint256(25), 50, 100, 250, 500, 1000,
            2500, 5000, 10000, 25000,
            50000, 100000, 250000, 500000
        ];
        for (uint256 i = 0; i < 14; i++) {
            validPackageAmounts[usdtAmounts[i] * 1e18 / USDT_PER_ETH] = true;
        }
    }

    function setValidPackage(uint256 ethWei, bool valid) external onlyOwner {
        validPackageAmounts[ethWei] = valid;
    }

    // ── Rate lookup helpers ──────────────────────────────────────────────────

    function _getTierIndex(uint256 ethInvestedWei) internal view returns (uint256 best) {
        uint256 usdtAmt = ethInvestedWei * USDT_PER_ETH / 1e18;
        uint256 bestDiff = usdtAmt >= investmentTiers[0] ? usdtAmt - investmentTiers[0] : investmentTiers[0] - usdtAmt;
        for (uint256 i = 1; i < 12; i++) {
            uint256 d = usdtAmt >= investmentTiers[i] ? usdtAmt - investmentTiers[i] : investmentTiers[i] - usdtAmt;
            if (d < bestDiff) { bestDiff = d; best = i; }
        }
    }

    function _getDurationIndex(uint256 durationDays) internal view returns (uint256 best) {
        uint256 bestDiff = durationDays >= stakingDurations[0] ? durationDays - stakingDurations[0] : stakingDurations[0] - durationDays;
        for (uint256 i = 1; i < 6; i++) {
            uint256 d = durationDays >= stakingDurations[i] ? durationDays - stakingDurations[i] : stakingDurations[i] - durationDays;
            if (d < bestDiff) { bestDiff = d; best = i; }
        }
    }

    function _getRewardRatePPM(uint256 ethInvestedWei, uint256 durationDays, uint256 streakLevel) internal view returns (uint256) {
        if (ethInvestedWei * USDT_PER_ETH / 1e18 < 100) return 0;
        uint256 sIdx = streakLevel > 3 ? 3 : streakLevel;
        return stakingRates[_getDurationIndex(durationDays)][_getTierIndex(ethInvestedWei)][sIdx];
    }

    function register(address _referrer) external notRegistered {
        require(_referrer != msg.sender, "Cannot refer yourself");
        require(users[_referrer].isRegistered, "Referrer not registered");

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
        require(msg.value > 0, "Must send ETH");
        require(_tokenAmount > 0, "Must specify token amount");
        require(IERC20(_token).balanceOf(address(this)) >= _tokenAmount, "Insufficient contract token balance");

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
            require(ok, "ETH return failed");
        }

        emit PoolSeeded(_token, msg.value, _tokenAmount, lpReceived);
    }

    function addToken(address _tokenAddress, string calldata _name, string calldata _symbol) external onlyOwner {
        require(_tokenAddress != address(0), "Invalid token address");
        require(tokens[_tokenAddress].tokenAddress == address(0), "Token already registered");

        tokens[_tokenAddress] = Token({
            tokenAddress: _tokenAddress,
            name: _name,
            symbol: _symbol,
            addedAt: block.timestamp
        });

        registeredTokens.push(_tokenAddress);

        emit TokenRegistered(_tokenAddress, _name, _symbol);
    }

    function invest(address _token) external payable onlyRegistered nonReentrant {
        require(validPackageAmounts[msg.value], "Invalid package amount");
        require(tokens[_token].tokenAddress != address(0), "Token not registered");
        require(IERC20(_token).balanceOf(address(this)) > 0, "Insufficient platform token supply");

        uint256 T   = msg.value;
        uint256 A   = T / 2;
        uint256 B   = T - A;
        uint256 A60 = (A * 60) / 100;
        uint256 A40 = (A * 40) / 100;

        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = _token;

        IUniswapV2Router02(UNISWAP_ROUTER).swapExactETHForTokens{value: A60}(
            0,
            path,
            address(this),
            block.timestamp + 300
        );

        uint256 platformTokens = IERC20(_token).balanceOf(address(this));
        IERC20(_token).approve(UNISWAP_ROUTER, platformTokens);

        (,, uint256 lpReceived) = IUniswapV2Router02(UNISWAP_ROUTER).addLiquidityETH{value: B}(
            _token,
            platformTokens,
            0,
            0,
            address(this),
            block.timestamp + 300
        );

        IERC20(_token).approve(UNISWAP_ROUTER, 0);

        uint256 surplus = address(this).balance > A40 ? address(this).balance - A40 : 0;
        if (surplus > 0) {
            (bool ok,) = payable(owner).call{value: surplus}("");
            require(ok, "Surplus transfer failed");
        }

        userLPLocks[msg.sender].push(LPLock({
            token: _token,
            lpAmount: lpReceived,
            unlockTime: block.timestamp + LP_LOCK_DURATION,
            claimed: false,
            ethInvested: T,
            lockedAt: block.timestamp,
            removed: false,
            rewardClaimedETH: 0,
            tokensAccumulated: 0,
            totalTokensClaimed: 0,
            rewardRatePPM: _getRewardRatePPM(T, 90, 0), // 90-day base rate, streak 0
            restakeCounts: [uint256(0), 0, 0, 0, 0, 0],
            streakBaseEth: T,
            commissionsCapUsed: 0
        }));

        userInvestments[msg.sender].push(Investment({
            token: _token,
            ethInvested: T,
            lpTokens: lpReceived,
            lpUnlockTime: block.timestamp + LP_LOCK_DURATION
        }));

        userTotalInvested[msg.sender] += T;
        totalEthInvested += T;

        distributeReferralCommissions(msg.sender, A40, _token);

        emit Invested(msg.sender, _token, T, lpReceived);
    }

    function claimLP(uint256 _lockIndex) external nonReentrant {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        require(!lock.claimed, "Already claimed");
        require(block.timestamp >= lock.unlockTime, "LP still locked");
        require(lock.lpAmount > 0, "No LP tokens");

        lock.claimed = true;

        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(lock.token, WETH);
        require(pair != address(0), "Pool not found");
        require(IERC20(pair).transfer(msg.sender, lock.lpAmount), "LP transfer failed");

        emit LPClaimed(msg.sender, lock.token, lock.lpAmount);
    }

    function removeLP(uint256 _lockIndex) external nonReentrant {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        require(lock.claimed, "Claim LP tokens first");
        require(lock.lpAmount > 0, "No LP tokens");

        _settleStakingReward(msg.sender, _lockIndex);

        uint256 lpAmount = lock.lpAmount;
        uint256 ethInvested = lock.ethInvested;
        lock.lpAmount = 0;
        lock.removed  = true;

        if (userTotalInvested[msg.sender] >= ethInvested)
            userTotalInvested[msg.sender] -= ethInvested;

        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(lock.token, WETH);
        require(pair != address(0), "Pool not found");

        require(IERC20(pair).transferFrom(msg.sender, address(this), lpAmount), "LP pull failed");
        IERC20(pair).approve(UNISWAP_ROUTER, lpAmount);

        (uint256 tokensReturned, uint256 ethReturned) = IUniswapV2Router02(UNISWAP_ROUTER)
            .removeLiquidityETH(
                lock.token,
                lpAmount,
                0,
                0,
                address(this),
                block.timestamp + 300
            );

        if (tokensReturned > 0) {
            require(IERC20(lock.token).transfer(msg.sender, tokensReturned), "Token return failed");
        }
        if (ethReturned > 0) {
            (bool ok,) = payable(msg.sender).call{value: ethReturned}("");
            require(ok, "ETH return failed");
        }

        emit LPRemoved(msg.sender, lock.token, lpAmount, ethReturned, tokensReturned);
    }

    function removeLPDirect(uint256 _lockIndex) external nonReentrant {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        require(!lock.removed, "Already removed");
        require(!lock.claimed, "LP already claimed to wallet");
        require(block.timestamp >= lock.unlockTime, "LP still locked");
        require(lock.lpAmount > 0, "No LP tokens");

        _settleStakingReward(msg.sender, _lockIndex);

        uint256 lpAmount = lock.lpAmount;
        uint256 ethInvested = lock.ethInvested;
        lock.lpAmount = 0;
        lock.claimed  = true;
        lock.removed  = true;

        if (userTotalInvested[msg.sender] >= ethInvested)
            userTotalInvested[msg.sender] -= ethInvested;

        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(lock.token, WETH);
        require(pair != address(0), "Pool not found");

        IERC20(pair).approve(UNISWAP_ROUTER, lpAmount);

        (uint256 tokensReturned, uint256 ethReturned) = IUniswapV2Router02(UNISWAP_ROUTER)
            .removeLiquidityETH(
                lock.token,
                lpAmount,
                0,
                0,
                address(this),
                block.timestamp + 300
            );

        if (tokensReturned > 0) {
            require(IERC20(lock.token).transfer(msg.sender, tokensReturned), "Token return failed");
        }
        if (ethReturned > 0) {
            (bool ok,) = payable(msg.sender).call{value: ethReturned}("");
            require(ok, "ETH return failed");
        }

        emit LPRemoved(msg.sender, lock.token, lpAmount, ethReturned, tokensReturned);
    }

    function restakeLP(uint256 _lockIndex, uint256 _durationSecs) external nonReentrant {
        require(
            _durationSecs == 7 || _durationSecs == 30 || _durationSecs == 60 ||
            _durationSecs == 90 || _durationSecs == 180 || _durationSecs == 360,
            "Duration must be 7, 30, 60, 90, 180, or 360 seconds"
        );
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        require(!lock.claimed, "LP already claimed to wallet");
        require(!lock.removed, "Already removed");
        require(block.timestamp >= lock.unlockTime, "LP still locked");
        require(lock.lpAmount > 0, "No LP tokens to restake");

        // Carry over unclaimed reward from the ending period as tokens at current price.
        uint256 price = _tokenPriceInETH();
        if (price > 0) {
            uint256 pendingETH = _calcPendingRewardETH(lock);
            if (pendingETH > 0) lock.tokensAccumulated += (pendingETH * 1e18) / price;
        }

        uint256 dIdx = _getDurationIndex(_durationSecs);

        // If the invested amount diverged from the streak baseline, reset all per-duration streaks.
        if (lock.streakBaseEth != 0 && lock.ethInvested != lock.streakBaseEth) {
            for (uint256 i = 0; i < 6; i++) lock.restakeCounts[i] = 0;
            lock.streakBaseEth = lock.ethInvested;
        }

        // Streak only continues when the same duration is reused consecutively.
        // Switching to a different duration breaks the streak and gives the base rate.
        uint256 prevDurSecs = lock.unlockTime > lock.lockedAt ? lock.unlockTime - lock.lockedAt : LP_LOCK_DURATION;
        uint256 prevDIdx    = _getDurationIndex(prevDurSecs);
        uint256 sIdx;
        if (dIdx == prevDIdx) {
            lock.restakeCounts[dIdx] += 1;
            uint256 cnt = lock.restakeCounts[dIdx];
            sIdx = cnt > 3 ? 3 : cnt;
        } else {
            lock.restakeCounts[dIdx] = 0; // streak broken by duration switch
            sIdx = 0;                     // base rate
        }
        lock.lockedAt         = block.timestamp;
        lock.unlockTime       = block.timestamp + _durationSecs;
        lock.rewardClaimedETH = 0; // reset for new period; carry is in tokensAccumulated
        lock.rewardRatePPM    = _getRewardRatePPM(lock.ethInvested, _durationSecs, sIdx);

        emit LPRestaked(msg.sender, lock.token, lock.lpAmount, lock.unlockTime, _durationSecs);
    }

    function _hasActiveInvestment(address _user) internal view returns (bool) {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 total = 0;
        for (uint256 j = 0; j < locks.length; j++) {
            if (!locks[j].removed) total += locks[j].ethInvested;
        }
        return total > 0 && total >= minDirectReferralInvestment;
    }

    function getActiveDirectReferralCount(address _user) public view returns (uint256 count) {
        address[] storage refs = users[_user].referrals;
        for (uint256 i = 0; i < refs.length; i++) {
            if (_hasActiveInvestment(refs[i])) count++;
        }
    }

    function setMinDirectReferralInvestment(uint256 _amount) external onlyOwner {
        minDirectReferralInvestment = _amount;
    }

    // Returns total available cap across all active (currently-locked) locks for _token, oldest first (FIFO).
    function _getAvailableCapForToken(address _user, address _token) internal view returns (uint256 available) {
        LPLock[] storage locks = userLPLocks[_user];
        for (uint256 j = 0; j < locks.length; j++) {
            LPLock storage l = locks[j];
            if (l.removed) continue;
            if (l.token != _token) continue;
            if (block.timestamp >= l.unlockTime) continue;
            uint256 cap = l.ethInvested * 5;
            if (l.commissionsCapUsed < cap) available += cap - l.commissionsCapUsed;
        }
    }

    // Charges _amount against active locks for _token, oldest first (FIFO), spilling into next lock on overflow.
    function _chargeCapForToken(address _user, address _token, uint256 _amount) internal {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 remaining = _amount;
        for (uint256 j = 0; j < locks.length && remaining > 0; j++) {
            LPLock storage l = locks[j];
            if (l.removed) continue;
            if (l.token != _token) continue;
            if (block.timestamp >= l.unlockTime) continue;
            uint256 cap = l.ethInvested * 5;
            if (l.commissionsCapUsed >= cap) continue;
            uint256 space = cap - l.commissionsCapUsed;
            uint256 toCharge = remaining < space ? remaining : space;
            l.commissionsCapUsed += toCharge;
            remaining -= toCharge;
        }
    }

    function _payCommission(address recipient, address from, uint256 amount, uint256 level) internal {
        userCommissionsEarned[recipient] += amount;
        (bool success,) = payable(recipient).call{value: amount}("");
        require(success, "Commission transfer failed");
        emit CommissionPaid(recipient, from, amount, level);
    }

    function distributeReferralCommissions(address _from, uint256 _amount, address _token) internal {
        address current = users[_from].referrer;

        for (uint256 i = 0; i < 10; i++) {
            uint256 toDistribute = (_amount * referralCommissionRates[i]) / 10000;
            if (toDistribute == 0) continue;

            address search = current;

            while (toDistribute > 0) {
                // Walk up the chain to find an eligible referrer for level i:
                // must have enough active direct referrals AND an active lock for _token with remaining cap.
                // If no active lock for _token exists (Option A), skip regardless of cap.
                while (search != address(0) && users[search].isRegistered) {
                    bool enoughReferrals = getActiveDirectReferralCount(search) > i;
                    if (!enoughReferrals) { search = users[search].referrer; continue; }
                    if (search == owner) break;
                    if (_getAvailableCapForToken(search, _token) > 0) break;
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
                    uint256 capAvail = _getAvailableCapForToken(search, _token);
                    toPay = toDistribute < capAvail ? toDistribute : capAvail;
                    _chargeCapForToken(search, _token, toPay);
                }

                _payCommission(search, _from, toPay, i + 1);
                toDistribute -= toPay;

                current = users[search].referrer;
                search  = current;
            }
        }
    }

    // ── STAKING REWARDS ──────────────────────────────────────────────────────

    // Returns ETH-denominated reward pending for a single lock (earned minus already claimed).
    // Reward accrues linearly per second, capped at the lock period end.
    // Works for removed locks too — LP removal requires the lock to be expired, so elapsed
    // is always >= lockDur and the full period reward is always earned.
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

    // Settle outstanding staking rewards before LP removal so they are never lost.
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
        stakingRewardPaid[_user] += total;
        lastStakingClaim[_user]   = block.timestamp;
        require(IERC20(platformToken).transfer(_user, total), "Staking reward transfer failed");
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

    // Returns aggregate staking state for the rewards tab.
    // Includes removed locks that still have unclaimed rewards.
    function getStakingReward(address _user) external view returns (
        uint256 totalAccumulated,
        uint256 previewNewTokens,
        uint256 lifetimeClaimed
    ) {
        uint256 price = _tokenPriceInETH();
        LPLock[] storage locks = userLPLocks[_user];
        for (uint256 i = 0; i < locks.length; i++) {
            totalAccumulated += locks[i].tokensAccumulated;
            lifetimeClaimed  += locks[i].totalTokensClaimed;
            if (price > 0) {
                uint256 pendingETH = _calcPendingRewardETH(locks[i]);
                if (pendingETH > 0) previewNewTokens += (pendingETH * 1e18) / price;
            }
        }
    }

    // Claim accumulated staking rewards across all locks in one transaction.
    // Includes removed locks that still have unclaimed rewards.
    function claimStakingReward() external nonReentrant onlyRegistered {
        uint256 price = _tokenPriceInETH();
        require(price > 0, "Price unavailable");
        LPLock[] storage locks = userLPLocks[msg.sender];
        uint256 totalTokens = 0;
        uint256 totalPendingETH = 0;
        for (uint256 i = 0; i < locks.length; i++) {
            uint256 pendingETH = _calcPendingRewardETH(locks[i]);
            uint256 carry      = locks[i].tokensAccumulated;
            uint256 lockTokens = (pendingETH * 1e18) / price + carry;
            if (lockTokens == 0) continue;
            locks[i].rewardClaimedETH  += pendingETH;
            locks[i].tokensAccumulated  = 0;
            locks[i].totalTokensClaimed += lockTokens;
            totalTokens    += lockTokens;
            totalPendingETH += pendingETH;
        }
        require(totalTokens > 0, "Nothing to claim");
        require(IERC20(platformToken).balanceOf(address(this)) >= totalTokens, "Insufficient token balance");
        stakingRewardPaid[msg.sender]      += totalTokens;
        lastStakingClaim[msg.sender]        = block.timestamp;
        totalStakingRewardsPaidETH         += totalPendingETH;
        require(IERC20(platformToken).transfer(msg.sender, totalTokens), "Token transfer failed");
        emit StakingRewardClaimed(msg.sender, totalTokens, totalPendingETH);
    }

    // Claim accumulated staking rewards for a single lock.
    // Removed locks are allowed — rewards earned before removal remain valid.
    function claimStakingRewardForLock(uint256 _lockIndex) external nonReentrant onlyRegistered {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        uint256 price = _tokenPriceInETH();
        require(price > 0, "Price unavailable");
        uint256 pendingETH   = _calcPendingRewardETH(lock);
        uint256 carry        = lock.tokensAccumulated;
        uint256 tokensToSend = (pendingETH * 1e18) / price + carry;
        require(tokensToSend > 0, "Nothing to claim");
        require(IERC20(platformToken).balanceOf(address(this)) >= tokensToSend, "Insufficient token balance");
        lock.rewardClaimedETH  += pendingETH;
        lock.tokensAccumulated  = 0;
        lock.totalTokensClaimed += tokensToSend;
        stakingRewardPaid[msg.sender]  += tokensToSend;
        lastStakingClaim[msg.sender]    = block.timestamp;
        totalStakingRewardsPaidETH     += pendingETH;
        require(IERC20(platformToken).transfer(msg.sender, tokensToSend), "Token transfer failed");
        emit StakingRewardClaimed(msg.sender, tokensToSend, pendingETH);
    }

    // ── VIEW HELPERS ─────────────────────────────────────────────────────────

    // Returns platform-wide aggregate stats in one call — avoids expensive event log scans.
    // totalUsers counts the owner (registered in constructor) + all register() callers.
    function getPlatformStats() external view returns (
        uint256 _totalUsers,
        uint256 _totalEthInvested,
        uint256 _totalStakingRewardsPaidETH
    ) {
        return (totalRegisteredUsers + 1, totalEthInvested, totalStakingRewardsPaidETH);
    }

    function getUserInvestments(address _user) external view returns (Investment[] memory) {
        return userInvestments[_user];
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
        uint256 missed,
        uint256 totalCap,
        uint256 remainingCap,
        uint256 active
    ) {
        earned = userCommissionsEarned[_user];
        missed = 0;
        uint256 activeCap = 0;
        uint256 pausedCap = 0;
        LPLock[] storage locks = userLPLocks[_user];
        for (uint256 i = 0; i < locks.length; i++) {
            LPLock storage l = locks[i];
            if (l.removed) continue;
            uint256 cap     = l.ethInvested * 5;
            uint256 capLeft = l.commissionsCapUsed < cap ? cap - l.commissionsCapUsed : 0;
            if (capLeft == 0) continue;
            if (block.timestamp < l.unlockTime) {
                activeCap += capLeft;
            } else {
                pausedCap += capLeft;
            }
        }
        // totalCap = remaining on active locks + remaining on paused (expired, non-removed) locks
        // remainingCap = active locks only (commission-eligible right now)
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
        LockCapInfo[] memory info = new LockCapInfo[](locks.length);
        for (uint256 i = 0; i < locks.length; i++) {
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
        }
        return info;
    }

    // Raw parameters for client-side wealth computation with live wall-clock elapsed.
    // lockedAt / unlockTime are set at investment time and don't change — the frontend uses
    // Date.now() - lockedAt for smooth per-second accumulation even when block.timestamp is frozen.
    struct WealthLockParam {
        uint256 ethInvested;
        uint256 rewardRatePPM;
        uint256 lockedAt;
        uint256 unlockTime;
        bool    removed;
        uint256 tokensAccumulated;
        uint256 lpAmount;
        uint256 reserveETH;      // ETH reserve in the Uniswap pair at call time
        uint256 totalLPSupply;   // LP token total supply at call time
    }

    struct WealthParams {
        uint256            refEarnings;
        uint256            platformTokenPriceEth;  // 1e18-scaled (wei ETH per 1e18 platform tokens)
        uint256            lpLockDuration;          // LP_LOCK_DURATION constant (fallback if unlockTime==lockedAt)
        WealthLockParam[]  locks;
    }

    // Returns all parameters needed for the frontend to compute live wealth without block.timestamp.
    // The frontend uses wall-clock now - lockedAt for per-second accumulation that advances even on Hardhat.
    function getWealthParams(address _user) external view returns (WealthParams memory p) {
        p.refEarnings           = userCommissionsEarned[_user];
        p.platformTokenPriceEth = _tokenPriceInETH();
        p.lpLockDuration        = LP_LOCK_DURATION;

        LPLock[] storage locks = userLPLocks[_user];
        p.locks = new WealthLockParam[](locks.length);
        for (uint256 i = 0; i < locks.length; i++) {
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
        }
    }

    // Returns the user's total wealth in ETH (wei), computed entirely on-chain.
    // wealth = refEarnings + max(0, currentLP - invested) + invested + stakingPending + tokensAccumulatedETH
    function getWealthOf(address _user) external view returns (uint256 wealthWei) {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 refEarnings    = userCommissionsEarned[_user];
        uint256 totalInvested  = 0;
        uint256 totalCurrentLP = 0;
        uint256 totalStaking   = 0;
        uint256 tokenPrice     = _tokenPriceInETH();

        for (uint256 i = 0; i < locks.length; i++) {
            LPLock storage l = locks[i];
            totalInvested += l.ethInvested;
            if (!l.removed) {
                address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(WETH, l.token);
                if (pair != address(0) && l.lpAmount > 0) {
                    (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
                    address t0 = IUniswapV2Pair(pair).token0();
                    uint256 reserveETH = (t0 == WETH) ? uint256(r0) : uint256(r1);
                    uint256 totalLP    = IUniswapV2Pair(pair).totalSupply();
                    if (totalLP > 0) {
                        totalCurrentLP += (l.lpAmount * reserveETH * 2) / totalLP;
                    }
                }
                totalStaking += _calcPendingRewardETH(l);
                if (l.tokensAccumulated > 0 && tokenPrice > 0) {
                    totalStaking += (l.tokensAccumulated * tokenPrice) / 1e18;
                }
            }
        }

        uint256 lpFees = totalCurrentLP > totalInvested ? totalCurrentLP - totalInvested : 0;
        wealthWei = refEarnings + lpFees + totalInvested + totalStaking;
    }

    // Per-lock staking snapshot computed at block.timestamp.
    // earnedETH = total reward earned so far (claimed + pending).
    // isActive   = lock is still within its staking period on-chain.
    // elapsed / lockDur let the frontend advance the ticker by wall clock without drifting.
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
        snaps = new LockStakingSnapshot[](locks.length);
        for (uint256 i = 0; i < locks.length; i++) {
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
        }
    }

    function getLockTimesLeft(address _user) external view returns (uint256[] memory) {
        LPLock[] storage locks = userLPLocks[_user];
        uint256[] memory times = new uint256[](locks.length);
        for (uint256 i = 0; i < locks.length; i++) {
            if (locks[i].claimed || locks[i].removed || block.timestamp >= locks[i].unlockTime) {
                times[i] = 0;
            } else {
                times[i] = locks[i].unlockTime - block.timestamp;
            }
        }
        return times;
    }

    function getContractTokenBalance(address _token) external view returns (uint256) {
        return IERC20(_token).balanceOf(address(this));
    }

    // Returns the staking rates for all 6 durations for a given investment amount.
    // Frontend uses this to populate the restake modal without any local reward tables.
    function getStakingRatesForAmount(uint256 ethInvestedWei) external view returns (
        uint256[6] memory durSecs,
        uint256[6] memory ratesPPM
    ) {
        uint256 investUSDT = ethInvestedWei * USDT_PER_ETH / 1e18;
        bool hasReward = investUSDT >= 100;
        uint256 tierIdx = hasReward ? _getTierIndex(ethInvestedWei) : 0;
        for (uint256 i = 0; i < 6; i++) {
            durSecs[i]  = stakingDurations[i];
            ratesPPM[i] = hasReward ? stakingRates[i][tierIdx][0] : 0;
        }
    }

    // Owner can update a rate for a specific duration, tier, and streak level after deployment.
    function setStakingRates(uint256 durationIdx, uint256 tierIdx, uint256 streakLevel, uint256 rate) external onlyOwner {
        require(durationIdx < 6, "Invalid duration index");
        require(tierIdx < 12, "Invalid tier index");
        require(streakLevel < 4, "Invalid streak level");
        stakingRates[durationIdx][tierIdx][streakLevel] = rate;
    }

    // Returns the projected reward rate for the NEXT restake of a given lock,
    // including the streak bonus that would be applied. If the package amount changed
    // since the streak was set, the streak would reset to 1 on the next restake.
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
            sIdx = 0; // switching duration → base rate
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

    receive() external payable {}
}
