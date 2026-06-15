// Deploys contracts, then registers + funds + invests all 20,000 accounts.
//
// Tree branching per depth:
//   depth 0 (acc[0])  → 10 children
//   depth 1–4         →  3 children each
//   depth 5–7         →  2 children each
//   depth 8+          →  1 child  each
//
// Level 1 (acc[1..10])  — sequential: register → fund → approve → invest
// Level 2+              — parallel in batches of CONCURRENCY:
//                           Phase A: all register in parallel
//                           Phase B: all fund from acc[0] in parallel (nonce managed)
//                           Phase C: all approve in parallel
//                           Phase D: all invest in parallel
//
// Run fullnodeamoy.js first so sub-wallets have POL for gas.
//
// USAGE:
//   npx hardhat run scripts/amoytestnet/fullsimulateamoy.js --network polygonAmoy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { deployAndWireViewFacet, mergedLiquidityAbi } = require("./_viewfacet");

const UNI_ROUTER     = "0x85eaBB2740eD2f9e3b53c51D8e1E7BdA53672825";
const UNI_FACTORY    = "0xa5d020Eb5a4D537f56F7314d2359f7770DE01a48";
const DEPLOYED_USDT  = "0xcDC1119387AE7cE0cDb2A84CB8be2D6C8F0F5CB9";
const USDT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];

const TOTAL          = 20_000;
const SEED_USDT      = hre.ethers.parseEther("100");
const SEED_TOKENS    = hre.ethers.parseEther("100");
const FUND_USDT      = hre.ethers.parseEther("100");
const TWAP_WAIT_SECS = 31;
const CONCURRENCY    = 50;   // accounts processed in parallel per batch
const MAX_RETRIES    = 5;
const RETRY_DELAY    = 5_000;

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

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sep(c = "─", n = 72) { return c.repeat(n); }
function pad(n, w = 5) { return String(n).padStart(w); }

// ── Wallet derivation ──────────────────────────────────────────────────────────
function deriveWallets(rawKey, provider) {
  const pk = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
  const wallets = [new hre.ethers.Wallet(pk, provider)];
  for (let i = 1; i < TOTAL; i++) {
    wallets.push(new hre.ethers.Wallet(
      hre.ethers.keccak256(hre.ethers.solidityPacked(["bytes32", "uint256"], [pk, i])),
      provider
    ));
  }
  return wallets;
}

// ── Build BFS levels: levels[i] = [{childIdx, parentIdx}] at depth i+1 ────────
function buildLevels() {
  const byDepth = {};
  const bfsQueue = [{ idx: 0, depth: 0 }];
  let next = 1;

  while (bfsQueue.length > 0 && next < TOTAL) {
    const { idx, depth } = bfsQueue.shift();
    const maxBranch =
      depth === 0 ? 10 :
      depth <= 4  ?  3 :
      depth <= 7  ?  2 : 1;
    const childDepth = depth + 1;
    if (!byDepth[childDepth]) byDepth[childDepth] = [];
    for (let c = 0; c < maxBranch && next < TOTAL; c++) {
      const childIdx = next++;
      byDepth[childDepth].push({ childIdx, parentIdx: idx });
      bfsQueue.push({ idx: childIdx, depth: childDepth });
    }
  }
  return Object.keys(byDepth)
    .map(Number).sort((a, b) => a - b)
    .map(d => byDepth[d]);
}

// ── Retry a single tx up to MAX_RETRIES times ─────────────────────────────────
async function retryTx(fn, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const tx = await fn();
      return await tx.wait();
    } catch (e) {
      const reason = (e.reason || e?.error?.message || e.message || String(e)).slice(0, 80);
      if (attempt < MAX_RETRIES) {
        console.log(`  ⚠  [${attempt}/${MAX_RETRIES}] ${label}: ${reason}`);
        await sleep(RETRY_DELAY);
      } else {
        console.log(`  ✗  [${attempt}/${MAX_RETRIES}] ${label}: ${reason}`);
        return null;
      }
    }
  }
}

// ── TWAP wait ──────────────────────────────────────────────────────────────────
async function waitForTwap(provider, firstTimestamp) {
  const target = firstTimestamp + TWAP_WAIT_SECS;
  while (true) {
    try {
      const block = await provider.getBlock("latest");
      if (block.timestamp >= target) break;
      const rem = target - block.timestamp;
      process.stdout.write(
        `\r  TWAP warm-up: ${String(Math.floor(rem / 60)).padStart(2, "0")}:${String(rem % 60).padStart(2, "0")} remaining…`
      );
    } catch (_) {}
    await sleep(2000);
  }
  process.stdout.write("\r  TWAP warm-up: complete!                              \n");
}

