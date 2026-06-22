// Pins the rule: ROI is claimable ONLY for time it accrued while BOTH (lock active) AND (cap
// available). ROI that accrues while the recipient's cap is exhausted is FORFEITED (missed) — it is
// NOT "held" and can NEVER be recovered by re-investing for fresh cap. Only ROI earned BEFORE the
// cap ran out stays claimable.
//
// Scenario (the reported case): A ($25 package, cap $125) refers B who invests big. B's referral
// commission immediately exhausts A's whole $125 cap, so A's level-0 ROI stream on B's lock accrues
// the entire time with ZERO cap available. After the locks run their term A re-invests for fresh
// cap — and must still be able to claim $0 of that stream (the whole accrual was no-cap).
//
// Regression guard: the cap-exhaustion resume boundary must be the EXHAUSTION time, not the later
// lock-expiry (the old max() let the no-cap stretch up to expiry be "held" and recovered).
//
// Run:  npx hardhat test test/no-cap-roi-forfeit.test.js

const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 10_000_000;
const SEED = E(9000);
const LOCK_SECS = 540; // 90 days @ 6 s/day (testing scale)
const f = (x) => parseFloat(ethers.formatEther(x));

async function increaseTime(secs) {
  await network.provider.send("evm_increaseTime", [secs]);
  await network.provider.send("evm_mine", []);
}

async function deploy() {
  await network.provider.request({ method: "hardhat_reset", params: [{}] });
  const signers = await ethers.getSigners();
  const [owner, u1] = signers;

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

  await (await usdt.connect(u1).deposit({ value: E(2000) })).wait();
  await (await usdt.connect(u1).approve(coreAddr, ethers.MaxUint256)).wait();
  await (await liq.connect(u1).register(owner.address)).wait();
  return { owner, u1, signers, liq, hordex, usdt, hordexAddr, coreAddr };
}

async function freshTwap(liq, hordexAddr) {
  await (await liq.updateTWAP()).wait();
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
}

describe("No-cap ROI is FORFEITED, never recovered by re-investing", function () {
  this.timeout(300000);

  it("ROI that accrues while A's cap is exhausted is not claimable after A re-invests", async () => {
    const ctx = await deploy();
    const { u1, signers, liq, hordex, usdt, hordexAddr, coreAddr } = ctx;

    // A invests $25 → 5× cap = $125.
    await (await liq.connect(u1).invest(hordexAddr, E(25))).wait();

    // B invests $2,500 under A → referral L1 = 50% × (20% × 2500) = $250, capped to A's $125, which
    // EXHAUSTS A's whole cap. B's package (≥ $100) assigns A a level-0 ROI stream — accruing with $0 cap.
    const B = signers[2];
    await (await usdt.connect(B).deposit({ value: E(3000) })).wait();
    await (await usdt.connect(B).approve(coreAddr, ethers.MaxUint256)).wait();
    await (await liq.connect(B).register(u1.address)).wait();
    await (await liq.connect(B).invest(hordexAddr, E(2500))).wait();

    assert.strictEqual(f(await liq.getAvailableCap(u1.address)), 0, "A's cap must be exhausted by the referral");
    const streams = await liq.getActiveROIStreams(u1.address);
    assert(streams.length >= 1, "A must hold a ROI stream from B");
    const s0 = streams[0];

    // Run the full lock term so A's $25 lock AND B's $2,500 lock both expire (the case the old
    // max(_capPausedAt, _lastExpiry) boundary mishandled — it would "hold" the no-cap stretch).
    await increaseTime(LOCK_SECS + 5);
    await freshTwap(liq, hordexAddr);

    // A re-invests $100 → fresh $500 cap.
    await (await liq.connect(u1).invest(hordexAddr, E(100))).wait();
    await freshTwap(liq, hordexAddr);

    // Force-settle B's stream, then assert nothing became claimable and it was recorded as MISSED.
    await (await liq.connect(u1).settleROIStreams(0, streams.length)).wait();
    const pending = await liq.getROIPending(u1.address);
    assert(f(pending) < 0.01, `no-cap ROI must NOT become claimable after re-invest (pending ${f(pending)})`);

    const info = await liq.getROIStreamInfo(s0.investor, s0.lockIndex, s0.level);
    assert.strictEqual(f(info.heldCarryETH), 0, "nothing may be HELD for the no-cap period");
    assert(f(info.historicalMissedETH) > 0, "the no-cap ROI must be recorded as MISSED (forfeited)");

    // And a real claim pays ~0.
    const before = await hordex.balanceOf(u1.address);
    try { await (await liq.connect(u1).claimAllROI()).wait(); } catch (_) {}
    const claimed = f((await hordex.balanceOf(u1.address)) - before);
    console.log("      ROI claimed after re-invest (must be ~0):", claimed, " missed:", f(info.historicalMissedETH));
    assert(claimed < 0.01, `no-cap ROI must be forfeited, not paid (claimed ${claimed})`);
  });
});
