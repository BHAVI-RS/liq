// Polygon Amoy simulation — 57 accounts, 3 tokens, full referral tree + all invest.
//
// This script self-funds sub-wallets — amoynode.js is NOT required.
//
// RUN:
//   npx hardhat run scripts/amoytestnet/simulateamoy.js --network polygonAmoy
//
// REQUIREMENTS:
//   account[0] (PRIVATE_KEY in .env) needs ≥ 350 POL
//     (3 × 100 MATIC pool seeds + ~28 POL to fund [1..56] + gas).

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Pre-deployed Uniswap V2 on Polygon Amoy ──────────────────────────────────
const UNI_ROUTER    = "0x85eaBB2740eD2f9e3b53c51D8e1E7BdA53672825";
const UNI_FACTORY   = "0xa5d020Eb5a4D537f56F7314d2359f7770DE01a48";
const DEPLOYED_USDT = "0x5b0Eaea74F03ED873B03d6C6ce54f6d5eDE75F9c";
const USDT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];

const USDT_PER_ETH  = 1;
const PACKAGE_USDT  = hre.ethers.parseEther("100");    // 100 USDT = $100
const SEED_USDT     = hre.ethers.parseEther("100000"); // 100,000 USDT → 1 token = $1
const SEED_TOKENS   = hre.ethers.parseEther("100000");
const FUND_USDT     = hre.ethers.parseEther("110");    // USDT per investing sub-wallet
const USDT_THRESH   = hre.ethers.parseEther("90");     // skip USDT top-up if already has this

const TOTAL_WALLETS  = 60;
const TOTAL_ACCOUNTS = 57; // accounts [0..56] used in simulation
const TWAP_WAIT_SECS = 31; // 31 sec for testing — change to 31 * 60 for mainnet

// All sub-wallets invest — fund each with 0.5 POL
const FUND_AMOUNT = hre.ethers.parseEther("0.05");
const FUND_THRESH = hre.ethers.parseEther("0.04");  // skip top-up if already has this

// maxFeePerGas × gasLimit must stay under 1 POL (the RPC provider's fee cap).
// Actual fee paid = baseFee × gasUsed — always much lower than the ceiling.
const DEPLOY_OVERRIDES = {
  maxFeePerGas:         hre.ethers.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: hre.ethers.parseUnits("30", "gwei"),
  gasLimit: 15_000_000,  // 60 gwei × 15M = 0.9 POL < 1 POL cap
};
const TX_OVERRIDES = {
  maxFeePerGas:         hre.ethers.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: hre.ethers.parseUnits("30", "gwei"),
  gasLimit: 5_000_000,   // invest() makes multiple DELEGATECALLs + ROI stream SSTOREs
};

// Spot referral commission rates (BPS out of 10000, applied to 20% of T = A40eth).
// Display formula: rate_bps / 500 = % of total investment T.
const COMM_RATES_BPS    = [5000, 2500, 1000, 300, 250, 225, 200, 200, 175, 150];
// ROI commission rates (% of investor's staking reward) — for display only.
const ROI_RATES_DISPLAY = [50, 10, 5, 2, 0.6, 0.5, 0.45, 0.4, 0.4, 0.35];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isTransient(e) {
  return e.code === "ECONNRESET"  ||
         e.code === "ETIMEDOUT"   ||
         e.code === "UND_ERR_SOCKET" ||
         e.message?.includes("ECONNRESET") ||
         e.message?.includes("ETIMEDOUT")  ||
         e.message?.includes("timeout")    ||
         e.message?.includes("network");
}

