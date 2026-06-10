const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const UNI_ROUTER     = "0x85eaBB2740eD2f9e3b53c51D8e1E7BdA53672825";
const UNI_FACTORY    = "0xa5d020Eb5a4D537f56F7314d2359f7770DE01a48";
const DEPLOYED_USDT  = "0x5b0Eaea74F03ED873B03d6C6ce54f6d5eDE75F9c";
const USDT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];

const TOTAL_WALLETS  = 7;
const SEED_USDT      = hre.ethers.parseEther("1");   // 1 USDT + 1 token → 1 HORDEX = 1 USDT = $1
const SEED_TOKENS    = hre.ethers.parseEther("1");
const PACKAGE_USDT   = hre.ethers.parseEther("100");    // 100 USDT = $100
const FUND_AMOUNT    = hre.ethers.parseEther("0.05");   // POL for gas
const FUND_THRESHOLD = hre.ethers.parseEther("0.04");
const FUND_USDT      = hre.ethers.parseEther("110");    // USDT per sub-wallet (100 + 10 buffer)
const USDT_THRESH    = hre.ethers.parseEther("90");     // skip USDT top-up if already has this
const TWAP_WAIT_SECS = 31;                              // 31 s testnet; use 31*60 for mainnet

const DEPLOY_OVERRIDES = {
  maxFeePerGas:         hre.ethers.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: hre.ethers.parseUnits("30", "gwei"),
  gasLimit: 15_000_000,
};
const TX_OVERRIDES = {
  maxFeePerGas:         hre.ethers.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: hre.ethers.parseUnits("30", "gwei"),
  gasLimit: 5_000_000,
};

// Referral tree: { referrer → children }
const groups = [
  { referrer: 0, children: [1]       },
  { referrer: 1, children: [2, 3, 4] },
  { referrer: 2, children: [5, 6]    },
];
// BFS invest order
const INVEST_ORDER = [0, 1, 2, 3, 4, 5, 6];

// ROI commission rates — % of investor's staking reward flowing to each level recipient
const LEVEL_RATES = [50, 10, 5, 2, 0.6, 0.5, 0.45, 0.4, 0.4, 0.35];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sep(c = "─", n = 64) { return c.repeat(n); }
function toUSD(wei) {
  return "$" + parseFloat(hre.ethers.formatEther(wei)).toFixed(2);
}

function deriveWallets(rawKey, provider) {
  const pk = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
  const wallets = [new hre.ethers.Wallet(pk, provider)];
  for (let i = 1; i < TOTAL_WALLETS; i++) {
    wallets.push(new hre.ethers.Wallet(
      hre.ethers.keccak256(hre.ethers.solidityPacked(["bytes32", "uint256"], [pk, i])),
      provider
    ));
  }
  return wallets;
}

function isTransient(e) {
  return ["ECONNRESET","ETIMEDOUT","UND_ERR_SOCKET"].includes(e.code) ||
    ["ECONNRESET","ETIMEDOUT","timeout","network"].some(k => e.message?.includes(k));
}

async function mine(txFn, maxRetries = 6) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let tx;
    try { tx = await txFn(); }
    catch (e) {
      if (isTransient(e) && attempt < maxRetries - 1) {
        await sleep(4000 * (attempt + 1)); continue;
      }
      throw e;
    }
    while (true) {
      try { const r = await tx.wait(); await sleep(500); return r; }
      catch (e) {
        if (isTransient(e)) { await sleep(3000); continue; }
        throw e;
      }
    }
  }
  throw new Error("mine(): exceeded retries");
}

const MAX_ATTEMPTS   = 3;
const RETRY_DELAY_MS = 30_000;

async function mineOrSkip(txFn, label) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await mine(txFn);
    } catch (e) {
      const reason = e.reason || e?.error?.message || e.message || String(e);
      if (attempt < MAX_ATTEMPTS) {
        console.log(`\n  ⚠  ${label} — attempt ${attempt}/${MAX_ATTEMPTS} failed: ${reason}`);
        console.log(`     Waiting 30s before retry…`);
        await sleep(RETRY_DELAY_MS);
      } else {
        console.log(`\n  ✗  ${label} — failed after ${MAX_ATTEMPTS} attempts, skipping.`);
        console.log(`     Last error: ${reason}`);
      }
    }
  }
  return null;
}

