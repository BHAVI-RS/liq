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
    }

    mapping(address => User) public users;
    mapping(address => Token) public tokens;
    mapping(address => Investment[]) public userInvestments;
    mapping(address => uint256) public userTotalInvested;
    mapping(address => LPLock[]) public userLPLocks;
    mapping(address => uint256) public userCommissionsEarned;
    mapping(address => uint256) public lastStakingClaim;
    mapping(address => uint256) public stakingRewardPaid;

    address[] public registeredTokens;
    address public owner;

    address public immutable UNISWAP_ROUTER;
    address public immutable UNISWAP_FACTORY;
    address public immutable WETH;
    address public immutable platformToken;

    uint256[10] public referralCommissionRates = [1000, 500, 200, 60, 50, 45, 40, 40, 35, 30];
    uint256 public minDirectReferralInvestment;

    uint256 public constant LP_LOCK_DURATION    = 1 minutes;
    uint256 public constant STAKING_REWARD_RATE = 3000; // 30% in basis points

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
        require(msg.value > 0, "Must send ETH");
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
            totalTokensClaimed: 0
        }));

        userInvestments[msg.sender].push(Investment({
            token: _token,
            ethInvested: T,
            lpTokens: lpReceived,
            lpUnlockTime: block.timestamp + LP_LOCK_DURATION
        }));

        userTotalInvested[msg.sender] += T;

        distributeReferralCommissions(msg.sender, A40);

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
        lock.lpAmount = 0;
        lock.removed  = true;

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
        lock.lpAmount = 0;
        lock.claimed  = true;
        lock.removed  = true;

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

    function restakeLP(uint256 _lockIndex, uint256 _durationDays) external nonReentrant {
        require(
            _durationDays == 30 || _durationDays == 60 || _durationDays == 90 ||
            _durationDays == 180 || _durationDays == 360,
            "Duration must be 30, 60, 90, 180, or 360"
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

        lock.lockedAt         = block.timestamp;
        lock.unlockTime       = block.timestamp + (_durationDays * 1 days);
        lock.rewardClaimedETH = 0; // reset for new period; carry is in tokensAccumulated

        emit LPRestaked(msg.sender, lock.token, lock.lpAmount, lock.unlockTime, _durationDays);
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

    function _payCommission(address recipient, address from, uint256 amount, uint256 level) internal {
        userCommissionsEarned[recipient] += amount;
        (bool success,) = payable(recipient).call{value: amount}("");
        require(success, "Commission transfer failed");
        emit CommissionPaid(recipient, from, amount, level);
    }

    function distributeReferralCommissions(address _from, uint256 _amount) internal {
        address current = users[_from].referrer;

        for (uint256 i = 0; i < 10; i++) {
            uint256 toDistribute = (_amount * referralCommissionRates[i]) / 10000;
            if (toDistribute == 0) continue;

            address search = current;

            while (toDistribute > 0) {
                while (search != address(0) && users[search].isRegistered) {
                    bool enoughReferrals = getActiveDirectReferralCount(search) > i;
                    bool belowCap        = (search == owner) ||
                                          (userCommissionsEarned[search] < userTotalInvested[search] * 5);
                    if (enoughReferrals && belowCap) break;
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
                    uint256 capRemaining = userTotalInvested[search] * 5 - userCommissionsEarned[search];
                    toPay = toDistribute < capRemaining ? toDistribute : capRemaining;
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
        uint256 lockDur = lock.unlockTime > lock.lockedAt
            ? lock.unlockTime - lock.lockedAt : LP_LOCK_DURATION;
        uint256 elapsed = block.timestamp > lock.lockedAt
            ? block.timestamp - lock.lockedAt : 0;
        if (elapsed > lockDur) elapsed = lockDur;
        uint256 totalEarned = (lock.ethInvested * STAKING_REWARD_RATE * elapsed) / (10000 * lockDur);
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
        for (uint256 i = 0; i < locks.length; i++) {
            uint256 pendingETH = _calcPendingRewardETH(locks[i]);
            uint256 carry      = locks[i].tokensAccumulated;
            uint256 lockTokens = (pendingETH * 1e18) / price + carry;
            if (lockTokens == 0) continue;
            locks[i].rewardClaimedETH  += pendingETH;
            locks[i].tokensAccumulated  = 0;
            locks[i].totalTokensClaimed += lockTokens;
            totalTokens += lockTokens;
        }
        require(totalTokens > 0, "Nothing to claim");
        require(IERC20(platformToken).balanceOf(address(this)) >= totalTokens, "Insufficient token balance");
        stakingRewardPaid[msg.sender] += totalTokens;
        lastStakingClaim[msg.sender]   = block.timestamp;
        require(IERC20(platformToken).transfer(msg.sender, totalTokens), "Token transfer failed");
        emit StakingRewardClaimed(msg.sender, totalTokens, 0);
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
        stakingRewardPaid[msg.sender] += tokensToSend;
        lastStakingClaim[msg.sender]   = block.timestamp;
        require(IERC20(platformToken).transfer(msg.sender, tokensToSend), "Token transfer failed");
        emit StakingRewardClaimed(msg.sender, tokensToSend, pendingETH);
    }

    // ── VIEW HELPERS ─────────────────────────────────────────────────────────

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
        earned       = userCommissionsEarned[_user];
        missed       = 0;
        totalCap     = userTotalInvested[_user] * 5;
        remainingCap = totalCap > earned ? totalCap - earned : 0;
        active       = userTotalInvested[_user];
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

    receive() external payable {}
}
