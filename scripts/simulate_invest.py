"""
Hordex Investment Simulator
Mirrors the on-chain invest() logic in pure Python (all values in USD).

Assumptions
  - TWAP price = current spot price (valid for a stable, recently-warmed pool)
  - USDT_PER_ETH = 10000  (1 MATIC = $10,000)
  - TWAP_GUARD_BPS = 500  (5% max deviation)
  - MAX_SLIPPAGE_BPS = 200 (2% execution slippage tolerance)
"""

TWAP_GUARD_BPS  = 500
SLIPPAGE_BPS    = 200
USDT_PER_ETH    = 10000


# ── Core math (USD-native, derived from Solidity wei formulas) ────────────────

def calc_max_pool_buy(res_token, res_usdt, twap_price_usd, twap_guard_bps=TWAP_GUARD_BPS):
    """
    Maximum USD that can be swapped into the pool while keeping the resulting
    spot price within twap_guard_bps of the TWAP price.

    Closed-form solution (USD version of LiquidityMath.calcMaxPoolBuy):
      maxA60_USD = (9_970_000 * resToken * twapPrice - 1000 * alphaBPS * resUSDT)
                   / (997 * alphaBPS)
    """
    if twap_price_usd <= 0:
        return 0.0
    alpha_bps = 10_000 - twap_guard_bps
    numer = 9_970_000 * res_token * twap_price_usd - 1_000 * alpha_bps * res_usdt
    denom = 997 * alpha_bps
    return max(0.0, numer / denom)


def amm_out(swap_usd, res_token, res_usdt):
    """
    Uniswap V2 output tokens for a given USD swap (0.3% fee applied).
    Formula: out = (swap * 997 * resToken) / (resUSDT * 1000 + swap * 997)
    """
    fee_in = swap_usd * 997
    return (fee_in * res_token) / (res_usdt * 1_000 + fee_in)


# ── Main simulator ────────────────────────────────────────────────────────────

def simulate_invest(res_token, res_usdt, investment_usd,
                    twap_guard_bps=TWAP_GUARD_BPS,
                    slippage_bps=SLIPPAGE_BPS):
    """
    Simulate one invest() transaction.

    Returns a dict with all intermediate values and final results.
    """
    if res_usdt <= 0 or res_token <= 0:
        raise ValueError("Pool reserves must be positive.")
    if investment_usd <= 0:
        raise ValueError("Investment must be positive.")

    spot_price = res_usdt / res_token          # USD per token (= TWAP for stable pool)

    # ── Split ─────────────────────────────────────────────────────────────────
    A      = investment_usd / 2                # 50 %  — token acquisition budget
    B      = investment_usd - A                # 50 %  — LP ETH side
    A60max = A * 0.60                          # 30 %  — max allowed for pool buy
    A40eth = A - A60max                        # 20 %  — fixed referral commission source

    # ── Pool buy cap ──────────────────────────────────────────────────────────
    max_feasible = calc_max_pool_buy(res_token, res_usdt, spot_price, twap_guard_bps)
    A60actual    = min(A60max, max_feasible)
    excess       = A60max - A60actual          # stays in contract

    pool_capped  = A60actual < A60max          # True when pool was the bottleneck

    # ── Tokens acquired ───────────────────────────────────────────────────────
    pool_buy_tokens     = amm_out(A60actual, res_token, res_usdt) if A60actual > 0 else 0.0
    platform_buy_tokens = (A40eth + excess) * res_token / res_usdt   # at current spot
    total_tokens        = pool_buy_tokens + platform_buy_tokens

    # ── Slippage guard (minimum acceptable swap output) ───────────────────────
    swap_min_out = pool_buy_tokens * (10_000 - slippage_bps) / 10_000

    # ── Post-swap pool state ──────────────────────────────────────────────────
    new_res_usdt  = res_usdt  + A60actual
    new_res_token = res_token - pool_buy_tokens
    new_price     = new_res_usdt / new_res_token if new_res_token > 0 else float("inf")
    price_impact  = (new_price - spot_price) / spot_price * 100

    # ── Pool utilisation ──────────────────────────────────────────────────────
    pool_used_pct    = (A60actual / A60max  * 100) if A60max > 0 else 0
    platform_pct     = platform_buy_tokens / total_tokens * 100 if total_tokens > 0 else 0
    pool_pct         = pool_buy_tokens     / total_tokens * 100 if total_tokens > 0 else 0

    return dict(
        # Inputs
        res_token        = res_token,
        res_usdt         = res_usdt,
        investment_usd   = investment_usd,
        spot_price       = spot_price,

        # Split
        lp_eth_usd       = B,
        token_budget_usd = A,
        A60max_usd       = A60max,
        A40eth_usd       = A40eth,

        # Pool buy
        max_feasible_usd = max_feasible,
        A60actual_usd    = A60actual,
        pool_capped      = pool_capped,
        excess_usd       = excess,

        # Token acquisition
        pool_buy_tokens      = pool_buy_tokens,
        platform_buy_tokens  = platform_buy_tokens,
        total_tokens         = total_tokens,
        swap_min_out         = swap_min_out,

        # Commissions
        commissions_usd  = A40eth,

        # Pool after swap
        new_price        = new_price,
        price_impact_pct = price_impact,
        new_res_usdt     = new_res_usdt,
        new_res_token    = new_res_token,

        # Ratios
        pool_used_pct    = pool_used_pct,
        pool_token_pct   = pool_pct,
        platform_pct     = platform_pct,
    )


