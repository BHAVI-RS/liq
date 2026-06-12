// Deploy Hordex platform contracts to Polygon Amoy — platform token only, up to TWAP warm-up,
// builds the same 32-account referral tree used by hfsroi.js, then invests $100 for [0..16].
//
// What this script does:
//   1. Derives 32 wallets from PRIVATE_KEY (same derivation as amoynode.js)
//   2. Funds sub-wallets [1..16] with 0.5 POL each, [17..31] with 0.2 POL each (if needed)
//   3. Deploys HordexToken (platform token)
//   4. Deploys LiquidityMath + LiquidityViewLib libraries
//   5. Deploys LiquidityFacet, LiquidityROIFacet, and Liquidity (main contract)
//   6. Transfers full token supply to Liquidity contract
//   7. Registers the platform token and seeds its Uniswap V2 pool
//   8. TWAP warm-up: two observations ≥ 31 s apart
//   9. Registers accounts [1..31] with the hfsroi.js referral tree
//  10. Invests 0.1 MATIC ($100) for each of accounts [0..16] in BFS order
//  11. Writes contract-config.js to both root and frontend/
//
// Referral tree (5-4-3-2-1 pattern, 2 cycles):
//   account[0]   →  [1]
//   -- cycle 1 --
//   account[1]   →  [2, 3, 4, 5, 6]
//   account[2]   →  [7, 8, 9, 10]
//   account[7]   →  [11, 12, 13]
//   account[11]  →  [14, 15]
//   account[14]  →  [16]
//   -- cycle 2 --
//   account[16]  →  [17, 18, 19, 20, 21]
//   account[17]  →  [22, 23, 24, 25]
//   account[22]  →  [26, 27, 28]
//   account[26]  →  [29, 30]
//   account[29]  →  [31]
//
// RUN:
//   npx hardhat run scripts/amoytestnet/deployamoy.js --network polygonAmoy
//
// REQUIREMENTS:
//   account[0] (PRIVATE_KEY in .env) needs ≥ 125 POL
//     (100 MATIC pool seed + 8 POL for [1..16] + 3 POL for [17..31] + gas).

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Uniswap V2 on Polygon Amoy ────────────────────────────────────────────────
const UNI_ROUTER  = "0x85eaBB2740eD2f9e3b53c51D8e1E7BdA53672825";
const UNI_FACTORY = "0xa5d020Eb5a4D537f56F7314d2359f7770DE01a48";
// UNI_WETH is no longer used — USDT is the pool base token instead.

// ── USDT — already deployed; used as the pool base token (replaces WETH) ─────
const DEPLOYED_USDT = "0xcDC1119387AE7cE0cDb2A84CB8be2D6C8F0F5CB9";

// ── Platform token config ─────────────────────────────────────────────────────
const TOKEN_NAME   = "Hordex Token";
const TOKEN_SYMBOL = "HORDEX";
const TOKEN_SUPPLY = 10_000_000;   // 10 million tokens

// ── Pool seed: 100,000 USDT + 100,000 HORDEX → 1 HORDEX = 1 USDT = $1.00 ───
const SEED_USDT   = hre.ethers.parseEther("100000");
const SEED_TOKENS = hre.ethers.parseEther("100000");

// ── TWAP: wait at least this long between obs0 and obs1 ───────────────────────
// 31 seconds for testnet. For mainnet change to 31 * 60 (31 minutes).
const TWAP_WAIT_SECS = 31;

// ── Investment config ─────────────────────────────────────────────────────────
const PACKAGE_USDT = hre.ethers.parseEther("100");  // 100 USDT = $100 per invest()
const INVEST_UP_TO = 16;                             // accounts [0..16] invest

// ── Sub-wallet funding ────────────────────────────────────────────────────────
const TOTAL_WALLETS  = 32;
// POL for gas only — investments are now paid in USDT.
const FUND_INVESTOR  = hre.ethers.parseEther("0.05");   // POL gas for invest+register wallets
const FUND_REG_ONLY  = hre.ethers.parseEther("0.02");   // POL gas for register-only wallets
const THRESH_INVESTOR = hre.ethers.parseEther("0.04");
const THRESH_REG_ONLY = hre.ethers.parseEther("0.005");
// USDT per investing wallet: PACKAGE_USDT + 10% buffer for LP ratio tolerance
const FUND_INVESTOR_USDT = hre.ethers.parseEther("110");  // 110 USDT per investing wallet

