// Deploy the Hordex Liquidity contracts to Polygon mainnet, then write the deployed
// addresses into contract-config.js (root + frontend). Deploy-only — it does NOT seed
// the pool, register the token, warm up TWAP, fund wallets, or invest. Those are
// separate, owner-driven steps you run afterwards.
//
// Pre-deployed inputs (already live on Polygon mainnet — NOT deployed here):
//   • Platform token : 0xCD575ebAEb4f5DC4E84CA324D936C37e8538cFBf
//   • USDT           : 0x03bE0af806A80FBF368526266aD789254A956c24  (pool base token)
//   • Uniswap V2      : official Polygon factory + router02 (see below)
//
// What it deploys:
//   1. LiquidityMath          (library)
//   2. LiquidityViewLib       (library, linked to LiquidityMath)
//   3. LiquidityFacet         (linked to LiquidityMath)
//   4. LiquidityROIFacet
//   5. Liquidity              (main contract, linked to LiquidityMath)
//   6. LiquidityViewFacet     (linked + wired via setViewFacet)
//   …then rewrites contract-config.js (root + frontend) and bumps the HTML cache-bust.
//
// USAGE:
//   npx hardhat run scripts/polygon/mdeploy.js --network polygon
//
// REQUIREMENTS:
//   • PRIVATE_KEY in .env  (64 hex chars, the deployer / contract owner)
//   • Deployer holds enough POL for gas (a few POL is plenty for deploy-only)
//   • Optional fee tuning if you hit "transaction underpriced":
//       POLYGON_MAX_FEE_GWEI=200  POLYGON_PRIORITY_GWEI=40
//     (left unset → fees are auto-estimated from the network)

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { deployAndWireViewFacet, mergedLiquidityAbi } = require("../amoytestnet/_viewfacet");

// ── Uniswap V2 on Polygon mainnet (official Uniswap deployment) ────────────────
const UNI_ROUTER   = "0xedf6066a2b290C185783862C7F4776A2C8077AD1";
const UNI_FACTORY  = "0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C";

// ── Pre-deployed tokens on Polygon mainnet ─────────────────────────────────────
const PLATFORM_TOKEN = "0xCD575ebAEb4f5DC4E84CA324D936C37e8538cFBf";
const USDT           = "0x03bE0af806A80FBF368526266aD789254A956c24"; // pool base token ("_weth")

// ── Gas overrides ──────────────────────────────────────────────────────────────
// Fee fields are omitted by default so ethers auto-estimates EIP-1559 fees from the
// live network (safest on mainnet). Override via env if a tx gets stuck underpriced.
const GWEI = n => hre.ethers.parseUnits(String(n), "gwei");
const FEE_OVERRIDES = {};
if (process.env.POLYGON_MAX_FEE_GWEI)  FEE_OVERRIDES.maxFeePerGas         = GWEI(process.env.POLYGON_MAX_FEE_GWEI);
if (process.env.POLYGON_PRIORITY_GWEI) FEE_OVERRIDES.maxPriorityFeePerGas = GWEI(process.env.POLYGON_PRIORITY_GWEI);
const DEPLOY_OVERRIDES = { ...FEE_OVERRIDES, gasLimit: 15_000_000 };
const TX_OVERRIDES     = { ...FEE_OVERRIDES, gasLimit:  5_000_000 };

// ── Helpers ────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sep(c = "─", n = 64) { return c.repeat(n); }

function isTransient(e) {
  return ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(e.code) ||
    ["ECONNRESET", "ETIMEDOUT", "timeout", "network"].some(k => e.message?.includes(k));
}

