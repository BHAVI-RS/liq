// Deploy the Hordex platform contract set to Polygon mainnet using PRIVATE_KEY from .env,
// verify every contract on PolygonScan (Etherscan V2 API) with ETHERSCAN_API_KEY, and
// print all deployed addresses at the end.
//
// HordexToken (HDX) is ALREADY DEPLOYED and is NOT deployed by this script — it is wired
// in as the platform token (default 0x88070EAf52AaE3E6fe16Ed70Ad16d82161958F19).
//
// What it deploys (in dependency order):
//   1. HordexMath      (library)
//   2. HordexViewLib   (library, linked to HordexMath)
//   3. HordexFacet     (linked to HordexMath)        — investment & liquidity engine
//   4. HordexROIFacet                                — multi-level ROI rewards
//   5. Hordex          (core, linked to HordexMath)  — single entry point
//   6. HordexViewFacet (linked to HordexMath + HordexViewLib) — wired via setViewFacet()
//
// After deploying it rewrites contract-config.js (root + frontend) so the new core/facet
// addresses, the HDX token (TOKEN_ADDRESS), and USDT (WETH/USDT_ADDRESS) propagate across
// the whole platform, and bumps the frontend HTML cache-bust.
//
// It does NOT move HDX inventory, register the token, seed the pool, or warm the TWAP —
// run scripts/polygon/mdeploy.js for the full go-live flow, or do those steps manually
// with the addresses printed here.
//
// USAGE:
//   npx hardhat run scripts/polygon/hordexdeploy.js --network polygon
//
// REQUIREMENTS:
//   • PRIVATE_KEY in .env       (64 hex chars — the deployer becomes the platform owner)
//   • ETHERSCAN_API_KEY in .env (one V2 key from etherscan.io/myapikey covers Polygon 137;
//                                if unset, deployment still succeeds and verification is skipped)
//   • Deployer holds a little POL for gas
//   • Optional overrides (env):
//       PLATFORM_TOKEN=0x...    the already-deployed HDX token (default below)
//       USDT_ADDRESS=0x...      base/pool token ("_weth"); default = canonical Polygon USDT
//       UNI_ROUTER=0x...   UNI_FACTORY=0x...     Uniswap V2 router02 / factory
//       POLYGON_MAX_FEE_GWEI=200   POLYGON_PRIORITY_GWEI=40

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { deployAndWireViewFacet, mergedLiquidityAbi } = require("../amoytestnet/_viewfacet");
const { verifyAllContracts } = require("../amoytestnet/_verify");

// ── External (already-live) addresses on Polygon mainnet — override via env ────────
const UNI_ROUTER  = process.env.UNI_ROUTER  || "0xedf6066a2b290C185783862C7F4776A2C8077AD1";
const UNI_FACTORY = process.env.UNI_FACTORY || "0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C";
// Base/pool token the contracts treat as "_weth". Default = canonical Polygon USDT (6-dec).
const USDT        = process.env.USDT_ADDRESS || "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

// ── Pre-deployed HordexToken (HDX) — NOT deployed here, wired in as the platform token ─
const PLATFORM_TOKEN = process.env.PLATFORM_TOKEN || "0x88070EAf52AaE3E6fe16Ed70Ad16d82161958F19";

