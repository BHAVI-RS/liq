// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HordexTypes.sol";
import "./HordexMath.sol";

/**
 * @title  HordexViewLib — View Computation Library
 * @notice Shared computation helpers for Hordex's read-only views. https://hordex.club
 *
 * @dev Lightweight, pure helpers that summarize a participant's positions and rewards from a
 *      snapshot of on-chain state. Used by the platform's analytics layer to present clear,
 *      accurate portfolio and reward information drawn directly from verifiable chain data.
 */
interface IUniV2PairView {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function totalSupply() external view returns (uint256);
}

interface IUniV2FactoryView {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

library HordexViewLib {

    function computeStakingReward(
        LPLock[] memory locks,
        uint256 price
    ) public view returns (
        uint256 totalAccumulated,
        uint256 previewNewTokens,
        uint256 lifetimeClaimed
    ) {
        uint256 len = locks.length;
        for (uint256 i = 0; i < len; ) {
            totalAccumulated += locks[i].tokensAccumulated;
            lifetimeClaimed  += locks[i].totalTokensClaimed;
            if (price > 0) {
                uint256 pendingETH = HordexMath.calcPendingRewardETH(
                    locks[i].rewardRatePPM, locks[i].ethInvested, locks[i].lockedAt,
                    locks[i].unlockTime, locks[i].rewardClaimedETH
                );
                if (pendingETH > 0) previewNewTokens += (pendingETH * 1e18) / price;
            }
            unchecked { i++; }
        }
    }

    function computeCommissionStats(
        LPLock[] memory locks,
        uint256 earned,
        uint256 totalInvested,
        uint256 timestamp
    ) public pure returns (
        uint256,
        uint256,
        uint256 totalCap,
        uint256 remainingCap,
        uint256
    ) {
        uint256 activeCap;
        uint256 pausedCap;
        uint256 len = locks.length;
        for (uint256 i = 0; i < len; ) {
            LPLock memory l = locks[i];
            if (!l.removed && !l.capPaused) {
                uint256 cap     = l.ethInvested * 5;
                uint256 capLeft = l.commissionsCapUsed < cap ? cap - l.commissionsCapUsed : 0;
                if (capLeft > 0) {
                    if (timestamp < l.unlockTime) {
                        activeCap += capLeft;
                    } else {
                        pausedCap += capLeft;
                    }
                }
            }
            unchecked { i++; }
        }
        return (earned, 0, activeCap + pausedCap, activeCap, totalInvested);
    }

    function computeWealthParams(
        LPLock[] memory locks,
        uint256 refEarnings,
        uint256 platformTokenPriceEth,
        uint256 lpLockDuration,
        address factory,
        address weth
    ) public view returns (WealthParams memory p) {
        p.refEarnings           = refEarnings;
        p.platformTokenPriceEth = platformTokenPriceEth;
        p.lpLockDuration        = lpLockDuration;

        uint256 len = locks.length;
        p.locks = new WealthLockParam[](len);
        for (uint256 i = 0; i < len; ) {
            LPLock memory l = locks[i];
            p.locks[i].ethInvested       = l.ethInvested;
            p.locks[i].rewardRatePPM     = l.rewardRatePPM;
            p.locks[i].lockedAt          = l.lockedAt;
            p.locks[i].unlockTime        = l.unlockTime;
            p.locks[i].removed           = l.removed;
            p.locks[i].tokensAccumulated = l.tokensAccumulated;
            p.locks[i].lpAmount          = l.lpAmount;
            if (!l.removed && l.lpAmount > 0) {
                address pair = IUniV2FactoryView(factory).getPair(weth, l.token);
                if (pair != address(0)) {
                    IUniV2PairView pairContract = IUniV2PairView(pair);
                    (uint112 r0, uint112 r1,) = pairContract.getReserves();
                    address t0 = pairContract.token0();
                    p.locks[i].reserveETH    = (t0 == weth) ? uint256(r0) : uint256(r1);
                    p.locks[i].totalLPSupply = pairContract.totalSupply();
                }
            }
            unchecked { i++; }
        }
    }
}