// Send a tx and wait for it to be mined, retrying transient RPC hiccups.
async function mine(txFn, maxRetries = 6) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let tx;
    try { tx = await txFn(); }
    catch (e) {
      if (isTransient(e) && attempt < maxRetries - 1) { await sleep(4000 * (attempt + 1)); continue; }
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Safety: this script is mainnet-only — refuse to run anywhere else.
  if (hre.network.config.chainId !== 137) {
    console.error(`❌  Wrong network "${hre.network.name}" (chainId ${hre.network.config.chainId}).`);
    console.error(`   Run with:  npx hardhat run scripts/polygon/mdeploy.js --network polygon`);
    process.exit(1);
  }

  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env"); process.exit(1);
  }

  const provider = hre.ethers.provider;
  const deployer = new hre.ethers.Wallet(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey, provider);
  const network  = hre.network.name;

  console.log(sep("═"));
  console.log("  MDEPLOY — Polygon mainnet · deploy Liquidity contracts");
  console.log(sep("═"));
  console.log(`  Network  : ${network} (chainId 137)`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Token    : ${PLATFORM_TOKEN}`);
  console.log(`  USDT     : ${USDT}`);
  console.log(`  Router   : ${UNI_ROUTER}`);
  console.log(`  Factory  : ${UNI_FACTORY}\n`);

  const bal = await provider.getBalance(deployer.address);
  console.log(`  POL balance : ${hre.ethers.formatEther(bal)} POL`);
  if (bal < hre.ethers.parseEther("1")) {
    console.error("❌  deployer needs ≥ 1 POL for gas"); process.exit(1);
  }

  // ── PHASE 1: Deploy contracts ──────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 1 — DEPLOY CONTRACTS"); console.log(sep());

  const LiquidityMath = await hre.ethers.getContractFactory("LiquidityMath", deployer);
  const liquidityMath = await LiquidityMath.deploy(DEPLOY_OVERRIDES);
  await liquidityMath.waitForDeployment();
  const libAddress = await liquidityMath.getAddress();
  console.log(`  LiquidityMath     : ${libAddress}`);

  const LiquidityViewLib = await hre.ethers.getContractFactory("LiquidityViewLib", {
    signer: deployer, libraries: { LiquidityMath: libAddress },
  });
  const liquidityViewLib = await LiquidityViewLib.deploy(DEPLOY_OVERRIDES);
  await liquidityViewLib.waitForDeployment();
  const libViewAddress = await liquidityViewLib.getAddress();
  console.log(`  LiquidityViewLib  : ${libViewAddress}`);

  const LiquidityFacet = await hre.ethers.getContractFactory("LiquidityFacet", {
    signer: deployer, libraries: { LiquidityMath: libAddress },
  });
  const liquidityFacet = await LiquidityFacet.deploy(
    UNI_ROUTER, UNI_FACTORY, USDT, PLATFORM_TOKEN, DEPLOY_OVERRIDES
  );
  await liquidityFacet.waitForDeployment();
  const facetAddress = await liquidityFacet.getAddress();
  console.log(`  LiquidityFacet    : ${facetAddress}`);

  const LiquidityROIFacet = await hre.ethers.getContractFactory("LiquidityROIFacet", deployer);
  const liquidityROIFacet = await LiquidityROIFacet.deploy(DEPLOY_OVERRIDES);
  await liquidityROIFacet.waitForDeployment();
  const roiFacetAddress = await liquidityROIFacet.getAddress();
  console.log(`  LiquidityROIFacet : ${roiFacetAddress}`);

  const Liquidity = await hre.ethers.getContractFactory("Liquidity", {
    signer: deployer, libraries: { LiquidityMath: libAddress },
  });
  const liquidity = await Liquidity.deploy(
    UNI_ROUTER, UNI_FACTORY, USDT, PLATFORM_TOKEN,
    facetAddress, roiFacetAddress, DEPLOY_OVERRIDES
  );
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  const deployReceipt    = await liquidity.deploymentTransaction().wait();
  const deployBlock      = deployReceipt.blockNumber;
  console.log(`  Liquidity         : ${liquidityAddress}  (block ${deployBlock})`);

  const artifact = hre.artifacts.readArtifactSync("Liquidity");
  const liq      = new hre.ethers.Contract(liquidityAddress, artifact.abi, deployer);

  // View facet (moved getters + batch views; reached via fallback)
  const viewFacetAddress = await deployAndWireViewFacet(hre, {
    deployer, liquidity: liq, factory: UNI_FACTORY, weth: USDT, token: PLATFORM_TOKEN,
    mathAddr: libAddress, viewLibAddr: libViewAddress, overrides: DEPLOY_OVERRIDES, mine,
  });
  console.log(`  LiquidityViewFacet: ${viewFacetAddress}  (wired via setViewFacet)`);
  const mergedAbi = mergedLiquidityAbi(hre);

  // ── PHASE 2: Write contract-config.js ──────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 2 — WRITE CONFIG"); console.log(sep());
  const configContent =
`// AUTO-GENERATED by scripts/polygon/mdeploy.js
// Network: ${network} (chainId 137) | Deployed: ${new Date().toLocaleString()}

const CONTRACT_ADDRESS        = "${liquidityAddress}";
const TOKEN_ADDRESS           = "${PLATFORM_TOKEN}";
const TOKEN_ADDRESS_JIGGY     = "";
const TOKEN_ADDRESS_PANWORLD  = "";
const ROUTER_ADDRESS          = "${UNI_ROUTER}";
const FACTORY_ADDRESS         = "${UNI_FACTORY}";
const WETH_ADDRESS            = "${USDT}";
const USDT_ADDRESS            = "${USDT}";
const DEPLOY_BLOCK            = ${deployBlock};
const FACET_ADDRESS           = "${facetAddress}";
const ROI_FACET_ADDRESS       = "${roiFacetAddress}";

const VIEW_FACET_ADDRESS      = "${viewFacetAddress}";

const CONTRACT_ABI = ${JSON.stringify(mergedAbi, null, 2)};
`;
  const root = path.join(__dirname, "..", "..");
  fs.writeFileSync(path.join(root, "contract-config.js"), configContent);
  fs.writeFileSync(path.join(root, "frontend", "contract-config.js"), configContent);
  console.log("  contract-config.js written ✓  (root + frontend)");

  // Bump the HTML cache-bust so browsers fetch the new config (not a stale cached copy).
  const stamp = Date.now();
  for (const htmlFile of ["index.html", "launchpad.html"]) {
    const htmlPath = path.join(root, "frontend", htmlFile);
    if (!fs.existsSync(htmlPath)) continue;
    const before = fs.readFileSync(htmlPath, "utf8");
    const after  = before.replace(/contract-config\.js\?v=\d+/g, `contract-config.js?v=${stamp}`);
    if (after !== before) {
      fs.writeFileSync(htmlPath, after);
      console.log(`  ${htmlFile} cache-bust bumped → ?v=${stamp} ✓`);
    }
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  console.log("\n" + sep("═"));
  console.log("  DONE — contracts deployed & config updated");
  console.log(sep("═"));
  console.log(`  Liquidity         : ${liquidityAddress}`);
  console.log(`  LiquidityFacet    : ${facetAddress}`);
  console.log(`  LiquidityROIFacet : ${roiFacetAddress}`);
  console.log(`  LiquidityViewFacet: ${viewFacetAddress}`);
  console.log(`  Deploy block      : ${deployBlock}`);
  console.log("\n  NOTE: deploy-only. Next (owner) steps, when ready: fund the contract with");
  console.log("        platform tokens, addToken(), seedPool(), then warm up TWAP (2× updateTWAP).");
  console.log(sep("═") + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
