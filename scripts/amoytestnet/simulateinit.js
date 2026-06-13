// Deploy Liquidity contracts (same as inithdx.js phases 1-4), then register
// 57 accounts in the full referral tree, then invest from each account.
// Sub-wallets must already be funded with POL + USDT by amoynode.js.
//
// Tree:
//   acc[0]  → acc[1]
//   acc[1]  → acc[2..11]    (10 members, spine → acc[2])
//   acc[2]  → acc[12..20]   ( 9 members, spine → acc[12])
//   acc[12] → acc[21..28]   ( 8 members, spine → acc[21])
//   acc[21] → acc[29..35]   ( 7 members, spine → acc[29])
//   acc[29] → acc[36..41]   ( 6 members, spine → acc[36])
//   acc[36] → acc[42..46]   ( 5 members, spine → acc[42])
//   acc[42] → acc[47..50]   ( 4 members, spine → acc[47])
//   acc[47] → acc[51..53]   ( 3 members, spine → acc[51])
//   acc[51] → acc[54..55]   ( 2 members, spine → acc[54])
//   acc[54] → acc[56]       ( 1 member,  leaf)
//
// Funding after registration (acc[1], acc[2], acc[3], ... acc[56] in order):
//   Main leg acc[1,2,12,21,29,36,42,47,51,54,56]: 100 USDT each
//   All others:                                     25 USDT each
//
// USAGE:
//   npx hardhat run scripts/amoytestnet/simulateinit.js --network polygonAmoy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Config ─────────────────────────────────────────────────────────────────────
const UNI_ROUTER     = "0x85eaBB2740eD2f9e3b53c51D8e1E7BdA53672825";
const UNI_FACTORY    = "0xa5d020Eb5a4D537f56F7314d2359f7770DE01a48";
const DEPLOYED_USDT  = "0xcDC1119387AE7cE0cDb2A84CB8be2D6C8F0F5CB9";
const PLATFORM_TOKEN = "0x39544CBb2aB89E64aD74c731Ee690D2923bB209f";

const HDX_TO_LIQUIDITY = hre.ethers.parseEther("10000000"); // 10 M HDX
const SEED_USDT        = hre.ethers.parseEther("1");        // 1 USDT
const SEED_TOKENS      = hre.ethers.parseEther("1");        // 1 HDX → price = 1 USDT
const REGISTRATION_FEE = hre.ethers.parseEther("1");        // 1 USDT legitimacy fee per account
const TWAP_WAIT_SECS   = 31;

const FUND_MAIN_LEG  = hre.ethers.parseEther("100"); // 100 USDT for main-leg accounts
const FUND_OTHER     = hre.ethers.parseEther("250"); // 250 USDT for all other accounts

const TOTAL_ACCOUNTS = 57; // acc[0] to acc[56]

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

// ── Helpers ────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sep(c = "─", n = 64) { return c.repeat(n); }

function deriveWallets(rawKey, provider, count = TOTAL_ACCOUNTS) {
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
      process.stdout.write(
        `\r  TWAP warm-up: ${String(Math.floor(rem / 60)).padStart(2, "0")}:${String(rem % 60).padStart(2, "0")} remaining…`
      );
    } catch (_) {}
    await sleep(2000);
  }
  process.stdout.write("\r  TWAP warm-up: complete!                             \n");
}

