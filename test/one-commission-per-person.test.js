// Verifies the "one referral commission per person per investment" rule:
//   a non-owner address receives AT MOST ONE referral commission from a single investment — the
//   highest-value level that reaches it — and every other level that would land on it skips upward
//   to the next eligible, not-yet-paid ancestor (ultimately the owner sink).
//
// Run:  npx hardhat test test/one-commission-per-person.test.js

const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 100_000_000;
const SEED = E(1_000_000);
const PKG = E(100);

async function increaseTime(secs) {
  await network.provider.send("evm_increaseTime", [secs]);
  await network.provider.send("evm_mine", []);
}
async function topUpETH(addr) {
  await network.provider.send("hardhat_setBalance", [addr, "0x52B7D2DCC80CD2E4000000"]);
}

async function deploy() {
  await network.provider.request({ method: "hardhat_reset", params: [{}] });
  const signers = await ethers.getSigners();
  const owner = signers[0];
  await topUpETH(owner.address);

  const Math = await (await ethers.getContractFactory("HordexMath")).deploy();
  const mathAddr = await Math.getAddress();
  const ViewLib = await (await ethers.getContractFactory("HordexViewLib", { libraries: { HordexMath: mathAddr } })).deploy();
  const viewLibAddr = await ViewLib.getAddress();
  const usdt = await (await ethers.getContractFactory("WETH9")).deploy();
  const usdtAddr = await usdt.getAddress();
  const factory = await (await ethers.getContractFactory("UniswapV2Factory")).deploy(owner.address);
  const factoryAddr = await factory.getAddress();
  const router = await (await ethers.getContractFactory("UniswapV2Router02")).deploy(factoryAddr, usdtAddr);
  const routerAddr = await router.getAddress();
  const hordex = await (await ethers.getContractFactory("HordexToken")).deploy("Hordex", "HORDEX", HORDEX_SUPPLY);
  const hordexAddr = await hordex.getAddress();
  const facet = await (await ethers.getContractFactory("HordexFacet", { libraries: { HordexMath: mathAddr } }))
    .deploy(routerAddr, factoryAddr, usdtAddr, hordexAddr);
  const roiFacet = await (await ethers.getContractFactory("HordexROIFacet")).deploy();
  const core = await (await ethers.getContractFactory("Hordex", { libraries: { HordexMath: mathAddr } }))
    .deploy(routerAddr, factoryAddr, usdtAddr, hordexAddr, await facet.getAddress(), await roiFacet.getAddress());
  const coreAddr = await core.getAddress();
  const viewFacet = await (await ethers.getContractFactory("HordexViewFacet", {
    libraries: { HordexMath: mathAddr, HordexViewLib: viewLibAddr },
  })).deploy(factoryAddr, usdtAddr, hordexAddr);
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
  await topUpETH(who.address);
  await (await ctx.usdt.connect(who).deposit({ value: E(5000) })).wait();
  await (await ctx.usdt.connect(who).approve(ctx.coreAddr, ethers.MaxUint256)).wait();
}
async function reg(ctx, who, ref) { await (await ctx.liq.connect(who).register(ref.address)).wait(); }
async function inv(ctx, who, amt) { await (await ctx.liq.connect(who).invest(ctx.hordexAddr, E(amt))).wait(); }

