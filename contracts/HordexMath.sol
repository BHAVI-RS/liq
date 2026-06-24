// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HordexTypes.sol"; // for the shared SECONDS_PER_DAY / LP_LOCK_DURATION constants

interface IUniV2PairMin {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

interface IUniV2FactoryMin {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

library HordexMath {
    // LP_LOCK_DURATION and USDT_ONE come from HordexTypes.sol (shared switches).

    function getTierIndex(uint32[12] memory tiers, uint256 ethInvestedWei)
        public pure returns (uint256 best)
    {
        uint256 usdtAmt  = ethInvestedWei / USDT_ONE;
        uint256 t0       = tiers[0];
        uint256 bestDiff = usdtAmt >= t0 ? usdtAmt - t0 : t0 - usdtAmt;
        for (uint256 i = 1; i < 12; ) {
            uint256 ti = tiers[i];
            uint256 d  = usdtAmt >= ti ? usdtAmt - ti : ti - usdtAmt;
            if (d < bestDiff) { bestDiff = d; best = i; }
            unchecked { i++; }
        }
    }

    function getDurationIndex(uint16[6] memory durations, uint256 durationDays)
        public pure returns (uint256 best)
    {
        uint256 s0       = durations[0];
        uint256 bestDiff = durationDays >= s0 ? durationDays - s0 : s0 - durationDays;
        for (uint256 i = 1; i < 6; ) {
            uint256 si = durations[i];
            uint256 d  = durationDays >= si ? durationDays - si : si - durationDays;
            if (d < bestDiff) { bestDiff = d; best = i; }
            unchecked { i++; }
        }
    }

    function calcPendingRewardETH(
        uint256 rewardRatePPM,
        uint256 ethInvested,
        uint256 lockedAt,
        uint256 unlockTime,
        uint256 rewardClaimedETH
    ) public view returns (uint256) {
        if (rewardRatePPM == 0) return 0;
        uint256 lockDur     = unlockTime > lockedAt ? unlockTime - lockedAt : LP_LOCK_DURATION;
        uint256 elapsed     = block.timestamp > lockedAt ? block.timestamp - lockedAt : 0;
        if (elapsed > lockDur) elapsed = lockDur;
        uint256 totalEarned = (ethInvested * rewardRatePPM * elapsed) / (1_000_000 * lockDur);
        return totalEarned > rewardClaimedETH ? totalEarned - rewardClaimedETH : 0;
    }

    function tokenPriceInETH(address factory, address _platformToken, address weth)
        public view returns (uint256)
    {
        address pair = IUniV2FactoryMin(factory).getPair(_platformToken, weth);
        if (pair == address(0)) return 0;
        IUniV2PairMin p = IUniV2PairMin(pair);
        (uint112 r0, uint112 r1,) = p.getReserves();
        address t0 = p.token0();
        uint256 resToken = t0 == _platformToken ? uint256(r0) : uint256(r1);
        uint256 resETH   = t0 == _platformToken ? uint256(r1) : uint256(r0);
        if (resToken == 0) return 0;
        return (resETH * 1e18) / resToken;
    }

    function pairCumulative(address pair, address _platformToken)
        public view returns (uint256 priceCumulative, uint32 blockTimestamp)
    {
        IUniV2PairMin p = IUniV2PairMin(pair);
        (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) = p.getReserves();
        address t0 = p.token0();
        blockTimestamp = uint32(block.timestamp);

        if (t0 == _platformToken) {
            priceCumulative = p.price0CumulativeLast();
            if (blockTimestampLast != blockTimestamp && reserve0 > 0) {
                unchecked {
                    uint32 dt = blockTimestamp - blockTimestampLast;
                    priceCumulative += (uint256(reserve1) << 112) / uint256(reserve0) * uint256(dt);
                }
            }
        } else {
            priceCumulative = p.price1CumulativeLast();
            if (blockTimestampLast != blockTimestamp && reserve1 > 0) {
                unchecked {
                    uint32 dt = blockTimestamp - blockTimestampLast;
                    priceCumulative += (uint256(reserve0) << 112) / uint256(reserve1) * uint256(dt);
                }
            }
        }
    }

    // Returns the maximum ETH that can be swapped in a single invest() call while
    // keeping the resulting spot price within TWAP_GUARD_BPS of the TWAP price.
    // Derived by solving: spotExpected(A60) >= A60 * (1e18/twapPrice) * alphaBPS/10000
    // for A60, cancelling the common A60 factor and rearranging.
    function calcMaxPoolBuy(
        uint256 resToken,
        uint256 resETH,
        uint256 twapPrice,
        uint256 twapGuardBPS
    ) public pure returns (uint256 maxA60) {
        if (twapPrice == 0) return 0;
        uint256 alphaBPS = 10000 - twapGuardBPS;
        uint256 numer    = 997 * resToken * twapPrice * 10000;
        uint256 sub      = 1e18 * alphaBPS * resETH * 1000;
        if (numer <= sub) return 0;
        maxA60 = (numer - sub) / (997 * 1e18 * alphaBPS);
    }

    // Pure AMM math for the invest() swap+liquidity calculation.
    // Extracted from Hordex.invest() so this bytecode lives in the library.
    function calcInvestAmounts(
        uint256 A60,
        uint256 A40,
        uint256 resToken,
        uint256 resETH,
        uint256 maxSlippageBPS
    ) public pure returns (uint256 platformBuyTokens, uint256 swapAmountOutMin) {
        platformBuyTokens    = A40 * resToken / resETH;
        uint256 a60Fee       = A60 * 997;
        uint256 expected     = (a60Fee * resToken) / (resETH * 1000 + a60Fee);
        swapAmountOutMin     = expected * (10000 - maxSlippageBPS) / 10000;
    }

    // Hybrid buy split: route up to a slippage-capped amount through the AMM pool, then fill the
    // remainder from the platform's own token inventory at the post-pool spot price. Used by both
    // Hordex.swapBuy (execution) and HordexViewFacet.quoteSwapBuy (display) so the quoted
    // "tokens to receive" matches the trade exactly.
    //   slippageBps — max effective price slippage (price impact + 0.3% pool fee) on the pool leg
    //                 (e.g. 200 = 2%). The pool leg never moves the price more than this.
    //   invBal      — contract's current token balance available to backstop the buy.
    // Returns the USDT routed to the pool, tokens bought from the pool, tokens sold from inventory,
    // and the total USDT actually spent (usdtIn - usdtSpent is refunded to the buyer).
    function calcHybridBuy(
        uint256 resToken,
        uint256 resETH,
        uint256 usdtIn,
        uint256 invBal,
        uint256 slippageBps
    ) public pure returns (
        uint256 poolUsdt,
        uint256 poolTokensOut,
        uint256 invTokensOut,
        uint256 usdtSpent
    ) {
        // Max USDT into the pool keeping avgPrice/spot = (1000*resETH + 997*poolUsdt)/(997*resETH)
        // within 1 + slippageBps/10000.  => poolUsdt <= resETH*(997*bps - 30000)/9_970_000.
        uint256 feeAdj      = 997 * slippageBps;
        uint256 maxPoolUsdt = feeAdj > 30000 ? resETH * (feeAdj - 30000) / 9970000 : 0;

        poolUsdt = usdtIn > maxPoolUsdt ? maxPoolUsdt : usdtIn;
        if (poolUsdt > 0) {
            uint256 amtInFee = poolUsdt * 997;
            poolTokensOut    = (amtInFee * resToken) / (resETH * 1000 + amtInFee);
        }
        usdtSpent = poolUsdt;

        uint256 remainingUsdt = usdtIn - poolUsdt;
        if (remainingUsdt > 0) {
            uint256 newResETH = resETH + poolUsdt;
            uint256 newResTok = resToken > poolTokensOut ? resToken - poolTokensOut : 0;
            if (newResTok > 0) {
                // Inventory priced at the post-pool spot price (no extra slippage).
                uint256 wantInv = remainingUsdt * newResTok / newResETH;
                if (wantInv <= invBal) {
                    invTokensOut = wantInv;
                    usdtSpent   += remainingUsdt;                 // full fill — no refund
                } else {
                    invTokensOut = invBal;                        // inventory short — partial fill
                    usdtSpent   += invBal * newResETH / newResTok; // charge only for what we deliver
                }
            }
        }
    }

    // Pure AMM math for the removeLiquidity slippage guards.
    // Extracted from Hordex._removeLPCore() so this bytecode lives in the library.
    function calcRemoveLPAmounts(
        uint256 resTok,
        uint256 resETH,
        uint256 supply,
        uint256 lpAmount,
        uint256 maxSlippageBPS
    ) public pure returns (uint256 minTokenOut, uint256 minETHOut) {
        if (supply > 0) {
            minTokenOut = resTok * lpAmount / supply * (10000 - maxSlippageBPS) / 10000;
            minETHOut   = resETH * lpAmount / supply * (10000 - maxSlippageBPS) / 10000;
        }
    }
}
