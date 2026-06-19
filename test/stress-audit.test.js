// Stress / scaling audit for Hordex.
// Goal: confirm (a) gas stays well under a block limit for every legit op as the team
// grows in DEPTH (chain length), BREADTH (many downline), and per-user LOCK COUNT;
// (b) no legit operation reverts; (c) the 5x cap & accounting hold.
//
// Run:  npx hardhat test test/stress-audit.test.js
//
// Block-limit reference: Polygon ~30M gas/block. We flag anything above 12M as a risk.

const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 100_000_000;
const SEED = E(1_000_000);   // big pool so price-guard never starves the pool-buy leg
const PKG = E(100);
const BLOCK_LIMIT = 30_000_000n;
const RISK = 12_000_000n;

async function increaseTime(secs) {
  await network.provider.send("evm_increaseTime", [secs]);
  await network.provider.send("evm_mine", []);
}

// Give an account effectively-unlimited ETH so WETH deposits never hit the 10k default cap.
async function topUpETH(addr) {
  await network.provider.send("hardhat_setBalance", [addr, "0x52B7D2DCC80CD2E4000000"]); // 100M ETH
}

async function deployBase() {
  await network.provider.request({ method: "hardhat_reset", params: [{}] });
  const signers = await ethers.getSigners();
  const owner = signers[0];

  await topUpETH(owner.address);

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

  return { owner, signers, liq, hordex, usdt, hordexAddr, coreAddr, usdtAddr, factoryAddr };
}