// Send a transaction and wait until it is mined.
// Accepts a thunk (() => txPromise) so the entire send+wait can be retried
// on transient RPC errors (ECONNRESET, timeout).
async function mine(txFn, maxRetries = 6) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let tx;
    try {
      tx = await txFn();
    } catch (e) {
      if (isTransient(e) && attempt < maxRetries - 1) {
        const delay = 4000 * (attempt + 1);
        process.stdout.write(`\r  ECONNRESET on send — retry ${attempt + 1}/${maxRetries - 1} in ${delay / 1000}s…   `);
        await sleep(delay);
        continue;
      }
      throw e;
    }

    // tx sent — now wait for receipt, retrying on transient poll errors
    while (true) {
      try {
        const receipt = await tx.wait();
        await sleep(600); // brief pause so the RPC isn't slammed back-to-back
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

// Wraps mine() with up to MAX_ATTEMPTS tries, waiting RETRY_DELAY_MS between each.
// On any error (revert, network, etc.) it waits and retries.
// After all attempts are exhausted it logs and returns null so the caller can skip.
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

function toUSDT(wei) {
  return (parseFloat(hre.ethers.formatEther(wei)) * USDT_PER_ETH).toFixed(2);
}
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

// Poll block timestamp until TWAP_WAIT_SECS past firstTimestamp, printing a countdown.
// Retries silently on transient RPC errors (timeout, network hiccup).
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
    await new Promise(r => setTimeout(r, 2_000));
  }
  process.stdout.write("\r  TWAP warm-up: complete!                          \n");
}

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

  console.log(sep("═"));
  console.log("  SIMULATE — Deploy · Referral Tree · Investments");
  console.log(sep("═"));
  console.log(`  Network  : ${network}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Accounts : ${TOTAL_ACCOUNTS} signers (accounts [0..56])\n`);

  const balBefore = await provider.getBalance(deployer.address);
  console.log(`  Balance  : ${hre.ethers.formatEther(balBefore)} POL\n`);

  if (balBefore < hre.ethers.parseEther("3")) {
    console.error("❌  account[0] needs ≥ 3 POL for gas");
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────
  // PHASE 0 — FUND SUB-WALLETS [1..56]
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 0 — FUND SUB-WALLETS  [1..56]");
  console.log(sep());

  const usdtCt = new hre.ethers.Contract(DEPLOYED_USDT, USDT_ABI, deployer);
  let funded = 0;
  for (let i = 1; i < TOTAL_ACCOUNTS; i++) {
    const [maticBal, usdtBal] = await Promise.all([
      provider.getBalance(signers[i].address),
      usdtCt.balanceOf(signers[i].address),
    ]);
    if (maticBal < FUND_THRESH) {
      await mine(() => deployer.sendTransaction({
        to: signers[i].address, value: FUND_AMOUNT,
        maxFeePerGas: TX_OVERRIDES.maxFeePerGas,
        maxPriorityFeePerGas: TX_OVERRIDES.maxPriorityFeePerGas,
      }));
      console.log(`  [${String(i).padStart(2)}]  funded ${hre.ethers.formatEther(FUND_AMOUNT)} POL ✓`);
      funded++;
    } else {
      console.log(`  [${String(i).padStart(2)}]  ${hre.ethers.formatEther(maticBal).padStart(10)} POL — skip`);
    }
    if (usdtBal < USDT_THRESH) {
      await mine(() => usdtCt.transfer(signers[i].address, FUND_USDT, TX_OVERRIDES));
      console.log(`  [${String(i).padStart(2)}]  funded 110 USDT ✓`);
    }
  }
  console.log(`\n  ${funded} wallets funded with POL.\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 1 — DEPLOY
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 1 — DEPLOY");
  console.log(sep());

  const tokenDefs = [
    { name: "Hordex Token",   symbol: "HORDEX"   },
    { name: "Jiggy Token",    symbol: "JIGGY"    },
    { name: "PanWorld Token", symbol: "PANWORLD" },
  ];
  const TOKEN_SUPPLY = 10_000_000;

  const HordexToken = await hre.ethers.getContractFactory("HordexToken", deployer);
  const deployedTokens = [];

  for (const def of tokenDefs) {
    const token = await HordexToken.deploy(def.name, def.symbol, TOKEN_SUPPLY, DEPLOY_OVERRIDES);
    await token.waitForDeployment();
    const addr = await token.getAddress();
    deployedTokens.push({ ...def, contract: token, address: addr });
    console.log(`  ${def.symbol.padEnd(8)}: ${addr}`);
  }

  const tokenAddress = deployedTokens[0].address;

  const LiquidityMath = await hre.ethers.getContractFactory("LiquidityMath", deployer);
  const liquidityMath = await LiquidityMath.deploy(DEPLOY_OVERRIDES);
  await liquidityMath.waitForDeployment();
  const libAddress = await liquidityMath.getAddress();
  console.log(`  LiquidityMath   : ${libAddress}`);

  const LiquidityViewLib = await hre.ethers.getContractFactory("LiquidityViewLib", {
    signer: deployer,
    libraries: { LiquidityMath: libAddress },
  });
  const liquidityViewLib = await LiquidityViewLib.deploy(DEPLOY_OVERRIDES);
  await liquidityViewLib.waitForDeployment();
  const libViewAddress = await liquidityViewLib.getAddress();
  console.log(`  LiquidityViewLib: ${libViewAddress}`);

  // ── Facets (must deploy before Liquidity) ──────────────────────────────────
  const LiquidityFacet = await hre.ethers.getContractFactory("LiquidityFacet", {
    signer: deployer,
    libraries: { LiquidityMath: libAddress },
  });
  const liquidityFacet = await LiquidityFacet.deploy(
    UNI_ROUTER, UNI_FACTORY, DEPLOYED_USDT, tokenAddress, DEPLOY_OVERRIDES
  );
  await liquidityFacet.waitForDeployment();
  const facetAddress = await liquidityFacet.getAddress();
  console.log(`  LiquidityFacet  : ${facetAddress}`);

  const LiquidityROIFacet = await hre.ethers.getContractFactory("LiquidityROIFacet", deployer);
  const liquidityROIFacet = await LiquidityROIFacet.deploy(DEPLOY_OVERRIDES);
  await liquidityROIFacet.waitForDeployment();
  const roiFacetAddress = await liquidityROIFacet.getAddress();
  console.log(`  LiquidityROIFacet: ${roiFacetAddress}`);

  // ── Main contract ──────────────────────────────────────────────────────────
  const Liquidity = await hre.ethers.getContractFactory("Liquidity", {
    signer: deployer,
    libraries: { LiquidityMath: libAddress, LiquidityViewLib: libViewAddress },
  });
  const liquidity = await Liquidity.deploy(
    UNI_ROUTER, UNI_FACTORY, DEPLOYED_USDT, tokenAddress, facetAddress, roiFacetAddress,
    DEPLOY_OVERRIDES
  );
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  const deployTx      = liquidity.deploymentTransaction();
  const deployReceipt = await deployTx.wait();
  const deployBlock   = deployReceipt.blockNumber;
  console.log(`  Liquidity       : ${liquidityAddress}  (block ${deployBlock})`);

  // Transfer full supply + register + seed pool for all 3 tokens
  for (const t of deployedTokens) {
    const supply = await t.contract.totalSupply();
    await mine(() => t.contract.transfer(liquidityAddress, supply, TX_OVERRIDES));
    console.log(`  Token supply (${hre.ethers.formatEther(supply)} ${t.symbol}) → Liquidity ✓`);

    await mine(() => usdtCt.transfer(liquidityAddress, SEED_USDT, TX_OVERRIDES));
    console.log(`  Transferred ${hre.ethers.formatEther(SEED_USDT)} USDT → Liquidity ✓`);

    await mine(() => liquidity.addToken(t.address, t.name, t.symbol, TX_OVERRIDES));
    console.log(`  ${t.symbol} registered in platform ✓`);

    await mine(() => liquidity.seedPool(t.address, SEED_TOKENS, SEED_USDT, DEPLOY_OVERRIDES));
    console.log(`  Uniswap pool seeded: ${hre.ethers.formatEther(SEED_USDT)} USDT + ${hre.ethers.formatEther(SEED_TOKENS)} ${t.symbol}  (1 ${t.symbol} = 1 USDT = $1.00) ✓`);
  }

  // ─────────────────────────────────────────────────────────────
  // TWAP WARM-UP
  // Needs two observations ≥ 30 min apart (TWAP_PERIOD in contract).
  // On Amoy, wait real time instead of evm_increaseTime.
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  TWAP WARM-UP");
  console.log(sep());

  const obs0Receipt = await mine(() => liquidity.updateTWAP(TX_OVERRIDES));
  const obs0Block   = await provider.getBlock(obs0Receipt.blockNumber);
  console.log(
    `  Observation 0 recorded ✓  (block ${obs0Receipt.blockNumber}, ` +
    `${new Date(obs0Block.timestamp * 1000).toLocaleTimeString()})`
  );
  console.log(`  Waiting 31 sec for second observation…`);

  await waitForTwap(provider, obs0Block.timestamp);

  await mine(() => liquidity.updateTWAP(TX_OVERRIDES));
  console.log("  Observation 1 recorded ✓");
  console.log("  TWAP ready — staking rewards are claimable ✓\n");

  // ─────────────────────────────────────────────────────────────
  // Write contract-config.js  (same format as simulate.js)
  // ─────────────────────────────────────────────────────────────
  const artifact      = hre.artifacts.readArtifactSync("Liquidity");
  const configContent =
`// AUTO-GENERATED by scripts/amoytestnet/simulateamoy.js — do not edit manually
// Network: ${network} | Deployed: ${new Date().toLocaleString()}

const CONTRACT_ADDRESS        = "${liquidityAddress}";
const TOKEN_ADDRESS           = "${deployedTokens[0].address}";
const TOKEN_ADDRESS_JIGGY     = "${deployedTokens[1].address}";
const TOKEN_ADDRESS_PANWORLD  = "${deployedTokens[2].address}";
const ROUTER_ADDRESS          = "${UNI_ROUTER}";
const FACTORY_ADDRESS         = "${UNI_FACTORY}";
const WETH_ADDRESS            = "${DEPLOYED_USDT}";
const USDT_ADDRESS            = "${DEPLOYED_USDT}";
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
  // Build referral tree  (identical structure to simulate.js)
  //
  //  account[0]  → [1]       ( 1)  spine → [1]
  //  account[1]  → [2..11]   (10)  spine → [2]
  //  account[2]  → [12..20]  ( 9)  spine → [12]
  //  account[12] → [21..28]  ( 8)  spine → [21]
  //  account[21] → [29..35]  ( 7)  spine → [29]
  //  account[29] → [36..41]  ( 6)  spine → [36]
  //  account[36] → [42..46]  ( 5)  spine → [42]
  //  account[42] → [47..50]  ( 4)  spine → [47]
  //  account[47] → [51..53]  ( 3)  spine → [51]
  //  account[51] → [54..55]  ( 2)  spine → [54]
  //  account[54] → [56]      ( 1)  (leaf)
  //
  //  Total: 57 accounts (0–56)
  // ─────────────────────────────────────────────────────────────
  const groups     = [];
  const referrerOf = new Map();
  referrerOf.set(0, null);

  {
    groups.push({ referrer: 0, children: [1] });
    referrerOf.set(1, 0);

    let spineNode = 1;
    let next      = 2;
    for (let depth = 0; depth < 10; depth++) {
      const count    = 10 - depth;
      const children = [];
      for (let k = 0; k < count; k++) children.push(next++);
      groups.push({ referrer: spineNode, children });
      for (const c of children) referrerOf.set(c, spineNode);
      spineNode = children[0];
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PHASE 2 — REGISTER
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 2 — REGISTER  (account[0] pre-registered in constructor)");
  console.log(sep());

  let totalRegistered = 0;
  let totalRegSkipped = 0;

  for (const g of groups) {
    const first = g.children[0];
    const last  = g.children[g.children.length - 1];
    console.log(
      `\n  account[${String(g.referrer).padStart(2)}]  →  ` +
      `${g.children.length} referral(s)  [${String(first).padStart(2)}..${String(last).padStart(2)}]`
    );
    for (const idx of g.children) {
      const ct = new hre.ethers.Contract(liquidityAddress, artifact.abi, signers[idx]);
      const r = await mineOrSkip(
        () => ct.register(signers[g.referrer].address, TX_OVERRIDES),
        `register [${idx}] under [${g.referrer}]`
      );
      if (r) {
        console.log(
          `    [${String(idx).padStart(2)}] ${signers[idx].address}` +
          `  ← [${String(g.referrer).padStart(2)}] ✓`
        );
        totalRegistered++;
      } else {
        totalRegSkipped++;
      }
    }
  }

  console.log(`\n  ${totalRegistered} registered ✓  ${totalRegSkipped > 0 ? `(${totalRegSkipped} skipped)` : ""}\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 3 — INVEST  (BFS order: parents before children)
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 3 — INVESTMENTS  (100 USDT = $100 each, all 57 accounts)");
  console.log(sep());

  const iface = new hre.ethers.Interface([
    "event CommissionPaid(address indexed recipient, address indexed from, uint256 amount, uint256 level)",
  ]);

  const investOrder = [0, ...groups.flatMap(g => g.children)];

  let totalInvested    = 0n;
  let totalCommissions = 0n;

  let totalInvestSkipped = 0;

  for (const idx of investOrder) {
    const account = signers[idx];
    const ct      = new hre.ethers.Contract(liquidityAddress, artifact.abi, account);
    const label   = `account[${String(idx).padStart(2)}]`;

    const approveR = await mineOrSkip(
      () => usdtCt.connect(account).approve(liquidityAddress, PACKAGE_USDT, TX_OVERRIDES),
      `approve USDT for ${label}`
    );
    if (!approveR) { totalInvestSkipped++; continue; }

    const receipt = await mineOrSkip(
      () => ct.invest(tokenAddress, PACKAGE_USDT, TX_OVERRIDES),
      `invest ${label}`
    );
    if (!receipt) { totalInvestSkipped++; continue; }

    totalInvested += PACKAGE_USDT;

    const comms = [];
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "CommissionPaid") {
          comms.push({
            recipient: parsed.args.recipient,
            amount:    parsed.args.amount,
            level:     Number(parsed.args.level),
          });
        }
      } catch (_) {}
    }

    const txTotal     = comms.reduce((s, c) => s + c.amount, 0n);
    totalCommissions += txTotal;

    const refIdx   = referrerOf.get(idx);
    const refLabel = refIdx === null ? "no referrer" : `ref by [${String(refIdx).padStart(2)}]`;
    console.log(
      `\n  account[${String(idx).padStart(2)}]  ${account.address}  (${refLabel})`
    );
    console.log(`  ${sep("·", 56)}`);

    if (comms.length === 0) {
      console.log(`    (no commission events)`);
    } else {
      for (const c of comms) {
        const ratePct  = (COMM_RATES_BPS[c.level - 1] / 500).toFixed(2).replace(/\.?0+$/, "");
        const usdtAmt  = toUSDT(c.amount);
        const recvIdx  = signers.findIndex(
          s => s.address.toLowerCase() === c.recipient.toLowerCase()
        );
        const isOwner   = recvIdx === 0;
        const recvLabel = isOwner
          ? `account[00]  (owner / platform)`
          : `account[${String(recvIdx).padStart(2)}]  ${c.recipient.slice(0, 10)}…`;
        console.log(
          `    L${String(c.level).padEnd(2)}  ${String(ratePct).padStart(5)}% of T` +
          `  $${usdtAmt.padStart(7)} USDT  →  ${recvLabel}`
        );
      }
      console.log(`    ── total: $${toUSDT(txTotal)} USDT`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────
  console.log(`\n${sep("═")}`);
  console.log("  SIMULATION COMPLETE");
  console.log(sep("═"));
  for (const t of deployedTokens) {
    console.log(`  ${t.symbol.padEnd(10)}: ${t.address}`);
  }
  console.log(`  LiquidityFacet   : ${facetAddress}`);
  console.log(`  LiquidityROIFacet: ${roiFacetAddress}`);
  console.log(`  Liquidity        : ${liquidityAddress}`);
  console.log(`  Router         : ${UNI_ROUTER}`);
  console.log(`  Factory        : ${UNI_FACTORY}`);
  console.log(`  USDT           : ${DEPLOYED_USDT}`);
  const balAfter = await provider.getBalance(deployer.address);
  console.log(`  POL spent      : ~${hre.ethers.formatEther(balBefore - balAfter)} POL`);
  console.log(`  Accounts       : ${investOrder.length}  (accounts[0..56])`);
  console.log(`  Package        : 100 USDT each`);
  console.log(`  Total invested : $${toUSDT(totalInvested)} USDT`);
  console.log(`  Total comms    : $${toUSDT(totalCommissions)} USDT`);
  if (totalRegSkipped > 0)    console.log(`  Reg skipped    : ${totalRegSkipped}`);
  if (totalInvestSkipped > 0) console.log(`  Invest skipped : ${totalInvestSkipped}`);

  console.log(`\n  Tree structure:`);
  console.log(`  ${"REFERRER".padEnd(14)} ${"COUNT".padEnd(7)} RANGE`);
  console.log(`  ${sep("·", 38)}`);
  for (const g of groups) {
    const first = g.children[0], last = g.children[g.children.length - 1];
    console.log(
      `  account[${String(g.referrer).padStart(2)}]    ` +
      `${String(g.children.length).padEnd(7)}` +
      `[${String(first).padStart(2)}..${String(last).padStart(2)}]`
    );
  }

  const usdtContractBal = await usdtCt.balanceOf(liquidityAddress);
  console.log(`\n  Contract balances:`);
  console.log(`    USDT     : ${hre.ethers.formatEther(usdtContractBal)}`);
  for (const t of deployedTokens) {
    const bal = await t.contract.balanceOf(liquidityAddress);
    console.log(`    ${t.symbol.padEnd(8)}: ${hre.ethers.formatEther(bal)}`);
  }

  // ── ROI commission rates ────────────────────────────────────────
  console.log(`\n  ROI commission rates (% of investor's staking reward):`);
  ROI_RATES_DISPLAY.forEach((r, i) => console.log(`    L${i + 1}: ${r}%`));

  // ── ROI pending for spine accounts (main recipients) ───────────
  const spineAccounts = [1, 2, 12, 21, 29, 36, 42, 47, 51, 54];
  const liqArtifact   = hre.artifacts.readArtifactSync("Liquidity");
  const liq           = new hre.ethers.Contract(liquidityAddress, liqArtifact.abi, deployer);
  console.log(`\n  ROI pending (live + settled) for spine accounts:`);
  for (const idx of spineAccounts) {
    if (idx >= TOTAL_ACCOUNTS) break;
    try {
      const pending = await liq.getROIPending(signers[idx].address);
      const usdt    = parseFloat(hre.ethers.formatEther(pending)).toFixed(6);
      console.log(`    account[${String(idx).padStart(2)}]  ${usdt} USDT`);
    } catch (_) {}
  }

  // ── Unified cap for spine accounts ────────────────────────────
  console.log(`\n  Unified cap (5× invested) for spine accounts:`);
  console.log(`  ${"ACCOUNT".padEnd(14)} ${"TOTAL CAP".padEnd(14)} ${"REMAINING".padEnd(14)} STATUS`);
  console.log(`  ${sep("·", 52)}`);
  for (const idx of spineAccounts) {
    if (idx >= TOTAL_ACCOUNTS) break;
    try {
      const [, , totalCapWei, remainingWei] = await liq.getUserCommissionStats(signers[idx].address);
      const capPausedAt = await liq.getCapPausedAt(signers[idx].address);
      const totalCap  = parseFloat(hre.ethers.formatEther(totalCapWei)).toFixed(2);
      const remaining = parseFloat(hre.ethers.formatEther(remainingWei)).toFixed(2);
      const status    = Number(capPausedAt) > 0 ? "⏸ paused" : "▶ active";
      console.log(
        `  account[${String(idx).padStart(2)}]     ` +
        `$${totalCap}`.padEnd(14) + `$${remaining}`.padEnd(14) + status
      );
    } catch (_) {}
  }

  console.log(sep("═") + "\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
