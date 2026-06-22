// Characterization for the referral-commission RESERVE (held over-0.5× commission).
//
// Rule (per-event, Option A): when a single downline investment pays an eligible upline more than
// its per-event wallet cap (= HALF the active self-stake), the over-0.5× band (bounded by the 5× cap)
// is HELD in reserve (net of the 5% deployer cut) instead of being paid out now. Anything over 5×
// still goes to the owner. Reserve unlocks at the TRIGGERING downline package's 90-day mark; it is
// then claimable for USDT (claimReserve) and spendable on a package any time (investFromReserve).
//
// Run:  npx hardhat test test/reserve-commission.test.js

const assert = require("assert");
const hre = require("hardhat");
const { ethers, network } = hre;
const { mergedLiquidityAbi } = require("../scripts/amoytestnet/_viewfacet");

const E = (n) => ethers.parseEther(String(n));
const HORDEX_SUPPLY = 10_000_000;
const SEED = E(5000);
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

async function fund(ctx, who, amt = 9000) {
  await (await ctx.usdt.connect(who).deposit({ value: E(amt) })).wait();
  await (await ctx.usdt.connect(who).approve(ctx.coreAddr, ethers.MaxUint256)).wait();
}
async function reg(ctx, who, referrer) {
  await (await ctx.liq.connect(who).register(referrer.address)).wait();
}
async function inv(ctx, who, amt) {
  await (await ctx.liq.connect(who).invest(ctx.hordexAddr, E(amt))).wait();
}

