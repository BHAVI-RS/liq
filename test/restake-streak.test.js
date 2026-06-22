// Pins the restake "streak" bonus. Restaking a lock for the SAME duration raises the reward rate
// each time (streak 1→2→3, capped at 3). Each duration owns an INDEPENDENT, PERSISTENT streak:
// switching to another duration starts/continues that duration's own streak and does NOT wipe the
// others, so a 90d→30d→90d sequence returns to 90d at streak 2 (not base).
//
// Model: restakeCounts[dIdx] = periods already started in that duration (the 90-day slot is seeded
// to 1 at invest, since the invest lock is a 90-day base period). A new period in dIdx applies
// streak level min(count, 3), then advances that one counter. No cross-duration reset.
//
// Run:  npx hardhat test test/restake-streak.test.js

const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 100_000_000;
const SEED = E(1_000_000);
const PKG = E(500); // ≥ $100 → earns a staking reward
const LOCK_SECS = 540; // 90 days @ 1 day = 6 s

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

const rateOf = async (liq, user, idx = 0) =>
  BigInt((await liq.getUserLPLocks(user))[idx].rewardRatePPM);

async function expireAndRestake(liq, hordexAddr, u1, days) {
  await increaseTime(LOCK_SECS + 1);
  await refreshTwap(liq, hordexAddr); // keep platform TWAP fresh right before the restake
  await (await liq.connect(u1).restakeLP(0, days)).wait();
}

// Advance just past a specific lock's current unlockTime (works for any duration).
async function advancePastUnlock(liq, user, idx) {
  const lock = (await liq.getUserLPLocks(user))[idx];
  const now  = (await ethers.provider.getBlock("latest")).timestamp;
  const wait = Number(lock.unlockTime) - now + 2;
  if (wait > 0) await increaseTime(wait);
}

