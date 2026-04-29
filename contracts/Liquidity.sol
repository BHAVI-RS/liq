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
        uint256 stakingTokens;
        bool stakingClaimed;
        bool removed;
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
    uint256 public constant LP_LOCK_DURATION        = 1 minutes;
    uint256 public constant STAKING_REWARD_RATE     = 3000;  // 30% in basis points
    uint256 public constant STAKING_SLOT_DURATION   = 10;    // seconds per slot
    uint256 public constant STAKING_CLAIM_COOLDOWN  = 1 days;

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

    // Seed or top-up a Uniswap pool using the contract's token balance.
    // Owner sends ETH; the contract provides tokens. LP tokens go to the owner.
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

        // Return any ETH the router didn't use back to owner.
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
        uint256 B   = T - A;                  // 50% — liquidity ETH
        uint256 A60 = (A * 60) / 100;         // 30% of T — buy tokens from pool
        uint256 A40 = (A * 40) / 100;         // 20% of T — referral commissions

        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = _token;

        // ── Step 1: Buy tokens from Uniswap pool with A60 ──
        IUniswapV2Router02(UNISWAP_ROUTER).swapExactETHForTokens{value: A60}(
            0,              // amountOutMin — accept any (no external MEV on local Hardhat)
            path,
            address(this),
            block.timestamp + 300
        );

        // ── Step 2: Approve router to spend platform tokens for liquidity ──
        // Approve full contract balance; router uses exactly what the pool ratio requires.
        uint256 platformTokens = IERC20(_token).balanceOf(address(this));
        IERC20(_token).approve(UNISWAP_ROUTER, platformTokens);

        // ── Step 3: Add liquidity — B ETH paired with platform tokens ──
        // Router returns any unused ETH or tokens; LP tokens go to this contract.
        (,, uint256 lpReceived) = IUniswapV2Router02(UNISWAP_ROUTER).addLiquidityETH{value: B}(
            _token,
            platformTokens,
            0,              // amountTokenMin
            0,              // amountETHMin
            address(this),
            block.timestamp + 300
        );

        // Reset approval to zero after use.
        IERC20(_token).approve(UNISWAP_ROUTER, 0);

        // ── Step 4: Send any ETH the router returned (unused from B) to owner ──
        uint256 surplus = address(this).balance > A40 ? address(this).balance - A40 : 0;
        if (surplus > 0) {
            (bool ok,) = payable(owner).call{value: surplus}("");
            require(ok, "Surplus transfer failed");
        }

        // ── Step 5: Lock LP tokens for the user ──
        userLPLocks[msg.sender].push(LPLock({
            token: _token,
            lpAmount: lpReceived,
            unlockTime: block.timestamp + LP_LOCK_DURATION,
            claimed: false,
            ethInvested: T,
            lockedAt: block.timestamp,
            stakingTokens: 0,
            stakingClaimed: false,
            removed: false
        }));

        userInvestments[msg.sender].push(Investment({
            token: _token,
            ethInvested: T,
            lpTokens: lpReceived,
            lpUnlockTime: block.timestamp + LP_LOCK_DURATION
        }));

        userTotalInvested[msg.sender] += T;

        // ── Step 6: Distribute referral commissions from A40 ──
        distributeReferralCommissions(msg.sender, A40);

        emit Invested(msg.sender, _token, T, lpReceived);
    }

    // Transfer locked LP tokens to the user after the lock period expires.
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

    // Remove liquidity using LP tokens the user already claimed and approved to this contract.
    // Frontend flow: user calls pairToken.approve(CONTRACT_ADDRESS, lpAmount), then this.
    function removeLP(uint256 _lockIndex) external nonReentrant {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        require(lock.claimed, "Claim LP tokens first");
        require(lock.lpAmount > 0, "No LP tokens");

        uint256 lpAmount = lock.lpAmount;
        lock.lpAmount = 0;
        lock.removed  = true;

        address pair = IUniswapV2Factory(UNISWAP_FACTORY).getPair(lock.token, WETH);
        require(pair != address(0), "Pool not found");

        // Pull LP tokens from user into this contract.
        require(IERC20(pair).transferFrom(msg.sender, address(this), lpAmount), "LP pull failed");

        // Approve router to burn the LP tokens.
        IERC20(pair).approve(UNISWAP_ROUTER, lpAmount);

        // Remove liquidity — ETH and tokens come back to this contract.
        (uint256 tokensReturned, uint256 ethReturned) = IUniswapV2Router02(UNISWAP_ROUTER)
            .removeLiquidityETH(
                lock.token,
                lpAmount,
                0, // amountTokenMin
                0, // amountETHMin
                address(this),
                block.timestamp + 300
            );

        // Forward ETH and tokens to the user.
        if (tokensReturned > 0) {
            require(IERC20(lock.token).transfer(msg.sender, tokensReturned), "Token return failed");
        }
        if (ethReturned > 0) {
            (bool ok,) = payable(msg.sender).call{value: ethReturned}("");
            require(ok, "ETH return failed");
        }

        emit LPRemoved(msg.sender, lock.token, lpAmount, ethReturned, tokensReturned);
    }

    // Remove liquidity when LP tokens are still held in this contract (not yet claimed to user wallet).
    function removeLPDirect(uint256 _lockIndex) external nonReentrant {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        require(!lock.removed, "Already removed");
        require(!lock.claimed, "LP already claimed to wallet");
        require(block.timestamp >= lock.unlockTime, "LP still locked");
        require(lock.lpAmount > 0, "No LP tokens");

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

    // Re-lock LP tokens (still in contract) for an additional period.
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

        lock.lockedAt   = block.timestamp;
        lock.unlockTime = block.timestamp + (_durationDays * 1 days);

        emit LPRestaked(msg.sender, lock.token, lock.lpAmount, lock.unlockTime, _durationDays);
    }

    function distributeReferralCommissions(address _from, uint256 _amount) internal {
        address current = users[_from].referrer;

        for (uint256 i = 0; i < 10; i++) {
            if (current == address(0) || !users[current].isRegistered) break;

            uint256 commission = (_amount * referralCommissionRates[i]) / 10000;

            if (commission > 0) {
                userCommissionsEarned[current] += commission;
                (bool success, ) = payable(current).call{value: commission}("");
                require(success, "Commission transfer failed");
                emit CommissionPaid(current, _from, commission, i + 1);
            }

            current = users[current].referrer;
        }
    }

    // ── STAKING REWARDS ──────────────────────────────────────────────────────

    // Returns ETH value of 1 token (scaled by 1e18) from the Uniswap pool.
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

    // Computes staking reward state for a user.
    // totalAccruedETH — total earned across all locks including already-claimed slots
    // claimableETH    — unclaimed portion: new slots since each lock's last per-lock claim
    // claimableTokens — claimableETH converted to tokens at current pool price
    // nextClaimTime   — unix timestamp when next global claim becomes available (0 = never claimed)
    function getStakingReward(address _user) external view returns (
        uint256 totalAccruedETH,
        uint256 claimableETH,
        uint256 claimableTokens,
        uint256 nextClaimTime
    ) {
        LPLock[] storage locks = userLPLocks[_user];

        for (uint256 i = 0; i < locks.length; i++) {
            uint256 lockDur = locks[i].unlockTime > locks[i].lockedAt
                ? locks[i].unlockTime - locks[i].lockedAt : LP_LOCK_DURATION;
            uint256 numSlots = lockDur / STAKING_SLOT_DURATION;
            if (numSlots == 0) numSlots = 1;

            uint256 elapsed = block.timestamp > locks[i].lockedAt
                ? block.timestamp - locks[i].lockedAt : 0;
            uint256 slotsComplete = elapsed / STAKING_SLOT_DURATION;
            if (slotsComplete > numSlots) slotsComplete = numSlots;

            totalAccruedETH += (locks[i].ethInvested * STAKING_REWARD_RATE * slotsComplete)
                / (10000 * numSlots);

            if (!locks[i].stakingClaimed) {
                uint256 slotsClaimed = locks[i].stakingTokens;
                uint256 newSlots = slotsComplete > slotsClaimed ? slotsComplete - slotsClaimed : 0;
                claimableETH += (locks[i].ethInvested * STAKING_REWARD_RATE * newSlots)
                    / (10000 * numSlots);
            }
        }

        uint256 price   = _tokenPriceInETH();
        claimableTokens = price > 0 ? (claimableETH * 1e18) / price : 0;
        uint256 lastClaim = lastStakingClaim[_user];
        nextClaimTime   = lastClaim > 0 ? lastClaim + STAKING_CLAIM_COOLDOWN : 0;
    }

    // Claim all pending staking rewards across every lock in one transaction.
    // Limited to once per STAKING_CLAIM_COOLDOWN; updates per-lock slot counters.
    function claimStakingReward() external nonReentrant onlyRegistered {
        uint256 lastClaim = lastStakingClaim[msg.sender];
        require(lastClaim == 0 || block.timestamp >= lastClaim + STAKING_CLAIM_COOLDOWN, "Claim cooldown active");

        LPLock[] storage locks = userLPLocks[msg.sender];
        uint256 claimable = 0;

        for (uint256 i = 0; i < locks.length; i++) {
            if (locks[i].stakingClaimed) continue;
            uint256 lockDur = locks[i].unlockTime > locks[i].lockedAt
                ? locks[i].unlockTime - locks[i].lockedAt : LP_LOCK_DURATION;
            uint256 numSlots = lockDur / STAKING_SLOT_DURATION;
            if (numSlots == 0) numSlots = 1;
            uint256 elapsed = block.timestamp > locks[i].lockedAt
                ? block.timestamp - locks[i].lockedAt : 0;
            uint256 slotsComplete = elapsed / STAKING_SLOT_DURATION;
            if (slotsComplete > numSlots) slotsComplete = numSlots;
            uint256 slotsClaimed = locks[i].stakingTokens;
            uint256 newSlots = slotsComplete > slotsClaimed ? slotsComplete - slotsClaimed : 0;
            if (newSlots == 0) continue;
            claimable += (locks[i].ethInvested * STAKING_REWARD_RATE * newSlots) / (10000 * numSlots);
            locks[i].stakingTokens = slotsComplete;
            if (slotsComplete == numSlots) locks[i].stakingClaimed = true;
        }

        require(claimable > 0, "Nothing to claim");

        uint256 price = _tokenPriceInETH();
        require(price > 0, "Token pool not available");
        uint256 tokensToSend = (claimable * 1e18) / price;
        require(IERC20(platformToken).balanceOf(address(this)) >= tokensToSend, "Insufficient token balance");

        stakingRewardPaid[msg.sender] += claimable;
        lastStakingClaim[msg.sender]  = block.timestamp;

        require(IERC20(platformToken).transfer(msg.sender, tokensToSend), "Token transfer failed");
        emit StakingRewardClaimed(msg.sender, tokensToSend, claimable);
    }

    // Claim staking rewards for a single lock, covering all new slots since the last claim.
    // Claimable after the first slot (10 s); each subsequent claim requires 1 more slot.
    // stakingTokens is repurposed as a per-lock counter of slots already paid out.
    function claimStakingRewardForLock(uint256 _lockIndex) external nonReentrant onlyRegistered {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        require(!lock.stakingClaimed, "Staking reward fully claimed");
        require(!lock.removed, "Investment removed");

        uint256 lockDur = lock.unlockTime > lock.lockedAt
            ? lock.unlockTime - lock.lockedAt : LP_LOCK_DURATION;
        uint256 numSlots = lockDur / STAKING_SLOT_DURATION;
        if (numSlots == 0) numSlots = 1;
        uint256 elapsed = block.timestamp > lock.lockedAt ? block.timestamp - lock.lockedAt : 0;
        uint256 slotsComplete = elapsed / STAKING_SLOT_DURATION;
        if (slotsComplete > numSlots) slotsComplete = numSlots;

        uint256 slotsClaimed = lock.stakingTokens;
        uint256 newSlots = slotsComplete > slotsClaimed ? slotsComplete - slotsClaimed : 0;
        require(newSlots > 0, "No new slots to claim");

        uint256 rewardETH = (lock.ethInvested * STAKING_REWARD_RATE * newSlots) / (10000 * numSlots);
        require(rewardETH > 0, "No reward");

        uint256 price = _tokenPriceInETH();
        require(price > 0, "Token pool not available");
        uint256 tokensToSend = (rewardETH * 1e18) / price;
        require(IERC20(platformToken).balanceOf(address(this)) >= tokensToSend, "Insufficient token balance");

        lock.stakingTokens = slotsComplete;
        if (slotsComplete == numSlots) lock.stakingClaimed = true;
        stakingRewardPaid[msg.sender] += rewardETH;

        require(IERC20(platformToken).transfer(msg.sender, tokensToSend), "Token transfer failed");
        emit StakingRewardClaimed(msg.sender, tokensToSend, rewardETH);
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

    // Returns commission stats the dashboard uses for the referral earnings card.
    // Cap = 3× total invested; active = current total invested.
    function getUserCommissionStats(address _user) external view returns (
        uint256 earned,
        uint256 missed,
        uint256 totalCap,
        uint256 remainingCap,
        uint256 active
    ) {
        earned      = userCommissionsEarned[_user];
        missed      = 0;
        totalCap    = userTotalInvested[_user] * 3;
        remainingCap = totalCap > earned ? totalCap - earned : 0;
        active      = userTotalInvested[_user];
    }

    // Returns seconds remaining until each LP lock unlocks, using block.timestamp at call time.
    // Returns 0 for locks that are already unlocked, claimed, or removed.
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