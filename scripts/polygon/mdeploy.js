// Deploy the Hordex contracts to Polygon mainnet, write the deployed addresses into
// contract-config.js (root + frontend), then set up the token + pool and warm up the
// TWAP (PHASES 3-4, ported from scripts/amoytestnet/amoytree.js). It does NOT fund
// sub-wallets, register a referral chain, or invest — those remain manual/owner steps.
//
// Pre-deployed inputs (already live on Polygon mainnet — NOT deployed here):
//   • Platform token : 0x88070EAf52AaE3E6fe16Ed70Ad16d82161958F19  (HDX)
//   • USDT           : 0xc2132D05D31c914a87C6611C10748AEb04B58e8F  (canonical Polygon USDT, 6 decimals — pool base token)
//   • Uniswap V2      : official Polygon factory + router02 (see below)
//
// What it deploys:
//   1. HordexMath          (library)
//   2. HordexViewLib       (library, linked to HordexMath)
//   3. HordexFacet         (linked to HordexMath)
//   4. HordexROIFacet
//   5. Hordex              (main contract, linked to HordexMath)
//   6. HordexViewFacet     (linked + wired via setViewFacet)
//   …then rewrites contract-config.js (root + frontend) and bumps the HTML cache-bust,
//   then PHASE 3 (transfer HDX inventory → addToken → seedPool) and PHASE 4 (warm TWAP).
//
// USAGE:
//   npx hardhat run scripts/polygon/mdeploy.js --network polygon
//
// REQUIREMENTS:
//   • PRIVATE_KEY in .env  (64 hex chars, the deployer / contract owner)
//   • Deployer holds enough POL for gas (a few POL is plenty)
//   • Deployer holds the HDX inventory (default 10,000,000 HDX) + the seed USDT
//     (default 1 USDT) — both are sent to the contract during PHASE 3
//   • Optional overrides:
//       HDX_INVENTORY=10000000   SEED_HDX=1   SEED_USDT=1   (human units)
//       TWAP_WAIT_SECS=930       (must exceed TWAP_PERIOD; 900s/15min in prod config)
//       POLYGON_MAX_FEE_GWEI=200  POLYGON_PRIORITY_GWEI=40
//     (left unset → defaults applied; fees auto-estimated from the network)

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { deployAndWireViewFacet, mergedLiquidityAbi } = require("../amoytestnet/_viewfacet");

// ── Uniswap V2 on Polygon mainnet (official Uniswap deployment) ────────────────
const UNI_ROUTER   = "0xedf6066a2b290C185783862C7F4776A2C8077AD1";
const UNI_FACTORY  = "0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C";

// ── Pre-deployed tokens on Polygon mainnet ─────────────────────────────────────
const PLATFORM_TOKEN = "0x88070EAf52AaE3E6fe16Ed70Ad16d82161958F19"; // HDX
const USDT           = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"; // canonical Polygon USDT, 6 decimals (pool base token "_weth")

// ── PHASE 3 token-setup amounts (human units; token decimals queried on-chain) ─
// Sent to the Hordex contract, then seedPool() establishes the starting price.
//   inventory = HDX moved into the contract (rewards + swap inventory + LP supply)
//   seed      = SEED_HDX : SEED_USDT  →  starting price (1 : 1 = 1 USDT per HDX)
const HDX_INVENTORY_STR = process.env.HDX_INVENTORY || "10000000"; // 10 M HDX
const SEED_HDX_STR      = process.env.SEED_HDX      || "1";        // 1 HDX
const SEED_USDT_STR     = process.env.SEED_USDT     || "1";        // 1 USDT
// TWAP warm-up: the 2nd observation must land > TWAP_PERIOD after the 1st. Production
// TWAP_PERIOD = 15 min (900 s); if you flipped to testing config (30 s) set this to 31.
const TWAP_WAIT_SECS    = Number(process.env.TWAP_WAIT_SECS || 930);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];

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

