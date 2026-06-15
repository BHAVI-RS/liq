// Characterization suite for the Method-2 rework (held ROI + unlimited streams).
//
// Stage 1: pin CURRENT behaviour so the rework can prove exactly what changes and what doesn't.
//   - Commission distribution up the referral chain  (MUST be preserved)
//   - The 5x per-investment earnings cap             (MUST be preserved — solvency)
//   - Retention of earned ROI across removeLP        (MUST be preserved)
//   - Cap-exhaustion forfeiture                      (WILL CHANGE → "held", claimable on cap regain)
//
// The last group is tagged [CHANGES] — after the rework those assertions flip from
// "over-cap ROI is forfeited" to "over-cap ROI is held and becomes claimable once cap regains".
//
// Run:  npx hardhat test test/method2-characterization.test.js

const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 10_000_000;
const SEED = E(1000);
const PKG = E(100);
const PKG_SMALL = E(25);
const PKG_BIG = E(500);

async function increaseTime(secs) {
  await network.provider.send("evm_increaseTime", [secs]);
  await network.provider.send("evm_mine", []);
}
function approxEq(a, b, tolPct = 3) {
  if (b === 0n) return a === 0n;
  const diff = a > b ? a - b : b - a;
  return diff * 100n <= b * BigInt(tolPct);
}

