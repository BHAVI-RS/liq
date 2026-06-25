// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HordexStorage.sol";
import "./HordexMath.sol";

/**
 * @title  HordexFacet — Investment & Liquidity Engine
 * @notice Powers investing, staking rewards, and liquidity management for Hordex.
 *         https://hordex.club
 *
 * @dev This module executes within the core platform's shared state and implements the
 *      participant-facing money flows: investing a stablecoin package, providing liquidity to
 *      the HDX/USDT pool, accruing and claiming staking rewards, restaking to compound, and
 *      unlocking liquidity when a position matures. Reward values are derived from an on-chain
 *      time-weighted average price with sensible slippage and price-deviation safeguards, so
 *      every payout is fair, predictable, and resistant to short-term price swings.
 */
interface IERC20F {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IRouterF {
    function swapExactTokensForTokens(uint, uint, address[] calldata, address, uint) external returns (uint[] memory);
    function addLiquidity(address, address, uint, uint, uint, uint, address, uint) external returns (uint, uint, uint);
    function removeLiquidity(address, address, uint, uint, uint, address, uint) external returns (uint, uint);
}

interface IFactoryF { function getPair(address, address) external view returns (address); }
interface IPairF {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function totalSupply() external view returns (uint256);
}

contract HordexFacet is HordexStorage {

    address private immutable UNISWAP_ROUTER;
    address private immutable UNISWAP_FACTORY;
    address private immutable WETH;
    address public  immutable platformToken;
    address private immutable _self;
    address private immutable _deployer;

    uint256 private constant TWAP_PERIOD       = 15 minutes;
    uint256 private constant TWAP_MAX_STALE    = 2 hours;
    uint256 private constant MAX_SLIPPAGE_BPS  = 200;
    uint256 private constant TWAP_GUARD_BPS    = 500;

    error NotDelegatecall();
    error NotDirectCall();
    error NoETHToWithdraw();
    error ETHWithdrawFailed();
    error NoTokensToWithdraw();
    error TokenWithdrawFailed();
    error NotOwner();
    error Reentrant();
    error MustSendETH();
    error InsufficientContractTokenBalance();
    error ETHReturnFailed();
    error SurplusTransferFailed();
    error InvalidPackageAmount();
    error TokenNotRegistered();
    error TokenDelisted();
    error TokenInProgress();
    error PoolNotFound();
    error NoLPTokens();
    error PriceUnavailable();
    error PriceDeviationTooHigh();
    error AlreadyRemoved();
    error LPAlreadyClaimed();
    error LPStillLocked();
    error ClaimLPFirst();
    error LPPullFailed();
    error TokenReturnFailed();
    error CommissionTransferFailed();
    error StakingRewardTransferFailed();
    error NothingToClaim();
    error InsufficientTokenBalance();
    error TokenTransferFailed();
    error InvalidDuration();
    error InvalidDurationIndex();
    error InvalidTierIndex();
    error InvalidStreakLevel();
    error TWAPStale();
    error TokenTWAPStale();

    event CommissionPaid(address indexed recipient, address indexed from, uint256 amount, uint256 level);

    event CommissionMissed(address indexed naturalRecipient, address indexed from, uint256 amount, uint256 level, uint8 reason);

    event CommissionReserved(address indexed recipient, address indexed from, uint256 amount, uint256 level, uint64 unlockTime);
    event Invested(address indexed user, address indexed token, uint256 ethAmount, uint256 lpTokens);
    event LPRemoved(address indexed user, address indexed token, uint256 lpAmount, uint256 ethReturned, uint256 tokensReturned);
    event LPRestaked(address indexed user, address indexed token, uint256 lpAmount, uint256 newUnlockTime, uint256 durationDays);
    event StakingRewardClaimed(address indexed user, uint256 tokensAmount, uint256 ethEquivalent);
    event TWAPUpdated(uint256 price, uint256 timestamp);

    constructor(address _router, address _factory, address _weth, address _platform) {
        UNISWAP_ROUTER  = _router;
        UNISWAP_FACTORY = _factory;
        WETH            = _weth;
        platformToken   = _platform;
        _self           = address(this);
        _deployer       = msg.sender;
    }

    modifier onlyDelegatecall() {
        if (address(this) == _self) revert NotDelegatecall();
        _;
    }

    function updateTokenTWAPExt(address _token) external payable onlyDelegatecall {
        _updateTokenTWAP(_token);
    }

    function updateTWAPExt() external payable onlyDelegatecall {
        uint256 priceBefore = _tokenTwapPrice[platformToken];
        _updateTokenTWAP(platformToken);
        uint256 priceAfter = _tokenTwapPrice[platformToken];
        if (priceAfter > 0 && priceAfter != priceBefore) {
            emit TWAPUpdated(priceAfter, block.timestamp);
        }
    }

    function _updateTokenTWAP(address _token) internal {
        address pair = IFactoryF(UNISWAP_FACTORY).getPair(_token, WETH);
        if (pair == address(0)) return;

        (uint256 cumulative, uint32 ts) = HordexMath.pairCumulative(pair, _token);

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

    function _twapPrice() internal view returns (uint256) {
        if (!_tokenTwapReady[platformToken]) return 0;
        if (block.timestamp - _tokenTwapLastUpdated[platformToken] > TWAP_MAX_STALE) return 0;
        return _tokenTwapPrice[platformToken];
    }

    function distributeCommissionsExt(address _from, uint256 _amount) external payable onlyDelegatecall {
        _distributeReferralCommissions(_from, _amount);
    }

    function _payCommission(address recipient, address from, uint256 amount, uint256 level) internal {
        uint256 toRecipient = amount;
        if (recipient != owner) {
            uint256 deployerCut = amount * 5 / 100;
            toRecipient = amount - deployerCut;
            if (deployerCut > 0) {
                if (!_safeTransfer(WETH, owner, deployerCut)) revert CommissionTransferFailed();
            }
        }
        bool success = _safeTransfer(WETH, recipient, toRecipient);
        if (!success) {
            if (!_safeTransfer(WETH, owner, toRecipient)) revert CommissionTransferFailed();
        } else {
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

    function _reserveCommission(address recipient, address from, uint256 amount, uint256 level, uint64 unlockTime) internal {
        uint256 deployerCut = amount * 5 / 100;
        uint256 toReserve   = amount - deployerCut;
        if (deployerCut > 0) {
            if (!_safeTransfer(WETH, owner, deployerCut)) revert CommissionTransferFailed();
        }
        if (toReserve > 0) {
            _pushReserveTranche(recipient, toReserve, unlockTime);
            emit CommissionReserved(recipient, from, toReserve, level, unlockTime);
        }
    }

    function _distributeReferralCommissions(address _from, uint256 _amount) internal {

        address[10] memory chain;
        {
            address c = users[_from].referrer;
            for (uint256 j = 0; j < 10; ) {
                chain[j] = c;
                if (c == address(0) || !users[c].isRegistered) break;
                c = users[c].referrer;
                unchecked { j++; }
            }
        }

        uint64 trancheUnlock;
        {
            LPLock[] storage fl = userLPLocks[_from];
            trancheUnlock = fl.length > 0
                ? uint64(fl[fl.length - 1].unlockTime)
                : uint64(block.timestamp + LP_LOCK_DURATION);
        }

        for (uint256 i = 0; i < 10; ) {
            uint256 toDistribute = (_amount * referralCommissionRates[i]) / 10000;
            if (toDistribute == 0) { unchecked { i++; } continue; }

            address naturalRecipient = chain[i];
            uint256 paidToNatural = 0;

            if (naturalRecipient == owner) {

                _payCommission(owner, _from, toDistribute, i + 1);
                paidToNatural = toDistribute;
            } else if (naturalRecipient != address(0) && users[naturalRecipient].isRegistered &&
                       _eligibleForReferralLevel(naturalRecipient, uint8(i))) {
                uint256 cap   = _getCommissionCap(naturalRecipient);
                uint256 toPay = toDistribute < cap ? toDistribute : cap;
                if (toPay > 0) {
                    _chargeCap(naturalRecipient, toPay);

                    uint256 walletCap     = _activeSelfStakeWei(naturalRecipient) / 2;
                    uint256 walletPortion = toPay < walletCap ? toPay : walletCap;
                    if (walletPortion > 0) {
                        _payCommission(naturalRecipient, _from, walletPortion, i + 1);
                    }
                    uint256 reservePortion = toPay - walletPortion;
                    if (reservePortion > 0) {
                        _reserveCommission(naturalRecipient, _from, reservePortion, i + 1, trancheUnlock);
                    }
                    paidToNatural = toPay;
                }
            }

            uint256 toOwner = toDistribute - paidToNatural;
            if (toOwner > 0) {
                _payCommission(owner, _from, toOwner, i + 1);
            }

            if (naturalRecipient != address(0) && users[naturalRecipient].isRegistered &&
                    naturalRecipient != owner && paidToNatural < toDistribute) {
                uint256 missedAmt = toDistribute - paidToNatural;
                totalMissedCommissions[naturalRecipient] += missedAmt;
                uint8 reason;
                if (paidToNatural > 0)                                           reason = 2;
                else if (!_eligibleForReferralLevel(naturalRecipient, uint8(i)))  reason = 0;
                else                                                             reason = 1;
                emit CommissionMissed(naturalRecipient, _from, missedAmt, i + 1, reason);
                _missedRecords[naturalRecipient].push(MissedRecord({
                    from:   _from,
                    ts:     uint64(block.timestamp),
                    level:  uint8(i + 1),
                    reason: reason,
                    amount: uint128(missedAmt)
                }));
            }

            unchecked { i++; }
        }
    }

    function _recordPeriodClaim(address _user, uint256 _lockIndex, uint256 _tokens) internal {
        if (_tokens == 0) return;
        LockPeriod[] storage periods = _lockPeriods[_user][_lockIndex];
        uint256 n = periods.length;
        if (n == 0) return;
        periods[n - 1].claimed += uint128(_tokens);
    }

    function settleStakingRewardExt(address _user, uint256 _lockIndex) external payable onlyDelegatecall {
        _settleStakingReward(_user, _lockIndex);
    }

    function _settleStakingReward(address _user, uint256 _lockIndex) internal {
        LPLock storage lock = userLPLocks[_user][_lockIndex];
        if (lock.removed) return;

        _updateTokenTWAP(platformToken);

        uint256 pendingETH = HordexMath.calcPendingRewardETH(
            lock.rewardRatePPM, lock.ethInvested, lock.lockedAt, lock.unlockTime, lock.rewardClaimedETH
        );
        uint256 carry = lock.tokensAccumulated;

        uint256 price     = _twapPrice();
        uint256 newTokens = price > 0 ? (pendingETH * 1e18) / price : 0;
        uint256 total     = newTokens + carry;

        if (total == 0) return;
        uint256 available = IERC20F(platformToken).balanceOf(address(this));

        if (available < total) return;

        if (newTokens > 0) lock.rewardClaimedETH += pendingETH;
        lock.tokensAccumulated = 0;
        lock.totalTokensClaimed += total;
        _recordPeriodClaim(_user, _lockIndex, total);
        if (!_safeTransfer(platformToken, _user, total)) revert StakingRewardTransferFailed();
        emit StakingRewardClaimed(_user, total, pendingETH);
    }

    function _computeLockReward(LPLock storage lock, uint256 price)
        internal returns (uint256 lockTokens, uint256 pendingETH)
    {
        pendingETH = HordexMath.calcPendingRewardETH(
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

    function claimStakingRewardExt() external payable onlyDelegatecall {
        _updateTokenTWAP(platformToken);
        uint256 price = _twapPrice();
        if (price == 0) revert PriceUnavailable();
        LPLock[] storage locks = userLPLocks[msg.sender];
        uint256 len = locks.length;
        uint256 totalTokens;
        uint256 totalPendingETH;
        for (uint256 i = 0; i < len; ) {
            (uint256 lt, uint256 pe) = _computeLockReward(locks[i], price);
            totalTokens     += lt;
            totalPendingETH += pe;
            _recordPeriodClaim(msg.sender, i, lt);
            unchecked { i++; }
        }
        if (totalTokens == 0) revert NothingToClaim();
        if (IERC20F(platformToken).balanceOf(address(this)) < totalTokens) revert InsufficientTokenBalance();
        totalStakingRewardsPaidETH += totalPendingETH;
        if (!_safeTransfer(platformToken, msg.sender, totalTokens)) revert TokenTransferFailed();
        _claimRecords[msg.sender].push(ClaimRecord({
            tokensAmount:  uint128(totalTokens),
            ethEquivalent: uint128(totalPendingETH),
            ts:            uint64(block.timestamp)
        }));
        emit StakingRewardClaimed(msg.sender, totalTokens, totalPendingETH);
    }

    function claimStakingRewardForLockExt(uint256 _lockIndex) external payable onlyDelegatecall {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        if (lock.removed) revert AlreadyRemoved();
        _updateTokenTWAP(platformToken);
        uint256 price = _twapPrice();
        if (price == 0) revert PriceUnavailable();
        (uint256 tokensToSend, uint256 pendingETH) = _computeLockReward(lock, price);
        if (tokensToSend == 0) revert NothingToClaim();
        if (IERC20F(platformToken).balanceOf(address(this)) < tokensToSend) revert InsufficientTokenBalance();
        _recordPeriodClaim(msg.sender, _lockIndex, tokensToSend);
        totalStakingRewardsPaidETH += pendingETH;
        if (!_safeTransfer(platformToken, msg.sender, tokensToSend)) revert TokenTransferFailed();
        _claimRecords[msg.sender].push(ClaimRecord({
            tokensAmount:  uint128(tokensToSend),
            ethEquivalent: uint128(pendingETH),
            ts:            uint64(block.timestamp)
        }));
        emit StakingRewardClaimed(msg.sender, tokensToSend, pendingETH);
    }

    function investExt(address _token, uint256 rewardPPM, uint256 T) external onlyDelegatecall {
        uint256 A      = T / 2;
        uint256 B      = T - A;
        uint256 A60max = (A * 60) / 100;
        uint256 A40eth = A - A60max;

        address pair = IFactoryF(UNISWAP_FACTORY).getPair(_token, WETH);
        if (pair == address(0)) revert PoolNotFound();

        uint256 platformBuyTokens;
        uint256 swapAmountOutMin;
        uint256 A60actual;
        {
            (uint112 r0, uint112 r1,) = IPairF(pair).getReserves();
            address t0 = IPairF(pair).token0();
            uint256 resToken = t0 == _token ? uint256(r0) : uint256(r1);
            uint256 resUSDT  = t0 == _token ? uint256(r1) : uint256(r0);
            if (resUSDT == 0) revert PriceUnavailable();

            uint256 maxFeasible = HordexMath.calcMaxPoolBuy(
                resToken, resUSDT, _tokenTwapPrice[_token], TWAP_GUARD_BPS
            );
            A60actual = A60max < maxFeasible ? A60max : maxFeasible;

            platformBuyTokens = (A40eth + (A60max - A60actual)) * resToken / resUSDT;

            if (A60actual > 0) {
                uint256 a60Fee       = A60actual * 997;
                uint256 spotExpected = (a60Fee * resToken) / (resUSDT * 1000 + a60Fee);
                swapAmountOutMin     = spotExpected * (10000 - MAX_SLIPPAGE_BPS) / 10000;
            }
        }

        if (IERC20F(_token).balanceOf(address(this)) < platformBuyTokens) revert InsufficientContractTokenBalance();

        uint256 poolBuyTokens = 0;
        if (A60actual > 0) {
            address[] memory path = new address[](2);
            path[0] = WETH;
            path[1] = _token;

            uint256 balanceBefore = IERC20F(_token).balanceOf(address(this));

            IERC20F(WETH).approve(UNISWAP_ROUTER, A60actual);
            IRouterF(UNISWAP_ROUTER).swapExactTokensForTokens(
                A60actual, swapAmountOutMin, path, address(this), block.timestamp + 300
            );
            IERC20F(WETH).approve(UNISWAP_ROUTER, 0);

            poolBuyTokens = IERC20F(_token).balanceOf(address(this)) - balanceBefore;
        }
        uint256 totalTokens = poolBuyTokens + platformBuyTokens;

        if (IERC20F(_token).balanceOf(address(this)) < totalTokens) revert InsufficientContractTokenBalance();

        IERC20F(_token).approve(UNISWAP_ROUTER, totalTokens);
        IERC20F(WETH).approve(UNISWAP_ROUTER, B);

        (,, uint256 lpReceived) = IRouterF(UNISWAP_ROUTER).addLiquidity(
            _token,
            WETH,
            totalTokens,
            B,
            0,
            B * (10000 - MAX_SLIPPAGE_BPS) / 10000,
            address(this),
            block.timestamp + 300
        );

        IERC20F(_token).approve(UNISWAP_ROUTER, 0);
        IERC20F(WETH).approve(UNISWAP_ROUTER, 0);

        if (lpReceived == 0) revert NoLPTokens();

        {
            (uint112 pr0, uint112 pr1,) = IPairF(pair).getReserves();
            address pt0 = IPairF(pair).token0();
            _tradeHistory[_token].push(TradeSnap({
                ts:     uint64(block.timestamp),
                isBuy:  true,
                ethAmt: uint128(A60actual),
                tokAmt: uint128(poolBuyTokens)
            }));
            _priceHistory[_token].push(PriceSnap({
                ts:       uint64(block.timestamp),
                resETH:   uint112(pt0 == _token ? pr1 : pr0),
                resToken: uint112(pt0 == _token ? pr0 : pr1)
            }));
        }

        userLPLocks[msg.sender].push(LPLock({
            token:              _token,
            claimed:            false,
            removed:            false,
            capPaused:          false,
            lpAmount:           lpReceived,
            unlockTime:         block.timestamp + LP_LOCK_DURATION,
            ethInvested:        T,
            lockedAt:           block.timestamp,
            rewardClaimedETH:   0,
            tokensAccumulated:  0,
            totalTokensClaimed: 0,
            rewardRatePPM:      rewardPPM,

            restakeCounts:      [uint8(0), 0, 0, 1, 0, 0],
            streakBaseEth:      T,
            commissionsCapUsed: 0
        }));

        _totalLockedLP[pair] += lpReceived;

        _lockPeriods[msg.sender][userLPLocks[msg.sender].length - 1].push(LockPeriod({
            start:   uint64(block.timestamp),
            end:     uint64(block.timestamp + LP_LOCK_DURATION),
            claimed: 0
        }));

        _investRecords[msg.sender].push(InvestRecord({
            token:         _token,
            ts:            uint64(block.timestamp),
            ethAmount:     uint128(T),
            lpTokens:      uint128(lpReceived),
            poolBuyTokens: uint128(poolBuyTokens),
            totalTokens:   uint128(totalTokens)
        }));

        emit Invested(msg.sender, _token, T, lpReceived);
    }

    function _getRewardRatePPM(uint256 ethInvestedWei, uint256 durationDays, uint256 streakLevel) internal view returns (uint256) {
        if (ethInvestedWei / USDT_ONE < 100) return 0;
        uint256 sIdx = streakLevel > 3 ? 3 : streakLevel;
        return stakingRates
            [HordexMath.getDurationIndex(stakingDurations, durationDays)]
            [HordexMath.getTierIndex(investmentTiers, ethInvestedWei)]
            [sIdx];
    }

    function removeLPCoreExt(uint256 _lockIndex, bool direct) external payable onlyDelegatecall {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        if (direct) {
            if (lock.removed)  revert AlreadyRemoved();
            if (lock.claimed)  revert LPAlreadyClaimed();
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

        if (userTotalInvested[msg.sender] >= ethInvested) {
            userTotalInvested[msg.sender] -= ethInvested;
        }

        _syncReferralCount(msg.sender);

        if (_roiRetainedAt[msg.sender] == 0 && _getRawAvailableCapInclExpired(msg.sender) == 0) {
            uint256 cap5     = ethInvested * 5;
            uint256 retained = cap5 > lock.commissionsCapUsed ? cap5 - lock.commissionsCapUsed : 0;
            if (retained > 0) {
                _roiRetainedCap[msg.sender] = retained;
                _roiRetainedAt[msg.sender]  = uint64(lock.unlockTime);
                _capPausedAt[msg.sender]    = 0;
            }
        }

        address pair = IFactoryF(UNISWAP_FACTORY).getPair(lock.token, WETH);
        if (pair == address(0)) revert PoolNotFound();

        if (direct) {

            if (_totalLockedLP[pair] >= lpAmount) _totalLockedLP[pair] -= lpAmount;
        } else {
            if (!_safeTransferFrom(pair, msg.sender, address(this), lpAmount)) revert LPPullFailed();
        }
        IERC20F(pair).approve(UNISWAP_ROUTER, lpAmount);

        uint256 minTokenOut;
        uint256 minETHOut;
        {
            IPairF p = IPairF(pair);
            (uint112 r0, uint112 r1,) = p.getReserves();
            address t0     = p.token0();
            uint256 resTok = t0 == lock.token ? uint256(r0) : uint256(r1);
            uint256 resETH = t0 == lock.token ? uint256(r1) : uint256(r0);
            uint256 supply = p.totalSupply();
            (minTokenOut, minETHOut) = HordexMath.calcRemoveLPAmounts(resTok, resETH, supply, lpAmount, MAX_SLIPPAGE_BPS);
        }

        (uint256 tokensReturned, uint256 usdtReturned) = IRouterF(UNISWAP_ROUTER)
            .removeLiquidity(lock.token, WETH, lpAmount, minTokenOut, minETHOut, address(this), block.timestamp + 300);

        if (tokensReturned > 0) {
            uint256 tokenFee    = tokensReturned * 5 / 100;
            uint256 tokensToUser = tokensReturned - tokenFee;
            if (!_safeTransfer(lock.token, msg.sender, tokensToUser)) revert TokenReturnFailed();
            if (tokenFee > 0) _safeTransfer(lock.token, owner, tokenFee);
        }
        if (usdtReturned > 0) {
            uint256 usdtFee    = usdtReturned * 5 / 100;
            uint256 usdtToUser = usdtReturned - usdtFee;
            if (!_safeTransfer(WETH, msg.sender, usdtToUser)) revert ETHReturnFailed();
            if (usdtFee > 0) _safeTransfer(WETH, owner, usdtFee);
        }

        _lpEventRecords[msg.sender].push(LPEventRecord({
            token:       lock.token,
            ts:          uint64(block.timestamp),
            isClaim:     false,
            lpAmount:    uint128(lpAmount),
            ethReturned: uint128(usdtReturned)
        }));

        emit LPRemoved(msg.sender, lock.token, lpAmount, usdtReturned, tokensReturned);
    }

    function restakeLPExt(uint256 _lockIndex, uint256 _durationDays) external payable onlyDelegatecall {
        LPLock storage lock = userLPLocks[msg.sender][_lockIndex];
        if (lock.claimed)  revert LPAlreadyClaimed();
        if (lock.removed)  revert AlreadyRemoved();
        if (block.timestamp < lock.unlockTime) revert LPStillLocked();
        if (lock.lpAmount == 0) revert NoLPTokens();

        _updateTokenTWAP(platformToken);
        if (!_tokenTwapReady[platformToken]) revert PriceUnavailable();
        if (block.timestamp - _tokenTwapLastUpdated[platformToken] > TWAP_MAX_STALE) revert TWAPStale();

        uint256 price = _twapPrice();
        uint256 pendingETH = HordexMath.calcPendingRewardETH(
            lock.rewardRatePPM, lock.ethInvested, lock.lockedAt, lock.unlockTime, lock.rewardClaimedETH
        );
        if (pendingETH > 0) lock.tokensAccumulated += (pendingETH * 1e18) / price;

        uint256 dIdx = HordexMath.getDurationIndex(stakingDurations, _durationDays);

        if (lock.streakBaseEth != 0 && lock.ethInvested != lock.streakBaseEth) {
            for (uint256 i = 0; i < 6; ) {
                lock.restakeCounts[i] = 0;
                unchecked { i++; }
            }
            lock.streakBaseEth = lock.ethInvested;
        }

        uint256 cnt  = lock.restakeCounts[dIdx];
        uint256 sIdx = cnt > 3 ? 3 : cnt;
        if (cnt < 4) lock.restakeCounts[dIdx] = uint8(cnt + 1);

        lock.lockedAt         = block.timestamp;
        lock.unlockTime       = block.timestamp + _durationDays * SECONDS_PER_DAY;
        lock.rewardClaimedETH = 0;
        lock.rewardRatePPM    = _getRewardRatePPM(lock.ethInvested, _durationDays, sIdx);

        _lockPeriods[msg.sender][_lockIndex].push(LockPeriod({
            start:   uint64(block.timestamp),
            end:     uint64(lock.unlockTime),
            claimed: 0
        }));

        emit LPRestaked(msg.sender, lock.token, lock.lpAmount, lock.unlockTime, _durationDays);
    }

    function getAvailableCapExt(address _user) external view returns (uint256) {
        return _getAvailableCap(_user);
    }

    function rescueETH() external {
        if (address(this) != _self) revert NotDirectCall();
        if (msg.sender != _deployer) revert NotOwner();
        uint256 bal = address(this).balance;
        if (bal == 0) revert NoETHToWithdraw();
        (bool ok,) = payable(_deployer).call{value: bal}("");
        if (!ok) revert ETHWithdrawFailed();
    }

    function rescueToken(address _token, uint256 amount) external {
        if (address(this) != _self) revert NotDirectCall();
        if (msg.sender != _deployer) revert NotOwner();
        uint256 bal = IERC20F(_token).balanceOf(address(this));
        uint256 toSend = amount == 0 ? bal : (amount > bal ? bal : amount);
        if (toSend == 0) revert NoTokensToWithdraw();
        if (!_safeTransfer(_token, _deployer, toSend)) revert TokenWithdrawFailed();
    }

    receive() external payable {}
}