// ── Build referral tree ────────────────────────────────────────────────────────
// Returns:
//   groups    – [{referrer, children}] in registration order
//   mainLegSet – Set of account indices on the spine (not including acc[0])
function buildTree() {
  const groups     = [];
  const mainLegSet = new Set();

  // acc[0] → acc[1]
  groups.push({ referrer: 0, children: [1] });
  mainLegSet.add(1);

  let spineNode = 1;
  let next      = 2;
  for (let depth = 0; depth < 10; depth++) {
    const count    = 10 - depth; // 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
    const children = [];
    for (let k = 0; k < count; k++) children.push(next++);
    groups.push({ referrer: spineNode, children });
    mainLegSet.add(children[0]); // first child continues the spine
    spineNode = children[0];
  }

  return { groups, mainLegSet };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env"); process.exit(1);
  }

  const provider = hre.ethers.provider;
  const signers  = deriveWallets(rawKey, provider);
  const deployer = signers[0];
  const network  = hre.network.name;

  const { groups, mainLegSet } = buildTree();
  const mainLegList  = [...mainLegSet].sort((a, b) => a - b);
  const mainLegCount = mainLegSet.size;          // 11
  const otherCount   = TOTAL_ACCOUNTS - 1 - mainLegCount; // 45

  console.log(sep("═"));
  console.log("  SIMULATEINIT — Deploy · Seed · TWAP · Register · Fund");
  console.log(sep("═"));
  console.log(`  Network  : ${network}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  HDX      : ${PLATFORM_TOKEN}`);
  console.log(`  USDT     : ${DEPLOYED_USDT}`);
  console.log(`  Accounts : ${TOTAL_ACCOUNTS} (acc[0..${TOTAL_ACCOUNTS - 1}])\n`);

  console.log(`  Referral tree:`);
  for (const g of groups) {
    const first = g.children[0], last = g.children[g.children.length - 1];
    const range = g.children.length === 1
      ? `acc[${String(first).padStart(2)}]`
      : `acc[${String(first).padStart(2)}..${String(last).padStart(2)}]`;
    console.log(`    acc[${String(g.referrer).padStart(2)}]  →  ${range}  (${g.children.length})`);
  }
  console.log(`\n  Main leg : ${mainLegList.map(i => `acc[${i}]`).join(", ")}  → 100 USDT`);
  console.log(`  Others   : ${otherCount} accounts  → 25 USDT each\n`);

  // ── Balance checks ──────────────────────────────────────────────────────────
  const deployerBal = await provider.getBalance(deployer.address);
  console.log(`  POL balance  : ${hre.ethers.formatEther(deployerBal)} POL`);
  if (deployerBal < hre.ethers.parseEther("3")) {
    console.error("❌  deployer needs ≥ 3 POL for gas"); process.exit(1);
  }

  const hdxCt  = new hre.ethers.Contract(PLATFORM_TOKEN, TOKEN_ABI, deployer);
  const usdtCt = new hre.ethers.Contract(DEPLOYED_USDT, TOKEN_ABI, deployer);

  const hdxBal  = await hdxCt.balanceOf(deployer.address);
  const usdtBal = await usdtCt.balanceOf(deployer.address);
  console.log(`  HDX balance  : ${hre.ethers.formatEther(hdxBal)} HDX`);
  console.log(`  USDT balance : ${hre.ethers.formatEther(usdtBal)} USDT\n`);

  if (hdxBal < HDX_TO_LIQUIDITY) {
    console.error(`❌  deployer needs ≥ 10,000,000 HDX (has ${hre.ethers.formatEther(hdxBal)})`); process.exit(1);
  }

  // Deployer only needs 1 USDT for pool seed; all accounts invest from their own balance
  if (usdtBal < SEED_USDT) {
    console.error(`❌  deployer needs ≥ 1 USDT for pool seed (has ${hre.ethers.formatEther(usdtBal)})`); process.exit(1);
  }

  // ── PHASE 1: Deploy contracts ──────────────────────────────────────────────
  console.log(sep()); console.log("  PHASE 1 — DEPLOY CONTRACTS"); console.log(sep());

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
    UNI_ROUTER, UNI_FACTORY, DEPLOYED_USDT, PLATFORM_TOKEN, DEPLOY_OVERRIDES
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
    UNI_ROUTER, UNI_FACTORY, DEPLOYED_USDT, PLATFORM_TOKEN,
    facetAddress, roiFacetAddress, DEPLOY_OVERRIDES
  );
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  const deployReceipt    = await liquidity.deploymentTransaction().wait();
  const deployBlock      = deployReceipt.blockNumber;
  console.log(`  Liquidity        : ${liquidityAddress}  (block ${deployBlock})`);

  const artifact = hre.artifacts.readArtifactSync("Liquidity");
  const liq      = new hre.ethers.Contract(liquidityAddress, artifact.abi, deployer);

  // ── PHASE 2: Write contract-config.js ─────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 2 — WRITE CONFIG"); console.log(sep());
  const configContent =
