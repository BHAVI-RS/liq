// Reproduction: per-stream CLAIM must NOT pay out HELD (over-cap) ROI.
// Held = ROI accruing after the cap is hit. It must only be claimable when cap
// headroom exists (new/expired cap), and claiming must consume cap.
//
// Run:  npx hardhat test test/held-roi-repro.test.js

const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 10_000_000;
const SEED = E(1000);
const PKG_SMALL = E(25);
const PKG_BIG = E(500);
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

  await (await usdt.connect(u1).deposit({ value: E(2000) })).wait();
  await (await usdt.connect(u1).approve(coreAddr, ethers.MaxUint256)).wait();
  await (await liq.connect(u1).register(owner.address)).wait();

  return { owner, u1, signers, liq, hordex, usdt, hordexAddr, coreAddr };
}

async function freshTwap(liq, hordexAddr) {
  await (await liq.updateTWAP()).wait();
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
}

async function directDownlineInvest(ctx, s) {
  const { u1, liq, usdt, coreAddr, hordexAddr } = ctx;
  await (await usdt.connect(s).deposit({ value: E(700) })).wait();
  await (await usdt.connect(s).approve(coreAddr, ethers.MaxUint256)).wait();
  await (await liq.connect(s).register(u1.address)).wait();
  await (await liq.connect(s).invest(hordexAddr, PKG_BIG)).wait();
}

describe("Per-stream CLAIM vs held over-cap ROI", function () {
  this.timeout(300000);

  it("per-stream claims must not exceed the raw committed cap (no held leak)", async () => {
    const ctx = await deploy();
    const { u1, signers, liq, hordex, hordexAddr } = ctx;

    await (await liq.connect(u1).invest(hordexAddr, PKG_SMALL)).wait(); // cap 125
    // 2 direct big downlines: referral commissions consume part of the cap; their level-0 ROI
    // streams accrue fast. Keep locks active so this is "held while staked".
    await directDownlineInvest(ctx, signers[2]);
    await directDownlineInvest(ctx, signers[3]);
    await increaseTime(300); // locks still active (term 540); ROI overshoots the cap → held
    await freshTwap(liq, hordexAddr);

    const avail = await liq.getAvailableCap(u1.address);
    const [, , totalCap] = await liq.getUserCommissionStats(u1.address);
    const pendingROI = await liq.getROIPending(u1.address);
    console.log("      availableCap(live):", f(avail), " totalCap(raw committed):", f(totalCap),
      " getROIPending:", f(pendingROI));

    // Sum what u1 can pull by clicking CLAIM on EACH stream individually (no re-invest).
    const streams = await liq.getActiveROIStreams(u1.address);
    let totalClaimed = 0n;
    for (const s of streams) {
      try {
        const b = await hordex.balanceOf(u1.address);
        await (await liq.connect(u1).claimROIFromStream(s.investor, s.lockIndex, s.level)).wait();
        const got = (await hordex.balanceOf(u1.address)) - b;
        totalClaimed += got;
        console.log("      claimed stream L" + s.level + ":", f(got));
      } catch (e) { console.log("      stream L" + s.level + " revert"); }
    }
    console.log("      TOTAL per-stream claimed:", f(totalClaimed), " (raw committed cap was", f(totalCap) + ")");

    // The held over-cap ROI must NOT be claimable: total payout cannot exceed the raw committed cap.
    assert(totalClaimed <= totalCap + E("0.01"),
      `per-stream claims (${f(totalClaimed)}) must not exceed raw committed cap (${f(totalCap)}) — held leaked`);

    // After draining, with the cap fully consumed, another round must pay ~0.
    await increaseTime(60);
    await freshTwap(liq, hordexAddr);
    const [, , totalCap2] = await liq.getUserCommissionStats(u1.address);
    let round2 = 0n;
    for (const s of streams) {
      try {
        const b = await hordex.balanceOf(u1.address);
        await (await liq.connect(u1).claimROIFromStream(s.investor, s.lockIndex, s.level)).wait();
        round2 += (await hordex.balanceOf(u1.address)) - b;
      } catch (_) {}
    }
    console.log("      round 2 (cap now", f(totalCap2) + "):", f(round2));
    assert(round2 <= totalCap2 + E("0.01"),
      `round-2 per-stream claims (${f(round2)}) must not exceed remaining cap (${f(totalCap2)}) — held leaked`);
  });
});
