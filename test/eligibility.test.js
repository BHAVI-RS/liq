// Characterization for the LEVEL-ELIGIBILITY model (active self-stake gate; team-business gate
// REMOVED). Referral and ROI now use DIFFERENT gates:
//   • REFERRAL: a FLAT $25 active self-stake unlocks ALL 10 levels at once. Below $25 → nothing at
//     any level (that level's amount goes to the deployer). No roll-up to a higher ancestor.
//   • ROI streams (0-indexed level i): per-level gate active self-stake >= selfStakeGate[i]
//     ([25,50,100,250,500,1000,2500,5000,5000,5000] — levels 8-10 share the $5,000 gate, so $5,000
//     unlocks all 10). An ineligible ancestor is assigned no stream for that level (skipped); a later
//     restake re-runs assignment.
// Self-stake is ACTIVE (drops when locks expire/are removed). No team-business requirement.
//
// Run:  npx hardhat test test/eligibility.test.js

const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 10_000_000;
const SEED = E(1000);
const f = (x) => parseFloat(ethers.formatEther(x));

async function increaseTime(secs) {
  await network.provider.send("evm_increaseTime", [secs]);
  await network.provider.send("evm_mine", []);
}

async function deploy() {
  await network.provider.request({ method: "hardhat_reset", params: [{}] });
  const signers = await ethers.getSigners();
  const [owner] = signers;

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

  return { owner, signers, liq, hordex, usdt, hordexAddr, coreAddr };
}

async function fund(ctx, who) {
  await (await ctx.usdt.connect(who).deposit({ value: E(5000) })).wait();
  await (await ctx.usdt.connect(who).approve(ctx.coreAddr, ethers.MaxUint256)).wait();
}
async function reg(ctx, who, referrer) {
  await (await ctx.liq.connect(who).register(referrer.address)).wait();
}
async function inv(ctx, who, amt) {
  await (await ctx.liq.connect(who).invest(ctx.hordexAddr, E(amt))).wait();
}