async function waitForTwap(provider, firstTimestamp) {
  const target = firstTimestamp + TWAP_WAIT_SECS;
  while (true) {
    try {
      const block = await provider.getBlock("latest");
      if (block.timestamp >= target) break;
      const rem = target - block.timestamp;
      process.stdout.write(`\r  TWAP warm-up: ${String(Math.floor(rem/60)).padStart(2,"0")}:${String(rem%60).padStart(2,"0")} remaining…`);
    } catch (_) {}
    await sleep(2000);
  }
  process.stdout.write("\r  TWAP warm-up: complete!                             \n");
}

// ── Print ROI stream table ────────────────────────────────────────────────────
async function printROITable(liquidity, signers) {
  console.log("\n" + sep());
  console.log("  ROI STREAM TABLE  (first lock for each investor, all 10 levels)");
  console.log(sep());
  console.log(
    "  " +
    "INVESTOR".padEnd(16) +
    "LEVEL".padEnd(8) +
    "RATE%".padEnd(8) +
    "RECIPIENT"
  );
  console.log("  " + sep("·", 58));

  for (const idx of INVEST_ORDER) {
    const addr  = signers[idx].address;
    const locks = await liquidity.getUserLPLocks(addr);
    if (locks.length === 0) { continue; }

    let firstRow = true;
    for (let level = 0; level < 10; level++) {
      const info = await liquidity.getROIStreamInfo(addr, 0, level);
      const recvIdx = signers.findIndex(
        s => s.address.toLowerCase() === info.recipient.toLowerCase()
      );
      const recvLabel =
        info.recipient === hre.ethers.ZeroAddress ? "nobody"
        : recvIdx >= 0                            ? `acc[${recvIdx}]`
        :                                            "acc[0] (Owner)";

      console.log(
        "  " +
        (firstRow ? `acc[${idx}] lock#0`.padEnd(16) : "".padEnd(16)) +
        `L${level + 1}`.padEnd(8) +
        `${LEVEL_RATES[level]}%`.padEnd(8) +
        recvLabel
      );
      firstRow = false;
    }
    console.log("  " + sep("·", 58));
  }
}

// ── Print pending ROI for each account ───────────────────────────────────────
async function printROIPending(liquidity, signers) {
  console.log("\n" + sep());
  console.log("  ROI PENDING  (settled + currently accruing; claimable now)");
  console.log(sep());
  for (let idx = 0; idx < signers.length; idx++) {
    const pending = await liquidity.getROIPending(signers[idx].address);
    if (pending === 0n) continue;
    const usdt = parseFloat(hre.ethers.formatEther(pending)).toFixed(6);
    console.log(`  acc[${idx}]  ${usdt} USDT`);
  }
}

