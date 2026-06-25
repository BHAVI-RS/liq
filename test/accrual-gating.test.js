// Invariant tests: ROI commissions and referral rewards are accrued/earned ONLY while the
// relevant lock is ACTIVE and cap is AVAILABLE. (Already-earned ROI stays claimable afterwards —
// the retention/H-1 behavior — but NO NEW value is earned once the lock expires or cap runs out.)
//
// Run (TESTING config — SECONDS_PER_DAY=6, USDT_ONE=1e18, TWAP_PERIOD=30s):
//   npx hardhat test test/accrual-gating.test.js
const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 100_000_000;
const SEED = E(1_000_000);
const LOCK_SECS = 540; // 90 * SECONDS_PER_DAY (testing config)

async function increaseTime(secs) {
  await network.provider.send("evm_increaseTime", [secs]);
  await network.provider.send("evm_mine", []);
}
async function topUpETH(addr) {
  await network.provider.send("hardhat_setBalance", [addr, "0x52B7D2DCC80CD2E4000000"]);
}
async function deployBase() {
  await network.provider.request({ method: "hardhat_reset", params: [{}] });
  const signers = await ethers.getSigners();
  const owner = signers[0];
  for (const s of signers.slice(0, 4)) await topUpETH(s.address);
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
async function fund(usdt, coreAddr, signer, amount) {
  await topUpETH(signer.address);
  await (await usdt.connect(signer).deposit({ value: amount })).wait();
  await (await usdt.connect(signer).approve(coreAddr, ethers.MaxUint256)).wait();
}
async function freshTwap(liq, hordexAddr) {
  await (await liq.updateTWAP()).wait();
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
}

describe("Accrual gating: earned only while lock active + cap available", function () {
  this.timeout(300000);

  it("ROI: stops accruing once the recipient's lock expires (earned-while-active stays claimable, no new accrual)", async () => {
    const { owner, signers, liq, usdt, hordexAddr, coreAddr } = await deployBase();
    const U = signers[1], D = signers[2];
    await fund(usdt, coreAddr, U, E(6000));
    await fund(usdt, coreAddr, D, E(6000));
    await (await liq.connect(U).register(owner.address)).wait();
    await (await liq.connect(D).register(U.address)).wait();

    await (await liq.connect(U).invest(hordexAddr, E(5000))).wait(); // U active recipient
    await (await liq.connect(D).invest(hordexAddr, E(5000))).wait(); // level-0 ROI stream → U

    // While active, ROI IS accruing (positive control).
    await increaseTime(200);
    const [liveMid] = await liq.getROIData(U.address);
    console.log(`      live ROI accrual mid-lock (active): ${ethers.formatEther(liveMid)}`);
    assert(liveMid > 0n, "ROI must accrue while the recipient's lock is active + has cap");

    // Let U's lock expire (do not remove). U now has NO active lock.
    await increaseTime(LOCK_SECS);
    await freshTwap(liq, hordexAddr);

    // No live accrual once the active lock is gone.
    const [liveAfter] = await liq.getROIData(U.address);
    assert(liveAfter === 0n, "no live ROI accrual once the recipient has no active lock");

    // The ROI earned WHILE active is still claimable (retention) — claim it…
    await (await liq.connect(U).claimAllROI()).wait();
    const recs = await liq.getROIClaimRecords(U.address);
    const earned = recs[recs.length - 1].ethEquivalent;
    console.log(`      claimed earned-while-active ROI: ${ethers.formatEther(earned)}`);
    assert(earned > 0n, "earned-while-active ROI must remain claimable");

    // …but NOTHING new accrues after expiry: wait more, claim again → reverts NothingToClaim.
    await increaseTime(400);
    await freshTwap(liq, hordexAddr);
    let reverted = false;
    try { await (await liq.connect(U).claimAllROI()).wait(); } catch (_) { reverted = true; }
    assert(reverted, "no further ROI may be earned/claimed after the recipient's lock expired");
    console.log("      post-expiry re-claim reverted (no new accrual) ✓");
  });

  it("Referral: an upline with no ACTIVE self-stake earns nothing — the commission routes to the deployer (recorded as missed)", async () => {
    const { owner, signers, liq, usdt, hordexAddr, coreAddr } = await deployBase();
    const U = signers[1], D = signers[2];
    await fund(usdt, coreAddr, U, E(6000));
    await fund(usdt, coreAddr, D, E(6000));
    await (await liq.connect(U).register(owner.address)).wait();
    await (await liq.connect(D).register(U.address)).wait();

    // U stakes, then D invests while U is ACTIVE → U earns a referral commission (positive control).
    await (await liq.connect(U).invest(hordexAddr, E(5000))).wait();
    await (await liq.connect(D).invest(hordexAddr, E(100))).wait();
    const [earnedActive] = await liq.getUserCommissionStats(U.address);
    const missedActive = (await liq.getMissedRecords(U.address)).length;
    console.log(`      U referral earned while active: ${ethers.formatEther(earnedActive)}  missedRecords=${missedActive}`);
    assert(earnedActive > 0n, "an active-staked upline must earn referral commission");

    // Let U's lock expire → U's active self-stake is now 0 (ineligible).
    await increaseTime(LOCK_SECS + 20);
    await freshTwap(liq, hordexAddr);

    const ownerEarnedBefore = (await liq.getUserCommissionStats(owner.address))[0];

    // D invests again. U is ineligible (no active stake) → nothing to U; routed to deployer + missed.
    await (await liq.connect(D).invest(hordexAddr, E(100))).wait();

    const [earnedAfter] = await liq.getUserCommissionStats(U.address);
    const missed = await liq.getMissedRecords(U.address);
    const ownerEarnedAfter = (await liq.getUserCommissionStats(owner.address))[0];

    assert(earnedAfter === earnedActive, "an upline with no active self-stake must NOT earn referral commission");
    assert(missed.length > missedActive, "the un-earned commission must be recorded as missed for the upline");
    assert(Number(missed[missed.length - 1].reason) === 0, "missed reason must be 0 (level-ineligible: no active self-stake)");
    assert(ownerEarnedAfter > ownerEarnedBefore, "the un-earned commission must route to the deployer");
    console.log(`      U earned unchanged (${ethers.formatEther(earnedAfter)}), commission routed to deployer, missed reason=0 ✓`);
  });
});