describe("Restake streak bonus", function () {
  this.timeout(600000);

  it("raises the reward rate on each same-duration restake (streak 1→2→3, then caps)", async () => {
    const { u1, liq, hordexAddr } = await deployBase();
    await (await liq.connect(u1).invest(hordexAddr, PKG)).wait(); // 90-day lock, base rate

    const base = await rateOf(liq, u1.address);
    assert(base > 0n, "package ≥ $100 must earn a base staking rate");

    await expireAndRestake(liq, hordexAddr, u1, 90);
    const s1 = await rateOf(liq, u1.address);
    await expireAndRestake(liq, hordexAddr, u1, 90);
    const s2 = await rateOf(liq, u1.address);
    await expireAndRestake(liq, hordexAddr, u1, 90);
    const s3 = await rateOf(liq, u1.address);
    await expireAndRestake(liq, hordexAddr, u1, 90);
    const s4 = await rateOf(liq, u1.address); // 4th restake — streak caps at 3

    console.log(`      base=${base}  streak1=${s1}  streak2=${s2}  streak3=${s3}  streak4(capped)=${s4}`);

    assert(s1 > base, "1st same-duration restake must beat the base rate (was the bug: equal to base)");
    assert(s2 > s1, "2nd restake must beat the 1st");
    assert(s3 > s2, "3rd restake must beat the 2nd");
    assert.equal(s4.toString(), s3.toString(), "streak caps at 3 — 4th restake stays at the 3rd's rate");

    // Restake counts surface the streak too (index 3 = 90-day bucket), capped tracking continues.
    const counts = (await liq.getUserLPLocks(u1.address))[0].restakeCounts.map(Number);
    assert.equal(counts[3], 4, "90-day bucket counts every same-duration restake");
  });

  it("keeps each duration's streak PERSISTENT across a duration switch (90→30→90 continues)", async () => {
    // The exact scenario: invest (90d base) → restake 90d (streak 1) → restake 30d (base, its own
    // streak) → restake 90d AGAIN must continue at streak 2, not reset to base. Each duration owns
    // an independent streak that never vanishes when you detour through another duration.
    const { u1, liq, hordexAddr } = await deployBase();
    await (await liq.connect(u1).invest(hordexAddr, PKG)).wait(); // 90-day lock, base

    const [durs, baseRates] = await liq.getStakingRatesForAmount(PKG);
    assert.equal(Number(durs[3]), 90, "index 3 = 90d");
    assert.equal(Number(durs[1]), 30, "index 1 = 30d");
    const base90  = BigInt(baseRates[3]);
    const base30  = BigInt(baseRates[1]);
    const incr90  = 30_000n;
    const incr30  = 5_000n;

    await expireAndRestake(liq, hordexAddr, u1, 90); // 90d streak 1
    const s1_90 = await rateOf(liq, u1.address);
    assert.equal(s1_90.toString(), (base90 + 1n * incr90).toString(), "first 90d restake = streak 1");

    await expireAndRestake(liq, hordexAddr, u1, 30); // 30d first visit → base (90d streak preserved)
    const b30 = await rateOf(liq, u1.address);
    assert.equal(b30.toString(), base30.toString(), "first 30d restake lands on 30d base");

    await expireAndRestake(liq, hordexAddr, u1, 90); // back to 90d → CONTINUES at streak 2
    const s2_90 = await rateOf(liq, u1.address);
    assert.equal(s2_90.toString(), (base90 + 2n * incr90).toString(), "returning to 90d continues at streak 2 (not reset)");

    await expireAndRestake(liq, hordexAddr, u1, 30); // back to 30d → its own streak advances to 1
    const s1_30 = await rateOf(liq, u1.address);
    assert.equal(s1_30.toString(), (base30 + 1n * incr30).toString(), "returning to 30d continues that duration's streak");

    console.log(`      90d: base=${base90} s1=${s1_90} s2=${s2_90}  |  30d: base=${base30} s1=${s1_30}`);

    // Both buckets persist simultaneously: 90d has done base(invest)+streak1+streak2 = 3 periods,
    // 30d has done base+streak1 = 2 periods. (periods-done counters; level = count-1.)
    const counts = (await liq.getUserLPLocks(u1.address))[0].restakeCounts.map(Number);
    assert.equal(counts[3], 3, "90-day bucket persisted across the 30d detour (3 periods done)");
    assert.equal(counts[1], 2, "30-day bucket tracked its own two periods");
  });

  // The default investment lock is ALWAYS 90 days, so restaking 90d continues straight into
  // streak 1; every other duration is a duration-change off that 90-day base, so its first
  // restake lands on base (streak 0) and builds from there. This pins the exact reward rate
  // (base + sIdx*incr) at each step for all six durations against the on-chain rate table.
  it("applies the correct streak rate on every restake, for all six durations", async () => {
    const DURATIONS   = [7, 30, 60, 90, 180, 360];
    // Per-duration streak increment — MUST match _setTieredRates() in Hordex.sol AND the
    // frontend's _streakIncrPPM in openStakeModal. (7-day = 0 → no streak bonus by design.)
    const STREAK_INCR = [0, 5_000, 26_000, 30_000, 50_000, 100_000];

    const { u1, liq, hordexAddr } = await deployBase();

    // Base (streak-0) rate per duration for this package, straight from the contract table.
    const [durs, baseRates] = await liq.getStakingRatesForAmount(PKG);
    durs.forEach((d, i) => assert.equal(Number(d), DURATIONS[i], "duration order sanity"));

    for (let di = 0; di < DURATIONS.length; di++) {
      const D    = DURATIONS[di];
      const base = BigInt(baseRates[di]);
      const incr = BigInt(STREAK_INCR[di]);
      assert(base > 0n, `package must earn a base rate at ${D}d`);

      // Fresh 90-day lock for this duration.
      await refreshTwap(liq, hordexAddr);
      await (await liq.connect(u1).invest(hordexAddr, PKG)).wait();
      const idx = (await liq.getUserLPLocks(u1.address)).length - 1;

      // Expected streak level after each successive restake of duration D.
      const ladder = (D === 90) ? [1, 2, 3, 3] : [0, 1, 2, 3, 3];
      const seen = [];
      for (const sIdx of ladder) {
        await advancePastUnlock(liq, u1.address, idx);
        await refreshTwap(liq, hordexAddr);
        await (await liq.connect(u1).restakeLP(idx, D)).wait();
        const rate = await rateOf(liq, u1.address, idx);
        const want = base + BigInt(sIdx) * incr;
        assert.equal(
          rate.toString(), want.toString(),
          `at ${D}d restake → expected streak ${sIdx} rate ${want}, got ${rate}`
        );
        seen.push(rate.toString());
      }
      console.log(`      ${String(D).padStart(3)}d  base=${base}  ladder=[${seen.join(", ")}]`);
    }
  });
});