// ── Referral tree (identical to hfsroi.js) ────────────────────────────────────
const groups = [
  { referrer: 0,  children: [1]                  },
  // cycle 1
  { referrer: 1,  children: [2, 3, 4, 5, 6]      },
  { referrer: 2,  children: [7, 8, 9, 10]         },
  { referrer: 7,  children: [11, 12, 13]          },
  { referrer: 11, children: [14, 15]              },
  { referrer: 14, children: [16]                  },
  // cycle 2
  { referrer: 16, children: [17, 18, 19, 20, 21] },
  { referrer: 17, children: [22, 23, 24, 25]      },
  { referrer: 22, children: [26, 27, 28]          },
  { referrer: 26, children: [29, 30]              },
  { referrer: 29, children: [31]                  },
];

// ── Gas overrides (max 0.9 POL per tx — within Amoy RPC fee cap of 1 POL) ────
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
function sep(c = "─", n = 60) { return c.repeat(n); }

// Same derivation as amoynode.js — always produces identical addresses
function deriveWallets(rawKey, provider) {
  const pk = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
  const wallets = [new hre.ethers.Wallet(pk, provider)];
  for (let i = 1; i < TOTAL_WALLETS; i++) {
    const derived = hre.ethers.keccak256(
      hre.ethers.solidityPacked(["bytes32", "uint256"], [pk, i])
    );
    wallets.push(new hre.ethers.Wallet(derived, provider));
  }
  return wallets;
}

function isTransient(e) {
  return e.code === "ECONNRESET"      ||
         e.code === "ETIMEDOUT"       ||
         e.code === "UND_ERR_SOCKET"  ||
         e.message?.includes("ECONNRESET") ||
         e.message?.includes("ETIMEDOUT")  ||
         e.message?.includes("timeout")    ||
         e.message?.includes("network");
}

// Send a transaction and wait for it to be mined. Retries on transient RPC errors.
async function mine(txFn, maxRetries = 6) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let tx;
    try {
      tx = await txFn();
    } catch (e) {
      if (isTransient(e) && attempt < maxRetries - 1) {
        const delay = 4000 * (attempt + 1);
        process.stdout.write(`\r  ECONNRESET — retry ${attempt + 1}/${maxRetries - 1} in ${delay / 1000}s…   `);
        await sleep(delay);
        continue;
      }
      throw e;
    }
    while (true) {
      try {
        const receipt = await tx.wait();
        await sleep(600);
        return receipt;
      } catch (e) {
        if (isTransient(e)) {
          process.stdout.write("\r  Network hiccup — retrying wait…          ");
          await sleep(3000);
          continue;
        }
        throw e;
      }
    }
  }
  throw new Error("mine(): exceeded max retries");
}

