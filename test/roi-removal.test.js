// ROI-on-removeLP regression suite.
//
// Pins the behaviour the user cares about: when a RECIPIENT of ROI (earning from a
// downline investor) removes their own LP without first claiming, the ROI they already
// earned must NOT be lost — it stays claimable (preserve), and a later re-invest resumes
// fresh accrual while excluding the no-stake gap (resume).
//
// The harness deploys a full local stack: local Uniswap V2 (the repo's own Factory/Router,
// whose hard-coded pair init-code-hash matches the locally compiled Pair), WETH9 used as the
// USDT base token, the Hordex platform token, the LiquidityMath / LiquidityViewLib libraries,
// the three facets, and the Liquidity core wired to its view facet.
//
//   Referral chain for these tests:  owner → A → B
//   B's invest creates ROI streams up the chain; A is the level-0 recipient of B's stream.
//   A also invests once (so A holds the active lock that backs A's own cap).
//
// Run:  npx hardhat test test/roi-removal.test.js

const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 10_000_000;      // minted * 1e18 by the token constructor
const SEED = E(1000);                   // 1000 HORDEX / 1000 USDT  →  price = 1.0
const PKG = E(100);                     // $100 package

async function increaseTime(secs) {
  await network.provider.send("evm_increaseTime", [secs]);
  await network.provider.send("evm_mine", []);
}
async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}
function approxEq(a, b, tolPct = 3) {
  if (b === 0n) return a === 0n;
  const diff = a > b ? a - b : b - a;
  return diff * 100n <= b * BigInt(tolPct);
}