// ── Process one account sequentially (register → fund → approve → invest) ─────
async function processOne(childIdx, parentIdx, wallets, deployer, usdtCt, liquidityAddress, tokenAddress, artifact) {
  const childWallet = wallets[childIdx];
  const parentAddr  = wallets[parentIdx].address;
  const childLiq    = new hre.ethers.Contract(liquidityAddress, artifact.abi, childWallet);
  const childUsdt   = new hre.ethers.Contract(DEPLOYED_USDT, USDT_ABI, childWallet);

  const regR = await retryTx(
    () => childLiq.register(parentAddr, TX_OVERRIDES),
    `register acc[${childIdx}] under acc[${parentIdx}]`
  );
  if (!regR) return false;

  const fundR = await retryTx(
    () => usdtCt.transfer(childWallet.address, FUND_USDT, TX_OVERRIDES),
    `fund acc[${childIdx}]`
  );
  if (!fundR) return false;

  const approveR = await retryTx(
    () => childUsdt.approve(liquidityAddress, FUND_USDT, TX_OVERRIDES),
    `approve acc[${childIdx}]`
  );
  if (!approveR) return false;

  const investR = await retryTx(
    () => childLiq.invest(tokenAddress, FUND_USDT, TX_OVERRIDES),
    `invest acc[${childIdx}]`
  );
  return !!investR;
}

// ── Process one batch in 4 parallel phases ────────────────────────────────────
async function processBatch(batch, wallets, deployer, usdtCt, liquidityAddress, tokenAddress, artifact, provider) {

  // Phase A — parallel register (each child wallet: no shared nonce)
  const regResults = await Promise.all(
    batch.map(({ childIdx, parentIdx }) => {
      const childLiq = new hre.ethers.Contract(liquidityAddress, artifact.abi, wallets[childIdx]);
      return retryTx(
        () => childLiq.register(wallets[parentIdx].address, TX_OVERRIDES),
        `register acc[${childIdx}]`
      ).then(r => ({ childIdx, ok: !!r }));
    })
  );
  const regOk = regResults.filter(r => r.ok).map(r => r.childIdx);

  if (regOk.length === 0) return { invested: 0, failed: batch.length };

  // Phase B — parallel fund from acc[0] with explicit sequential nonces
  const baseNonce = await provider.getTransactionCount(deployer.address, "pending");
  const fundTxs = await Promise.all(
    regOk.map((childIdx, i) =>
      usdtCt.transfer(wallets[childIdx].address, FUND_USDT, { ...TX_OVERRIDES, nonce: baseNonce + i })
        .catch(e => {
          console.log(`  ✗  fund submit acc[${childIdx}]: ${(e.reason || e.message || "").slice(0, 60)}`);
          return null;
        })
    )
  );
  const fundReceipts = await Promise.all(
    fundTxs.map((tx, i) => tx
      ? tx.wait().then(() => ({ childIdx: regOk[i], ok: true  }))
              .catch(e => {
                console.log(`  ✗  fund wait acc[${regOk[i]}]: ${(e.message || "").slice(0, 60)}`);
                return { childIdx: regOk[i], ok: false };
              })
      : Promise.resolve({ childIdx: regOk[i], ok: false })
    )
  );
  const fundOk = fundReceipts.filter(r => r.ok).map(r => r.childIdx);

  if (fundOk.length === 0) return { invested: 0, failed: batch.length };

  // Phase C — parallel approve (each child wallet: no shared nonce)
  const approveResults = await Promise.all(
    fundOk.map(childIdx => {
      const childUsdt = new hre.ethers.Contract(DEPLOYED_USDT, USDT_ABI, wallets[childIdx]);
      return retryTx(
        () => childUsdt.approve(liquidityAddress, FUND_USDT, TX_OVERRIDES),
        `approve acc[${childIdx}]`
      ).then(r => ({ childIdx, ok: !!r }));
    })
  );
  const approveOk = approveResults.filter(r => r.ok).map(r => r.childIdx);

  if (approveOk.length === 0) return { invested: 0, failed: batch.length };

  // Phase D — parallel invest (each child wallet: no shared nonce)
  const investResults = await Promise.all(
    approveOk.map(childIdx => {
      const childLiq = new hre.ethers.Contract(liquidityAddress, artifact.abi, wallets[childIdx]);
      return retryTx(
        () => childLiq.invest(tokenAddress, FUND_USDT, TX_OVERRIDES),
        `invest acc[${childIdx}]`
      ).then(r => ({ childIdx, ok: !!r }));
    })
  );
  const invested = investResults.filter(r => r.ok).length;

  return { invested, failed: batch.length - invested };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const rawKey = process.env.AMOY_PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  AMOY_PRIVATE_KEY missing or wrong length in .env"); process.exit(1);
  }

  const provider = hre.ethers.provider;
  const network  = hre.network.name;

  console.log(sep("═"));
  console.log("  FULL SIMULATE AMOY — Deploy · Register · Fund · Invest  (20,000 accounts)");
  console.log("  Deriving wallets… (takes a moment)");
  console.log(sep("═"));

  const wallets  = deriveWallets(rawKey, provider);
  const deployer = wallets[0];
  const usdtCt   = new hre.ethers.Contract(DEPLOYED_USDT, USDT_ABI, deployer);

  console.log(`  Network  : ${network}`);
  console.log(`  Deployer : ${deployer.address}`);

  const bal0 = await provider.getBalance(deployer.address);
  console.log(`  Balance  : ${hre.ethers.formatEther(bal0)} POL`);
  if (bal0 < hre.ethers.parseEther("3")) {
    console.error("❌  acc[0] needs ≥ 3 POL for gas"); process.exit(1);
  }

  // ── PHASE 1: Platform token ──────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 1 — PLATFORM TOKEN"); console.log(sep());
  const HordexToken = await hre.ethers.getContractFactory("HordexToken", deployer);
  const token = await HordexToken.deploy("Hordex", "HDX", 10_000_000, DEPLOY_OVERRIDES);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`  HordexToken      : ${tokenAddress}`);

  // ── PHASE 2: Contracts ───────────────────────────────────────────────────────
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
    libraries: { LiquidityMath: libAddress },
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

  // ── View facet (holds the moved getters + batch views; reached via fallback) ──
  const viewFacetAddress = await deployAndWireViewFacet(hre, {
    deployer, liquidity, factory: UNI_FACTORY, weth: DEPLOYED_USDT, token: tokenAddress,
    mathAddr: libAddress, viewLibAddr: libViewAddress, overrides: DEPLOY_OVERRIDES, mine,
  });
  console.log(`  LiquidityViewFacet: ${viewFacetAddress}  (wired via setViewFacet)`);
  const mergedAbi = mergedLiquidityAbi(hre);

  // ── Write contract-config.js immediately after deployment ────────────────────
  const configContent =
