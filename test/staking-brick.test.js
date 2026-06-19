// Pin the gas growth of claimStakingReward() (claim-ALL-locks, one tx, no chunking in the
// frontend) to find the lock count at which it exceeds the Polygon block gas limit (~30M).
//
// Run:  npx hardhat test test/staking-brick.test.js

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
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
  await (await liq.updateTWAP()).wait();
  await increaseTime(31);
  await (await liq.updateTokenTWAP(hordexAddr)).wait();
  await (await liq.updateTWAP()).wait();

  await (await usdt.connect(u1).deposit({ value: E(200000) })).wait();
  await (await usdt.connect(u1).approve(coreAddr, ethers.MaxUint256)).wait();
  await (await liq.connect(u1).register(owner.address)).wait();
  return { owner, u1, liq, hordex, usdt, hordexAddr, coreAddr };
}

describe("claimStakingReward (all locks) gas growth", function () {
  this.timeout(600000);

  it("measures gas at increasing lock counts and extrapolates the block-limit brick point", async () => {
    const { u1, liq, hordexAddr } = await deployBase();
    const samples = [];
    const targets = [50, 150, 300];
    let made = 0;
    for (const target of targets) {
      while (made < target) {
        await (await liq.connect(u1).invest(hordexAddr, PKG)).wait();
        made++;
        if (made % 40 === 0) { await (await liq.updateTWAP()).wait(); await (await liq.updateTokenTWAP(hordexAddr)).wait(); }
      }
      await increaseTime(20);
      await (await liq.updateTWAP()).wait();
      await (await liq.updateTokenTWAP(hordexAddr)).wait();
      const r = await (await liq.connect(u1).claimStakingReward()).wait();
      samples.push({ locks: made, gas: r.gasUsed });
      console.log(`      locks=${made}  claimStakingReward gas=${r.gasUsed}`);
    }
    // Linear fit between first and last sample → per-lock cost and brick point.
    const a = samples[0], b = samples[samples.length - 1];
    const perLock = (b.gas - a.gas) / BigInt(b.locks - a.locks);
    const fixed = a.gas - perLock * BigInt(a.locks);
    const brick = (30_000_000n - fixed) / perLock;
    console.log(`      ~per-lock gas≈${perLock}  fixed≈${fixed}  →  claimStakingReward exceeds 30M block limit at ≈${brick} locks`);
    assert(samples.every(s => s.gas > 0n));
  });
});