// Block until the chain clock has advanced TWAP_WAIT_SECS past the first observation,
// so the second updateTWAP() records a distinct observation spaced past TWAP_PERIOD.
async function waitForTwap(provider, firstTimestamp) {
  const target = firstTimestamp + TWAP_WAIT_SECS;
  while (true) {
    try {
      const block = await provider.getBlock("latest");
      if (block.timestamp >= target) break;
      const rem = target - block.timestamp;
      process.stdout.write(`\r  TWAP warm-up: ${String(Math.floor(rem / 60)).padStart(2, "0")}:${String(rem % 60).padStart(2, "0")} remaining…`);
    } catch (_) {}
    await sleep(2000);
  }
  process.stdout.write("\r  TWAP warm-up: complete!                             \n");
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
  console.log("  MDEPLOY — Polygon mainnet · deploy Hordex contracts");
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

  // ── Token handles + decimal-aware amounts + balance checks (fail fast) ──────
  const hdxCt  = new hre.ethers.Contract(PLATFORM_TOKEN, ERC20_ABI, deployer);
  const usdtCt = new hre.ethers.Contract(USDT, ERC20_ABI, deployer);
  const hdxDec  = Number(await hdxCt.decimals());
  const usdtDec = Number(await usdtCt.decimals());
  const HDX_TO_LIQUIDITY = hre.ethers.parseUnits(HDX_INVENTORY_STR, hdxDec);
  const SEED_TOKENS      = hre.ethers.parseUnits(SEED_HDX_STR, hdxDec);
  const SEED_USDT        = hre.ethers.parseUnits(SEED_USDT_STR, usdtDec);

  const hdxBal  = await hdxCt.balanceOf(deployer.address);
  const usdtBal = await usdtCt.balanceOf(deployer.address);
  console.log(`  HDX  balance: ${hre.ethers.formatUnits(hdxBal, hdxDec)} HDX  (need ${HDX_INVENTORY_STR}, ${hdxDec}-dec)`);
  console.log(`  USDT balance: ${hre.ethers.formatUnits(usdtBal, usdtDec)} USDT (need ${SEED_USDT_STR}, ${usdtDec}-dec)`);
  if (hdxBal < HDX_TO_LIQUIDITY) {
    console.error(`❌  deployer needs ≥ ${HDX_INVENTORY_STR} HDX for the contract inventory`); process.exit(1);
  }
  if (usdtBal < SEED_USDT) {
    console.error(`❌  deployer needs ≥ ${SEED_USDT_STR} USDT for the pool seed`); process.exit(1);
  }

  // ── PHASE 1: Deploy contracts ──────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 1 — DEPLOY CONTRACTS"); console.log(sep());

  const HordexMath = await hre.ethers.getContractFactory("HordexMath", deployer);
  const liquidityMath = await HordexMath.deploy(DEPLOY_OVERRIDES);
  await liquidityMath.waitForDeployment();
  const libAddress = await liquidityMath.getAddress();
  console.log(`  HordexMath     : ${libAddress}`);

  const HordexViewLib = await hre.ethers.getContractFactory("HordexViewLib", {
    signer: deployer, libraries: { HordexMath: libAddress },
  });
  const liquidityViewLib = await HordexViewLib.deploy(DEPLOY_OVERRIDES);
  await liquidityViewLib.waitForDeployment();
  const libViewAddress = await liquidityViewLib.getAddress();
  console.log(`  HordexViewLib  : ${libViewAddress}`);

  const HordexFacet = await hre.ethers.getContractFactory("HordexFacet", {
    signer: deployer, libraries: { HordexMath: libAddress },
  });
  const liquidityFacet = await HordexFacet.deploy(
    UNI_ROUTER, UNI_FACTORY, USDT, PLATFORM_TOKEN, DEPLOY_OVERRIDES
  );
  await liquidityFacet.waitForDeployment();
  const facetAddress = await liquidityFacet.getAddress();
  console.log(`  HordexFacet    : ${facetAddress}`);

  const HordexROIFacet = await hre.ethers.getContractFactory("HordexROIFacet", deployer);
  const liquidityROIFacet = await HordexROIFacet.deploy(DEPLOY_OVERRIDES);
  await liquidityROIFacet.waitForDeployment();
  const roiFacetAddress = await liquidityROIFacet.getAddress();
  console.log(`  HordexROIFacet : ${roiFacetAddress}`);

  const Hordex = await hre.ethers.getContractFactory("Hordex", {
    signer: deployer, libraries: { HordexMath: libAddress },
  });
  const liquidity = await Hordex.deploy(
    UNI_ROUTER, UNI_FACTORY, USDT, PLATFORM_TOKEN,
    facetAddress, roiFacetAddress, DEPLOY_OVERRIDES
  );
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  const deployReceipt    = await liquidity.deploymentTransaction().wait();
  const deployBlock      = deployReceipt.blockNumber;
  console.log(`  Hordex         : ${liquidityAddress}  (block ${deployBlock})`);

  const artifact = hre.artifacts.readArtifactSync("Hordex");
  const liq      = new hre.ethers.Contract(liquidityAddress, artifact.abi, deployer);

  // View facet (moved getters + batch views; reached via fallback)
  const viewFacetAddress = await deployAndWireViewFacet(hre, {
    deployer, liquidity: liq, factory: UNI_FACTORY, weth: USDT, token: PLATFORM_TOKEN,
    mathAddr: libAddress, viewLibAddr: libViewAddress, overrides: DEPLOY_OVERRIDES, mine,
  });
  console.log(`  HordexViewFacet: ${viewFacetAddress}  (wired via setViewFacet)`);
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

  // ── PHASE 3: Token setup (transfer HDX inventory → addToken → seedPool) ──────
  console.log("\n" + sep()); console.log("  PHASE 3 — TOKEN SETUP"); console.log(sep());

  // Move HDX inventory into the contract (rewards + swap inventory + LP supply side).
  await mine(() => hdxCt.transfer(liquidityAddress, HDX_TO_LIQUIDITY, TX_OVERRIDES));
  console.log(`  ${HDX_INVENTORY_STR} HDX → Hordex ✓`);

  // Register HDX as a tradable token.
  await mine(() => liq.addToken(PLATFORM_TOKEN, "Hordex Token", "HDX", TX_OVERRIDES));
  console.log(`  HDX token registered ✓`);

  // Drain any LP the deployer holds in a pre-existing HDX/USDT pair so the seed below
  // establishes a clean price (the Uniswap pair persists independently of this contract;
  // on a first-ever deploy there is no pair and this is a no-op).
  {
    const _factoryCt = new hre.ethers.Contract(
      UNI_FACTORY,
      ["function getPair(address,address) view returns (address)"],
      deployer
    );
    const _pairAddr = await _factoryCt.getPair(PLATFORM_TOKEN, USDT);
    if (_pairAddr !== hre.ethers.ZeroAddress) {
      const _pairCt = new hre.ethers.Contract(
        _pairAddr,
        ["function balanceOf(address) view returns (uint256)",
         "function approve(address,uint256) returns (bool)"],
        deployer
      );
      const _lpBal = await _pairCt.balanceOf(deployer.address);
      if (_lpBal > 0n) {
        console.log(`  Existing pair found — draining deployer LP (${hre.ethers.formatEther(_lpBal)} LP)…`);
        await mine(() => _pairCt.approve(UNI_ROUTER, _lpBal, TX_OVERRIDES));
        const _routerCt = new hre.ethers.Contract(
          UNI_ROUTER,
          ["function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)"],
          deployer
        );
        await mine(() => _routerCt.removeLiquidity(
          PLATFORM_TOKEN, USDT, _lpBal, 0, 0,
          deployer.address,
          BigInt(Math.floor(Date.now() / 1000) + 300),
          TX_OVERRIDES
        ));
        console.log(`  Existing LP drained → pair reset ✓`);
      } else {
        console.log(`  Pair exists but deployer holds no LP — skipping drain`);
      }
    } else {
      console.log(`  No existing pair — fresh creation`);
    }
  }

  // Move the seed USDT into the contract, then seed the pool to set the starting price.
  await mine(() => usdtCt.transfer(liquidityAddress, SEED_USDT, TX_OVERRIDES));
  console.log(`  ${SEED_USDT_STR} USDT → Hordex ✓`);
  await mine(() => liq.seedPool(PLATFORM_TOKEN, SEED_TOKENS, SEED_USDT, TX_OVERRIDES));
  console.log(`  Pool seeded: ${SEED_HDX_STR} HDX + ${SEED_USDT_STR} USDT  →  1 HDX = ${Number(SEED_USDT_STR) / Number(SEED_HDX_STR)} USDT ✓`);

  // ── PHASE 4: TWAP warm-up (2 observations spaced > TWAP_PERIOD apart) ────────
  console.log("\n" + sep()); console.log("  PHASE 4 — TWAP WARM-UP"); console.log(sep());
  const obs0Receipt = await mine(() => liq.updateTWAP(TX_OVERRIDES));
  await mine(() => liq.updateTokenTWAP(PLATFORM_TOKEN, TX_OVERRIDES));
  const obs0Block   = await provider.getBlock(obs0Receipt.blockNumber);
  console.log(`  Observation 0  (block ${obs0Receipt.blockNumber}) ✓`);
  console.log(`  Waiting ${TWAP_WAIT_SECS}s for the second observation…`);
  await waitForTwap(provider, obs0Block.timestamp);
  await mine(() => liq.updateTWAP(TX_OVERRIDES));
  await mine(() => liq.updateTokenTWAP(PLATFORM_TOKEN, TX_OVERRIDES));
  console.log("  Observation 1 ✓  —  TWAP ready");

  // ── Done ───────────────────────────────────────────────────────────────────
  console.log("\n" + sep("═"));
  console.log("  DONE — deployed · config updated · token set up · pool seeded · TWAP warm");
  console.log(sep("═"));
  console.log(`  Hordex         : ${liquidityAddress}`);
  console.log(`  HordexFacet    : ${facetAddress}`);
  console.log(`  HordexROIFacet : ${roiFacetAddress}`);
  console.log(`  HordexViewFacet: ${viewFacetAddress}`);
  console.log(`  Deploy block   : ${deployBlock}`);
  console.log(`  Pool / TWAP    : seeded @ ${Number(SEED_USDT_STR) / Number(SEED_HDX_STR)} USDT/HDX · TWAP ready`);
  console.log("\n  NOTE: contract is live and tradeable. Remaining steps are yours: top up extra");
  console.log("        reward inventory if desired, then users approve USDT → register → invest.");
  console.log(sep("═") + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