// ── Gas overrides ──────────────────────────────────────────────────────────────────
// Fee fields omitted by default so ethers auto-estimates EIP-1559 fees from the network.
const GWEI = n => hre.ethers.parseUnits(String(n), "gwei");
const FEE_OVERRIDES = {};
if (process.env.POLYGON_MAX_FEE_GWEI)  FEE_OVERRIDES.maxFeePerGas         = GWEI(process.env.POLYGON_MAX_FEE_GWEI);
if (process.env.POLYGON_PRIORITY_GWEI) FEE_OVERRIDES.maxPriorityFeePerGas = GWEI(process.env.POLYGON_PRIORITY_GWEI);
const DEPLOY_OVERRIDES = { ...FEE_OVERRIDES, gasLimit: 15_000_000 };
const TX_OVERRIDES     = { ...FEE_OVERRIDES, gasLimit:  5_000_000 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sep(c = "─", n = 64) { return c.repeat(n); }

function isTransient(e) {
  return ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(e.code) ||
    ["ECONNRESET", "ETIMEDOUT", "timeout", "network"].some(k => e.message?.includes(k));
}

// Send a tx and wait for it to mine, retrying transient RPC hiccups.
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

async function main() {
  // Safety: mainnet-only (PRIVATE_KEY maps to the `polygon` network in hardhat.config.js).
  if (hre.network.config.chainId !== 137) {
    console.error(`❌  Wrong network "${hre.network.name}" (chainId ${hre.network.config.chainId}).`);
    console.error(`   Run with:  npx hardhat run scripts/polygon/hordexdeploy.js --network polygon`);
    process.exit(1);
  }

  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env"); process.exit(1);
  }

  const provider = hre.ethers.provider;
  const deployer = new hre.ethers.Wallet(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey, provider);

  console.log(sep("═"));
  console.log("  HORDEXDEPLOY — Polygon mainnet · deploy + verify the full Hordex set");
  console.log(sep("═"));
  console.log(`  Network  : ${hre.network.name} (chainId 137)`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Router   : ${UNI_ROUTER}`);
  console.log(`  Factory  : ${UNI_FACTORY}`);
  console.log(`  USDT     : ${USDT}  (base/pool token "_weth")`);
  console.log(`  Token    : ${PLATFORM_TOKEN}  (pre-deployed HordexToken — not deployed here)`);
  console.log("");

  const bal = await provider.getBalance(deployer.address);
  console.log(`  POL balance : ${hre.ethers.formatEther(bal)} POL`);
  if (bal === 0n) { console.error("❌  deployer needs POL for gas"); process.exit(1); }

  // ── DEPLOY ─────────────────────────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  DEPLOY"); console.log(sep());

  // HordexToken (HDX) is already deployed — wire it in, do not deploy.
  const tokenAddress = PLATFORM_TOKEN;
  console.log(`  HordexToken    : ${tokenAddress}  (pre-deployed)`);

  // 1. HordexMath (library)
  const HordexMath = await hre.ethers.getContractFactory("HordexMath", deployer);
  const mathLib = await HordexMath.deploy(DEPLOY_OVERRIDES);
  await mathLib.waitForDeployment();
  const mathAddress = await mathLib.getAddress();
  console.log(`  HordexMath     : ${mathAddress}`);

  // 2. HordexViewLib (library, linked to HordexMath)
  const HordexViewLib = await hre.ethers.getContractFactory("HordexViewLib", {
    signer: deployer, libraries: { HordexMath: mathAddress },
  });
  const viewLib = await HordexViewLib.deploy(DEPLOY_OVERRIDES);
  await viewLib.waitForDeployment();
  const viewLibAddress = await viewLib.getAddress();
  console.log(`  HordexViewLib  : ${viewLibAddress}`);

  // 3. HordexFacet (linked to HordexMath)
  const HordexFacet = await hre.ethers.getContractFactory("HordexFacet", {
    signer: deployer, libraries: { HordexMath: mathAddress },
  });
  const facet = await HordexFacet.deploy(UNI_ROUTER, UNI_FACTORY, USDT, tokenAddress, DEPLOY_OVERRIDES);
  await facet.waitForDeployment();
  const facetAddress = await facet.getAddress();
  console.log(`  HordexFacet    : ${facetAddress}`);

  // 4. HordexROIFacet (no constructor args)
  const HordexROIFacet = await hre.ethers.getContractFactory("HordexROIFacet", deployer);
  const roiFacet = await HordexROIFacet.deploy(DEPLOY_OVERRIDES);
  await roiFacet.waitForDeployment();
  const roiFacetAddress = await roiFacet.getAddress();
  console.log(`  HordexROIFacet : ${roiFacetAddress}`);

  // 5. Hordex (core, linked to HordexMath)
  const Hordex = await hre.ethers.getContractFactory("Hordex", {
    signer: deployer, libraries: { HordexMath: mathAddress },
  });
  const core = await Hordex.deploy(
    UNI_ROUTER, UNI_FACTORY, USDT, tokenAddress, facetAddress, roiFacetAddress, DEPLOY_OVERRIDES
  );
  await core.waitForDeployment();
  const coreAddress   = await core.getAddress();
  const deployReceipt = await core.deploymentTransaction().wait();
  const deployBlock   = deployReceipt.blockNumber;
  console.log(`  Hordex         : ${coreAddress}  (block ${deployBlock})`);

  // 6. HordexViewFacet (linked to HordexMath + HordexViewLib) + wire via setViewFacet()
  const coreArtifact = hre.artifacts.readArtifactSync("Hordex");
  const coreContract = new hre.ethers.Contract(coreAddress, coreArtifact.abi, deployer);
  const viewFacetAddress = await deployAndWireViewFacet(hre, {
    deployer, liquidity: coreContract, factory: UNI_FACTORY, weth: USDT, token: tokenAddress,
    mathAddr: mathAddress, viewLibAddr: viewLibAddress, overrides: DEPLOY_OVERRIDES, mine,
  });
  console.log(`  HordexViewFacet: ${viewFacetAddress}  (wired via setViewFacet)`);

  // ── Record addresses for later re-verify / reference ─────────────────────────────
  const outPath = path.join(__dirname, "hordex-deploy-output.json");
  fs.writeFileSync(outPath, JSON.stringify({
    network: hre.network.name,
    chainId: 137,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    deployBlock,
    router: UNI_ROUTER,
    factory: UNI_FACTORY,
    usdt: USDT,
    platformToken:   tokenAddress, // pre-deployed HordexToken (HDX), not deployed by this script
    addresses: {
      HordexMath:      mathAddress,
      HordexViewLib:   viewLibAddress,
      HordexFacet:     facetAddress,
      HordexROIFacet:  roiFacetAddress,
      Hordex:          coreAddress,
      HordexViewFacet: viewFacetAddress,
    },
  }, null, 2));
  console.log(`\n  hordex-deploy-output.json written ✓`);

  // ── WRITE PLATFORM CONFIG ────────────────────────────────────────────────────────
  // Propagate the new addresses + HDX (TOKEN_ADDRESS) + USDT (WETH/USDT_ADDRESS) across
  // the whole platform by rewriting contract-config.js (root + frontend) and bumping the
  // HTML cache-bust so browsers fetch the new config instead of a stale cached copy.
  console.log("\n" + sep()); console.log("  WRITE CONFIG"); console.log(sep());
  const mergedAbi = mergedLiquidityAbi(hre);
  const configContent =
`// AUTO-GENERATED by scripts/polygon/hordexdeploy.js
// Network: ${hre.network.name} (chainId 137) | Deployed: ${new Date().toLocaleString()}

const CONTRACT_ADDRESS        = "${coreAddress}";
const TOKEN_ADDRESS           = "${tokenAddress}";
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
  console.log(`    TOKEN_ADDRESS (HDX) : ${tokenAddress}`);
  console.log(`    USDT_ADDRESS        : ${USDT}`);

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

  // ── VERIFY on PolygonScan ────────────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  VERIFY (PolygonScan / Etherscan V2)"); console.log(sep());
  if (!process.env.ETHERSCAN_API_KEY) {
    console.log("  ⚠️  ETHERSCAN_API_KEY not set in .env — skipping source verification.");
    console.log("      Add the key and re-run, or verify manually with the addresses above.");
  } else {
    // Give PolygonScan a moment to index the freshly-deployed bytecode (verifyOne also retries).
    await sleep(20000);
    await verifyAllContracts(hre, {
      router: UNI_ROUTER, factory: UNI_FACTORY, usdt: USDT, token: tokenAddress,
      liquidity: coreAddress, facet: facetAddress, roiFacet: roiFacetAddress,
      lib: mathAddress, libView: viewLibAddress, viewFacet: viewFacetAddress,
    });
  }

  // ── SUMMARY — all deployed addresses ─────────────────────────────────────────────
  console.log("\n" + sep("═"));
  console.log("  DONE — all Hordex contracts deployed");
  console.log(sep("═"));
  console.log(`  HordexToken     : ${tokenAddress}  (pre-deployed)`);
  console.log(`  HordexMath      : ${mathAddress}`);
  console.log(`  HordexViewLib   : ${viewLibAddress}`);
  console.log(`  HordexFacet     : ${facetAddress}`);
  console.log(`  HordexROIFacet  : ${roiFacetAddress}`);
  console.log(`  Hordex (core)   : ${coreAddress}`);
  console.log(`  HordexViewFacet : ${viewFacetAddress}`);
  console.log(`  Deploy block    : ${deployBlock}`);
  console.log(`  Explorer        : https://polygonscan.com/address/${coreAddress}#code`);
  console.log(sep("═"));
  console.log("  NEXT: move HDX inventory into the core, addToken(HDX), seedPool, warm the TWAP");
  console.log("        (or run scripts/polygon/mdeploy.js for the full automated go-live flow).");
  console.log(sep("═") + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