describe("Level-eligibility (active self-stake gate; team-business gate removed)", function () {
  this.timeout(300000);

  // ── REFERRAL: FLAT $25 gate unlocks ALL 10 levels (DECOUPLED from the ROI per-level gate) ──────
  it("referral: a flat $25 self-stake unlocks a DEEP level (L3) the old per-level gate would block", async () => {
    const ctx = await deploy();
    const { owner, signers, usdt } = ctx;
    const A = signers[2], B = signers[3], C = signers[4], X = signers[5];

    // chain owner → A → B → C → X. From X: C=L1 (i=0), B=L2 (i=1), A=L3 (i=2).
    // A stakes only $25 — under the OLD per-level gate L3 needed $100; the flat referral gate unlocks it.
    await fund(ctx, A); await fund(ctx, B); await fund(ctx, C); await fund(ctx, X);
    await reg(ctx, A, owner); await inv(ctx, A, 25);
    await reg(ctx, B, A);     await inv(ctx, B, 100);
    await reg(ctx, C, B);     await inv(ctx, C, 100);
    await reg(ctx, X, C);     await inv(ctx, X, 100);

    // X invests again → A is the fixed level-3 recipient with only $25 active self-stake ⇒ earns.
    const b = await usdt.balanceOf(A.address);
    await inv(ctx, X, 100);
    const got = (await usdt.balanceOf(A.address)) - b;

    console.log("      L3 recipient with only $25 self-stake earned:", f(got));
    assert(got > 0n, "with >= $25 active self-stake a recipient earns EVERY referral level (incl. L3)");
  });

  // ── REFERRAL: below $25 ⇒ nothing at any level (goes to deployer); $25 unlocks it ──
  it("referral: a recipient below $25 earns nothing; a flat $25 unlocks the level", async () => {
    const ctx = await deploy();
    const { owner, signers, usdt } = ctx;
    const R = signers[2], M = signers[3], X = signers[4];

    // chain owner → R → M → X. From X: M=L1 (i=0), R=L2 (i=1).
    // R registers but does NOT stake (self-stake $0) ⇒ below the flat $25 referral gate.
    await fund(ctx, R); await fund(ctx, M); await fund(ctx, X);
    await reg(ctx, R, owner);                  // R has NO active self-stake
    await reg(ctx, M, R);     await inv(ctx, M, 100);
    await reg(ctx, X, M);     await inv(ctx, X, 100);

    // X invests → R is the level-2 recipient but has $0 self-stake ⇒ gets nothing (goes to deployer).
    let b = await usdt.balanceOf(R.address);
    await inv(ctx, X, 100);
    const blocked = (await usdt.balanceOf(R.address)) - b;

    // R stakes just $25 (the flat referral gate) ⇒ now eligible for EVERY level, including L2.
    await inv(ctx, R, 25);
    b = await usdt.balanceOf(R.address);
    await inv(ctx, X, 100);
    const allowed = (await usdt.balanceOf(R.address)) - b;

    console.log("      referral L2 — blocked@ $0 self:", f(blocked), " allowed@ $25 self:", f(allowed));
    assert(blocked === 0n, "below $25 active self-stake the recipient receives nothing (goes to deployer)");
    assert(allowed > 0n, "at/above the flat $25 gate the recipient receives the commission");
  });

  // ── ROI: per-level self-stake gate, NO business gate ────────────────────────────────────
  it("ROI: a level-2 ancestor with $100 self-stake (low business) IS assigned the stream (no business gate)", async () => {
    const ctx = await deploy();
    const { owner, signers, liq } = ctx;
    const U3 = signers[2], V2 = signers[3], V1 = signers[4], W = signers[5];
    const ZERO = ethers.ZeroAddress;

    // chain owner → U3 → V2 → V1 → W. W's lock-0 streams: V1=L0, V2=L1, U3=L2.
    // U3 self $100 == L2 self-gate ($100); business is low (< old $500 gate) but business no longer gates.
    await fund(ctx, U3); await fund(ctx, V2); await fund(ctx, V1); await fund(ctx, W);
    await reg(ctx, U3, owner); await inv(ctx, U3, 100);
    await reg(ctx, V2, U3);    await inv(ctx, V2, 100);
    await reg(ctx, V1, V2);    await inv(ctx, V1, 100);
    await reg(ctx, W,  V1);    await inv(ctx, W, 100);     // U3 business only 300

    const l0 = (await liq.getROIStreamInfo(W.address, 0, 0)).recipient;
    const l2 = (await liq.getROIStreamInfo(W.address, 0, 2)).recipient;
    console.log("      ROI assign — W.L0:", l0, " W.L2:", l2);
    assert(l0.toLowerCase() === V1.address.toLowerCase(), "eligible direct referrer is assigned the L0 stream");
    assert(l2.toLowerCase() === U3.address.toLowerCase(),
      "a $100-self-stake L2 ancestor is assigned the stream regardless of (low) team business");
  });

  it("ROI: a level-2 ancestor below the $100 self-stake gate is skipped, then assigned after topping up", async () => {
    const ctx = await deploy();
    const { owner, signers, liq } = ctx;
    const U3 = signers[2], V2 = signers[3], V1 = signers[4], W = signers[5];
    const ZERO = ethers.ZeroAddress;

    // U3 self $50 (< L2 self-gate $100) ⇒ its L2 stream is skipped at assignment.
    await fund(ctx, U3); await fund(ctx, V2); await fund(ctx, V1); await fund(ctx, W);
    await reg(ctx, U3, owner); await inv(ctx, U3, 50);
    await reg(ctx, V2, U3);    await inv(ctx, V2, 100);
    await reg(ctx, V1, V2);    await inv(ctx, V1, 100);
    await reg(ctx, W,  V1);    await inv(ctx, W, 100);

    assert((await liq.getROIStreamInfo(W.address, 0, 2)).recipient === ZERO,
      "self-stake-ineligible L2 ancestor is skipped (recipient stays address(0))");

    // U3 tops up to $100 active self-stake, then W opens a NEW lock → U3 now qualifies for L2.
    await inv(ctx, U3, 50);                                // U3 active self-stake → $100
    await inv(ctx, W, 100);                                // W lock-1 assignment
    const l2b = (await liq.getROIStreamInfo(W.address, 1, 2)).recipient;
    console.log("      ROI re-assign after topping up — W.lock1.L2:", l2b);
    assert(l2b.toLowerCase() === U3.address.toLowerCase(), "once self-stake >= $100 the L2 stream is assigned to U3");
    assert((await liq.getROIStreamInfo(W.address, 0, 2)).recipient === ZERO,
      "lock-0's skipped L2 stream is not retroactively assigned");
  });

  // ── View getters the frontend depends on ─────────────────────────────────────────────
  it("views: getEligibilityGates returns new self-stake gates + zeroed business gates; getUserEligibility = ROI depth", async () => {
    const ctx = await deploy();
    const { owner, signers, liq } = ctx;
    const P = signers[2], Q = signers[3];

    const [selfGates, bizGates] = await liq.getEligibilityGates();
    assert.equal(Number(selfGates[0]), 25);
    assert.equal(Number(selfGates[5]), 1000);
    assert.equal(Number(selfGates[6]), 2500);
    assert.equal(Number(selfGates[7]), 5000);    // levels 8-10 share the $5,000 gate
    assert.equal(Number(selfGates[8]), 5000);
    assert.equal(Number(selfGates[9]), 5000);    // $5,000 unlocks all 10 ROI levels
    // Business gate is removed → all zeros.
    for (let i = 0; i < 10; i++) assert.equal(Number(bizGates[i]), 0, "business gates must be zeroed");

    // P stakes $100 active self-stake → ROI levels: L1($25)✓ L2($50)✓ L3($100)✓ L4($250)✗ ⇒ 3.
    // (Team business is irrelevant to the gate now.)
    await fund(ctx, P); await fund(ctx, Q);
    await reg(ctx, P, owner); await inv(ctx, P, 100);
    await reg(ctx, Q, P);     await inv(ctx, Q, 250);

    const e = await liq.getUserEligibility(P.address);
    console.log("      getUserEligibility(P):", Number(e.selfStakeUSDT ?? e[0]), Number(e.teamBusinessUSDT ?? e[1]), Number(e.unlockedLevels ?? e[2]));
    assert.equal(Number(e.selfStakeUSDT ?? e[0]), 100);
    assert.equal(Number(e.unlockedLevels ?? e[2]), 3, "ROI unlocked levels = highest level whose self-stake gate is met");
  });
});
