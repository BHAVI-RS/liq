// Polygon Amoy full simulation with ROI commission system.
// Deploys 3 tokens, builds the 32-account referral tree (5-4-3-2-1 pattern, 2 cycles),
// all 32 accounts invest, then inspects ROI streams.
//
// This script self-funds sub-wallets — amoynode.js is NOT required.
//
// RUN:
//   npx hardhat run scripts/amoytestnet/hfsroi.js --network polygonAmoy
//
// REQUIREMENTS:
//   account[0] (PRIVATE_KEY in .env) needs ≥ 325 POL
//     (3 × 100 MATIC pool seeds + ~16 POL to fund [1..31] + gas).
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

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Uniswap V2 on Polygon Amoy ────────────────────────────────────────────────
const UNI_ROUTER  = "0x85eaBB2740eD2f9e3b53c51D8e1E7BdA53672825";
const UNI_FACTORY = "0xa5d020Eb5a4D537f56F7314d2359f7770DE01a48";
const UNI_WETH    = "0x7Bd0A72d3A07353C91dDA48D2B78454248d281E6";

const USDT_PER_ETH   = 1000;
const PACKAGE_ETH    = hre.ethers.parseEther("0.1");
const SEED_ETH       = hre.ethers.parseEther("100");
const SEED_TOKENS    = hre.ethers.parseEther("100000");
const TWAP_WAIT_SECS = 31;

const TOTAL_WALLETS = 32;

// All sub-wallets invest — fund each with 0.5 POL
const FUND_AMOUNT = hre.ethers.parseEther("0.5");
const FUND_THRESH = hre.ethers.parseEther("0.4");   // skip top-up if already has this

// ── Referral tree (identical to deployamoy.js) ────────────────────────────────
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

// ── Gas overrides ─────────────────────────────────────────────────────────────
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

