// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

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
    address token;              // slot 0: 20 bytes
    bool claimed;               //         +1 byte
    bool removed;               //         +1 byte
    bool capPaused;             //         +1 byte  (23 bytes total, slot 0)
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

// On-chain price snapshot written by seedPool() and invest() for frontend charting.
// Avoids unreliable eth_getLogs on public RPCs.
struct PriceSnap {
    uint64  ts;       // block.timestamp
    uint112 resETH;   // WETH reserve after the operation
    uint112 resToken; // token reserve after the operation
}

// On-chain trade snapshot written by invest() for frontend trade history.
struct TradeSnap {
    uint64  ts;
    bool    isBuy;   // always true for invest() swaps
    uint128 ethAmt;  // ETH spent in the swap
    uint128 tokAmt;  // tokens received from the swap
}

// On-chain commission record (avoids unreliable eth_getLogs on Amoy RPC).
struct CommissionRecord {
    address from;     // slot 0: 160 bits
    uint64  ts;       //         +64  = 224 bits
    uint8   level;    //         +8   = 232 bits
    uint128 amount;   // slot 1: 128 bits
}

// On-chain missed-commission record — reason: 0=level-ineligible, 1=no-cap, 2=cap-overflow.
struct MissedRecord {
    address from;     // slot 0: 160 bits
    uint64  ts;       //         +64  = 224 bits
    uint8   level;    //         +8   = 232 bits
    uint8   reason;   //         +8   = 240 bits
    uint128 amount;   // slot 1: 128 bits
}

// On-chain invest record for frontend history tab.
struct InvestRecord {
    address token;         // slot 0: 160 bits
    uint64  ts;            //         +64  = 224 bits
    uint128 ethAmount;     // slot 1: 128 bits
    uint128 lpTokens;      //         +128 = 256 bits
    uint128 poolBuyTokens; // slot 2: tokens bought from pool (A60 swap leg)
    uint128 totalTokens;   //         +128 = 256 bits  (poolBuyTokens + platform supply → sent to addLiquidityETH)
}

// On-chain staking claim record for frontend history tab.
struct ClaimRecord {
    uint128 tokensAmount;   // slot 0: 128 bits
    uint128 ethEquivalent;  //         +128 = 256 bits
    uint64  ts;             // slot 1: 64 bits
}

// On-chain LP event record (claim or remove) for frontend history tab.
struct LPEventRecord {
    address token;      // slot 0: 160 bits
    uint64  ts;         //         +64  = 224 bits
    bool    isClaim;    //         +8   = 232 bits
    uint128 lpAmount;   // slot 1: 128 bits
    uint128 ethReturned;//         +128 = 256 bits
}

// ROI commission stream — one per level per LP lock.
struct ROIStream {
    address recipient;           // who is currently accumulating this stream
    uint64  recipientSince;      // timestamp when current recipient started
    bool    ended;               // true once the underlying lock is removed
    uint128 roiPaidETH;          // ETH-equiv settled in the CURRENT lock period
    uint128 capETH;              // cap for the CURRENT period = ethInvested * commissionRate / 10_000
    uint128 historicalPaidETH;   // cumulative ETH-equiv paid across ALL previous periods (restakes)
    uint128 historicalMissedETH; // cumulative ROI missed (cap-blocked) across ALL previous periods
}

// Pointer stored in _activeROIStreams / _skippedROIStreams per address.
struct StreamRef {
    address investor;
    uint64  lockIndex;
    uint8   level;
}

// Compact per-referral info for the dashboard's Direct Referral Performance section.
// Returned by getDirectRefsInfo() to replace N×3 individual RPC calls with one batch call.
struct DirectRefInfo {
    address addr;
    uint256 totalInvested;
    uint256 directRefCount;
    uint256 remainingCap;   // activeCap: cap from locks still within unlock window
    uint256 totalCap;       // activeCap + pausedCap
}

// Flattened downline node returned by getDownline().
// Lets the frontend rebuild the whole referral tree (genealogy + team stats) from a
// single RPC call instead of one getReferrals()/userTotalInvested() call per member.
// parent is the index (in the returned array) of this node's referrer; the root node
// is at index 0 with parent == 0 and depth == 0. Children are reconstructed client-side
// by grouping nodes under their parent index.
struct DownlineNode {
    address addr;
    uint32  parent;        // index into the returned array
    uint32  depth;         // 0 = root, 1 = direct referral, …
    uint256 totalInvested; // userTotalInvested[addr]
}