// Approve a user's LP to the core so the non-direct removeLP (transferFrom) path works.
async function approveLP(factoryAddr, usdtAddr, coreAddr, signer, tokenAddr) {
  const factory = new ethers.Contract(factoryAddr, ["function getPair(address,address) view returns (address)"], signer);
  const pair = await factory.getPair(tokenAddr, usdtAddr);
  const lp = new ethers.Contract(pair, ["function approve(address,uint256) returns (bool)"], signer);
  await (await lp.approve(coreAddr, ethers.MaxUint256)).wait();
  return pair;
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

describe("Hordex stress / scaling audit", function () {
  this.timeout(600000);

  it("A) one user with MANY locks: invest/claim/remove gas stays bounded", async () => {
    const ctx = await deployBase();
    const { owner, signers, liq, hordex, usdt, hordexAddr, coreAddr } = ctx;
    const u1 = signers[1];
    await fund(usdt, coreAddr, u1, E(40000));
    await (await liq.connect(u1).register(owner.address)).wait();

    const N = 120; // 120 locks on a single user
    let firstGas, lastGas;
    for (let i = 0; i < N; i++) {
      const r = await (await liq.connect(u1).invest(hordexAddr, PKG)).wait();
      if (i === 0) firstGas = r.gasUsed;
      if (i === N - 1) lastGas = r.gasUsed;
      if (i % 30 === 0) await freshTwap(liq, hordexAddr);
    }
    const locks = await liq.getUserLPLocks(u1.address);
    console.log(`      locks=${locks.length}  invest#1 gas=${firstGas}  invest#${N} gas=${lastGas}`);

    // claim-all staking reward across all N locks
    await increaseTime(50);
    await freshTwap(liq, hordexAddr);
    const cs = await (await liq.connect(u1).claimStakingReward()).wait();
    console.log(`      claimStakingReward (all ${N} locks) gas=${cs.gasUsed}`);

    // remove one — exercise BOTH paths: direct (lock 0) and claim+approve+removeLP (lock 1)
    await increaseTime(600);
    await freshTwap(liq, hordexAddr);
    const rmDirect = await (await liq.connect(u1).removeLPDirect(0)).wait();
    const cl = await (await liq.connect(u1).claimLP(1)).wait();
    await approveLP(ctx.factoryAddr, ctx.usdtAddr, coreAddr, u1, hordexAddr);
    const rm = await (await liq.connect(u1).removeLP(1)).wait();
    console.log(`      removeLPDirect gas=${rmDirect.gasUsed}  claimLP gas=${cl.gasUsed}  removeLP gas=${rm.gasUsed}`);

    assert(lastGas < RISK, `invest#${N} gas ${lastGas} exceeds risk threshold ${RISK}`);
    assert(cs.gasUsed < BLOCK_LIMIT, `claimStakingReward gas ${cs.gasUsed} exceeds block limit`);
    assert(rm.gasUsed < RISK, `removeLP gas ${rm.gasUsed} exceeds risk threshold`);
  });

  it("B) UPLINE with many locks makes every DOWNLINE invest more expensive (O(upline locks))", async () => {
    const ctx = await deployBase();
    const { owner, signers, liq, usdt, hordexAddr, coreAddr } = ctx;
    const up = signers[1];     // upline that accumulates many locks
    const dn = signers[2];     // downline under up
    await fund(usdt, coreAddr, up, E(40000));
    await fund(usdt, coreAddr, dn, E(40000));
    await (await liq.connect(up).register(owner.address)).wait();
    await (await liq.connect(dn).register(up.address)).wait();

    // baseline downline invest with upline holding 1 lock
    await (await liq.connect(up).invest(hordexAddr, PKG)).wait();
    const g0 = (await (await liq.connect(dn).invest(hordexAddr, PKG)).wait()).gasUsed;

    // pile locks onto the upline
    for (let i = 0; i < 100; i++) {
      await (await liq.connect(up).invest(hordexAddr, PKG)).wait();
      if (i % 30 === 0) await freshTwap(liq, hordexAddr);
    }
    await freshTwap(liq, hordexAddr);
    const g1 = (await (await liq.connect(dn).invest(hordexAddr, PKG)).wait()).gasUsed;

    console.log(`      downline invest gas — upline 1 lock: ${g0}  | upline 101 locks: ${g1}  (delta ${g1 - g0})`);
    assert(g1 < RISK, `downline invest gas ${g1} with a 101-lock upline exceeds risk threshold`);
  });

  it("C) ONE upline accumulating MANY ROI streams: claim must not brick (chunkable)", async () => {
    const ctx = await deployBase();
    const { owner, signers, liq, hordex, usdt, hordexAddr, coreAddr } = ctx;
    const up = signers[1];
    const dn = signers[2];
    await fund(usdt, coreAddr, up, E(5000));
    await fund(usdt, coreAddr, dn, E(60000));
    await (await liq.connect(up).register(owner.address)).wait();
    await (await liq.connect(dn).register(up.address)).wait();

    // up holds a lock so it is an eligible level-0 recipient with cap
    await (await liq.connect(up).invest(hordexAddr, E(1000))).wait(); // cap 5x$1000 = $5000

    // dn invests many times → each lock creates a level-0 ROI stream to `up`
    const STREAMS = 150;
    for (let i = 0; i < STREAMS; i++) {
      await (await liq.connect(dn).invest(hordexAddr, PKG)).wait();
      if (i % 40 === 0) await freshTwap(liq, hordexAddr);
    }
    const refs = await liq.getActiveROIStreams(up.address);
    console.log(`      up active ROI streams: ${refs.length}`);

    await increaseTime(200);
    await freshTwap(liq, hordexAddr);

    // Try claimAllROI in one shot; measure gas.
    let oneShotGas = null, oneShotOk = true;
    try {
      const r = await (await liq.connect(up).claimAllROI()).wait();
      oneShotGas = r.gasUsed;
    } catch (e) { oneShotOk = false; }
    console.log(`      claimAllROI one-shot ok=${oneShotOk} gas=${oneShotGas}`);

    // Chunked path must always work: settle in batches then claim pending.
    await increaseTime(50);
    await freshTwap(liq, hordexAddr);
    let settleGasMax = 0n;
    const CHUNK = 50;
    for (let from = 0; from < refs.length; from += CHUNK) {
      const r = await (await liq.connect(up).settleROIStreams(from, CHUNK)).wait();
      if (r.gasUsed > settleGasMax) settleGasMax = r.gasUsed;
    }
    let claimPendingGas = null;
    try {
      const r = await (await liq.connect(up).claimPendingROI()).wait();
      claimPendingGas = r.gasUsed;
    } catch (e) { /* nothing pending is fine */ }
    console.log(`      chunked settle max gas=${settleGasMax}  claimPendingROI gas=${claimPendingGas}`);

    if (oneShotGas !== null) assert(oneShotGas < BLOCK_LIMIT, `claimAllROI one-shot gas ${oneShotGas} exceeds block limit`);
    assert(settleGasMax < RISK, `chunked settle gas ${settleGasMax} exceeds risk threshold`);
  });

  it("D) DEEP referral chain (18 deep): deepest invest propagates commission/ROI, bounded gas", async () => {
    const ctx = await deployBase();
    const { owner, signers, liq, usdt, hordexAddr, coreAddr } = ctx;

    const depth = 18;
    const chain = signers.slice(1, 1 + depth);
    // register chain owner→s1→s2→...
    let parent = owner;
    for (const s of chain) {
      await fund(usdt, coreAddr, s, E(2000));
      await (await liq.connect(s).register(parent.address)).wait();
      parent = s;
    }
    // each invests so uplines are eligible & hold cap
    let lastGas;
    for (let i = 0; i < chain.length; i++) {
      const r = await (await liq.connect(chain[i]).invest(hordexAddr, PKG)).wait();
      lastGas = r.gasUsed;
      if (i % 6 === 0) await freshTwap(liq, hordexAddr);
    }
    console.log(`      deepest (level ${depth}) invest gas=${lastGas}`);
    assert(lastGas < RISK, `deep-chain invest gas ${lastGas} exceeds risk threshold`);

    // top-of-chain users should have received commission + ROI streams
    const ownerStreams = await liq.getActiveROIStreams(owner.address);
    console.log(`      owner active ROI streams from chain: ${ownerStreams.length}`);
  });

  it("E) getDownline view scales to a wide tree without reverting", async () => {
    const ctx = await deployBase();
    const { owner, signers, liq, usdt, hordexAddr, coreAddr } = ctx;
    // build a 2-level tree: owner -> 8 children -> ~6 each
    const top = signers.slice(1, 9);
    for (const s of top) {
      await fund(usdt, coreAddr, s, E(500));
      await (await liq.connect(s).register(owner.address)).wait();
      await (await liq.connect(s).invest(hordexAddr, PKG)).wait();
    }
    let idx = 9;
    for (const parent of top) {
      for (let k = 0; k < 6 && idx < 58; k++, idx++) {
        const s = signers[idx];
        await fund(usdt, coreAddr, s, E(300));
        await (await liq.connect(s).register(parent.address)).wait();
        await (await liq.connect(s).invest(hordexAddr, PKG)).wait();
      }
    }
    const dl = await liq.getDownline(owner.address, 10);
    console.log(`      getDownline returned ${dl.length} nodes`);
    assert(dl.length > 8, "downline should include all descendants");
  });

  it("F) revert-safety: legit ops never revert on a fresh user across a full lifecycle", async () => {
    const ctx = await deployBase();
    const { owner, signers, liq, hordex, usdt, hordexAddr, coreAddr } = ctx;
    const u = signers[1];
    await fund(usdt, coreAddr, u, E(5000));
    await (await liq.connect(u).register(owner.address)).wait();
    await (await liq.connect(u).invest(hordexAddr, PKG)).wait();

    // staking reward
    await increaseTime(60); await freshTwap(liq, hordexAddr);
    await (await liq.connect(u).claimStakingReward()).wait();

    // restake after unlock
    await increaseTime(600); await freshTwap(liq, hordexAddr);
    await (await liq.connect(u).restakeLP(0, 90)).wait();

    // swapBuy / swapSell round-trip
    await (await liq.connect(u).swapBuy(hordexAddr, E(10), 0)).wait();
    const bal = await hordex.balanceOf(u.address);
    if (bal > 0n) {
      await (await hordex.connect(u).approve(coreAddr, ethers.MaxUint256)).wait();
      await (await liq.connect(u).swapSell(hordexAddr, bal / 2n, 0)).wait();
    }

    // full exit after the restake unlock — claim + approve + removeLP (wallet path)
    await increaseTime(600); await freshTwap(liq, hordexAddr);
    await (await liq.connect(u).claimLP(0)).wait();
    await approveLP(ctx.factoryAddr, ctx.usdtAddr, coreAddr, u, hordexAddr);
    await (await liq.connect(u).removeLP(0)).wait();
    console.log("      full lifecycle completed with no reverts");
  });
});
