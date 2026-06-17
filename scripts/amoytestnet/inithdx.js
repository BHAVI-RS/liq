// Deploy Hordex contracts (incl. a fresh Uniswap V2 factory + router) using the
// pre-deployed HDX token, seed the pool, warm up TWAP, register the referral tree,
// then invest from each account.
//
// Referral tree + investments ($250 → acc[1,2,5,7] · $25 → acc[3,4,6] · acc[0] none):
//   acc[0]  (deployer, auto-registered as owner)
//   └─ acc[1]                 $250
//      ├─ acc[2]              $250
//      │  ├─ acc[5]           $250
//      │  │  └─ acc[7]        $250
//      │  └─ acc[6]           $25
//      ├─ acc[3]              $25
//      └─ acc[4]              $25
//
// USAGE:
//   npx hardhat run scripts/amoytestnet/inithdx.js --network polygonAmoy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { deployAndWireViewFacet, mergedLiquidityAbi } = require("./_viewfacet");
const { verifyAllContracts } = require("./_verify");

// ── Config ────────────────────────────────────────────────────────────────────
// Uniswap V2 Factory + Router are deployed FRESH each run (see PHASE 1) from
// contracts/uniswapamoy, so the script no longer depends on a one-time external DEX.
const DEPLOYED_USDT        = "0xcDC1119387AE7cE0cDb2A84CB8be2D6C8F0F5CB9";
const PLATFORM_TOKEN       = "0x39544CBb2aB89E64aD74c731Ee690D2923bB209f";

const HDX_TO_LIQUIDITY     = hre.ethers.parseEther("10000000"); // 10 M HDX
const SEED_USDT            = hre.ethers.parseEther("1");        // 1 USDT
const SEED_TOKENS          = hre.ethers.parseEther("1");        // 1 HDX  → price = 1 USDT
const REGISTRATION_FEE     = hre.ethers.parseEther("1");        // 1 USDT legitimacy check per account
const TWAP_WAIT_SECS       = 31;       // must exceed TWAP_PERIOD (30 s) so the 2nd obs lands

const FUND_AMOUNT    = hre.ethers.parseEther("0.5");  // POL for gas (register + invest)
const FUND_THRESHOLD = hre.ethers.parseEther("0.4");

// Referral tree (referrer index → child indices):
//   acc[0] → acc[1] | acc[1] → acc[2,3,4] | acc[2] → acc[5,6] | acc[5] → acc[7]
const REFERRAL_TREE = [
  { referrer: 0, children: [1] },
  { referrer: 1, children: [2, 3, 4] },
  { referrer: 2, children: [5, 6] },
  { referrer: 5, children: [7] },
];
// USDT each account invests after registering (acc[0] invests nothing).
const INVEST_USDT = {
  1: hre.ethers.parseEther("250"),
  2: hre.ethers.parseEther("250"),
  3: hre.ethers.parseEther("25"),
  4: hre.ethers.parseEther("25"),
  5: hre.ethers.parseEther("250"),
  6: hre.ethers.parseEther("25"),
  7: hre.ethers.parseEther("250"),
};
const TOTAL_ACCOUNTS = 8; // acc[0..7]

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