// ── Print unified cap stats per account ──────────────────────────────────────
async function printCapStats(liquidity, signers) {
  console.log("\n" + sep());
  console.log("  UNIFIED CAP STATS  (cap = 5× invested; consumed by referral + ROI)");
  console.log(sep());
  console.log(
    "  " + "ACCOUNT".padEnd(16) + "TOTAL CAP".padEnd(14) +
    "REMAINING".padEnd(14) + "STATUS"
  );
  console.log("  " + sep("·", 58));
  for (let idx = 0; idx < signers.length; idx++) {
    const addr  = signers[idx].address;
    const locks = await liquidity.getUserLPLocks(addr);
    if (locks.length === 0) continue;
    const [, , totalCapWei, remainingWei] = await liquidity.getUserCommissionStats(addr);
    const capPausedAt = await liquidity.getCapPausedAt(addr);
    const totalCap  = parseFloat(hre.ethers.formatEther(totalCapWei)).toFixed(2);
    const remaining = parseFloat(hre.ethers.formatEther(remainingWei)).toFixed(2);
    const status    = Number(capPausedAt) > 0 ? "⏸  CAP PAUSED" : "▶  active";
    console.log(
      "  " +
      `acc[${idx}]`.padEnd(16) +
      `$${totalCap}`.padEnd(14) +
      `$${remaining}`.padEnd(14) +
      status
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x","").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env"); process.exit(1);
  }

  const provider = hre.ethers.provider;
  const signers  = deriveWallets(rawKey, provider);
  const deployer = signers[0];
  const network  = hre.network.name;

  console.log(sep("═"));
  console.log("  JUSTDEPLOY — Deploy · Seed Pool · TWAP Warm-up (Phases 0–4)");
  console.log(sep("═"));
  console.log(`  Network  : ${network}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Accounts : ${TOTAL_WALLETS}  (0–6)\n`);

  const bal0 = await provider.getBalance(deployer.address);
  console.log(`  Balance  : ${hre.ethers.formatEther(bal0)} POL\n`);
  if (bal0 < hre.ethers.parseEther("3")) {
    console.error("❌  account[0] needs ≥ 3 POL for gas"); process.exit(1);
  }

  // ── PHASE 0: Fund sub-wallets ──────────────────────────────────────────────
  console.log(sep()); console.log("  PHASE 0 — FUND SUB-WALLETS [1..6]"); console.log(sep());
  const usdtCt = new hre.ethers.Contract(DEPLOYED_USDT, USDT_ABI, deployer);
  for (let i = 1; i < TOTAL_WALLETS; i++) {
    const [maticBal, usdtBal] = await Promise.all([
      provider.getBalance(signers[i].address),
      usdtCt.balanceOf(signers[i].address),
    ]);
    if (maticBal < FUND_THRESHOLD) {
      await mine(() => deployer.sendTransaction({
        to: signers[i].address, value: FUND_AMOUNT,
        maxFeePerGas: TX_OVERRIDES.maxFeePerGas,
        maxPriorityFeePerGas: TX_OVERRIDES.maxPriorityFeePerGas,
      }));
      console.log(`  [${i}] funded ${hre.ethers.formatEther(FUND_AMOUNT)} POL ✓`);
    } else {
      console.log(`  [${i}] ${hre.ethers.formatEther(maticBal).padStart(8)} POL — skip`);
    }
    if (usdtBal < USDT_THRESH) {
      await mine(() => usdtCt.transfer(signers[i].address, FUND_USDT, TX_OVERRIDES));
      console.log(`  [${i}] funded 110 USDT ✓`);
    } else {
      console.log(`  [${i}] ${hre.ethers.formatEther(usdtBal)} USDT — skip`);
    }
  }

  // ── PHASE 1: Platform token ────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 1 — PLATFORM TOKEN"); console.log(sep());
  const HordexToken = await hre.ethers.getContractFactory("HordexToken", deployer);
  const token = await HordexToken.deploy("Hordex", "HDX", 10_000_000, DEPLOY_OVERRIDES);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`  HORDEX  : ${tokenAddress}`);

  // ── PHASE 2: Contracts ─────────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 2 — CONTRACTS"); console.log(sep());

  const LiquidityMath = await hre.ethers.getContractFactory("LiquidityMath", deployer);
  const liquidityMath = await LiquidityMath.deploy(DEPLOY_OVERRIDES);
  await liquidityMath.waitForDeployment();
  const libAddress = await liquidityMath.getAddress();
  console.log(`  LiquidityMath    : ${libAddress}`);

  const LiquidityViewLib = await hre.ethers.getContractFactory("LiquidityViewLib", {
    signer: deployer, libraries: { LiquidityMath: libAddress },
  });
  const liquidityViewLib = await LiquidityViewLib.deploy(DEPLOY_OVERRIDES);
  await liquidityViewLib.waitForDeployment();
  const libViewAddress = await liquidityViewLib.getAddress();
  console.log(`  LiquidityViewLib : ${libViewAddress}`);

  const LiquidityFacet = await hre.ethers.getContractFactory("LiquidityFacet", {
    signer: deployer, libraries: { LiquidityMath: libAddress },
  });
  const liquidityFacet = await LiquidityFacet.deploy(
    UNI_ROUTER, UNI_FACTORY, DEPLOYED_USDT, tokenAddress, DEPLOY_OVERRIDES
  );
  await liquidityFacet.waitForDeployment();
  const facetAddress = await liquidityFacet.getAddress();
  console.log(`  LiquidityFacet   : ${facetAddress}`);

  const LiquidityROIFacet = await hre.ethers.getContractFactory("LiquidityROIFacet", deployer);
  const liquidityROIFacet = await LiquidityROIFacet.deploy(DEPLOY_OVERRIDES);
  await liquidityROIFacet.waitForDeployment();
  const roiFacetAddress = await liquidityROIFacet.getAddress();
  console.log(`  LiquidityROIFacet: ${roiFacetAddress}`);

  const Liquidity = await hre.ethers.getContractFactory("Liquidity", {
    signer: deployer,
    libraries: { LiquidityMath: libAddress, LiquidityViewLib: libViewAddress },
  });
  const liquidity = await Liquidity.deploy(
    UNI_ROUTER, UNI_FACTORY, DEPLOYED_USDT, tokenAddress,
    facetAddress, roiFacetAddress, DEPLOY_OVERRIDES
  );
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  const deployReceipt = await liquidity.deploymentTransaction().wait();
  const deployBlock   = deployReceipt.blockNumber;
  console.log(`  Liquidity        : ${liquidityAddress}  (block ${deployBlock})`);

  const artifact = hre.artifacts.readArtifactSync("Liquidity");
  const liq      = new hre.ethers.Contract(liquidityAddress, artifact.abi, deployer);

  // ── Write contract-config.js ──────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  WRITE CONFIG"); console.log(sep());
  const configContent =
