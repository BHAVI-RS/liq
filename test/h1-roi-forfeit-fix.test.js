// Regression tests for the audit fixes:
//   H-1 — ROI that was settled against an EXPIRED-but-not-removed lock's cap must stay claimable
//         even while a fresh ACTIVE lock coexists (it used to be forfeited because the claim only
//         paid the active-lock cap and then zeroed pending).
//   M-1 — register / withdraw work with a base token that returns NO data on transfer/transferFrom
//         (e.g. canonical USDT), via _safeTransfer / _safeTransferFrom.
//
// Run (TESTING config — SECONDS_PER_DAY=6, USDT_ONE=1e18, TWAP_PERIOD=30s):
//   npx hardhat test test/h1-roi-forfeit-fix.test.js
const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 100_000_000;
const SEED = E(1_000_000);

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
  return { owner, signers, liq, hordex, usdt, hordexAddr, coreAddr, factoryAddr, usdtAddr };
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

describe("H-1: expired-lock ROI is claimable (not forfeited) while an active lock coexists", function () {
  this.timeout(300000);

  it("pays preserved ROI from an expired lock's cap even after re-investing a small package", async () => {
    const { owner, signers, liq, usdt, hordexAddr, coreAddr } = await deployBase();
    const U = signers[1];   // upline — level-0 ROI recipient
    const D = signers[2];   // downline — generates the ROI stream to U

    await fund(usdt, coreAddr, U, E(6000));
    await fund(usdt, coreAddr, D, E(6000));
    await (await liq.connect(U).register(owner.address)).wait();
    await (await liq.connect(D).register(U.address)).wait();

    // U stakes $5000 (lock A, active cap = $25,000) FIRST so U is an eligible ROI recipient when
    // D's stream is assigned. Then D stakes $5000 → a level-0 ROI stream accrues to U.
    await (await liq.connect(U).invest(hordexAddr, E(5000))).wait();
    await (await liq.connect(D).invest(hordexAddr, E(5000))).wait();

    // Let both 90-day locks expire (90 * SECONDS_PER_DAY = 540s in testing config). U does NOT
    // remove lock A — it becomes an EXPIRED, non-removed lock with lots of leftover cap.
    await increaseTime(600);
    await freshTwap(liq, hordexAddr);

    // U re-invests a TINY package ($25 → lock B, active cap = $125). This is the trigger: U now
    // holds an active lock (B, $125 cap) AND an expired lock (A, ~$24.5k cap) with preserved ROI.
    await (await liq.connect(U).invest(hordexAddr, E(25))).wait();

    const activeCapB = E(125); // 5 × $25 — the most the OLD (buggy) claim could ever pay here

    await freshTwap(liq, hordexAddr);
    await (await liq.connect(U).claimAllROI()).wait();

    const recs = await liq.getROIClaimRecords(U.address);
    assert(recs.length > 0, "U should have an ROI claim record");
    const claimedEth = recs[recs.length - 1].ethEquivalent; // toClaim, in USDT-wei

    console.log(`      claimed ROI (ethEquivalent) = ${ethers.formatEther(claimedEth)}  | active-lock cap = 125`);

    // The OLD code capped this at the active lock's $125 and forfeited the rest. The fix pays the
    // full preserved ROI (~$670) from the expired lock's cap.
    assert(claimedEth > activeCapB, `claim must exceed the active-lock cap (got ${ethers.formatEther(claimedEth)}, cap 125) — expired-lock ROI was forfeited`);
    assert(claimedEth > E(500), `expected the bulk of the preserved ROI (~$670), got ${ethers.formatEther(claimedEth)}`);
    assert(claimedEth < E(700), `sanity upper bound, got ${ethers.formatEther(claimedEth)}`);

    // Nothing left stranded/forfeited: pending is drained and an immediate re-claim yields nothing.
    let secondReverted = false;
    try { await (await liq.connect(U).claimAllROI()).wait(); } catch (_) { secondReverted = true; }
    assert(secondReverted, "second immediate claim should revert NothingToClaim (all settled ROI paid, none double-paid)");
  });
});

describe("M-1: non-standard base token (returns no data, like canonical USDT)", function () {
  this.timeout(120000);

  it("register pulls the fee and withdrawToken pays out, both via the safe-transfer helpers", async () => {
    await network.provider.request({ method: "hardhat_reset", params: [{}] });
    const [owner, u1] = await ethers.getSigners();
    await topUpETH(owner.address); await topUpETH(u1.address);

    const Math = await (await ethers.getContractFactory("HordexMath")).deploy();
    const mathAddr = await Math.getAddress();
    const ViewLib = await (await ethers.getContractFactory("HordexViewLib", { libraries: { HordexMath: mathAddr } })).deploy();
    const viewLibAddr = await ViewLib.getAddress();
    const usdt = await (await ethers.getContractFactory("NoReturnUSDT")).deploy(); // returns NO data
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

    // Registration fee = 1 USDT (USDT_ONE). With a no-data token, the OLD `if (!token.transferFrom(...))`
    // would revert on the bool decode; the safe helper succeeds.
    const ONE_USDT = E(1); // USDT_ONE = 1e18 in testing config
    await (await usdt.mint(u1.address, E(10))).wait();
    await (await usdt.connect(u1).approve(coreAddr, ethers.MaxUint256)).wait();

    const ownerBefore = await usdt.balanceOf(owner.address);
    await (await liq.connect(u1).register(owner.address)).wait();
    const ownerAfter = await usdt.balanceOf(owner.address);

    const u = await liq.users(u1.address);
    assert(u.isRegistered, "u1 should be registered with a no-data base token");
    assert(ownerAfter - ownerBefore === ONE_USDT, "owner should receive exactly the 1 USDT fee");

    // withdrawToken uses _safeTransfer on a no-data token: send some to the contract, withdraw it.
    await (await usdt.mint(coreAddr, E(50))).wait();
    const ownerPre = await usdt.balanceOf(owner.address);
    await (await liq.withdrawToken(usdtAddr, E(50))).wait();
    const ownerPost = await usdt.balanceOf(owner.address);
    assert(ownerPost - ownerPre === E(50), "owner should receive the withdrawn no-data tokens");
    console.log("      register + withdrawToken succeeded with a no-data (USDT-style) token");
  });
});