describe("Referral-commission reserve (held over-0.5×)", function () {
  this.timeout(300000);

  // ── Worked example: $25 upline, one $2,500 downline → $11.875 wallet, $106.875 reserve, $125 owner ──
  it("single big downline: over-0.5× band is held in reserve, not paid now", async () => {
    const ctx = await deploy();
    const { owner, signers } = ctx;
    const U = signers[2], K = signers[3];

    await fund(ctx, U); await fund(ctx, K);
    await reg(ctx, U, owner); await inv(ctx, U, 25);   // U: $25 package (0.5× = $12.50, 5× = $125)
    await reg(ctx, K, U);     await inv(ctx, K, 2500);  // K under U → level-1 commission to U

    // Level-1 gross = 20% × 2500 × 50% = $250. Within 5× cap = $125. Wallet 0.5× = $12.50 → net $11.875.
    // Reserve band = $112.50 → net $106.875. Over-5× = $125 → owner.
    const earned = await ctx.liq.getUserCommissionStats(U.address);
    assert.strictEqual(f(earned.earned), 11.875, "wallet (earned) should be 0.5× minus 5% cut");

    const rs = await ctx.liq.getReserveStats(U.address);
    assert.strictEqual(f(rs.total), 106.875, "reserve total = over-0.5× band ($112.50) minus 5% cut");
    assert.strictEqual(f(rs.claimable), 0, "reserve is locked until the downline package matures");

    const tranches = await ctx.liq.getReserveTranches(U.address);
    assert.strictEqual(tranches.length, 1, "exactly one reserve tranche");
    assert.strictEqual(f(tranches[0].amount), 106.875, "tranche amount net of cut");
  });

  // ── Per-event: five $250 downlines each above 0.5× → half wallet, half reserve, every event ─────
  it("fragmented downlines each above 0.5× split half to wallet, half to reserve", async () => {
    const ctx = await deploy();
    const { owner, signers } = ctx;
    const U = signers[2];
    const Ds = [signers[3], signers[4], signers[5], signers[6], signers[7]];

    await fund(ctx, U);
    await reg(ctx, U, owner); await inv(ctx, U, 25);   // 0.5× = $12.50, 5× cap = $125
    for (const D of Ds) {
      await fund(ctx, D);
      await reg(ctx, D, U);
      await inv(ctx, D, 250);  // each level-1 gross = 20%×250×50% = $25 > 0.5× → $12.50 wallet / $12.50 reserve
    }

    // Each event: $12.50 wallet (net $11.875) + $12.50 reserve (net $11.875). 5 events fill the 5× cap.
    const earned = await ctx.liq.getUserCommissionStats(U.address);
    assert.strictEqual(f(earned.earned), 59.375, "5 × half-stake to wallet, net of cut");
    const rs = await ctx.liq.getReserveStats(U.address);
    assert.strictEqual(f(rs.total), 59.375, "5 × over-0.5× band to reserve, net of cut");
    assert.strictEqual((await ctx.liq.getReserveTranches(U.address)).length, 5, "one tranche per event");
  });

  // ── Claim after maturity ─────────────────────────────────────────────────────────────────────
  it("reserve becomes claimable for USDT after the downline package matures", async () => {
    const ctx = await deploy();
    const { owner, signers, usdt } = ctx;
    const U = signers[2], K = signers[3];

    await fund(ctx, U); await fund(ctx, K);
    await reg(ctx, U, owner); await inv(ctx, U, 25);
    await reg(ctx, K, U);     await inv(ctx, K, 2500);

    // Before maturity: claim reverts (nothing matured).
    await assert.rejects(ctx.liq.connect(U).claimReserve(), /NothingToClaim/);

    // Advance past the 90-day window (90 × SECONDS_PER_DAY = 540s in test scale) + margin.
    await increaseTime(600);

    const rs = await ctx.liq.getReserveStats(U.address);
    assert.strictEqual(f(rs.claimable), 106.875, "fully matured");

    const balBefore = await usdt.balanceOf(U.address);
    await (await ctx.liq.connect(U).claimReserve()).wait();
    const balAfter = await usdt.balanceOf(U.address);
    assert.strictEqual(f(balAfter - balBefore), 106.875, "claim transfers 106.875 USDT");

    const rsAfter = await ctx.liq.getReserveStats(U.address);
    assert.strictEqual(f(rsAfter.total), 0, "reserve emptied after claim");
  });

  // ── Spend reserve on a package while still locked ──────────────────────────────────────────────
  it("reserve can buy a package before maturity (investFromReserve), drawing it down", async () => {
    const ctx = await deploy();
    const { owner, signers } = ctx;
    const U = signers[2], K = signers[3];

    await fund(ctx, U); await fund(ctx, K);
    await reg(ctx, U, owner); await inv(ctx, U, 25);
    await reg(ctx, K, U);     await inv(ctx, K, 2500);   // U holds $106.875 reserve, locked

    const locksBefore = (await ctx.liq.getUserLPLocks(U.address)).length;

    // Spend $50 of the $106.875 reserve on a package — allowed even though it's still locked.
    await (await ctx.liq.connect(U).investFromReserve(ctx.hordexAddr, E(50))).wait();

    const rs = await ctx.liq.getReserveStats(U.address);
    assert.strictEqual(f(rs.total), 56.875, "reserve drawn down by the $50 spent");

    const locksAfter = (await ctx.liq.getUserLPLocks(U.address)).length;
    assert.strictEqual(locksAfter, locksBefore + 1, "a new package lock was created from reserve");

    // Overspending reserve reverts ($100 > $56.875 remaining).
    await assert.rejects(ctx.liq.connect(U).investFromReserve(ctx.hordexAddr, E(100)), /InsufficientReserve/);
  });

  // ── Mixed funding: reserve first, wallet for the shortfall ─────────────────────────────────────
  it("investUseReserve covers a package from reserve first, then the wallet for the shortfall", async () => {
    const ctx = await deploy();
    const { owner, signers, usdt } = ctx;
    const U = signers[2], K = signers[3];

    await fund(ctx, U); await fund(ctx, K);
    await reg(ctx, U, owner); await inv(ctx, U, 25);
    await reg(ctx, K, U);     await inv(ctx, K, 2500);   // U holds $106.875 reserve

    // Buy a $250 package: $106.875 from reserve + $143.125 from wallet.
    const walletBefore = await usdt.balanceOf(U.address);
    const locksBefore  = (await ctx.liq.getUserLPLocks(U.address)).length;
    await (await ctx.liq.connect(U).investUseReserve(ctx.hordexAddr, E(250))).wait();

    assert.strictEqual(f((await ctx.liq.getReserveStats(U.address)).total), 0, "all reserve consumed");
    assert.strictEqual(f(walletBefore - (await usdt.balanceOf(U.address))), 143.125, "only the shortfall came from the wallet");
    assert.strictEqual((await ctx.liq.getUserLPLocks(U.address)).length, locksBefore + 1, "package lock created");
  });

  it("investUseReserve funds the whole package from reserve when it is enough (no wallet spend)", async () => {
    const ctx = await deploy();
    const { owner, signers, usdt } = ctx;
    const U = signers[2], K = signers[3];

    await fund(ctx, U); await fund(ctx, K);
    await reg(ctx, U, owner); await inv(ctx, U, 25);
    await reg(ctx, K, U);     await inv(ctx, K, 2500);   // U holds $106.875 reserve

    // Buy a $50 package fully from reserve — wallet untouched, $56.875 reserve remains.
    const walletBefore = await usdt.balanceOf(U.address);
    await (await ctx.liq.connect(U).investUseReserve(ctx.hordexAddr, E(50))).wait();

    assert.strictEqual(f((await ctx.liq.getReserveStats(U.address)).total), 56.875, "reserve drawn down by exactly $50");
    assert.strictEqual(f(walletBefore - (await usdt.balanceOf(U.address))), 0, "wallet untouched when reserve covers it");
  });
});
