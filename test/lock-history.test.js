// Verifies the on-chain per-lock period history that backs the frontend "Lock History" modal.
//
// The old modal reconstructed periods/claims from event logs filtered only by user+token
// (restakes) or just user (staking claims), so with multiple locks the data was cross-
// attributed (one lock's claim showed up against another). These tests pin the new
// getLockPeriods() getter: each lock owns its own periods, and a per-lock staking claim is
// recorded ONLY against that lock's current period.
//
// Run:  npx hardhat test test/lock-history.test.js

const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 100_000_000;
const SEED = E(1_000_000);
const PKG = E(500); // ≥ $100 → earns a staking reward

async function increaseTime(secs) {
  await network.provider.send("evm_increaseTime", [secs]);
  await network.provider.send("evm_mine", []);
}
async function topUpETH(addr) {
  await network.provider.send("hardhat_setBalance", [addr, "0x52B7D2DCC80CD2E4000000"]);
}
async function refreshTwap(liq, hordexAddr) {
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
  await (await liq.updateTWAP()).wait();
}

async function deployBase() {
  await network.provider.request({ method: "hardhat_reset", params: [{}] });
  const [owner, u1] = await ethers.getSigners();
  await topUpETH(owner.address);
  await topUpETH(u1.address);

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
  await refreshTwap(liq, hordexAddr);
  await increaseTime(31);
  await refreshTwap(liq, hordexAddr);

  await (await usdt.connect(u1).deposit({ value: E(200000) })).wait();
  await (await usdt.connect(u1).approve(coreAddr, ethers.MaxUint256)).wait();
  await (await liq.connect(u1).register(owner.address)).wait();
  return { owner, u1, liq, hordex, usdt, hordexAddr, coreAddr };
}

describe("Lock History — per-lock period tracking (getLockPeriods)", function () {
  this.timeout(600000);

  it("records one initial period per lock and never cross-attributes a per-lock staking claim", async () => {
    const { u1, liq, hordexAddr } = await deployBase();

    // Two locks of the SAME token — the exact scenario the old log-reconstruction mixed up.
    await (await liq.connect(u1).invest(hordexAddr, PKG)).wait(); // lock 0
    await increaseTime(15);
    await refreshTwap(liq, hordexAddr);
    await (await liq.connect(u1).invest(hordexAddr, PKG)).wait(); // lock 1

    let p0 = await liq.getLockPeriods(u1.address, 0);
    let p1 = await liq.getLockPeriods(u1.address, 1);
    assert.equal(p0.length, 1, "lock 0 should have exactly its initial period");
    assert.equal(p1.length, 1, "lock 1 should have exactly its initial period");
    assert.equal(p0[0].claimed, 0n);
    assert.equal(p1[0].claimed, 0n);
    assert(p0[0].end > p0[0].start, "period end must be after start");

    // Accrue, then claim ONLY lock 0.
    await increaseTime(300);
    await refreshTwap(liq, hordexAddr);
    await (await liq.connect(u1).claimStakingRewardForLock(0)).wait();

    p0 = await liq.getLockPeriods(u1.address, 0);
    p1 = await liq.getLockPeriods(u1.address, 1);
    assert(p0[0].claimed > 0n, "lock 0 period must record the claim");
    assert.equal(p1[0].claimed, 0n, "lock 1 must NOT inherit lock 0's claim (the bug)");

    // Per-lock claimed total is authoritative and matches the lock struct.
    const locks = await liq.getUserLPLocks(u1.address);
    assert.equal(p0[0].claimed.toString(), locks[0].totalTokensClaimed.toString());
    assert.equal(locks[1].totalTokensClaimed.toString(), "0");
  });

  it("opens a new period on restake and attributes later claims to the current period only", async () => {
    const { u1, liq, hordexAddr } = await deployBase();

    await (await liq.connect(u1).invest(hordexAddr, PKG)).wait(); // lock 0
    await increaseTime(300);
    await refreshTwap(liq, hordexAddr);
    await (await liq.connect(u1).claimStakingRewardForLock(0)).wait();

    let p0 = await liq.getLockPeriods(u1.address, 0);
    const period0Claimed = p0[0].claimed;
    assert(period0Claimed > 0n);

    // Expire and restake → a second period opens, first period stays frozen.
    await increaseTime(600);
    await refreshTwap(liq, hordexAddr);
    await (await liq.connect(u1).restakeLP(0, 90)).wait();

    p0 = await liq.getLockPeriods(u1.address, 0);
    assert.equal(p0.length, 2, "restake should append a second period");
    assert.equal(p0[1].claimed, 0n, "new period starts with zero claimed");
    assert.equal(p0[0].claimed.toString(), period0Claimed.toString(), "old period claimed is immutable");

    // Claim again → only the current (2nd) period grows.
    await increaseTime(300);
    await refreshTwap(liq, hordexAddr);
    await (await liq.connect(u1).claimStakingRewardForLock(0)).wait();

    p0 = await liq.getLockPeriods(u1.address, 0);
    assert(p0[1].claimed > 0n, "current period records the new claim");
    assert.equal(p0[0].claimed.toString(), period0Claimed.toString(), "old period still immutable");

    // Sum of period claims equals the lock's authoritative lifetime total.
    const locks = await liq.getUserLPLocks(u1.address);
    const sum = p0.reduce((s, p) => s + p.claimed, 0n);
    assert.equal(sum.toString(), locks[0].totalTokensClaimed.toString());
  });
});
