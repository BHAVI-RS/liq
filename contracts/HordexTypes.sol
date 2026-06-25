// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/*
 * HordexTypes — Shared Data Definitions
 *
 * Common constants and data structures used across the entire Hordex platform.
 * https://hordex.club
 *
 * Hordex is a transparent, fully on-chain DeFi platform on Polygon where participants
 * provide liquidity, stake, and earn rewards. This file is the single source of truth
 * for the platform's shared types and configuration so every component speaks the same
 * language and stays perfectly in sync:
 *        - SECONDS_PER_DAY / LP_LOCK_DURATION : the time basis for staking and reward cycles.
 *        - USDT_ONE                            : the stablecoin unit of account for packages,
 *                                                tiers, and team-business totals.
 *        - Structs (User, LPLock, ROIStream, history records, …) : richly indexed on-chain
 *          records that let the interface render a complete, verifiable view of every
 *          position, reward, and referral directly from chain state.
 */
uint256 constant SECONDS_PER_DAY = 86400;

uint256 constant LP_LOCK_DURATION = 90 * SECONDS_PER_DAY;

uint256 constant USDT_ONE = 1e6;

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

struct LPLock {
    address token;
    bool claimed;
    bool removed;
    bool capPaused;
    uint256 lpAmount;
    uint256 unlockTime;
    uint256 ethInvested;
    uint256 lockedAt;
    uint256 rewardClaimedETH;
    uint256 tokensAccumulated;
    uint256 totalTokensClaimed;
    uint256 rewardRatePPM;
    uint8[6] restakeCounts;
    uint256 streakBaseEth;
    uint256 commissionsCapUsed;
}

struct TwapObs {
    uint256 priceCumulative;
    uint32  timestamp;
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

struct PriceSnap {
    uint64  ts;
    uint112 resETH;
    uint112 resToken;
}

struct TradeSnap {
    uint64  ts;
    bool    isBuy;
    uint128 ethAmt;
    uint128 tokAmt;
}

struct CommissionRecord {
    address from;
    uint64  ts;
    uint8   level;
    uint128 amount;
}

struct MissedRecord {
    address from;
    uint64  ts;
    uint8   level;
    uint8   reason;
    uint128 amount;
}

struct InvestRecord {
    address token;
    uint64  ts;
    uint128 ethAmount;
    uint128 lpTokens;
    uint128 poolBuyTokens;
    uint128 totalTokens;
}

struct ClaimRecord {
    uint128 tokensAmount;
    uint128 ethEquivalent;
    uint64  ts;
}

struct LockPeriod {
    uint64  start;
    uint64  end;
    uint128 claimed;
}

struct LPEventRecord {
    address token;
    uint64  ts;
    bool    isClaim;
    uint128 lpAmount;
    uint128 ethReturned;
}

struct ROIStream {
    address recipient;
    uint64  recipientSince;
    bool    ended;
    uint128 roiPaidETH;
    uint128 capETH;
    uint128 historicalPaidETH;
    uint128 historicalMissedETH;
    uint128 heldCarryETH;

}

struct StreamRef {
    address investor;
    uint64  lockIndex;
    uint8   level;
}

struct ReserveTranche {
    uint128 amount;
    uint64  unlockTime;
}

struct DirectRefInfo {
    address addr;
    uint256 totalInvested;
    uint256 directRefCount;
    uint256 remainingCap;
    uint256 totalCap;
}

struct DownlineNode {
    address addr;
    uint32  parent;
    uint32  depth;
    uint256 totalInvested;
}
