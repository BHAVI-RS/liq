// Pins the restake "streak" bonus. Restaking a lock for the SAME duration should raise the
// reward rate each time (streak 1→2→3, capped at 3); restaking a DIFFERENT duration resets it.
//
// Regression: restakeLPExt recovered the ending period's duration with `(unlockTime-lockedAt)/2`
// while lock windows are scaled 1 day = 6 s, so the recovered "days" landed on the wrong bucket
// (90d → 270 ≈ 180d). dIdx never matched prevDIdx, the streak reset every time, and every
// same-duration restake paid the BASE rate. Fixed by dividing by 6.
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

  it("resets the streak when the restake duration changes", async () => {
    const { u1, liq, hordexAddr } = await deployBase();
    await (await liq.connect(u1).invest(hordexAddr, PKG)).wait(); // 90-day lock

    await expireAndRestake(liq, hordexAddr, u1, 90); // streak 1 @ 90d
    const s1_90 = await rateOf(liq, u1.address);
    assert(s1_90 > 0n);

    // Switch to a different duration → streak resets to base for that duration.
    await expireAndRestake(liq, hordexAddr, u1, 30);
    const base30 = await rateOf(liq, u1.address);

    await expireAndRestake(liq, hordexAddr, u1, 30); // now streak 1 @ 30d
    const s1_30 = await rateOf(liq, u1.address);

    console.log(`      streak1@90d=${s1_90}  base@30d=${base30}  streak1@30d=${s1_30}`);
    assert(base30 < s1_90, "switching duration drops back to that duration's base rate (streak reset)");
    assert(s1_30 > base30, "after switching durations, the new duration builds its own streak");

    // The contract zeroes the bucket being switched INTO, not the one left behind, so the old
    // 90-day count lies dormant (1) and is harmless — it gets zeroed if the user ever returns to
    // 90d (that path takes the mismatch branch first). What matters is the 30-day bucket tracking.
    const counts = (await liq.getUserLPLocks(u1.address))[0].restakeCounts.map(Number);
    assert.equal(counts[1], 1, "30-day bucket counts the same-duration 30d restake");
    assert.equal(counts[3], 1, "old 90-day count lies dormant until the user returns to 90d");
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