describe("One referral commission per person per investment", function () {
  this.timeout(300000);

  it("an ancestor receives ONLY its own natural level (no roll-up); ineligible uplines' levels go to the deployer", async () => {
    const ctx = await deploy();
    const { owner, signers, liq, usdt, hordexAddr } = ctx;
    const A = signers[1], B = signers[2], C = signers[3], X = signers[4];

    // chain owner → A → B → C → X. A is eligible (flat $25 referral gate); B and C are NOT (no stake).
    // From X: C=L1 (i=0), B=L2 (i=1), A=L3 (i=2). No roll-up — A only ever earns its OWN depth (L3),
    // and B's/C's ineligible levels go to the deployer, NOT up to A.
    await fund(ctx, A); await fund(ctx, B); await fund(ctx, C); await fund(ctx, X);
    await reg(ctx, A, owner); await inv(ctx, A, 25);   // A eligible (>= $25), holds cap
    await reg(ctx, B, A);                               // B registered, NO stake → ineligible
    await reg(ctx, C, B);                               // C registered, NO stake → ineligible
    await reg(ctx, X, C); await inv(ctx, X, 100);       // priming invest

    // Count A's commission records before/after X's next invest; assert exactly ONE new one.
    const before = (await liq.getCommissionRecords(A.address)).length;
    const aBalBefore = await usdt.balanceOf(A.address);
    await inv(ctx, X, 100);
    const recs = await liq.getCommissionRecords(A.address);
    const newRecs = recs.slice(before);
    const aGain = (await usdt.balanceOf(A.address)) - aBalBefore;

    console.log(`      A new commission records from one invest: ${newRecs.length}`,
      newRecs.map(r => `L${Number(r.level)}=$${ethers.formatEther(r.amount)}`).join(" "));
    assert.equal(newRecs.length, 1, "A must receive exactly ONE referral commission from one investment");

    // A earns ONLY its natural depth — paid level 3 (index i=2). No roll-up to the higher-value L1.
    assert.equal(Number(newRecs[0].level), 3, "A keeps its own natural level (paid level 3), not a rolled-up one");

    // Sanity: that single commission = rate[2] (10%) of the 20% pool of the $100 package, minus the
    // 5% deployer cut → 100 * 0.20 * 0.10 * 0.95 = $1.90.
    console.log(`      A single-commission gain: $${ethers.formatEther(aGain)}`);
    assert(aGain > E(1.8) && aGain < E(2.0), "A's single commission should be its natural level-3 amount (~$1.90)");
  });

  it("with all uplines eligible, each distinct ancestor still gets exactly one (their own) level", async () => {
    const ctx = await deploy();
    const { owner, signers, liq, hordexAddr } = ctx;
    const A = signers[1], B = signers[2], C = signers[3], X = signers[4];

    // chain owner → A → B → C → X, all eligible.
    await fund(ctx, A); await fund(ctx, B); await fund(ctx, C); await fund(ctx, X);
    await reg(ctx, A, owner); await inv(ctx, A, 100);
    await reg(ctx, B, A);     await inv(ctx, B, 100);
    await reg(ctx, C, B);     await inv(ctx, C, 100);
    await reg(ctx, X, C);     await inv(ctx, X, 100);

    const aBefore = (await liq.getCommissionRecords(A.address)).length;
    const bBefore = (await liq.getCommissionRecords(B.address)).length;
    const cBefore = (await liq.getCommissionRecords(C.address)).length;
    await inv(ctx, X, 100);
    const aNew = (await liq.getCommissionRecords(A.address)).length - aBefore;
    const bNew = (await liq.getCommissionRecords(B.address)).length - bBefore;
    const cNew = (await liq.getCommissionRecords(C.address)).length - cBefore;

    console.log(`      new commission counts — C(L1):${cNew} B(L2):${bNew} A(L3):${aNew}`);
    assert.equal(cNew, 1, "C gets exactly one (its level 1)");
    assert.equal(bNew, 1, "B gets exactly one (its level 2)");
    assert.equal(aNew, 1, "A gets exactly one (its level 3)");
  });

  it("an ancestor is only ever the recipient at its OWN depth, so it is never 'missed' on other levels", async () => {
    const ctx = await deploy();
    const { owner, signers, liq, hordexAddr } = ctx;
    const A = signers[1], B = signers[2], C = signers[3], X = signers[4];

    // Same ineligible-uplines setup. A's natural depth from X is L3 (i=2); A is eligible there (flat
    // $25 gate) and gets paid, so it has no missed record. The lower levels (C's L1, B's L2) are
    // B's/C's natural depths — not A's — so A is never flagged as "missing" them.
    await fund(ctx, A); await fund(ctx, B); await fund(ctx, C); await fund(ctx, X);
    await reg(ctx, A, owner); await inv(ctx, A, 25);
    await reg(ctx, B, A);
    await reg(ctx, C, B);
    await reg(ctx, X, C); await inv(ctx, X, 100);

    const missedBefore = (await liq.getMissedRecords(A.address)).length;
    await inv(ctx, X, 100);
    const missedAfter = (await liq.getMissedRecords(A.address)).length;

    console.log(`      A missed records delta: ${missedAfter - missedBefore}`);
    // A is the recipient only at its own depth (where it is eligible and paid) → no missed records.
    assert.equal(missedAfter - missedBefore, 0, "A is only the recipient at its own depth, so it has no missed levels");
  });
});
