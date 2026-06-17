// Characterization for the natural-expiry RESUME path (_handleNaturalExpiryResume).
//
// This pins the behaviour that the "lazy resume" rework must preserve, and measures the
// thing the rework is meant to change: the gas of invest()/restakeLP() when the caller is
// a RECIPIENT whose own lock expired naturally and who holds many active ROI streams.
//
//   owner → A,  with N downlines directly under A.
//   A invests (own lock + cap). Each downline invests → one L0 ROI stream to A.
//   A's lock expires naturally (no removal, not cap-paused). A re-invests →
//   _handleNaturalExpiryResume iterates ALL of A's streams in that one tx.
//
// TODAY: that re-invest's gas grows with A's stream count (the O(M) loop).
// AFTER the lazy rework: it should be ~flat (O(1)); the [CHANGES] assertion below flips.
//
// It also pins the CORRECTNESS invariants the rework must keep:
//   - pre-expiry ROI stays claimable, the post-expiry no-stake gap is forfeited,
//   - no double-pay.
//
// Run:  npx hardhat test test/resume-characterization.test.js

const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 10_000_000;
const SEED = E(1000);
const PKG = E(100);
const f = (x) => parseFloat(ethers.formatEther(x));

async function increaseTime(secs) {
  await network.provider.send("evm_increaseTime", [secs]);
  await network.provider.send("evm_mine", []);
}
function approxEq(a, b, tolPct = 5) {
  if (b === 0n) return a === 0n;
  const diff = a > b ? a - b : b - a;
  return diff * 100n <= b * BigInt(tolPct);
}

async function deploy() {
  await network.provider.request({ method: "hardhat_reset", params: [{}] });
  const signers = await ethers.getSigners();
  const [owner, A] = signers;

  const Math = await (await ethers.getContractFactory("HordexMath")).deploy();
  await Math.waitForDeployment();
  const mathAddr = await Math.getAddress();
  const ViewLib = await (await ethers.getContractFactory("HordexViewLib", { libraries: { HordexMath: mathAddr } })).deploy();
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

  const facet = await (await ethers.getContractFactory("HordexFacet", { libraries: { HordexMath: mathAddr } }))
    .deploy(routerAddr, factoryAddr, usdtAddr, hordexAddr);
  await facet.waitForDeployment();
  const roiFacet = await (await ethers.getContractFactory("HordexROIFacet")).deploy();
  await roiFacet.waitForDeployment();
  const core = await (await ethers.getContractFactory("Hordex", { libraries: { HordexMath: mathAddr } }))
    .deploy(routerAddr, factoryAddr, usdtAddr, hordexAddr, await facet.getAddress(), await roiFacet.getAddress());
  await core.waitForDeployment();
  const coreAddr = await core.getAddress();
  const viewFacet = await (await ethers.getContractFactory("HordexViewFacet", {
    libraries: { HordexMath: mathAddr, HordexViewLib: viewLibAddr },
  })).deploy(factoryAddr, usdtAddr, hordexAddr);
  await viewFacet.waitForDeployment();
  await (await core.setViewFacet(await viewFacet.getAddress())).wait();

  const liq = new ethers.Contract(coreAddr, mergedLiquidityAbi(hre), owner);

  await (await hordex.transfer(coreAddr, E(HORDEX_SUPPLY))).wait();
  await (await usdt.deposit({ value: SEED })).wait();
  await (await usdt.transfer(coreAddr, SEED)).wait();
  await (await liq.addToken(hordexAddr, "Hordex", "HORDEX")).wait();
  await (await liq.seedPool(hordexAddr, SEED, SEED)).wait();

  await (await liq.updateTokenTWAP(hordexAddr)).wait();
  await (await liq.updateTWAP()).wait();
  await increaseTime(31);
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
  await (await liq.updateTWAP()).wait();

  // Fund A generously (it re-invests several times) and register under owner.
  await (await usdt.connect(A).deposit({ value: E(5000) })).wait();
  await (await usdt.connect(A).approve(coreAddr, ethers.MaxUint256)).wait();
  await (await liq.connect(A).register(owner.address)).wait();

  return { owner, A, signers, liq, hordex, usdt, hordexAddr, coreAddr };
}