# ── Display ───────────────────────────────────────────────────────────────────

def print_report(r):
    W = 56
    sep  = lambda c="─": print(c * W)
    head = lambda t: (sep(), print(f"  {t}"), sep())
    usd  = lambda v: f"${v:>17,.2f}"
    tok  = lambda v: f"{v:>17,.4f} tokens"
    pct  = lambda v: f"{v:>16,.2f}%"

    print("=" * W)
    print(f"  {'HORDEX INVESTMENT SIMULATION':^{W-4}}")
    print("=" * W)

    head("POOL STATE")
    print(f"  Tokens in pool       : {tok(r['res_token'])}")
    print(f"  USDT in pool         : {usd(r['res_usdt'])}")
    print(f"  Spot / TWAP price    : ${r['spot_price']:>16,.6f} per token")

    head("INVESTMENT SPLIT")
    print(f"  Total investment     : {usd(r['investment_usd'])}")
    print(f"  LP ETH side   (50 %) : {usd(r['lp_eth_usd'])}")
    print(f"  Token budget  (50 %) : {usd(r['token_budget_usd'])}")
    print(f"    ├─ Pool buy max (30%) : {usd(r['A60max_usd'])}")
    print(f"    └─ Platform fixed (20%): {usd(r['A40eth_usd'])}")

    head("POOL BUY  (Uniswap Swap)")
    print(f"  Max pool can absorb  : {usd(r['max_feasible_usd'])}")
    print(f"  Actual swap amount   : {usd(r['A60actual_usd'])}")
    print(f"  Pool buy utilisation : {pct(r['pool_used_pct'])}")
    print(f"  Tokens received      : {tok(r['pool_buy_tokens'])}")
    print(f"  Swap min out (2% sl.): {tok(r['swap_min_out'])}")
    if r["pool_capped"]:
        print(f"  ⚠  Pool capped — {usd(r['excess_usd'])} unspent")

    head("PLATFORM BUY  (Contract Reserve)")
    print(f"  Fixed 20% component  : {usd(r['A40eth_usd'])}")
    print(f"  Pool shortfall comp. : {usd(r['excess_usd'])}")
    print(f"  Total USD equivalent : {usd(r['A40eth_usd'] + r['excess_usd'])}")
    print(f"  Tokens provided      : {tok(r['platform_buy_tokens'])}")

    head("RESULT SUMMARY")
    print(f"  Pool buy tokens      : {tok(r['pool_buy_tokens'])}  ({r['pool_token_pct']:.1f}%)")
    print(f"  Platform buy tokens  : {tok(r['platform_buy_tokens'])}  ({r['platform_pct']:.1f}%)")
    print(f"  Total tokens → LP    : {tok(r['total_tokens'])}")
    print(f"  ETH side → LP        : {usd(r['lp_eth_usd'])}")
    print(f"  Excess held in contr.: {usd(r['excess_usd'])}")
    print(f"  Referral commissions : {usd(r['commissions_usd'])}")

    head("POST-SWAP POOL PRICE")
    print(f"  New token price      : ${r['new_price']:>16,.6f} per token")
    print(f"  Price impact         : {pct(r['price_impact_pct'])}")
    print(f"  Pool USDT after swap : {usd(r['new_res_usdt'])}")
    print(f"  Pool tokens after    : {tok(r['new_res_token'])}")
    print("=" * W)


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    print("=" * 56)
    print("  Hordex Investment Simulator")
    print("  (all values in USD, TWAP assumed = spot)")
    print("=" * 56)
    try:
        res_token      = float(input("  Tokens in pool          : "))
        res_usdt       = float(input("  USDT in pool            : $"))
        investment_usd = float(input("  Investment amount (USD) : $"))
    except ValueError:
        print("  ✗  Invalid input — please enter numbers only.")
        return

    print()
    result = simulate_invest(res_token, res_usdt, investment_usd)
    print_report(result)


if __name__ == "__main__":
    main()