`// AUTO-GENERATED by scripts/amoytestnet/fullsimulateamoy.js
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

const VIEW_FACET_ADDRESS      = "${viewFacetAddress}";

const CONTRACT_ABI = ${JSON.stringify(mergedAbi, null, 2)};
`;
  fs.writeFileSync(path.join(__dirname, "..", "..", "contract-config.js"), configContent);
  fs.writeFileSync(path.join(__dirname, "..", "..", "frontend", "contract-config.js"), configContent);
  const idxHtml = path.join(__dirname, "..", "..", "frontend", "index.html");
  if (fs.existsSync(idxHtml)) {
    fs.writeFileSync(idxHtml, fs.readFileSync(idxHtml, "utf8")
      .replace(/contract-config\.js\?v=\d+/g, `contract-config.js?v=${Date.now()}`));
  }
  fs.writeFileSync(
    path.join(__dirname, "deploy-output.json"),
    JSON.stringify({
      network, deployedAt: new Date().toISOString(), deployBlock,
      usdtAddress: DEPLOYED_USDT, tokenAddress, liquidityAddress,
      facetAddress, roiFacetAddress, libAddress, libViewAddress,
      totalAccounts: TOTAL,
    }, null, 2)
  );
  console.log(`  contract-config.js written ✓  (frontend live immediately)`);
  console.log(`  deploy-output.json written ✓`);

  // ── PHASE 3: Token setup ─────────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 3 — TOKEN SETUP"); console.log(sep());
  const supply = await token.totalSupply();
  await (await token.transfer(liquidityAddress, supply, TX_OVERRIDES)).wait();
  console.log(`  ${hre.ethers.formatEther(supply)} HORDEX → Liquidity ✓`);
  await (await liq.addToken(tokenAddress, "Hordex", "HDX", TX_OVERRIDES)).wait();
  console.log(`  Token registered ✓`);
  await (await usdtCt.transfer(liquidityAddress, SEED_USDT, TX_OVERRIDES)).wait();
  console.log(`  ${hre.ethers.formatEther(SEED_USDT)} USDT → Liquidity ✓`);
  await (await liq.seedPool(tokenAddress, SEED_TOKENS, SEED_USDT, TX_OVERRIDES)).wait();
  console.log(`  Pool seeded: ${hre.ethers.formatEther(SEED_USDT)} USDT + ${hre.ethers.formatEther(SEED_TOKENS)} HORDEX ✓`);

  // ── PHASE 4: TWAP warm-up ────────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 4 — TWAP WARM-UP"); console.log(sep());
  const obs0R   = await (await liq.updateTWAP(TX_OVERRIDES)).wait();
  const obs0Blk = await provider.getBlock(obs0R.blockNumber);
  console.log(`  Observation 0  (block ${obs0R.blockNumber}) ✓`);
  console.log(`  Waiting ${TWAP_WAIT_SECS}s for second observation…`);
  await waitForTwap(provider, obs0Blk.timestamp);
  await (await liq.updateTWAP(TX_OVERRIDES)).wait();
  console.log("  Observation 1 ✓  —  TWAP ready");

  // ── PHASE 5: Register + Fund + Invest ────────────────────────────────────────
  const levels     = buildLevels();
  const totalAccts = levels.reduce((s, l) => s + l.length, 0);

  console.log("\n" + sep());
  console.log(`  PHASE 5 — REGISTER · FUND · INVEST  (${totalAccts.toLocaleString()} accounts, batch=${CONCURRENCY})`);
  console.log(sep());

  let globalOk = 0, globalFailed = 0;

  // ── Level 1: sequential (acc[1..10] all under acc[0]) ────────────────────────
  const lvl1 = levels[0];
  console.log(`\n  Level 1  — ${lvl1.length} accounts  [sequential]`);
  console.log("  " + "ACCOUNT".padEnd(20) + "STATUS");
  console.log("  " + sep("·", 50));

  for (const { childIdx, parentIdx } of lvl1) {
    const success = await processOne(
      childIdx, parentIdx, wallets, deployer, usdtCt, liquidityAddress, tokenAddress, artifact
    );
    const status = success ? "registered ✓  funded ✓  approved ✓  invested ✓" : "✗ failed";
    console.log(`  acc[${pad(childIdx)}] ← acc[${pad(parentIdx)}]   ${status}`);
    if (success) globalOk++; else globalFailed++;
  }

  // ── Levels 2+: parallel batches ──────────────────────────────────────────────
  for (let lvlIdx = 1; lvlIdx < levels.length; lvlIdx++) {
    const level    = levels[lvlIdx];
    const depth    = lvlIdx + 1;
    const total    = level.length;
    const batches  = Math.ceil(total / CONCURRENCY);

    console.log(`\n  Level ${depth}  — ${total.toLocaleString()} accounts  [parallel, ${batches} batch${batches > 1 ? "es" : ""}]`);
    console.log(
      "  " +
      "BATCH".padEnd(14) +
      "RANGE".padEnd(30) +
      "REG+FUND+INV".padEnd(16) +
      "✓ ok".padEnd(10) +
      "✗ fail"
    );
    console.log("  " + sep("·", 68));

    let levelOk = 0, levelFail = 0;

    for (let b = 0; b < batches; b++) {
      const batch     = level.slice(b * CONCURRENCY, (b + 1) * CONCURRENCY);
      const firstIdx  = batch[0].childIdx;
      const lastIdx   = batch[batch.length - 1].childIdx;

      const { invested, failed } = await processBatch(
        batch, wallets, deployer, usdtCt, liquidityAddress, tokenAddress, artifact, provider
      );

      levelOk   += invested;
      levelFail += failed;
      globalOk  += invested;
      globalFailed += failed;

      const bLabel  = `[${b + 1}/${batches}]`;
      const range   = `acc[${pad(firstIdx)}..${pad(lastIdx)}]`;
      const counts  = `${invested}/${batch.length}`;
      const cumOk   = String(levelOk).padStart(5);
      const cumFail = String(levelFail).padStart(4);
      console.log(
        "  " +
        bLabel.padEnd(14) +
        range.padEnd(30) +
        counts.padEnd(16) +
        cumOk.padEnd(10) +
        cumFail
      );
    }

    console.log(`  Level ${depth} done — ✓ ${levelOk}  ✗ ${levelFail}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log("\n" + sep("═"));
  console.log("  SUMMARY");
  console.log(sep("═"));
  console.log(`  Accounts invested  : ${globalOk.toLocaleString().padStart(8)} / ${totalAccts.toLocaleString()}`);
  console.log(`  Failed / skipped   : ${globalFailed.toLocaleString().padStart(8)}`);
  console.log(sep());
  console.log(`  Liquidity  : ${liquidityAddress}`);
  console.log(`  Token      : ${tokenAddress}`);
  console.log(`  Deploy blk : ${deployBlock}`);
  console.log(sep("═") + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
