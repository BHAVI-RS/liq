// binary.js — Deploy · Seed · TWAP · Register 511-node binary tree · Invest
//
// Tree structure (acc[i] registers under acc[floor(i/2)]):
//   acc[0]  (deployer — root referrer, not registered)
//   └─ acc[1]          level 0  →  $25,000
//      ├─ acc[2]       level 1  →  $10,000
//      │  ├─ acc[4]   level 2  →   $5,000
//      │  └─ acc[5]   level 2  →   $5,000
//      └─ acc[3]       level 1  →  $10,000
//         ├─ acc[6]   level 2  →   $5,000
//         └─ acc[7]   level 2  →   $5,000
//      ... (complete binary tree through level 8, acc[256..511])
//
//   Level 0 : acc[1]          1 account   — $25,000
//   Level 1 : acc[2..3]       2 accounts  — $10,000
//   Level 2 : acc[4..7]       4 accounts  — $ 5,000
//   Level 3 : acc[8..15]      8 accounts  — $ 2,500
//   Level 4 : acc[16..31]    16 accounts  — $ 1,000
//   Level 5 : acc[32..63]    32 accounts  — $   500
//   Level 6 : acc[64..127]   64 accounts  — $   250
//   Level 7 : acc[128..255] 128 accounts  — $   100
//   Level 8 : acc[256..511] 256 accounts  — $   100
//
// Sub-wallet balances are NOT checked — run amoynode.js first.
//
// USAGE:
//   npx hardhat run scripts/amoytestnet/binary.js --network polygonAmoy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { deployAndWireViewFacet, mergedLiquidityAbi } = require("./_viewfacet");

// ── Config ────────────────────────────────────────────────────────────────────
const DEPLOYED_USDT    = "0xcDC1119387AE7cE0cDb2A84CB8be2D6C8F0F5CB9";
const PLATFORM_TOKEN   = "0x39544CBb2aB89E64aD74c731Ee690D2923bB209f";

const HDX_TO_LIQUIDITY = hre.ethers.parseEther("10000000"); // 10 M HDX
const SEED_USDT        = hre.ethers.parseEther("1");
const SEED_TOKENS      = hre.ethers.parseEther("1");
const REGISTRATION_FEE = hre.ethers.parseEther("1");        // 1 USDT per account
const TWAP_WAIT_SECS   = 31;

// acc[i] is at level floor(log2(i)); invest amount indexed by level
const INVEST_BY_LEVEL = [
  hre.ethers.parseEther("25000"), // level 0 — acc[1]
  hre.ethers.parseEther("10000"), // level 1 — acc[2..3]
  hre.ethers.parseEther("5000"),  // level 2 — acc[4..7]
  hre.ethers.parseEther("2500"),  // level 3 — acc[8..15]
  hre.ethers.parseEther("1000"),  // level 4 — acc[16..31]
  hre.ethers.parseEther("500"),   // level 5 — acc[32..63]
  hre.ethers.parseEther("250"),   // level 6 — acc[64..127]
  hre.ethers.parseEther("100"),   // level 7 — acc[128..255]
  hre.ethers.parseEther("100"),   // level 8 — acc[256..511]
];

// Tree spans acc[1..511]; acc[0] is deployer/root referrer.
const TREE_SIZE = 511; // acc[1..511]

const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];

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

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sep(c = "─", n = 64) { return c.repeat(n); }

function deriveWallets(rawKey, provider, count) {
  const pk = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
  const wallets = [new hre.ethers.Wallet(pk, provider)];
  for (let i = 1; i < count; i++) {
    wallets.push(new hre.ethers.Wallet(
      hre.ethers.keccak256(hre.ethers.solidityPacked(["bytes32", "uint256"], [pk, i])),
      provider
    ));
  }
  return wallets;
}

function treeLevel(i) { return Math.floor(Math.log2(i)); }