const COMM_RATES_BPS = [5000, 2500, 1000, 300, 250, 225, 200, 200, 175, 150];

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sep(c = "─", n = 60) { return c.repeat(n); }
function toUSDT(wei) { return (parseFloat(hre.ethers.formatEther(wei)) * USDT_PER_ETH).toFixed(2); }
function toETH(wei)  { return parseFloat(hre.ethers.formatEther(wei)).toFixed(6); }

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

  const referrerOf = new Map();
  referrerOf.set(0, null);
  for (const g of groups) {
    for (const c of g.children) referrerOf.set(c, g.referrer);
  }

  console.log(sep("═"));
  console.log("  HFSROI — Deploy · Referral Tree · Investments · ROI Streams");
  console.log(sep("═"));
  console.log(`  Network  : ${network}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Accounts : ${TOTAL_WALLETS} (0–${TOTAL_WALLETS - 1})\n`);

  const balBefore = await provider.getBalance(deployer.address);
  console.log(`  Balance  : ${hre.ethers.formatEther(balBefore)} POL\n`);

  if (balBefore < hre.ethers.parseEther("325")) {
    console.error(
      "❌  account[0] needs ≥ 325 POL\n" +
      "   (3 × 100 MATIC pool seeds + ~16 POL to fund [1..31] + gas)"
    );
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────
  // PHASE 0 — FUND SUB-WALLETS [1..31]
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 0 — FUND SUB-WALLETS  [1..31]");
  console.log(sep());

  let funded = 0;
  for (let i = 1; i < TOTAL_WALLETS; i++) {
    const bal = await provider.getBalance(signers[i].address);
    if (bal >= FUND_THRESH) {
      console.log(`  [${String(i).padStart(2)}]  ${hre.ethers.formatEther(bal).padStart(10)} POL — skip`);
      continue;
    }
    await mine(() => deployer.sendTransaction({
      to:    signers[i].address,
      value: FUND_AMOUNT,
      maxFeePerGas:         TX_OVERRIDES.maxFeePerGas,
      maxPriorityFeePerGas: TX_OVERRIDES.maxPriorityFeePerGas,
    }));
    console.log(`  [${String(i).padStart(2)}]  funded ${hre.ethers.formatEther(FUND_AMOUNT)} POL ✓`);
    funded++;
  }
  console.log(`\n  ${funded} wallets funded, ${TOTAL_WALLETS - 1 - funded} already had enough POL.\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 1 — DEPLOY
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 1 — DEPLOY");
  console.log(sep());

  const tokenDefs = [
    { name: "Hordex",   symbol: "HDX" },
    { name: "Jiggy",    symbol: "JGY" },
    { name: "PanWorld", symbol: "PWD" },
  ];
  const TOKEN_SUPPLY = 10_000_000;

  const HordexToken    = await hre.ethers.getContractFactory("HordexToken", deployer);
  const deployedTokens = [];

  for (const def of tokenDefs) {
    const token = await HordexToken.deploy(def.name, def.symbol, TOKEN_SUPPLY, DEPLOY_OVERRIDES);
    await token.waitForDeployment();
    const addr = await token.getAddress();
    deployedTokens.push({ ...def, contract: token, address: addr });
    console.log(`  ${def.symbol.padEnd(8)}: ${addr}`);
  }

  const tokenAddress = deployedTokens[0].address;  // HDX = platform token

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
    UNI_ROUTER, UNI_FACTORY, UNI_WETH, tokenAddress, DEPLOY_OVERRIDES
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
    UNI_ROUTER, UNI_FACTORY, UNI_WETH, tokenAddress, facetAddress, roiFacetAddress,
    DEPLOY_OVERRIDES
  );
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  const deployReceipt    = await liquidity.deploymentTransaction().wait();
  const deployBlock      = deployReceipt.blockNumber;
  console.log(`  Liquidity        : ${liquidityAddress}  (block ${deployBlock})`);

  const artifact = hre.artifacts.readArtifactSync("Liquidity");
  const liq      = new hre.ethers.Contract(liquidityAddress, artifact.abi, deployer);

  for (const t of deployedTokens) {
    const supply = await t.contract.totalSupply();
    await mine(() => t.contract.connect(deployer).transfer(liquidityAddress, supply, TX_OVERRIDES));
    console.log(`  ${hre.ethers.formatEther(supply)} ${t.symbol} → Liquidity ✓`);

    await mine(() => liq.addToken(t.address, t.name, t.symbol, TX_OVERRIDES));
    console.log(`  ${t.symbol} registered in platform ✓`);

    await mine(() => liq.seedPool(t.address, SEED_TOKENS, { value: SEED_ETH, ...TX_OVERRIDES }));
    console.log(`  Pool seeded: 100 MATIC + 100,000 ${t.symbol}  (1 ${t.symbol} = 0.001 MATIC = $1.00) ✓`);
  }

  // ─────────────────────────────────────────────────────────────
  // TWAP WARM-UP
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  TWAP WARM-UP");
  console.log(sep());

  const obs0Receipt = await mine(() => liq.updateTWAP(TX_OVERRIDES));
  const obs0Block   = await provider.getBlock(obs0Receipt.blockNumber);
  console.log(
    `  Observation 0 recorded ✓  ` +
    `(block ${obs0Receipt.blockNumber}, ${new Date(obs0Block.timestamp * 1000).toLocaleTimeString()})`
  );
  console.log(`  Waiting ${TWAP_WAIT_SECS}s for second observation…`);

  await waitForTwap(provider, obs0Block.timestamp);

  await mine(() => liq.updateTWAP(TX_OVERRIDES));
  console.log("  Observation 1 recorded ✓");
  console.log("  TWAP ready — staking rewards and ROI claims are enabled ✓\n");

  // ─────────────────────────────────────────────────────────────
  // Write contract-config.js
  // ─────────────────────────────────────────────────────────────
  const configContent =
`// AUTO-GENERATED by scripts/amoytestnet/hfsroi.js — do not edit manually
// Network: ${network} | Deployed: ${new Date().toLocaleString()}

const CONTRACT_ADDRESS        = "${liquidityAddress}";
const TOKEN_ADDRESS           = "${deployedTokens[0].address}";
const TOKEN_ADDRESS_JIGGY     = "${deployedTokens[1].address}";
const TOKEN_ADDRESS_PANWORLD  = "${deployedTokens[2].address}";
const ROUTER_ADDRESS          = "${UNI_ROUTER}";
const FACTORY_ADDRESS         = "${UNI_FACTORY}";
const WETH_ADDRESS            = "${UNI_WETH}";
const DEPLOY_BLOCK            = ${deployBlock};
const FACET_ADDRESS           = "${facetAddress}";
const ROI_FACET_ADDRESS       = "${roiFacetAddress}";

const CONTRACT_ABI = ${JSON.stringify(artifact.abi, null, 2)};
`;
  fs.writeFileSync(path.join(__dirname, "..", "..", "contract-config.js"),             configContent);
  fs.writeFileSync(path.join(__dirname, "..", "..", "frontend", "contract-config.js"), configContent);

  const indexPath = path.join(__dirname, "..", "..", "frontend", "index.html");
  if (fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath,
      fs.readFileSync(indexPath, "utf8")
        .replace(/contract-config\.js\?v=\d+/g, `contract-config.js?v=${Date.now()}`)
    );
  }
  console.log(`  contract-config.js written ✓ (root + frontend)\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 2 — REGISTER
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 2 — REGISTER  (account[0] pre-registered in constructor)");
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
  console.log(`\n  ${registered} accounts registered ✓\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 3 — INVEST  (BFS order: parents before children)
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log(`  PHASE 3 — INVESTMENTS  (100 USDT = 0.1 MATIC each, all ${TOTAL_WALLETS} accounts)`);
  console.log(sep());

  const commIface = new hre.ethers.Interface([
    "event CommissionPaid(address indexed recipient, address indexed from, uint256 amount, uint256 level)",
  ]);

  const investOrder = [0, ...groups.flatMap(g => g.children)];
  const lockIndexOf = new Map();  // investor idx → lock index used

  let totalInvested    = 0n;
  let totalCommissions = 0n;

  for (const idx of investOrder) {
    const account = signers[idx];
    const ct      = new hre.ethers.Contract(liquidityAddress, artifact.abi, account);

    const locksBefore = await liq.getUserLPLocks(account.address);
    const lockIndex   = locksBefore.length;
    lockIndexOf.set(idx, lockIndex);

    const receipt = await mine(() => ct.invest(tokenAddress, { value: PACKAGE_ETH, ...TX_OVERRIDES }));
    totalInvested += PACKAGE_ETH;

    const comms = [];
    for (const log of receipt.logs) {
      try {
        const parsed = commIface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "CommissionPaid") {
          comms.push({ recipient: parsed.args.recipient, amount: parsed.args.amount, level: Number(parsed.args.level) });
        }
      } catch (_) {}
    }

    const txTotal     = comms.reduce((s, c) => s + c.amount, 0n);
    totalCommissions += txTotal;

    const refIdx   = referrerOf.get(idx);
    const refLabel = refIdx === null ? "no referrer" : `ref by [${String(refIdx).padStart(2)}]`;
    console.log(`\n  account[${String(idx).padStart(2)}]  ${account.address}  (${refLabel})`);
    console.log(`  ${sep("·", 56)}`);

    if (comms.length === 0) {
      console.log(`    (no commission events)`);
    } else {
      for (const c of comms) {
        const ratePct   = (COMM_RATES_BPS[c.level - 1] / 500).toFixed(2).replace(/\.?0+$/, "");
        const usdtAmt   = toUSDT(c.amount);
        const recvIdx   = signers.findIndex(s => s.address.toLowerCase() === c.recipient.toLowerCase());
        const recvLabel = recvIdx === 0
          ? `account[00]  (owner / platform)`
          : `account[${String(recvIdx).padStart(2)}]  ${c.recipient.slice(0, 10)}…`;
        console.log(
          `    L${String(c.level).padEnd(2)}  ${String(ratePct).padStart(5)}% of T` +
          `  $${usdtAmt.padStart(7)} USDT  →  ${recvLabel}`
        );
      }
      console.log(`    ── total: $${toUSDT(txTotal)} USDT`);
    }
    console.log(`    Lock index: ${lockIndex}  (ROI streams initialised)`);
  }

  // ─────────────────────────────────────────────────────────────
  // PHASE 4 — ROI STREAM INSPECTION
  // ─────────────────────────────────────────────────────────────
  const LEVEL_NAMES = ["L1 (50%)", "L2 (25%)", "L3 (10%)", "L4 (3%)", "L5 (2.5%)",
                       "L6 (2.25%)", "L7 (2%)", "L8 (2%)", "L9 (1.75%)", "L10 (1.5%)"];

  console.log(`\n${sep()}`);
  console.log("  PHASE 4 — ROI STREAMS");
  console.log(sep());

  console.log("  ── Active streams per account (as recipient) ──\n");
  for (let idx = 0; idx < signers.length; idx++) {
    const addr    = signers[idx].address;
    const streams = await liq.getActiveROIStreams(addr);
    const pending = await liq.getROIPending(addr);
    if (streams.length === 0) continue;
    console.log(`  account[${String(idx).padStart(2)}]  ${addr}`);
    console.log(`  ${sep("·", 56)}`);
    console.log(`  Receiving ${streams.length} stream(s) as ROI recipient:`);
    for (const s of streams) {
      const investorIdx   = signers.findIndex(w => w.address.toLowerCase() === s.investor.toLowerCase());
      const investorLabel = investorIdx >= 0 ? `account[${String(investorIdx).padStart(2)}]` : s.investor.slice(0, 10) + "…";
      const accrued = await liq.getROIAccrued(s.investor, s.lockIndex, s.level);
      const info    = await liq.getROIStreamInfo(s.investor, s.lockIndex, s.level);
      console.log(
        `    ${LEVEL_NAMES[Number(s.level)].padEnd(12)}  investor=${investorLabel}` +
        `  lock=${s.lockIndex}  accrued=${toETH(accrued)} MATIC  cap=$${toUSDT(info.capETH)}`
      );
    }
    console.log(`  Pending (settled): ${toETH(pending)} MATIC\n`);
  }

  console.log("  ── Stream recipients per investment (levels 1–5) ──\n");
  for (const idx of investOrder) {
    const addr      = signers[idx].address;
    const lockIndex = lockIndexOf.get(idx);
    const locks     = await liq.getUserLPLocks(addr);
    const lock      = locks[lockIndex];
    const refIdx    = referrerOf.get(idx);
    if (refIdx === null) {
      console.log(`  account[${String(idx).padStart(2)}]  (owner — no referrer chain, no ROI streams)`);
      continue;
    }
    console.log(`  account[${String(idx).padStart(2)}] lock#${lockIndex}  ethInvested=${toETH(lock.ethInvested)} MATIC`);
    for (let lvl = 0; lvl < 5; lvl++) {
      const info = await liq.getROIStreamInfo(addr, lockIndex, lvl);
      const recvIdx   = signers.findIndex(w => w.address.toLowerCase() === info.recipient.toLowerCase());
      const recvLabel = recvIdx >= 0 ? `account[${String(recvIdx).padStart(2)}]` : info.recipient.slice(0, 10) + "…";
      console.log(
        `    ${LEVEL_NAMES[lvl].padEnd(12)}  → ${recvLabel}` +
        `  cap=$${toUSDT(info.capETH)}  ended=${info.ended}`
      );
    }
    console.log();
  }

  // ─────────────────────────────────────────────────────────────
  // WRITE DEPLOY-OUTPUT.JSON
  // ─────────────────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(__dirname, "deploy-output.json"),
    JSON.stringify({
      network,
      deployedAt:       new Date().toISOString(),
      deployBlock,
      platformToken:    tokenAddress,
      tokens:           deployedTokens.map(t => ({ symbol: t.symbol, address: t.address })),
      liquidityAddress,
      facetAddress,
      roiFacetAddress,
      libAddress,
      libViewAddress,
      accounts:         signers.map((s, i) => ({
        index:   i,
        address: s.address,
        referrer: referrerOf.get(i) ?? null,
      })),
    }, null, 2)
  );
  console.log("  deploy-output.json written ✓\n");

  // ─────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────
  const balAfter = await provider.getBalance(deployer.address);

  console.log(sep("═"));
  console.log("  HFSROI COMPLETE");
  console.log(sep("═"));
  for (const t of deployedTokens) {
    console.log(`  ${t.symbol.padEnd(10)}: ${t.address}`);
  }
  console.log(`  LiquidityFacet   : ${facetAddress}`);
  console.log(`  LiquidityROIFacet: ${roiFacetAddress}`);
  console.log(`  Liquidity        : ${liquidityAddress}`);
  console.log(`  Deploy block     : ${deployBlock}`);
  console.log(`  Accounts         : ${TOTAL_WALLETS}  (accounts[0..${TOTAL_WALLETS - 1}])`);
  console.log(`  Package          : 100 USDT (0.1 MATIC) each`);
  console.log(`  Total invested   : $${toUSDT(totalInvested)} USDT`);
  console.log(`  Total comms      : $${toUSDT(totalCommissions)} USDT`);
  console.log(`  POL spent        : ~${hre.ethers.formatEther(balBefore - balAfter)} POL`);

  console.log(`\n  Tree structure:`);
  console.log(`  ${"REFERRER".padEnd(14)} ${"COUNT".padEnd(7)} CHILDREN`);
  console.log(`  ${sep("·", 42)}`);
  for (const g of groups) {
    console.log(
      `  account[${String(g.referrer).padStart(2)}]    ` +
      `${String(g.children.length).padEnd(7)}` +
      `[${g.children.map(c => String(c).padStart(2)).join(", ")}]`
    );
  }

  const contractBal = await provider.getBalance(liquidityAddress);
  console.log(`\n  Contract balances:`);
  console.log(`    MATIC    : ${hre.ethers.formatEther(contractBal)}`);
  for (const t of deployedTokens) {
    const bal = await t.contract.balanceOf(liquidityAddress);
    console.log(`    ${t.symbol.padEnd(8)}: ${hre.ethers.formatEther(bal)}`);
  }
  console.log(sep("═") + "\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