function deriveWallets(rawKey, provider, count = 5) {
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
  const signers  = deriveWallets(rawKey, provider, TOTAL_ACCOUNTS);
  const deployer = signers[0];
  const network  = hre.network.name;

  console.log(sep("═"));
  console.log("  INITHDX — Deploy · Seed · TWAP · Register");
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
  const usdtCt = new hre.ethers.Contract(DEPLOYED_USDT, TOKEN_ABI, deployer);

  const hdxBal  = await hdxCt.balanceOf(deployer.address);
  const usdtBal = await usdtCt.balanceOf(deployer.address);
  console.log(`  HDX balance : ${hre.ethers.formatEther(hdxBal)} HDX`);
  console.log(`  USDT balance: ${hre.ethers.formatEther(usdtBal)} USDT\n`);
  if (hdxBal < HDX_TO_LIQUIDITY) {
    console.error(`❌  deployer needs ≥ 10,000,000 HDX (has ${hre.ethers.formatEther(hdxBal)})`); process.exit(1);
  }
  // Deployer must cover: pool seed + (1 USDT registration fee + invest amount) for every account.
  let _totalInvest = 0n;
  for (const k of Object.keys(INVEST_USDT)) _totalInvest += INVEST_USDT[k];
  const MIN_USDT = SEED_USDT
    + REGISTRATION_FEE * BigInt(Object.keys(INVEST_USDT).length)
    + _totalInvest;
  if (usdtBal < MIN_USDT) {
    console.error(`❌  deployer needs ≥ ${hre.ethers.formatEther(MIN_USDT)} USDT (has ${hre.ethers.formatEther(usdtBal)})`); process.exit(1);
  }

  // ── PHASE 1: Deploy contracts ──────────────────────────────────────────────
  console.log(sep()); console.log("  PHASE 1 — DEPLOY CONTRACTS"); console.log(sep());

  // Deploy a fresh Uniswap V2 Factory + Router (from contracts/uniswapamoy) so each
  // run is fully self-contained. The router carries the init-code hash matching this
  // repo's UniswapV2Pair, so pairs created by this factory resolve correctly.
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

  // ── View facet (holds the moved getters + batch views; reached via fallback) ──
  const viewFacetAddress = await deployAndWireViewFacet(hre, {
    deployer, liquidity, factory: factoryAddress, weth: DEPLOYED_USDT, token: PLATFORM_TOKEN,
    mathAddr: libAddress, viewLibAddr: libViewAddress, overrides: DEPLOY_OVERRIDES, mine,
  });
  console.log(`  HordexViewFacet: ${viewFacetAddress}  (wired via setViewFacet)`);
  const mergedAbi = mergedLiquidityAbi(hre);

  // ── PHASE 2: Write contract-config.js ─────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 2 — WRITE CONFIG"); console.log(sep());
  const configContent =
`// AUTO-GENERATED by scripts/amoytestnet/inithdx.js
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

  // ── Also update deploy-output.json ───────────────────────────────────────
  const outputPath = path.join(__dirname, "deploy-output.json");
  const outputData = {
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
  };
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log("  deploy-output.json written ✓");

  // ── PHASE 2b: Verify source on PolygonScan ─────────────────────────────────
  // Runs right after deploy so contracts are verified even if a later phase fails.
  // No-ops (with a notice) when ETHERSCAN_API_KEY is unset; never aborts the deploy.
  console.log("\n" + sep()); console.log("  PHASE 2b — VERIFY ON POLYGONSCAN"); console.log(sep());
  await verifyAllContracts(hre, {
    router: routerAddress, factory: factoryAddress, usdt: DEPLOYED_USDT, token: PLATFORM_TOKEN,
    liquidity: liquidityAddress, facet: facetAddress, roiFacet: roiFacetAddress,
    lib: libAddress, libView: libViewAddress, viewFacet: viewFacetAddress,
  });

  // ── PHASE 3: Token setup ───────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 3 — TOKEN SETUP"); console.log(sep());

  // Send 10,000,000 HDX to Hordex
  await mine(() => hdxCt.transfer(liquidityAddress, HDX_TO_LIQUIDITY, TX_OVERRIDES));
  console.log(`  ${hre.ethers.formatEther(HDX_TO_LIQUIDITY)} HDX → Hordex ✓`);

  // Register HDX token
  await mine(() => liq.addToken(PLATFORM_TOKEN, "Hordex Token", "HDX", TX_OVERRIDES));
  console.log(`  HDX token registered ✓`);

  // ── Drain existing deployer LP so re-init always seeds at the desired price ──
  // The HDX/USDT pair is a persistent on-chain Uniswap pool.  On the first init it
  // doesn't exist yet and is created at 1:1.  On subsequent inits the pair already
  // exists at whatever price the previous session left it, so addLiquidity silently
  // preserves that ratio.  Removing the deployer's LP tokens first collapses the
  // reserves to ~0 so the seed below can establish a clean 1:1 price.
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

  // Send 1 USDT to Hordex for pool seed
  await mine(() => usdtCt.transfer(liquidityAddress, SEED_USDT, TX_OVERRIDES));
  console.log(`  ${hre.ethers.formatEther(SEED_USDT)} USDT → Hordex ✓`);

  // Seed pool: 1 HDX + 1 USDT → price = 1 USDT per HDX
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

  // ── PHASE 5: Fund sub-wallets [1..7] (POL gas + USDT: 1 fee + invest amount) ─
  console.log("\n" + sep()); console.log("  PHASE 5 — FUND SUB-WALLETS [1..7]"); console.log(sep());
  for (let i = 1; i < TOTAL_ACCOUNTS; i++) {
    // POL for gas (registration + investment)
    const bal = await provider.getBalance(signers[i].address);
    if (bal < FUND_THRESHOLD) {
      await mine(() => deployer.sendTransaction({
        to: signers[i].address,
        value: FUND_AMOUNT,
        maxFeePerGas:         TX_OVERRIDES.maxFeePerGas,
        maxPriorityFeePerGas: TX_OVERRIDES.maxPriorityFeePerGas,
      }));
      console.log(`  acc[${i}]  ${signers[i].address}  →  sent ${hre.ethers.formatEther(FUND_AMOUNT)} POL ✓`);
    } else {
      console.log(`  acc[${i}]  ${signers[i].address}  →  ${hre.ethers.formatEther(bal)} POL (sufficient, skipped)`);
    }
    // USDT: 1 registration fee + this account's invest amount
    const needUsdt   = REGISTRATION_FEE + (INVEST_USDT[i] || 0n);
    const usdtBalSub = await usdtCt.balanceOf(signers[i].address);
    if (usdtBalSub < needUsdt) {
      const topUp = needUsdt - usdtBalSub;
      await mine(() => usdtCt.transfer(signers[i].address, topUp, TX_OVERRIDES));
      console.log(`  acc[${i}]  →  sent ${hre.ethers.formatEther(topUp)} USDT (fee + invest) ✓`);
    } else {
      console.log(`  acc[${i}]  →  already has ≥ ${hre.ethers.formatEther(needUsdt)} USDT (skipped)`);
    }
  }

  // ── PHASE 6: Register accounts per the referral tree ───────────────────────
  console.log("\n" + sep()); console.log("  PHASE 6 — REGISTER ACCOUNTS"); console.log(sep());
  console.log(`  (each account approves 1 USDT legitimacy fee before registering)`);
  for (const { referrer, children } of REFERRAL_TREE) {
    for (const i of children) {
      const usdtN = new hre.ethers.Contract(DEPLOYED_USDT, TOKEN_ABI, signers[i]);
      await mine(() => usdtN.approve(liquidityAddress, REGISTRATION_FEE, TX_OVERRIDES));
      const liqN = new hre.ethers.Contract(liquidityAddress, artifact.abi, signers[i]);
      await mine(() => liqN.register(signers[referrer].address, TX_OVERRIDES));
      console.log(`  acc[${i}] registered under acc[${referrer}] ✓`);
    }
  }

  // ── PHASE 7: Invest ($250 → acc[1,2,5,7] · $25 → acc[3,4,6] · acc[0] none) ──
  console.log("\n" + sep()); console.log("  PHASE 7 — INVEST"); console.log(sep());
  for (let i = 1; i < TOTAL_ACCOUNTS; i++) {
    const amount = INVEST_USDT[i] || 0n;
    if (amount === 0n) { console.log(`  acc[${i}] — no investment (skipped)`); continue; }
    const usdtN = new hre.ethers.Contract(DEPLOYED_USDT, TOKEN_ABI, signers[i]);
    await mine(() => usdtN.approve(liquidityAddress, amount, TX_OVERRIDES));
    const liqN = new hre.ethers.Contract(liquidityAddress, artifact.abi, signers[i]);
    await mine(() => liqN.invest(PLATFORM_TOKEN, amount, TX_OVERRIDES));
    console.log(`  acc[${i}] invested ${hre.ethers.formatEther(amount)} USDT ✓`);
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log("\n" + sep("═"));
  console.log("  DONE");
  console.log(sep("═"));
  console.log(`  Hordex   : ${liquidityAddress}`);
  console.log(`  HDX token   : ${PLATFORM_TOKEN}`);
  console.log(`  Deploy block: ${deployBlock}`);
  console.log(`  TWAP        : ready`);
  console.log(`  Tree        : acc[1]→acc[0], acc[2/3/4]→acc[1], acc[5/6]→acc[2], acc[7]→acc[5]`);
  console.log(`  Invested    : $250 → acc[1,2,5,7] · $25 → acc[3,4,6] · acc[0] none`);
  console.log(sep("═") + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