function isTransient(e) {
  return ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(e.code) ||
    ["ECONNRESET", "ETIMEDOUT", "timeout", "network"].some(k => e.message?.includes(k));
}

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
  const rawKey = process.env.AMOY_PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  AMOY_PRIVATE_KEY missing or wrong length in .env"); process.exit(1);
  }

  const provider = hre.ethers.provider;
  // acc[0..511] — 512 wallets total
  const signers  = deriveWallets(rawKey, provider, TREE_SIZE + 1);
  const deployer = signers[0];
  const network  = hre.network.name;

  console.log(sep("═"));
  console.log("  BINARY — Deploy · Seed · TWAP · Register 511-node tree · Invest");
  console.log(sep("═"));
  console.log(`  Network  : ${network}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  HDX      : ${PLATFORM_TOKEN}`);
  console.log(`  USDT     : ${DEPLOYED_USDT}\n`);

  const deployerBal = await provider.getBalance(deployer.address);
  console.log(`  POL balance : ${hre.ethers.formatEther(deployerBal)} POL`);
  if (deployerBal < hre.ethers.parseEther("3")) {
    console.error("❌  deployer needs ≥ 3 POL for gas"); process.exit(1);
  }

  const hdxCt  = new hre.ethers.Contract(PLATFORM_TOKEN, TOKEN_ABI, deployer);
  const usdtCt = new hre.ethers.Contract(DEPLOYED_USDT,  TOKEN_ABI, deployer);

  const hdxBal  = await hdxCt.balanceOf(deployer.address);
  const usdtBal = await usdtCt.balanceOf(deployer.address);
  console.log(`  HDX balance : ${hre.ethers.formatEther(hdxBal)} HDX`);
  console.log(`  USDT balance: ${hre.ethers.formatEther(usdtBal)} USDT\n`);
  if (hdxBal < HDX_TO_LIQUIDITY) {
    console.error(`❌  deployer needs ≥ 10,000,000 HDX (has ${hre.ethers.formatEther(hdxBal)})`); process.exit(1);
  }

  // ── PHASE 1: Deploy contracts ──────────────────────────────────────────────
  console.log(sep()); console.log("  PHASE 1 — DEPLOY CONTRACTS"); console.log(sep());

  const UniswapV2Factory = await hre.ethers.getContractFactory("UniswapV2Factory", deployer);
  const uniFactory = await UniswapV2Factory.deploy(deployer.address, DEPLOY_OVERRIDES);
  await uniFactory.waitForDeployment();
  const factoryAddress = await uniFactory.getAddress();
  console.log(`  UniswapV2Factory : ${factoryAddress}`);

  const UniswapV2Router02 = await hre.ethers.getContractFactory("UniswapV2Router02", deployer);
  const uniRouter = await UniswapV2Router02.deploy(factoryAddress, DEPLOYED_USDT, DEPLOY_OVERRIDES);
  await uniRouter.waitForDeployment();
  const routerAddress = await uniRouter.getAddress();
  console.log(`  UniswapV2Router02: ${routerAddress}`);

  const HordexMath = await hre.ethers.getContractFactory("HordexMath", deployer);
  const liquidityMath = await HordexMath.deploy(DEPLOY_OVERRIDES);
  await liquidityMath.waitForDeployment();
  const libAddress = await liquidityMath.getAddress();
  console.log(`  HordexMath    : ${libAddress}`);

  const HordexViewLib = await hre.ethers.getContractFactory("HordexViewLib", {
    signer: deployer, libraries: { HordexMath: libAddress },
  });
  const liquidityViewLib = await HordexViewLib.deploy(DEPLOY_OVERRIDES);
  await liquidityViewLib.waitForDeployment();
  const libViewAddress = await liquidityViewLib.getAddress();
  console.log(`  HordexViewLib : ${libViewAddress}`);

  const HordexFacet = await hre.ethers.getContractFactory("HordexFacet", {
    signer: deployer, libraries: { HordexMath: libAddress },
  });
  const liquidityFacet = await HordexFacet.deploy(
    routerAddress, factoryAddress, DEPLOYED_USDT, PLATFORM_TOKEN, DEPLOY_OVERRIDES
  );
  await liquidityFacet.waitForDeployment();
  const facetAddress = await liquidityFacet.getAddress();
  console.log(`  HordexFacet   : ${facetAddress}`);

  const HordexROIFacet = await hre.ethers.getContractFactory("HordexROIFacet", deployer);
  const liquidityROIFacet = await HordexROIFacet.deploy(DEPLOY_OVERRIDES);
  await liquidityROIFacet.waitForDeployment();
  const roiFacetAddress = await liquidityROIFacet.getAddress();
  console.log(`  HordexROIFacet: ${roiFacetAddress}`);

  const Hordex = await hre.ethers.getContractFactory("Hordex", {
    signer: deployer,
    libraries: { HordexMath: libAddress },
  });
  const liquidity = await Hordex.deploy(
    routerAddress, factoryAddress, DEPLOYED_USDT, PLATFORM_TOKEN,
    facetAddress, roiFacetAddress, DEPLOY_OVERRIDES
  );
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  const deployReceipt = await liquidity.deploymentTransaction().wait();
  const deployBlock   = deployReceipt.blockNumber;
  console.log(`  Hordex        : ${liquidityAddress}  (block ${deployBlock})`);

  const artifact = hre.artifacts.readArtifactSync("Hordex");
  const liq      = new hre.ethers.Contract(liquidityAddress, artifact.abi, deployer);

  const viewFacetAddress = await deployAndWireViewFacet(hre, {
    deployer, liquidity, factory: factoryAddress, weth: DEPLOYED_USDT, token: PLATFORM_TOKEN,
    mathAddr: libAddress, viewLibAddr: libViewAddress, overrides: DEPLOY_OVERRIDES, mine,
  });
  console.log(`  HordexViewFacet: ${viewFacetAddress}  (wired via setViewFacet)`);
  const mergedAbi = mergedLiquidityAbi(hre);

  // ── PHASE 2: Write contract-config.js ─────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 2 — WRITE CONFIG"); console.log(sep());
  const configContent =
