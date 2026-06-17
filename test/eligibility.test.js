// Characterization for the LEVEL-ELIGIBILITY gates (self-stake + team-business) that replace the
// old headcount gate ("N directs for level N") for BOTH referral commissions and ROI.
//
// Rule (0-indexed level i, paid level N = i+1): a recipient earns level i only if
//   active self-stake (USDT)        >= selfStakeGate[i]   ([25,50,100,250,500,1000,1000,1000,1000,1000])
//   cumulative team business (USDT) >= businessGate[i]    ([0,0,500,2500,5000,10000,10000,10000,10000,10000])
// Self-stake is ACTIVE (drops when locks expire); team business is sticky (lifetime), rolled up 10
// levels on each downline invest. An ineligible ancestor is skipped: referral rolls up to the next
// eligible ancestor; ROI assigns no stream for that level.
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

describe("Level-eligibility gates (self-stake + team business)", function () {
  this.timeout(300000);

  // ── SELF-STAKE gate (isolated at level 2, whose business-gate is $0) ─────────────────
  it("referral: a level-2 recipient below the self-stake gate ($50) is skipped, then qualifies after topping up", async () => {
    const ctx = await deploy();
    const { owner, signers, liq, usdt, hordexAddr } = ctx;
    const U2 = signers[2], U1 = signers[3], X = signers[4];

    // chain owner → U2 → U1 → X. U2 stakes only $25 → meets L1 ($25) but NOT L2 self-gate ($50).
    await fund(ctx, U2); await fund(ctx, U1); await fund(ctx, X);
    await reg(ctx, U2, owner); await inv(ctx, U2, 25);
    await reg(ctx, U1, U2);    await inv(ctx, U1, 100);
    await reg(ctx, X,  U1);    await inv(ctx, X, 100);

    // X invests → U2 is the natural level-2 recipient. $25 < $50 ⇒ rolled up, U2 gets nothing.
    let b = await usdt.balanceOf(U2.address);
    await inv(ctx, X, 100);
    const blocked = (await usdt.balanceOf(U2.address)) - b;

    // U2 adds $25 (active self-stake now $50) ⇒ eligible for level 2.
    await inv(ctx, U2, 25);
    b = await usdt.balanceOf(U2.address);
    await inv(ctx, X, 100);
    const allowed = (await usdt.balanceOf(U2.address)) - b;

    console.log("      L2 self-gate — blocked@ $25:", f(blocked), " allowed@ $50:", f(allowed));
    assert(blocked === 0n, "below the L2 self-gate the recipient must receive nothing (rolled up)");
    assert(allowed > 0n, "at/above the L2 self-gate the recipient must receive the level-2 commission");
  });

  // ── TEAM-BUSINESS gate (isolated at level 3: self-gate $100, business-gate $500) ──────
  it("referral: a level-3 recipient below the business gate ($500) is skipped, then qualifies once business crosses it", async () => {
    const ctx = await deploy();
    const { owner, signers, liq, usdt, hordexAddr } = ctx;
    const U3 = signers[2], V2 = signers[3], V1 = signers[4], W = signers[5], Y = signers[6];

    // chain owner → U3 → V2 → V1 → W. U3 stakes $100 (meets L3 self-gate $100); business builds up.
    await fund(ctx, U3); await fund(ctx, V2); await fund(ctx, V1); await fund(ctx, W); await fund(ctx, Y);
    await reg(ctx, U3, owner); await inv(ctx, U3, 100);
    await reg(ctx, V2, U3);    await inv(ctx, V2, 100);   // U3 business 100
    await reg(ctx, V1, V2);    await inv(ctx, V1, 100);   // U3 business 200
    await reg(ctx, W,  V1);    await inv(ctx, W, 100);    // U3 business 300

    // W (level 3 of U3) invests → U3 business 400 (< 500) ⇒ U3 skipped at level 3.
    let b = await usdt.balanceOf(U3.address);
    await inv(ctx, W, 100);
    const blocked = (await usdt.balanceOf(U3.address)) - b;

    // Add a deeper downline so U3's cumulative business crosses $500, then trigger level 3 again.
    await reg(ctx, Y, W); await inv(ctx, Y, 250);          // U3 business 650
    b = await usdt.balanceOf(U3.address);
    await inv(ctx, W, 100);                                // U3 business 750 ⇒ eligible
    const allowed = (await usdt.balanceOf(U3.address)) - b;

    console.log("      L3 business-gate — blocked@ $400:", f(blocked), " allowed@ $750:", f(allowed));
    assert(blocked === 0n, "below the L3 business-gate the recipient must receive nothing (rolled up)");
    assert(allowed > 0n, "once business >= $500 the recipient must receive the level-3 commission");
  });

  // ── ROI uses the SAME gate at assignment ─────────────────────────────────────────────
  it("ROI: an ancestor below a level's gates is assigned NO stream for that level (skipped), then gets it once eligible", async () => {
    const ctx = await deploy();
    const { owner, signers, liq, hordexAddr } = ctx;
    const U3 = signers[2], V2 = signers[3], V1 = signers[4], W = signers[5], Y = signers[6];
    const ZERO = ethers.ZeroAddress;

    // chain owner → U3 → V2 → V1 → W. W's lock-0 streams go up: V1=L0, V2=L1, U3=L2.
    // U3 (self $100 ✓, business 300 < $500 ✗) fails the L2 business-gate → its L2 stream is skipped.
    await fund(ctx, U3); await fund(ctx, V2); await fund(ctx, V1); await fund(ctx, W); await fund(ctx, Y);
    await reg(ctx, U3, owner); await inv(ctx, U3, 100);
    await reg(ctx, V2, U3);    await inv(ctx, V2, 100);
    await reg(ctx, V1, V2);    await inv(ctx, V1, 100);
    await reg(ctx, W,  V1);    await inv(ctx, W, 100);     // U3 business 300 (< 500) at assignment

    const l0 = (await liq.getROIStreamInfo(W.address, 0, 0)).recipient;  // direct referrer V1 (eligible)
    const l2 = (await liq.getROIStreamInfo(W.address, 0, 2)).recipient;  // U3 (business-ineligible)
    console.log("      ROI assign — W.L0:", l0, " W.L2(skipped?):", l2);
    assert(l0.toLowerCase() === V1.address.toLowerCase(), "eligible direct referrer is assigned the L0 stream");
    assert(l2 === ZERO, "business-ineligible L2 ancestor is skipped (recipient stays address(0))");

    // Boost U3's cumulative business past $500, then W opens a NEW lock → U3 now qualifies for L2.
    await reg(ctx, Y, W); await inv(ctx, Y, 250);          // U3 business → 550
    await inv(ctx, W, 100);                                // W lock-1 assignment; U3 business → 650, eligible
    const l2b = (await liq.getROIStreamInfo(W.address, 1, 2)).recipient;
    console.log("      ROI assign after eligible — W.lock1.L2:", l2b);
    assert(l2b.toLowerCase() === U3.address.toLowerCase(), "once business >= $500 the L2 stream is assigned to U3");
    // The earlier lock-0 L2 stream stays skipped (eligibility is evaluated per assignment, not retroactively).
    assert((await liq.getROIStreamInfo(W.address, 0, 2)).recipient === ZERO, "lock-0's skipped L2 stream is not retroactively assigned");
  });

  // ── View getters the frontend depends on ─────────────────────────────────────────────
  it("views: getEligibilityGates + getUserEligibility expose the right values for the UI", async () => {
    const ctx = await deploy();
    const { owner, signers, liq } = ctx;
    const P = signers[2], Q = signers[3];

    const [selfGates, bizGates] = await liq.getEligibilityGates();
    assert.equal(Number(selfGates[0]), 25);
    assert.equal(Number(selfGates[5]), 1000);   // levels 6-10 share $1,000
    assert.equal(Number(selfGates[9]), 1000);
    assert.equal(Number(bizGates[2]), 500);
    assert.equal(Number(bizGates[4]), 5000);    // level 5
    assert.equal(Number(bizGates[9]), 10000);   // levels 6-10 share $10,000

    // P stakes $100 (self 100) with one $250 downline (business 250):
    // L1($25/$0)✓  L2($50/$0)✓  L3($100/$500)✗ ⇒ unlockedLevels = 2.
    await fund(ctx, P); await fund(ctx, Q);
    await reg(ctx, P, owner); await inv(ctx, P, 100);
    await reg(ctx, Q, P);     await inv(ctx, Q, 250);

    const e = await liq.getUserEligibility(P.address);
    console.log("      getUserEligibility(P):", Number(e.selfStakeUSDT ?? e[0]), Number(e.teamBusinessUSDT ?? e[1]), Number(e.unlockedLevels ?? e[2]));
    assert.equal(Number(e.selfStakeUSDT ?? e[0]), 100);
    assert.equal(Number(e.teamBusinessUSDT ?? e[1]), 250);
    assert.equal(Number(e.unlockedLevels ?? e[2]), 2);
  });
});