async function freshTwap(liq, hordexAddr) {
  await (await liq.updateTWAP()).wait();
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
}

// Register a fresh downline directly under A and have it invest (→ one L0 ROI stream to A).
async function downlineInvest(ctx, s) {
  const { A, liq, usdt, coreAddr, hordexAddr } = ctx;
  await (await usdt.connect(s).deposit({ value: E(300) })).wait();
  await (await usdt.connect(s).approve(coreAddr, ethers.MaxUint256)).wait();
  await (await liq.connect(s).register(A.address)).wait();
  await (await liq.connect(s).invest(hordexAddr, PKG)).wait();
}

describe("Natural-expiry RESUME characterization", function () {
  this.timeout(300000);

  // ── Complexity proof: invest()'s resume cost is now FLAT in the recipient's stream count ──
  // Before the lazy rework this grew ~70k gas/stream (O(M)); now the resume is an O(1) checkpoint.
  it("re-invest gas after natural expiry does NOT scale with the recipient's stream count (O(1))", async () => {
    // Few-stream run.
    const few = await deploy();
    await (await few.liq.connect(few.A).invest(few.hordexAddr, PKG)).wait(); // A's own lock + cap
    for (let i = 2; i < 4; i++) await downlineInvest(few, few.signers[i]);   // 2 streams to A
    await increaseTime(560);                                                  // A's lock expires naturally
    await freshTwap(few.liq, few.hordexAddr);
    const gasFew = (await (await few.liq.connect(few.A).invest(few.hordexAddr, PKG)).wait()).gasUsed;

    // Many-stream run (fresh deploy so state is comparable).
    const many = await deploy();
    await (await many.liq.connect(many.A).invest(many.hordexAddr, PKG)).wait();
    for (let i = 2; i < 16; i++) await downlineInvest(many, many.signers[i]); // 14 streams to A
    await increaseTime(560);
    await freshTwap(many.liq, many.hordexAddr);
    const gasMany = (await (await many.liq.connect(many.A).invest(many.hordexAddr, PKG)).wait()).gasUsed;

    console.log("      resume re-invest gas — 2 streams:", gasFew.toString(), " | 14 streams:", gasMany.toString(),
      " | delta:", (gasMany - gasFew).toString());

    // After the lazy rework the natural-expiry resume is an O(1) checkpoint write, so the re-invest
    // gas must NOT scale with the recipient's stream count. (Pre-rework the 12-stream delta was
    // ~842k gas; assert it stays well under a flat margin now.)
    assert(gasMany < gasFew + 100000n,
      `resume re-invest gas must stay flat: 2-stream ${gasFew} vs 14-stream ${gasMany}`);
  });

  // ── Correctness invariants the rework MUST preserve ──
  it("pre-expiry ROI is claimable; post-expiry no-stake gap is forfeited (PRESERVE)", async () => {
    const ctx = await deploy();
    const { A, signers, liq, hordex, hordexAddr } = ctx;
    const B = signers[2];

    // A invests; B invests LATER so B's lock outlasts A's. That way, after A's lock expires,
    // B's stream keeps accruing — the [A.expiry → A.reinvest] window is a genuine no-stake gap
    // (B still active, A has no cap) that must be forfeited, with no restake to muddy A's stream.
    await (await liq.connect(A).invest(hordexAddr, PKG)).wait();   // A.unlock = t0+540, cap $500
    await increaseTime(300);
    await freshTwap(liq, hordexAddr);
    await downlineInvest(ctx, B);                                  // B.unlock = t0+840; A earns from t0+300

    // Advance just past A's expiry (t0+540) — A earned ROI from B over [t0+300, t0+540] while staked.
    await increaseTime(250);                                       // ≈ t0+550
    await freshTwap(liq, hordexAddr);

    // Baseline = the pre-expiry earned ROI (claim bounds at A's natural expiry).
    const snap = await network.provider.send("evm_snapshot", []);
    const pre0 = await hordex.balanceOf(A.address);
    let baseline = 0n;
    try { await (await liq.connect(A).claimAllROI()).wait(); baseline = (await hordex.balanceOf(A.address)) - pre0; } catch (_) {}
    await network.provider.send("evm_revert", [snap]);
    assert(baseline > 0n, "precondition: A earned pre-expiry ROI from B");

    // Let the gap grow (A expired, B still active), then A re-invests → natural-expiry resume.
    await increaseTime(200);                                       // ≈ t0+750, B still active (<t0+840)
    await freshTwap(liq, hordexAddr);
    await (await liq.connect(A).invest(hordexAddr, PKG)).wait();   // triggers _handleNaturalExpiryResume
    await freshTwap(liq, hordexAddr);
    const pre1 = await hordex.balanceOf(A.address);
    await (await liq.connect(A).claimAllROI()).wait();
    const afterResume = (await hordex.balanceOf(A.address)) - pre1;

    console.log("      baseline (pre-expiry earned):", f(baseline), " claimed after resume:", f(afterResume));
    // The resume must preserve pre-expiry ROI (≈ baseline) and NOT pay the [expiry→reinvest] gap.
    assert(afterResume > 0n, "pre-expiry ROI must remain claimable after re-invest");
    assert(approxEq(afterResume, baseline, 5),
      `claim after resume (${f(afterResume)}) must ≈ pre-expiry baseline (${f(baseline)}) — gap must be forfeited, not leaked`);
  });

  it("retained/earned ROI cannot be double-claimed across a resume (PRESERVE)", async () => {
    const ctx = await deploy();
    const { A, signers, liq, hordex, hordexAddr } = ctx;
    const B = signers[2];

    await (await liq.connect(A).invest(hordexAddr, PKG)).wait();
    await downlineInvest(ctx, B);
    await increaseTime(560);
    await freshTwap(liq, hordexAddr);
    await (await liq.connect(A).invest(hordexAddr, PKG)).wait();   // resume

    await freshTwap(liq, hordexAddr);
    const b0 = await hordex.balanceOf(A.address);
    await (await liq.connect(A).claimAllROI()).wait();
    const first = (await hordex.balanceOf(A.address)) - b0;

    let second = 0n;
    try {
      const b1 = await hordex.balanceOf(A.address);
      await (await liq.connect(A).claimAllROI()).wait();
      second = (await hordex.balanceOf(A.address)) - b1;
    } catch (_) {}

    console.log("      first claim:", f(first), " immediate second claim:", f(second));
    assert(second < first / 5n || second === 0n, "must not re-pay already-claimed ROI right after a resume");
  });

  // The multi-gap landmine: two natural-expiry resumes with NO claim in between. The lazy design
  // must drain the first checkpoint before recording the second (so a stream never carries two
  // gaps) — otherwise the deferred claim would over-credit the first, already-forfeited gap.
  it("multi-gap: a second resume before claiming does NOT over-credit the first gap (PRESERVE)", async () => {
    const ctx = await deploy();
    const { A, signers, liq, hordex, hordexAddr } = ctx;
    const C = signers[2];

    // A invests, then a downline C invests LATER so C's 540s lock outlives A's short resume cycles
    // and keeps accruing to A WITHOUT C ever restaking. (Under the new level-eligibility gate a
    // downline restake re-runs assignment, so a restake during A's expiry would correctly drop A's
    // stream — the old "restake B long" trick is no longer usable. A staggered, non-restaking
    // downline keeps the double-resume drain on A's inbound stream testable.) A then expires/resumes
    // TWICE with no claim between, so cp1 is still unabsorbed when cp2 forms and _drainPendingResume
    // must reconcile it — without over-crediting the first (already-forfeited) gap.
    await (await liq.connect(A).invest(hordexAddr, PKG)).wait();   // A.unlock ≈ t0+540
    await increaseTime(300);
    await freshTwap(liq, hordexAddr);
    await downlineInvest(ctx, C);                                  // C.unlock ≈ t0+841, accrues to A

    await increaseTime(245);                                       // ≈ t0+546: A expired, C still active
    await freshTwap(liq, hordexAddr);
    await (await liq.connect(A).restakeLP(0, 7)).wait();           // resume #1 (cp1); A active ~[546,588]
    await increaseTime(60);                                        // ≈ t0+608: A's 42s lock expired → gap-2
    await freshTwap(liq, hordexAddr);

    // Decision point: resume #2 is imminent with NO intervening claim → _drainPendingResume must fire.
    const snap = await network.provider.send("evm_snapshot", []);

    // CONTROL: claim (absorbs cp1 step-by-step), resume #2, claim — each gap forfeited as it forms.
    let cb = await hordex.balanceOf(A.address);
    try { await (await liq.connect(A).claimAllROI()).wait(); } catch (_) {}
    await (await liq.connect(A).restakeLP(0, 7)).wait();      // resume #2
    try { await (await liq.connect(A).claimAllROI()).wait(); } catch (_) {}
    const controlTotal = (await hordex.balanceOf(A.address)) - cb;
    await network.provider.send("evm_revert", [snap]);

    // TEST: resume #2 FIRST (drain cp1), THEN one claim. Must match control — gap-1 not leaked.
    let tb = await hordex.balanceOf(A.address);
    await (await liq.connect(A).restakeLP(0, 7)).wait();      // resume #2 → _drainPendingResume(cp1)
    try { await (await liq.connect(A).claimAllROI()).wait(); } catch (_) {}
    const testTotal = (await hordex.balanceOf(A.address)) - tb;

    console.log("      multi-gap — control (claim each step):", f(controlTotal),
      " test (claim once at end):", f(testTotal));
    assert(testTotal > 0n, "should still claim the legitimately-earned ROI");
    // A leak of the first gap would make the deferred claim materially exceed the control.
    assert(testTotal <= controlTotal + controlTotal / 4n + E("0.02"),
      `deferred multi-resume claim (${f(testTotal)}) must not exceed claim-each control (${f(controlTotal)}) — gap-1 leaked`);
  });

  // ── Sizes MAX_ACTIVE_ROI_STREAMS ──────────────────────────────────────────────
  // After the lazy rework the ONLY remaining O(M) path inside invest/restake is the rare
  // _drainPendingResume — it fires when a recipient resumes a SECOND time before any claim/settle
  // has absorbed the first checkpoint. This can't be chunked (it's inside invest/restake), so the
  // worst-case full drain must fit comfortably in a block. Measure its per-stream cost to size the
  // safe cap.
  it("safety: double-resume drain is O(unabsorbed) — measures per-stream cost to size the cap", async () => {
    async function drainGas(n) {
      const ctx = await deploy();
      const { A, signers, liq, hordexAddr } = ctx;
      await (await liq.connect(A).invest(hordexAddr, PKG)).wait();              // A's own lock (index 0)
      for (let i = 2; i < 2 + n; i++) await downlineInvest(ctx, signers[i]);    // n streams where A is recipient
      await increaseTime(560);                                                  // A + downline locks expire
      await freshTwap(liq, hordexAddr);
      await (await liq.connect(A).restakeLP(0, 7)).wait();                       // resume #1 — NO claim after
      await increaseTime(50);                                                   // A's 42s lock expires again
      await freshTwap(liq, hordexAddr);
      // resume #2 with the first checkpoint still unabsorbed → _drainPendingResume over n streams.
      return (await (await liq.connect(A).restakeLP(0, 7)).wait()).gasUsed;
    }
    const g3  = await drainGas(3);
    const g18 = await drainGas(18);
    const perStream = (g18 - g3) / 15n;
    const safeCap = perStream > 0n ? 18000000n / perStream : 0n; // keep full drain < ~18M (well under 30M block)
    console.log("      drain gas — 3 streams:", g3.toString(), " | 18 streams:", g18.toString(),
      " | per-stream:", perStream.toString(), " | worst-case-safe cap ~", safeCap.toString());
    assert(perStream > 0n, "drain cost should scale with unabsorbed stream count");
  });
});