`// AUTO-GENERATED by scripts/amoytestnet/binary.js
// Network: ${network} | Deployed: ${new Date().toLocaleString()}

const CONTRACT_ADDRESS        = "${liquidityAddress}";
const TOKEN_ADDRESS           = "${PLATFORM_TOKEN}";
const TOKEN_ADDRESS_JIGGY     = "";
const TOKEN_ADDRESS_PANWORLD  = "";
const ROUTER_ADDRESS          = "${routerAddress}";
const FACTORY_ADDRESS         = "${factoryAddress}";
const WETH_ADDRESS            = "${DEPLOYED_USDT}";
const USDT_ADDRESS            = "${DEPLOYED_USDT}";
const DEPLOY_BLOCK            = ${deployBlock};
const FACET_ADDRESS           = "${facetAddress}";
const ROI_FACET_ADDRESS       = "${roiFacetAddress}";

const VIEW_FACET_ADDRESS      = "${viewFacetAddress}";

const CONTRACT_ABI = ${JSON.stringify(mergedAbi, null, 2)};
`;
  const root = path.join(__dirname, "..", "..");
  fs.writeFileSync(path.join(root, "contract-config.js"), configContent);
  fs.writeFileSync(path.join(root, "frontend", "contract-config.js"), configContent);
  const htmlPath = path.join(root, "frontend", "index.html");
  if (fs.existsSync(htmlPath)) {
    fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, "utf8")
      .replace(/contract-config\.js\?v=\d+/g, `contract-config.js?v=${Date.now()}`));
  }
  console.log("  contract-config.js written ✓  (root + frontend)");

  const outputPath = path.join(__dirname, "deploy-output.json");
  fs.writeFileSync(outputPath, JSON.stringify({
    network,
    deployedAt:      new Date().toISOString(),
    deployBlock,
    usdtAddress:     DEPLOYED_USDT,
    tokenAddress:    PLATFORM_TOKEN,
    routerAddress,
    factoryAddress,
    liquidityAddress,
    facetAddress,
    roiFacetAddress,
    libAddress,
    libViewAddress,
  }, null, 2));
  console.log("  deploy-output.json written ✓");

  // ── PHASE 3: Token setup ───────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 3 — TOKEN SETUP"); console.log(sep());

  await mine(() => hdxCt.transfer(liquidityAddress, HDX_TO_LIQUIDITY, TX_OVERRIDES));
  console.log(`  ${hre.ethers.formatEther(HDX_TO_LIQUIDITY)} HDX → Hordex ✓`);

  await mine(() => liq.addToken(PLATFORM_TOKEN, "Hordex Token", "HDX", TX_OVERRIDES));
  console.log(`  HDX token registered ✓`);

  // Drain any existing deployer LP so pool reseeds at a clean 1:1 price
  {
    const _factoryCt = new hre.ethers.Contract(
      factoryAddress,
      ["function getPair(address,address) view returns (address)"],
      deployer
    );
    const _pairAddr = await _factoryCt.getPair(PLATFORM_TOKEN, DEPLOYED_USDT);
    if (_pairAddr !== hre.ethers.ZeroAddress) {
      const _pairCt = new hre.ethers.Contract(
        _pairAddr,
        [
          "function balanceOf(address) view returns (uint256)",
          "function approve(address,uint256) returns (bool)",
        ],
        deployer
      );
      const _lpBal = await _pairCt.balanceOf(deployer.address);
      if (_lpBal > 0n) {
        console.log(`  Existing pair found — draining deployer LP (${hre.ethers.formatEther(_lpBal)} LP)…`);
        await mine(() => _pairCt.approve(routerAddress, _lpBal, TX_OVERRIDES));
        const _routerCt = new hre.ethers.Contract(
          routerAddress,
          ["function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)"],
          deployer
        );
        await mine(() => _routerCt.removeLiquidity(
          PLATFORM_TOKEN, DEPLOYED_USDT, _lpBal, 0, 0,
          deployer.address,
          BigInt(Math.floor(Date.now() / 1000) + 300),
          TX_OVERRIDES
        ));
        console.log(`  Existing LP drained → pair reset to ~0 reserves ✓`);
      } else {
        console.log(`  Pair exists but deployer holds no LP — skipping drain`);
      }
    } else {
      console.log(`  No existing pair — fresh creation`);
    }
  }

  await mine(() => usdtCt.transfer(liquidityAddress, SEED_USDT, TX_OVERRIDES));
  console.log(`  ${hre.ethers.formatEther(SEED_USDT)} USDT → Hordex ✓`);

  await mine(() => liq.seedPool(PLATFORM_TOKEN, SEED_TOKENS, SEED_USDT, TX_OVERRIDES));
  console.log(`  Pool seeded: 1 HDX + 1 USDT  →  1 HDX = 1 USDT ✓`);

  // ── PHASE 4: TWAP warm-up ─────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 4 — TWAP WARM-UP"); console.log(sep());
  const obs0Receipt = await mine(() => liq.updateTWAP(TX_OVERRIDES));
  const obs0Block   = await provider.getBlock(obs0Receipt.blockNumber);
  console.log(`  Observation 0  (block ${obs0Receipt.blockNumber}) ✓`);
  console.log(`  Waiting ${TWAP_WAIT_SECS}s for second observation…`);
  await waitForTwap(provider, obs0Block.timestamp);
  await mine(() => liq.updateTWAP(TX_OVERRIDES));
  console.log("  Observation 1 ✓  —  TWAP ready");

  // ── PHASE 5: Register acc[1..511] in BFS order ────────────────────────────
  // Parent of acc[i] = acc[floor(i/2)], so iterating i=1..511 guarantees
  // every parent is registered before its children.
  console.log("\n" + sep()); console.log("  PHASE 5 — REGISTER 511 ACCOUNTS (binary tree)"); console.log(sep());
  for (let i = 1; i <= TREE_SIZE; i++) {
    const parentIdx = Math.floor(i / 2);
    const child     = signers[i];
    const parent    = signers[parentIdx];
    const usdtN = new hre.ethers.Contract(DEPLOYED_USDT, TOKEN_ABI, child);
    await mine(() => usdtN.approve(liquidityAddress, REGISTRATION_FEE, TX_OVERRIDES));
    const liqN  = new hre.ethers.Contract(liquidityAddress, artifact.abi, child);
    await mine(() => liqN.register(parent.address, TX_OVERRIDES));
    const lvl = treeLevel(i);
    if (i % 50 === 0 || lvl <= 3) {
      console.log(`  acc[${String(i).padStart(3)}] registered under acc[${String(parentIdx).padStart(3)}]  (level ${lvl}) ✓`);
    }
  }
  console.log(`  All 511 accounts registered ✓`);

  // ── PHASE 6: Invest ───────────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 6 — INVEST"); console.log(sep());
  for (let i = 1; i <= TREE_SIZE; i++) {
    const lvl    = treeLevel(i);
    const amount = INVEST_BY_LEVEL[lvl];
    const usdtN  = new hre.ethers.Contract(DEPLOYED_USDT, TOKEN_ABI, signers[i]);
    await mine(() => usdtN.approve(liquidityAddress, amount, TX_OVERRIDES));
    const liqN   = new hre.ethers.Contract(liquidityAddress, artifact.abi, signers[i]);
    await mine(() => liqN.invest(PLATFORM_TOKEN, amount, TX_OVERRIDES));
    if (i % 50 === 0 || lvl <= 3) {
      console.log(`  acc[${String(i).padStart(3)}] invested $${hre.ethers.formatEther(amount)}  (level ${lvl}) ✓`);
    }
  }
  console.log(`  All 511 accounts invested ✓`);

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log("\n" + sep("═"));
  console.log("  DONE");
  console.log(sep("═"));
  console.log(`  Hordex      : ${liquidityAddress}`);
  console.log(`  HDX token   : ${PLATFORM_TOKEN}`);
  console.log(`  Deploy block: ${deployBlock}`);
  console.log(`  TWAP        : ready`);
  console.log(`  Tree        : 511 accounts, 9 levels (acc[1..511])`);
  console.log(`  Invested    : $25k→L0 · $10k→L1 · $5k→L2 · $2.5k→L3 · $1k→L4 · $500→L5 · $250→L6 · $100→L7/L8`);
  console.log(sep("═") + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