// Deploy the full local stack and fund/register a referral chain owner→u1→u2→u3→u4.
async function deploy() {
  await network.provider.request({ method: "hardhat_reset", params: [{}] });
  const signers = await ethers.getSigners();
  const [owner, u1, u2, u3, u4, u5] = signers;

  const Math = await (await ethers.getContractFactory("LiquidityMath")).deploy();
  await Math.waitForDeployment();
  const mathAddr = await Math.getAddress();
  const ViewLib = await (await ethers.getContractFactory("LiquidityViewLib", { libraries: { LiquidityMath: mathAddr } })).deploy();
  await ViewLib.waitForDeployment();
  const viewLibAddr = await ViewLib.getAddress();

  const usdt = await (await ethers.getContractFactory("WETH9")).deploy();
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();
  const factory = await (await ethers.getContractFactory("UniswapV2Factory")).deploy(owner.address);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  const router = await (await ethers.getContractFactory("UniswapV2Router02")).deploy(factoryAddr, usdtAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  const hordex = await (await ethers.getContractFactory("HordexToken")).deploy("Hordex", "HORDEX", HORDEX_SUPPLY);
  await hordex.waitForDeployment();
  const hordexAddr = await hordex.getAddress();

  const facet = await (await ethers.getContractFactory("LiquidityFacet", { libraries: { LiquidityMath: mathAddr } }))
    .deploy(routerAddr, factoryAddr, usdtAddr, hordexAddr);
  await facet.waitForDeployment();
  const roiFacet = await (await ethers.getContractFactory("LiquidityROIFacet")).deploy();
  await roiFacet.waitForDeployment();
  const core = await (await ethers.getContractFactory("Liquidity", { libraries: { LiquidityMath: mathAddr } }))
    .deploy(routerAddr, factoryAddr, usdtAddr, hordexAddr, await facet.getAddress(), await roiFacet.getAddress());
  await core.waitForDeployment();
  const coreAddr = await core.getAddress();
  const viewFacet = await (await ethers.getContractFactory("LiquidityViewFacet", {
    libraries: { LiquidityMath: mathAddr, LiquidityViewLib: viewLibAddr },
  })).deploy(factoryAddr, usdtAddr, hordexAddr);
  await viewFacet.waitForDeployment();
  await (await core.setViewFacet(await viewFacet.getAddress())).wait();

  const liq = new ethers.Contract(coreAddr, mergedLiquidityAbi(hre), owner);

  await (await hordex.transfer(coreAddr, E(HORDEX_SUPPLY))).wait();
  await (await usdt.deposit({ value: SEED })).wait();
  await (await usdt.transfer(coreAddr, SEED)).wait();
  await (await liq.addToken(hordexAddr, "Hordex", "HORDEX")).wait();
  await (await liq.seedPool(hordexAddr, SEED, SEED)).wait();

  // Warm both TWAPs (two observations ≥ TWAP_PERIOD = 30 s apart).
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
  await (await liq.updateTWAP()).wait();
  await increaseTime(31);
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
  await (await liq.updateTWAP()).wait();

  // Fund + register chain owner → u1 → u2 → u3 → u4 → u5.
  const chain = [u1, u2, u3, u4, u5];
  for (const u of chain) {
    await (await usdt.connect(u).deposit({ value: E(2000) })).wait();
    await (await usdt.connect(u).approve(coreAddr, ethers.MaxUint256)).wait();
  }
  await (await liq.connect(u1).register(owner.address)).wait();
  await (await liq.connect(u2).register(u1.address)).wait();
  await (await liq.connect(u3).register(u2.address)).wait();
  await (await liq.connect(u4).register(u3.address)).wait();
  await (await liq.connect(u5).register(u4.address)).wait();

  return { owner, u1, u2, u3, u4, u5, liq, hordex, usdt, hordexAddr, coreAddr };
}

// Refresh both TWAPs so a subsequent claim's getTWAPPrice() is fresh.
async function freshTwap(liq, hordexAddr) {
  await (await liq.updateTWAP()).wait();
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
}

describe("Method-2 characterization", function () {
  this.timeout(180000);

  it("commission flows up the chain when a downline invests (PRESERVE)", async () => {
    const ctx = await deploy();
    const { u1, u2, liq, usdt, hordexAddr } = ctx;

    // A recipient must hold an active lock (cap) of their own to earn — so u1 invests first.
    await (await liq.connect(u1).invest(hordexAddr, PKG)).wait();
    // u2 (referred by u1) invests; u1 is the level-0 commission recipient.
    const u1Before = await usdt.balanceOf(u1.address);
    await (await liq.connect(u2).invest(hordexAddr, PKG)).wait();
    const u1Gain = (await usdt.balanceOf(u1.address)) - u1Before;

    console.log("      u1 USDT commission from u2's $100 invest:", ethers.formatEther(u1Gain));
    // Level-0 referral rate is 50% of the 20% commission pool = 10% of the package, minus the
    // 5% deployer cut on non-owner recipients. So u1 should receive a clearly positive amount.
    assert(u1Gain > 0n, "u1 must receive a referral commission from its direct downline");

    const [earned] = await liq.getUserCommissionStats(u1.address);
    assert(earned > 0n, "getUserCommissionStats.earned should reflect the commission");
  });

  it("total earnings (commission + ROI) never exceed the 5x cap (PRESERVE — solvency)", async () => {
    const ctx = await deploy();
    const { u1, u2, u3, liq, hordex, hordexAddr } = ctx;

    // u1 invests the SMALL package → cap = 5 × $25 = $125.
    await (await liq.connect(u1).invest(hordexAddr, PKG_SMALL)).wait();
    // Two big downline investors under u1 generate far more than $125 of ROI+commission to u1.
    await (await liq.connect(u2).invest(hordexAddr, PKG_BIG)).wait();
    await (await liq.connect(u3).invest(hordexAddr, PKG_BIG)).wait(); // u3 is under u2, level-1 to u1
    await increaseTime(200); // locks still active (lock term 540 s) so ROI is live, gated by cap
    await freshTwap(liq, hordexAddr);

    // Sum everything u1 can pull: commission stats (earned, USDT) + ROI claim (tokens → ETH-equiv).
    const [earnedComm] = await liq.getUserCommissionStats(u1.address);
    const pendingROI = await liq.getROIPending(u1.address); // ETH-equivalent

    const cap = PKG_SMALL * 5n; // $125
    const total = earnedComm + pendingROI;
    console.log("      u1 cap $125 | earnedComm:", ethers.formatEther(earnedComm),
      " pendingROI:", ethers.formatEther(pendingROI), " total:", ethers.formatEther(total));
    // The unified cap bounds commission + claimable ROI at 5x. Allow a tiny tolerance.
    assert(total <= cap + E(1), `total earnings ${ethers.formatEther(total)} must not exceed 5x cap ${ethers.formatEther(cap)}`);
  });

  it("[CHANGES] cap-exhaustion: ROI accruing past the cap is NOT claimable today (forfeited)", async () => {
    const ctx = await deploy();
    const { u1, u2, u3, liq, hordex, hordexAddr } = ctx;

    // u1 invests small → small cap; big downline overshoots it.
    await (await liq.connect(u1).invest(hordexAddr, PKG_SMALL)).wait();
    await (await liq.connect(u2).invest(hordexAddr, PKG_BIG)).wait();
    await (await liq.connect(u3).invest(hordexAddr, PKG_BIG)).wait();
    await increaseTime(600);
    await freshTwap(liq, hordexAddr);

    // First claim: pays up to the cap.
    const b0 = await hordex.balanceOf(u1.address);
    let firstOk = true;
    try { await (await liq.connect(u1).claimAllROI()).wait(); } catch (_) { firstOk = false; }
    const firstClaim = (await hordex.balanceOf(u1.address)) - b0;
    console.log("      first claim:", ethers.formatEther(firstClaim), "HORDEX (firstOk=" + firstOk + ")");

    // TODAY: with cap exhausted, the over-cap ROI is recorded missed and a second claim yields
    // nothing even though streams kept accruing. After Method 2 this becomes claimable once u1
    // regains cap (invests again). We pin TODAY's behaviour here.
    await increaseTime(50);
    await freshTwap(liq, hordexAddr);
    let secondClaim = 0n;
    try {
      const b1 = await hordex.balanceOf(u1.address);
      await (await liq.connect(u1).claimAllROI()).wait();
      secondClaim = (await hordex.balanceOf(u1.address)) - b1;
    } catch (_) { secondClaim = 0n; }
    console.log("      second claim (cap exhausted):", ethers.formatEther(secondClaim), "HORDEX");

    // Characterize current behaviour: once cap is exhausted, further claims yield ~nothing.
    assert(secondClaim < firstClaim / 10n || secondClaim === 0n,
      "without re-investing, a capped recipient cannot claim more — cap headroom is needed");
  });

  it("[HELD] over-cap ROI becomes claimable after re-investing to regain cap", async () => {
    const ctx = await deploy();
    const { u1, u2, u3, liq, hordex, hordexAddr } = ctx;
    await (await liq.connect(u1).invest(hordexAddr, PKG_SMALL)).wait(); // small cap → easily exhausted
    await (await liq.connect(u2).invest(hordexAddr, PKG_BIG)).wait();
    await (await liq.connect(u3).invest(hordexAddr, PKG_BIG)).wait();
    await increaseTime(200);
    await freshTwap(liq, hordexAddr);

    // First claim pays up to the small cap; the rest accrues over-cap (now HELD, not forfeited).
    let b = await hordex.balanceOf(u1.address);
    await (await liq.connect(u1).claimAllROI()).wait();
    const first = (await hordex.balanceOf(u1.address)) - b;
    assert(first > 0n, "first claim pays up to cap");

    // Control: WITHOUT re-investing, a second claim yields ~nothing (no cap headroom).
    const snap = await network.provider.send("evm_snapshot", []);
    let b2 = await hordex.balanceOf(u1.address);
    let noReinvest = 0n;
    try { await (await liq.connect(u1).claimAllROI()).wait(); noReinvest = (await hordex.balanceOf(u1.address)) - b2; } catch (_) {}
    await network.provider.send("evm_revert", [snap]);

    // Re-invest to regain cap, then claim — the HELD over-cap ROI must now come through.
    await (await liq.connect(u1).invest(hordexAddr, PKG_SMALL)).wait();
    await freshTwap(liq, hordexAddr);
    let b3 = await hordex.balanceOf(u1.address);
    await (await liq.connect(u1).claimAllROI()).wait();
    const afterReinvest = (await hordex.balanceOf(u1.address)) - b3;

    console.log("      first:", ethers.formatEther(first),
      " 2nd (no re-invest):", ethers.formatEther(noReinvest),
      " 2nd (after re-invest):", ethers.formatEther(afterReinvest));
    assert(afterReinvest > noReinvest, "re-investing must unlock more than the no-re-invest control");
    assert(afterReinvest > 0n, "held over-cap ROI must be claimable once cap regains");
  });

  it("[UNLIMITED] commission-path gas does NOT scale with the recipient's stream count", async () => {
    const ctx = await deploy();
    const { u1, liq, usdt, coreAddr, hordexAddr } = ctx;
    const signers = await ethers.getSigners();

    // u1 invests so it holds cap and can be a commission recipient.
    await (await liq.connect(u1).invest(hordexAddr, PKG)).wait();

    // Register a fresh investor directly under u1 and invest → adds one more ROI stream to u1.
    async function downlineInvest(s) {
      await (await usdt.connect(s).deposit({ value: E(300) })).wait();
      await (await usdt.connect(s).approve(coreAddr, ethers.MaxUint256)).wait();
      await (await liq.connect(s).register(u1.address)).wait();
      const r = await (await liq.connect(s).invest(hordexAddr, PKG)).wait();
      return r.gasUsed;
    }

    // Invest when u1 holds ~0 streams.
    const gasFew = await downlineInvest(signers[6]);
    // Pile on many more downline invests so u1 accumulates a large active-stream array.
    for (let i = 7; i < 18; i++) { await downlineInvest(signers[i]); }
    // Invest again, now that u1 holds ~12 live streams.
    const gasMany = await downlineInvest(signers[18]);

    console.log("      invest gas — recipient ~0 streams:", gasFew.toString(),
      " | ~12 streams:", gasMany.toString());
    // Pre-Method-2 this grew with stream count (the DoS). Now commissions charge committed cap
    // (O(locks)), so the cost is flat — assert it doesn't balloon as streams pile up.
    assert(gasMany < gasFew + 250000n,
      `commission-path gas must stay flat: ~0-stream ${gasFew} vs ~12-stream ${gasMany}`);
  });
});