async function deploy() {
  // Default hardhat network is configured to fork mainnet (for the repo's own scripts);
  // these tests use a fully local Uniswap stack, so reset to a clean, non-forked chain.
  await network.provider.request({ method: "hardhat_reset", params: [{}] });

  const [owner, A, B] = await ethers.getSigners();

  // ── Libraries (ViewLib links Math) ──
  const Math = await (await ethers.getContractFactory("LiquidityMath")).deploy();
  await Math.waitForDeployment();
  const mathAddr = await Math.getAddress();
  const ViewLib = await (await ethers.getContractFactory("LiquidityViewLib", { libraries: { LiquidityMath: mathAddr } })).deploy();
  await ViewLib.waitForDeployment();
  const viewLibAddr = await ViewLib.getAddress();

  // ── Local Uniswap V2 + WETH9 (as USDT) ──
  const usdt = await (await ethers.getContractFactory("WETH9")).deploy();
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();

  const factory = await (await ethers.getContractFactory("UniswapV2Factory")).deploy(owner.address);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();

  const router = await (await ethers.getContractFactory("UniswapV2Router02")).deploy(factoryAddr, usdtAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  // ── Platform token ──
  const hordex = await (await ethers.getContractFactory("HordexToken")).deploy("Hordex", "HORDEX", HORDEX_SUPPLY);
  await hordex.waitForDeployment();
  const hordexAddr = await hordex.getAddress();

  // ── Facets + core ──
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

  // Merged-ABI handle so view-facet getters (getROIData, getROIPending, …) resolve via fallback.
  const liq = new ethers.Contract(coreAddr, mergedLiquidityAbi(hre), owner);

  // ── Seed: contract holds full token supply + 1000 USDT, then seed the pool ──
  await (await hordex.transfer(coreAddr, E(HORDEX_SUPPLY))).wait();
  await (await usdt.deposit({ value: SEED })).wait();
  await (await usdt.transfer(coreAddr, SEED)).wait();
  await (await liq.addToken(hordexAddr, "Hordex", "HORDEX")).wait();
  await (await liq.seedPool(hordexAddr, SEED, SEED)).wait();

  // ── Warm both TWAPs (two observations ≥ 30 s apart) ──
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
  await (await liq.updateTWAP()).wait();
  await increaseTime(31);
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
  await (await liq.updateTWAP()).wait();

  // ── Fund + register A and B (each deposits USDT, approves, registers) ──
  for (const u of [A, B]) {
    await (await usdt.connect(u).deposit({ value: E(300) })).wait();
    await (await usdt.connect(u).approve(coreAddr, ethers.MaxUint256)).wait();
  }
  await (await liq.connect(A).register(owner.address)).wait();
  await (await liq.connect(B).register(A.address)).wait();

  return { owner, A, B, liq, hordex, usdt, hordexAddr, coreAddr };
}

// Build the owner→A→B scenario: A invests, then B invests so A becomes the level-0
// recipient of B's ROI stream. Advance until A's own lock has expired (so A can removeLP)
// while ROI has accrued to A from B.
async function scenarioAEarnsFromB(ctx) {
  const { A, B, liq, hordexAddr } = ctx;
  await (await liq.connect(A).invest(hordexAddr, PKG)).wait();
  await increaseTime(5);
  await (await liq.connect(B).invest(hordexAddr, PKG)).wait();
  // A's lock (LP_LOCK_DURATION = 180 s) — advance past it so removeLPDirect is allowed.
  await increaseTime(220);
  // keep TWAP fresh for the eventual claim's getTWAPPrice()
  await (await liq.updateTWAP()).wait();
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
}

describe("ROI preservation across removeLP", function () {
  this.timeout(120000);

  it("harness sanity: A actually earns claimable ROI from B (claim BEFORE any removal)", async () => {
    const ctx = await deploy();
    await scenarioAEarnsFromB(ctx);
    const { A, liq, hordex } = ctx;

    const before = await hordex.balanceOf(A.address);
    await (await liq.connect(A).claimAllROI()).wait();
    const gained = (await hordex.balanceOf(A.address)) - before;

    console.log("      A claimable ROI (no removal):", ethers.formatEther(gained), "HORDEX");
    assert(gained > 0n, "A should have earned claimable ROI from B's stream");
  });

  it("A must NOT lose earned ROI when removing LP before claiming (preserve)", async () => {
    const ctx = await deploy();
    await scenarioAEarnsFromB(ctx);
    const { A, liq, hordex } = ctx;

    // Measure what A could claim WITHOUT removing (snapshot, claim, revert to same instant).
    const snap = await network.provider.send("evm_snapshot", []);
    const b0 = await hordex.balanceOf(A.address);
    await (await liq.connect(A).claimAllROI()).wait();
    const claimableNoRemoval = (await hordex.balanceOf(A.address)) - b0;
    await network.provider.send("evm_revert", [snap]);   // back to the same instant

    assert(claimableNoRemoval > 0n, "precondition: A has claimable ROI before removal");

    // Now A removes its single LP WITHOUT claiming, then tries to claim the earned ROI.
    await (await liq.connect(A).removeLPDirect(0)).wait();

    const b1 = await hordex.balanceOf(A.address);
    let claimableAfterRemoval = 0n;
    try {
      await (await liq.connect(A).claimAllROI()).wait();
      claimableAfterRemoval = (await hordex.balanceOf(A.address)) - b1;
    } catch (e) {
      claimableAfterRemoval = 0n; // current code: reverts NothingToClaim → ROI lost
    }

    console.log("      claimable before removal:", ethers.formatEther(claimableNoRemoval), "HORDEX");
    console.log("      claimable after  removal:", ethers.formatEther(claimableAfterRemoval), "HORDEX");

    assert(
      approxEq(claimableAfterRemoval, claimableNoRemoval),
      `earned ROI must survive removeLP — lost ${ethers.formatEther(claimableNoRemoval - claimableAfterRemoval)} HORDEX`
    );
  });

  it("preserves earned ROI through removeLP → re-invest → claim (resume)", async () => {
    const ctx = await deploy();
    await scenarioAEarnsFromB(ctx);
    const { A, liq, hordex, hordexAddr } = ctx;

    // Baseline: what A could claim at this instant without removing.
    const snap = await network.provider.send("evm_snapshot", []);
    const b0 = await hordex.balanceOf(A.address);
    await (await liq.connect(A).claimAllROI()).wait();
    const baseline = (await hordex.balanceOf(A.address)) - b0;
    await network.provider.send("evm_revert", [snap]);

    // Remove WITHOUT claiming, then re-invest, then claim — the earned ROI must survive both.
    await (await liq.connect(A).removeLPDirect(0)).wait();
    await (await liq.connect(A).invest(hordexAddr, PKG)).wait();

    const before = await hordex.balanceOf(A.address);
    await (await liq.connect(A).claimAllROI()).wait();
    const gained = (await hordex.balanceOf(A.address)) - before;

    console.log("      claim after remove+reinvest:", ethers.formatEther(gained),
      "(baseline", ethers.formatEther(baseline) + ")");
    assert(gained > 0n, "earned ROI must survive removeLP + re-invest");
    assert(approxEq(gained, baseline, 5), "preserved ROI should match the pre-removal baseline");
  });

  it("retained ROI cannot be claimed twice (no over-pay)", async () => {
    const ctx = await deploy();
    await scenarioAEarnsFromB(ctx);
    const { A, liq, hordex } = ctx;

    await (await liq.connect(A).removeLPDirect(0)).wait();

    const b0 = await hordex.balanceOf(A.address);
    await (await liq.connect(A).claimAllROI()).wait();
    const first = (await hordex.balanceOf(A.address)) - b0;
    assert(first > 0n, "first claim should pay the preserved ROI");

    // A second claim must yield nothing — the retained budget was committed on the first claim.
    let second = 0n;
    try {
      const b1 = await hordex.balanceOf(A.address);
      await (await liq.connect(A).claimAllROI()).wait();
      second = (await hordex.balanceOf(A.address)) - b1;
    } catch (e) {
      second = 0n; // NothingToClaim
    }
    console.log("      first claim:", ethers.formatEther(first), " second claim:", ethers.formatEther(second));
    assert(second === 0n, "must not be able to claim the same earned ROI twice");
  });

  it("view getters surface the retained claimable ROI after removeLP", async () => {
    const ctx = await deploy();
    await scenarioAEarnsFromB(ctx);
    const { A, liq, hordex } = ctx;

    await (await liq.connect(A).removeLPDirect(0)).wait();

    const [liveETH] = await liq.getROIData(A.address);
    const pendingView = await liq.getROIPending(A.address);  // ETH-equivalent
    console.log("      after removal — getROIData.liveETH:", ethers.formatEther(liveETH),
      " getROIPending:", ethers.formatEther(pendingView));
    assert(liveETH > 0n, "getROIData should surface retained claimable ROI");
    assert(pendingView > 0n, "getROIPending should surface retained claimable ROI");

    // The view is ETH-equivalent; the claim pays tokens (= ethEquiv / TWAP price). Compare
    // like-for-like against the ROIClaimed event's ethEquivalent.
    const b0 = await hordex.balanceOf(A.address);
    const rc = await (await liq.connect(A).claimAllROI()).wait();
    const paidTokens = (await hordex.balanceOf(A.address)) - b0;
    let ethEquiv = 0n;
    for (const log of rc.logs) {
      try {
        const p = liq.interface.parseLog(log);
        if (p && p.name === "ROIClaimed") ethEquiv = p.args.ethEquivalent;
      } catch (_) { /* not our event */ }
    }
    console.log("      claim — tokens:", ethers.formatEther(paidTokens), " ethEquiv:", ethers.formatEther(ethEquiv));
    assert(paidTokens > 0n, "claim should pay tokens");
    assert(approxEq(ethEquiv, pendingView, 2), "getROIPending (ETH-equiv) must match claimed ethEquivalent");
  });
});