`// AUTO-GENERATED by scripts/amoytestnet/roitest.js
// Network: ${network} | Deployed: ${new Date().toLocaleString()}

const CONTRACT_ADDRESS        = "${liquidityAddress}";
const TOKEN_ADDRESS           = "${tokenAddress}";
const TOKEN_ADDRESS_JIGGY     = "";
const TOKEN_ADDRESS_PANWORLD  = "";
const ROUTER_ADDRESS          = "${UNI_ROUTER}";
const FACTORY_ADDRESS         = "${UNI_FACTORY}";
const WETH_ADDRESS            = "${DEPLOYED_USDT}";
const USDT_ADDRESS            = "${DEPLOYED_USDT}";
const DEPLOY_BLOCK            = ${deployBlock};
const FACET_ADDRESS           = "${facetAddress}";
const ROI_FACET_ADDRESS       = "${roiFacetAddress}";

const CONTRACT_ABI = ${JSON.stringify(artifact.abi, null, 2)};
`;
  fs.writeFileSync(path.join(__dirname, "..", "..", "contract-config.js"), configContent);
  fs.writeFileSync(path.join(__dirname, "..", "..", "frontend", "contract-config.js"), configContent);
  const htmlPath = path.join(__dirname, "..", "..", "frontend", "index.html");
  if (fs.existsSync(htmlPath)) {
    fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, "utf8")
      .replace(/contract-config\.js\?v=\d+/g, `contract-config.js?v=${Date.now()}`));
  }
  console.log("  contract-config.js written ✓");

  // ── PHASE 3: Token setup ───────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 3 — TOKEN SETUP"); console.log(sep());
  const supply = await token.totalSupply();
  await mine(() => token.transfer(liquidityAddress, supply, TX_OVERRIDES));
  console.log(`  ${hre.ethers.formatEther(supply)} HORDEX → Liquidity ✓`);
  await mine(() => liq.addToken(tokenAddress, "Hordex", "HDX", TX_OVERRIDES));
  console.log(`  Token registered ✓`);
  await mine(() => usdtCt.transfer(liquidityAddress, SEED_USDT, TX_OVERRIDES));
  console.log(`  Transferred ${hre.ethers.formatEther(SEED_USDT)} USDT → Liquidity ✓`);
  await mine(() => liq.seedPool(tokenAddress, SEED_TOKENS, SEED_USDT, TX_OVERRIDES));
  console.log(`  Pool seeded: ${hre.ethers.formatEther(SEED_USDT)} USDT + ${hre.ethers.formatEther(SEED_TOKENS)} HORDEX`);
  console.log(`  Price: 1 HORDEX = 1 USDT = $1.00 ✓`);

  // ── PHASE 4: TWAP warm-up ─────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 4 — TWAP WARM-UP"); console.log(sep());
  const obs0Receipt = await mine(() => liq.updateTWAP(TX_OVERRIDES));
  const obs0Block   = await provider.getBlock(obs0Receipt.blockNumber);
  console.log(`  Observation 0  (block ${obs0Receipt.blockNumber}) ✓`);
  console.log(`  Waiting ${TWAP_WAIT_SECS}s for second observation…`);
  await waitForTwap(provider, obs0Block.timestamp);
  await mine(() => liq.updateTWAP(TX_OVERRIDES));
  console.log("  Observation 1 ✓  —  TWAP ready, staking + ROI claims enabled");
}

main().catch(err => { console.error(err); process.exit(1); });