`// AUTO-GENERATED by scripts/amoytestnet/simulateinit.js
// Network: ${network} | Deployed: ${new Date().toLocaleString()}

const CONTRACT_ADDRESS        = "${liquidityAddress}";
const TOKEN_ADDRESS           = "${PLATFORM_TOKEN}";
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
  console.log(`  ${hre.ethers.formatEther(HDX_TO_LIQUIDITY)} HDX → Liquidity ✓`);

  await mine(() => liq.addToken(PLATFORM_TOKEN, "Hordex Token", "HDX", TX_OVERRIDES));
  console.log(`  HDX token registered ✓`);

  // Drain existing deployer LP so the seed below always establishes a clean 1:1 price
  {
    const _factoryCt = new hre.ethers.Contract(
      UNI_FACTORY,
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
        await mine(() => _pairCt.approve(UNI_ROUTER, _lpBal, TX_OVERRIDES));
        const _routerCt = new hre.ethers.Contract(
          UNI_ROUTER,
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
  console.log(`  ${hre.ethers.formatEther(SEED_USDT)} USDT → Liquidity ✓`);

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

  // ── PHASE 5: Register accounts ────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 5 — REGISTER ACCOUNTS"); console.log(sep());
  console.log(`  (each account approves 1 USDT legitimacy fee before registering)\n`);

  for (const g of groups) {
    const referrerAddr = signers[g.referrer].address;
    const first        = g.children[0];
    const last         = g.children[g.children.length - 1];
    const range        = g.children.length === 1
      ? `acc[${String(first).padStart(2)}]`
      : `acc[${String(first).padStart(2)}..${String(last).padStart(2)}]`;
    console.log(`  Registering ${range} under acc[${String(g.referrer).padStart(2)}]:`);

    for (const idx of g.children) {
      const usdtN = new hre.ethers.Contract(DEPLOYED_USDT, TOKEN_ABI, signers[idx]);
      await mine(() => usdtN.approve(liquidityAddress, REGISTRATION_FEE, TX_OVERRIDES));
      console.log(`    acc[${String(idx).padStart(2)}]  approved 1 USDT ✓`);

      const liqN = new hre.ethers.Contract(liquidityAddress, artifact.abi, signers[idx]);
      await mine(() => liqN.register(referrerAddr, TX_OVERRIDES));
      console.log(`    acc[${String(idx).padStart(2)}]  registered under acc[${String(g.referrer).padStart(2)}] ✓`);
    }
  }

  // ── PHASE 6: Invest (sequential: acc[1], acc[2], … acc[56]) ─────────────
  console.log("\n" + sep()); console.log("  PHASE 6 — INVEST"); console.log(sep());
  console.log(`  Main leg : ${mainLegList.map(i => `acc[${i}]`).join(", ")}  → 100 USDT each`);
  console.log(`  Others   : 250 USDT each\n`);

  for (let i = 1; i < TOTAL_ACCOUNTS; i++) {
    const isMainLeg = mainLegSet.has(i);
    const amount    = isMainLeg ? FUND_MAIN_LEG : FUND_OTHER;
    const tag       = isMainLeg ? "100 USDT  [main leg]" : "250 USDT";

    await mine(() => usdtCt.connect(signers[i]).approve(liquidityAddress, amount, TX_OVERRIDES));
    console.log(`  acc[${String(i).padStart(2)}]  approved ${tag} ✓`);

    await mine(() => liq.connect(signers[i]).invest(PLATFORM_TOKEN, amount, TX_OVERRIDES));
    console.log(`  acc[${String(i).padStart(2)}]  invested  ${tag} ✓`);
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log("\n" + sep("═"));
  console.log("  DONE");
  console.log(sep("═"));
  console.log(`  Liquidity    : ${liquidityAddress}`);
  console.log(`  HDX token    : ${PLATFORM_TOKEN}`);
  console.log(`  Deploy block : ${deployBlock}`);
  console.log(`  TWAP         : ready`);
  console.log(`  Registered   : ${TOTAL_ACCOUNTS} accounts (acc[0..${TOTAL_ACCOUNTS - 1}])`);
  console.log(`  Main leg     : ${mainLegList.map(i => `acc[${i}]`).join(", ")}  (invested 100 USDT each)`);
  console.log(`  Others       : invested 250 USDT each`);
  console.log(sep("═") + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
