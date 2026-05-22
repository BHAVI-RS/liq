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