// Poll block timestamp until TWAP_WAIT_SECS have elapsed since firstTimestamp.
async function waitForTwap(provider, firstTimestamp) {
  const target = firstTimestamp + TWAP_WAIT_SECS;
  while (true) {
    try {
      const block = await provider.getBlock("latest");
      if (block.timestamp >= target) break;
      const rem  = target - block.timestamp;
      const mins = Math.floor(rem / 60);
      const secs = rem % 60;
      process.stdout.write(
        `\r  TWAP warm-up: ${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")} remaining…`
      );
    } catch (_) {
      process.stdout.write(`\r  TWAP warm-up: RPC hiccup — retrying…              `);
    }
    await sleep(2_000);
  }
  process.stdout.write("\r  TWAP warm-up: complete!                          \n");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env");
    process.exit(1);
  }

  const provider = hre.ethers.provider;
  const signers  = deriveWallets(rawKey, provider);
  const deployer = signers[0];
  const network  = hre.network.name;

  const totalChildren = groups.reduce((s, g) => s + g.children.length, 0); // 31

  console.log(sep("═"));
  console.log("  DEPLOY AMOY — Platform Token + TWAP Warm-up + Referral Tree");
  console.log(sep("═"));
  console.log(`  Network  : ${network}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Accounts : ${TOTAL_WALLETS} (0–${TOTAL_WALLETS - 1})`);
  console.log(`  Tree     : ${totalChildren} accounts to register (no investments)\n`);

  const balBefore = await provider.getBalance(deployer.address);
  console.log(`  Balance  : ${hre.ethers.formatEther(balBefore)} POL\n`);

  if (balBefore < hre.ethers.parseEther("3")) {
    console.error(
      "❌  account[0] needs ≥ 3 POL for gas.\n" +
      "   Investments are now paid in USDT — no large POL balance needed for seeding."
    );
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────
  // PHASE 0 — FUND SUB-WALLETS [1..31]
  // Each sub-wallet needs a small POL balance to send the register() tx.
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 0 — FUND SUB-WALLETS  [1..31]");
  console.log(sep());

  let funded = 0;
  for (let i = 1; i < TOTAL_WALLETS; i++) {
    const willInvest = i <= INVEST_UP_TO;
    const target     = willInvest ? FUND_INVESTOR  : FUND_REG_ONLY;
    const thresh     = willInvest ? THRESH_INVESTOR : THRESH_REG_ONLY;
    const tag        = willInvest ? "invest+reg" : "reg only  ";

    const bal = await provider.getBalance(signers[i].address);
    if (bal >= thresh) {
      console.log(
        `  [${String(i).padStart(2)}] (${tag})  ` +
        `${hre.ethers.formatEther(bal).padStart(10)} POL — skip`
      );
      continue;
    }
    await mine(() => deployer.sendTransaction({
      to:    signers[i].address,
      value: target,
      maxFeePerGas:         TX_OVERRIDES.maxFeePerGas,
      maxPriorityFeePerGas: TX_OVERRIDES.maxPriorityFeePerGas,
    }));
    console.log(
      `  [${String(i).padStart(2)}] (${tag})  ` +
      `funded ${hre.ethers.formatEther(target)} POL ✓`
    );
    funded++;
  }
  console.log(`\n  ${funded} wallets funded, ${TOTAL_WALLETS - 1 - funded} already had enough POL.\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 1 — ATTACH TO EXISTING USDT + DEPLOY PLATFORM TOKEN
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 1 — USDT (existing) + PLATFORM TOKEN");
  console.log(sep());

  const HordexToken = await hre.ethers.getContractFactory("HordexToken", deployer);
  const usdtArtifact = hre.artifacts.readArtifactSync("HordexToken");

  // Attach to the already-deployed USDT — no deployment needed.
  const usdtAddress = DEPLOYED_USDT;
  const usdtToken   = new hre.ethers.Contract(usdtAddress, usdtArtifact.abi, deployer);
  const usdtSupply  = await usdtToken.totalSupply();
  console.log(`  USDT       : ${usdtAddress}  (existing)`);
  console.log(`  USDT supply: ${hre.ethers.formatEther(usdtSupply)} USDT`);

  const token = await HordexToken.deploy(TOKEN_NAME, TOKEN_SYMBOL, TOKEN_SUPPLY, DEPLOY_OVERRIDES);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`  ${TOKEN_SYMBOL.padEnd(10)}: ${tokenAddress}`);
  console.log(`  Supply     : ${TOKEN_SUPPLY.toLocaleString()} ${TOKEN_SYMBOL}`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 2 — DEPLOY INFRASTRUCTURE CONTRACTS
  // ─────────────────────────────────────────────────────────────
  console.log("\n" + sep());
  console.log("  PHASE 2 — CONTRACTS");
  console.log(sep());

  const LiquidityMath = await hre.ethers.getContractFactory("LiquidityMath", deployer);
  const liquidityMath = await LiquidityMath.deploy(DEPLOY_OVERRIDES);
  await liquidityMath.waitForDeployment();
  const libAddress = await liquidityMath.getAddress();
  console.log(`  LiquidityMath    : ${libAddress}`);

  const LiquidityViewLib = await hre.ethers.getContractFactory("LiquidityViewLib", {
    signer: deployer,
    libraries: { LiquidityMath: libAddress },
  });
  const liquidityViewLib = await LiquidityViewLib.deploy(DEPLOY_OVERRIDES);
  await liquidityViewLib.waitForDeployment();
  const libViewAddress = await liquidityViewLib.getAddress();
  console.log(`  LiquidityViewLib : ${libViewAddress}`);

  const LiquidityFacet = await hre.ethers.getContractFactory("LiquidityFacet", {
    signer: deployer,
    libraries: { LiquidityMath: libAddress },
  });
  const liquidityFacet = await LiquidityFacet.deploy(
    UNI_ROUTER, UNI_FACTORY, usdtAddress, tokenAddress, DEPLOY_OVERRIDES
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
    UNI_ROUTER, UNI_FACTORY, usdtAddress, tokenAddress, facetAddress, roiFacetAddress,
    DEPLOY_OVERRIDES
  );
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  const deployReceipt    = await liquidity.deploymentTransaction().wait();
  const deployBlock      = deployReceipt.blockNumber;
  console.log(`  Liquidity        : ${liquidityAddress}  (block ${deployBlock})`);

  const artifact = hre.artifacts.readArtifactSync("Liquidity");
  const liq      = new hre.ethers.Contract(liquidityAddress, artifact.abi, deployer);

  // ─────────────────────────────────────────────────────────────
  // PHASE 3 — REGISTER TOKEN + SEED POOL
  // ─────────────────────────────────────────────────────────────
  console.log("\n" + sep());
  console.log("  PHASE 3 — TOKEN SETUP");
  console.log(sep());

  // Transfer full HORDEX supply to Liquidity contract.
  const supply = await token.totalSupply();
  await mine(() => token.connect(deployer).transfer(liquidityAddress, supply, TX_OVERRIDES));
  console.log(`  Transferred ${hre.ethers.formatEther(supply)} ${TOKEN_SYMBOL} → Liquidity ✓`);

  // Transfer USDT needed for pool seed to Liquidity contract.
  await mine(() => usdtToken.connect(deployer).transfer(liquidityAddress, SEED_USDT, TX_OVERRIDES));
  console.log(`  Transferred ${hre.ethers.formatEther(SEED_USDT)} USDT → Liquidity ✓`);

  await mine(() => liq.addToken(tokenAddress, TOKEN_NAME, TOKEN_SYMBOL, TX_OVERRIDES));
  console.log(`  Token registered in platform ✓`);

  await mine(() => liq.seedPool(tokenAddress, SEED_TOKENS, SEED_USDT, TX_OVERRIDES));
  console.log(
    `  Pool seeded: ${hre.ethers.formatEther(SEED_USDT)} USDT + ` +
    `${hre.ethers.formatEther(SEED_TOKENS)} ${TOKEN_SYMBOL}  ` +
    `(1 ${TOKEN_SYMBOL} = 1 USDT = $1.00) ✓`
  );

  // ─────────────────────────────────────────────────────────────
  // PHASE 4 — TWAP WARM-UP
  // ─────────────────────────────────────────────────────────────
  console.log("\n" + sep());
  console.log("  PHASE 4 — TWAP WARM-UP");
  console.log(sep());
  console.log(`  Waiting ${TWAP_WAIT_SECS}s between observations (testnet).`);
  console.log(`  Change TWAP_WAIT_SECS to ${31 * 60} for mainnet (31 min).\n`);

  const obs0Receipt = await mine(() => liq.updateTWAP(TX_OVERRIDES));
  const obs0Block   = await provider.getBlock(obs0Receipt.blockNumber);
  console.log(
    `  Observation 0 recorded ✓  ` +
    `(block ${obs0Receipt.blockNumber}, ${new Date(obs0Block.timestamp * 1000).toLocaleTimeString()})`
  );
  console.log(`  Waiting for ${TWAP_WAIT_SECS}s to elapse on-chain…`);

  await waitForTwap(provider, obs0Block.timestamp);

  await mine(() => liq.updateTWAP(TX_OVERRIDES));
  console.log("  Observation 1 recorded ✓");
  console.log("  TWAP ready — staking rewards are claimable ✓");

  // ─────────────────────────────────────────────────────────────
  // PHASE 5 — BUILD REFERRAL TREE
  // account[0] is pre-registered as owner in the constructor.
  // Accounts [1..31] register in BFS order (parent always before child).
  // No investments are made.
  // ─────────────────────────────────────────────────────────────
  console.log("\n" + sep());
  console.log("  PHASE 5 — REGISTER  (account[0] pre-registered as owner)");
  console.log(sep());

  let registered = 0;
  for (const g of groups) {
    console.log(
      `\n  account[${String(g.referrer).padStart(2)}]  →  ` +
      `${g.children.length} child${g.children.length > 1 ? "ren" : ""}  ` +
      `[${g.children.map(c => String(c).padStart(2)).join(", ")}]`
    );
    for (const idx of g.children) {
      const ct = new hre.ethers.Contract(liquidityAddress, artifact.abi, signers[idx]);
      await mine(() => ct.register(signers[g.referrer].address, TX_OVERRIDES));
      console.log(
        `    [${String(idx).padStart(2)}] ${signers[idx].address}` +
        `  ← [${String(g.referrer).padStart(2)}] ✓`
      );
      registered++;
    }
  }
  console.log(`\n  ${registered} accounts registered ✓`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 6 — INVEST  (accounts [0..INVEST_UP_TO] in BFS order)
  // BFS order ensures each parent has already invested before its children,
  // so ROI stream eligibility (activeReferralCount) is maximised at each invest().
  // ─────────────────────────────────────────────────────────────
  console.log("\n" + sep());
  console.log(`  PHASE 6 — FUND USDT + INVEST  (accounts [0..${INVEST_UP_TO}], 100 USDT = $100 each)`);
  console.log(sep());

  // Distribute USDT to each investing wallet so they can call invest().
  // Deployer (account[0]) already holds all USDT; sub-wallets need their allocation.
  for (let i = 1; i <= INVEST_UP_TO; i++) {
    await mine(() => usdtToken.connect(deployer).transfer(
      signers[i].address, FUND_INVESTOR_USDT, TX_OVERRIDES
    ));
    console.log(`  [${String(i).padStart(2)}] funded ${hre.ethers.formatEther(FUND_INVESTOR_USDT)} USDT ✓`);
  }

  const commIface = new hre.ethers.Interface([
    "event CommissionPaid(address indexed recipient, address indexed from, uint256 amount, uint256 level)",
  ]);

  // BFS order: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
  const investOrder = [];
  for (const g of groups) {
    if (g.referrer <= INVEST_UP_TO && !investOrder.includes(g.referrer)) {
      investOrder.push(g.referrer);
    }
    for (const c of g.children) {
      if (c <= INVEST_UP_TO) investOrder.push(c);
    }
  }
  if (!investOrder.includes(0)) investOrder.unshift(0);

  let totalInvested    = 0n;
  let totalCommissions = 0n;

  for (const idx of investOrder) {
    const account    = signers[idx];
    const usdtArtifact = hre.artifacts.readArtifactSync("HordexToken");
    const usdtCt     = new hre.ethers.Contract(usdtAddress, usdtArtifact.abi, account);
    // Approve Liquidity contract to pull USDT from this wallet before invest().
    await mine(() => usdtCt.approve(liquidityAddress, PACKAGE_USDT, TX_OVERRIDES));

    const ct      = new hre.ethers.Contract(liquidityAddress, artifact.abi, account);
    const receipt = await mine(() => ct.invest(tokenAddress, PACKAGE_USDT, TX_OVERRIDES));

    totalInvested += PACKAGE_USDT;

    // Parse CommissionPaid events from the receipt
    const comms = [];
    for (const log of receipt.logs) {
      try {
        const parsed = commIface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "CommissionPaid") {
          comms.push({ recipient: parsed.args.recipient, amount: parsed.args.amount, level: Number(parsed.args.level) });
        }
      } catch (_) {}
    }
    totalCommissions += comms.reduce((s, c) => s + c.amount, 0n);

    const refIdx   = groups.find(g => g.children.includes(idx))?.referrer;
    const refLabel = refIdx === undefined ? "no referrer (owner)" : `ref [${refIdx}]`;
    const commStr  = comms.length > 0
      ? `  → ${comms.length} commission(s): ` +
        comms.map(c => `L${c.level + 1} $${parseFloat(hre.ethers.formatEther(c.amount)).toFixed(2)}`).join(", ")
      : "  → no commissions";
    console.log(`  [${String(idx).padStart(2)}] invested $100 USDT  (${refLabel})`);
    console.log(commStr);
  }

  console.log(
    `\n  ${investOrder.length} accounts invested ✓` +
    `  total: $${parseFloat(hre.ethers.formatEther(totalInvested)).toFixed(2)} USDT` +
    `  commissions paid: $${parseFloat(hre.ethers.formatEther(totalCommissions)).toFixed(2)} USDT`
  );

  // ─────────────────────────────────────────────────────────────
  // WRITE CONTRACT-CONFIG.JS
  // ─────────────────────────────────────────────────────────────
  console.log("\n" + sep());
  console.log("  WRITE CONFIG");
  console.log(sep());

  const configContent =
`// AUTO-GENERATED by scripts/amoytestnet/deployamoy.js — do not edit manually
// Network: ${network} | Deployed: ${new Date().toLocaleString()}

const CONTRACT_ADDRESS        = "${liquidityAddress}";
const TOKEN_ADDRESS           = "${tokenAddress}";
const TOKEN_ADDRESS_JIGGY     = "";
const TOKEN_ADDRESS_PANWORLD  = "";
const ROUTER_ADDRESS          = "${UNI_ROUTER}";
const FACTORY_ADDRESS         = "${UNI_FACTORY}";
const WETH_ADDRESS            = "${usdtAddress}";
const USDT_ADDRESS            = "${usdtAddress}";
const DEPLOY_BLOCK            = ${deployBlock};
const FACET_ADDRESS           = "${facetAddress}";
const ROI_FACET_ADDRESS       = "${roiFacetAddress}";

const CONTRACT_ABI = ${JSON.stringify(artifact.abi, null, 2)};
`;

  const rootConfig     = path.join(__dirname, "..", "..", "contract-config.js");
  const frontendConfig = path.join(__dirname, "..", "..", "frontend", "contract-config.js");
  fs.writeFileSync(rootConfig,     configContent);
  fs.writeFileSync(frontendConfig, configContent);
  console.log("  contract-config.js written ✓  (root + frontend)");

  const indexPath = path.join(__dirname, "..", "..", "frontend", "index.html");
  if (fs.existsSync(indexPath)) {
    fs.writeFileSync(
      indexPath,
      fs.readFileSync(indexPath, "utf8")
        .replace(/contract-config\.js\?v=\d+/g, `contract-config.js?v=${Date.now()}`)
    );
    console.log("  index.html cache-bust updated ✓");
  }

  // Save deploy-output.json for reference (not used by the app)
  const outPath = path.join(__dirname, "deploy-output.json");
  fs.writeFileSync(outPath, JSON.stringify({
    network,
    deployedAt:       new Date().toISOString(),
    deployBlock,
    usdtAddress,
    tokenAddress,
    tokenName:        TOKEN_NAME,
    tokenSymbol:      TOKEN_SYMBOL,
    tokenSupply:      TOKEN_SUPPLY.toString(),
    liquidityAddress,
    facetAddress,
    roiFacetAddress,
    libAddress,
    libViewAddress,
    uniRouter:        UNI_ROUTER,
    uniFactory:       UNI_FACTORY,
    uniWeth:          usdtAddress,
    seedUsdt:         hre.ethers.formatEther(SEED_USDT),
    seedTokens:       hre.ethers.formatEther(SEED_TOKENS),
    accounts: signers.map((s, i) => ({
      index:   i,
      address: s.address,
      referrer: groups.find(g => g.children.includes(i))?.referrer ?? null,
    })),
  }, null, 2));
  console.log("  deploy-output.json written ✓  (includes all 32 addresses + referral map)");

  // ─────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────
  const balAfter = await provider.getBalance(deployer.address);
  const spent    = balBefore - balAfter;

  console.log("\n" + sep("═"));
  console.log("  DEPLOYMENT COMPLETE");
  console.log(sep("═"));
  console.log(`  Network        : ${network} (chainId 80002)`);
  console.log(`  USDT           : ${usdtAddress}  (${USDT_SYMBOL})`);
  console.log(`  Token          : ${tokenAddress}  (${TOKEN_SYMBOL})`);
  console.log(`  Liquidity      : ${liquidityAddress}`);
  console.log(`  LiquidityFacet : ${facetAddress}`);
  console.log(`  ROIFacet       : ${roiFacetAddress}`);
  console.log(`  Deploy block   : ${deployBlock}`);
  console.log(`  Pool price     : 1 ${TOKEN_SYMBOL} = 1 USDT = $1.00`);
  console.log(`  TWAP           : ready ✓`);
  console.log(`  Registered     : ${registered + 1} accounts (including owner)`);
  console.log(`  Invested       : accounts [0..${INVEST_UP_TO}]  ($100 USDT each = $${(INVEST_UP_TO + 1) * 100} total)`);
  console.log(`  POL spent      : ~${hre.ethers.formatEther(spent)} POL`);
  console.log(sep("═"));
  console.log(`  App is live — [0..${INVEST_UP_TO}] have active investments, [${INVEST_UP_TO + 1}..31] registered only.`);
  console.log("  Connect any wallet from deploy-output.json to invest or explore.");
  console.log(sep("═") + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
