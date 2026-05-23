// Polygon Amoy simulation — exact equivalent of scripts/simulate.js on Hardhat.
//
// Differences from simulate.js:
//   • Uses pre-deployed Uniswap V2 contracts on Polygon Amoy
//   • 57 signers derived from PRIVATE_KEY (funded by amoynode.js)
//   • TWAP warm-up waits real 31 sec instead of evm_increaseTime
//   • Pool seed: 100 MATIC + 100,000 tokens per pool (1 token = 0.001 MATIC = $1.00)
//   • Investment package: 0.1 MATIC = 100 USDT (identical to simulate.js)
//
// RUN:
//   1. npx hardhat run scripts/amoytestnet/amoynode.js --network polygonAmoy
//   2. npx hardhat run scripts/amoytestnet/simulateamoy.js --network polygonAmoy
//
// account[00] needs ≥ 310 POL (3 × 100 seed + gas).

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Pre-deployed Uniswap V2 on Polygon Amoy ──────────────────────────────────
const UNI_ROUTER  = "0x85eaBB2740eD2f9e3b53c51D8e1E7BdA53672825";
const UNI_FACTORY = "0xa5d020Eb5a4D537f56F7314d2359f7770DE01a48";
const UNI_WETH    = "0x7Bd0A72d3A07353C91dDA48D2B78454248d281E6";

const USDT_PER_ETH = 1000;
// Same package as simulate.js: 0.1 MATIC = 100 USDT
const PACKAGE_ETH  = hre.ethers.parseEther("0.1");
// Seed: 100 MATIC + 100,000 tokens per pool → 1 token = 0.001 MATIC = $1.00
const SEED_ETH     = hre.ethers.parseEther("100");
const SEED_TOKENS  = hre.ethers.parseEther("100000");

const TOTAL_WALLETS  = 60;
const TOTAL_ACCOUNTS = 57; // accounts [0..56] used in simulation (same as simulate.js)
const TWAP_WAIT_SECS = 31; // 31 sec for testing — change to 31 * 60 for mainnet

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
  gasLimit: 2_000_000,   // 60 gwei × 2M = 0.12 POL < 1 POL cap
};

const COMM_RATES_BPS = [5000, 2500, 1000, 300, 250, 225, 200, 200, 175, 150];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Send a transaction and wait until it is mined.
// Retries the receipt poll on transient network errors (ECONNRESET, timeout).
async function mine(txPromise) {
  const tx = await txPromise;
  while (true) {
    try {
      const receipt = await tx.wait();
      await sleep(500); // brief pause so the RPC isn't slammed back-to-back
      return receipt;
    } catch (e) {
      const transient = e.code === "ECONNRESET" ||
                        e.code === "ETIMEDOUT"  ||
                        e.message?.includes("ECONNRESET") ||
                        e.message?.includes("timeout");
      if (transient) {
        process.stdout.write("\r  Network hiccup — retrying wait…          ");
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }
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

  // Sanity-check: account[0] and at least account[56] must have some balance
  const bal0  = await provider.getBalance(signers[0].address);
  const bal56 = await provider.getBalance(signers[56].address);
  if (bal0 < hre.ethers.parseEther("310")) {
    console.error("❌  account[00] needs ≥ 310 POL (3 × 100 MATIC seed + gas). Run amoynode.js first.");
    process.exit(1);
  }
  if (bal56 < hre.ethers.parseEther("0.15")) {
    console.error("❌  account[56] has < 0.15 POL. Run amoynode.js first to fund sub-wallets.");
    process.exit(1);
  }

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

  const Liquidity = await hre.ethers.getContractFactory("Liquidity", {
    signer: deployer,
    libraries: { LiquidityMath: libAddress, LiquidityViewLib: libViewAddress },
  });
  const liquidity = await Liquidity.deploy(UNI_ROUTER, UNI_FACTORY, UNI_WETH, tokenAddress, DEPLOY_OVERRIDES);
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  const deployTx      = liquidity.deploymentTransaction();
  const deployReceipt = await deployTx.wait();
  const deployBlock   = deployReceipt.blockNumber;
  console.log(`  Liquidity   : ${liquidityAddress}  (block ${deployBlock})`);

  // Transfer full supply + register + seed pool for all 3 tokens
  const seedETH    = SEED_ETH;
  const seedTokens = SEED_TOKENS;

  for (const t of deployedTokens) {
    const supply = await t.contract.totalSupply();
    await mine(t.contract.transfer(liquidityAddress, supply, TX_OVERRIDES));
    console.log(`  Token supply (${hre.ethers.formatEther(supply)} ${t.symbol}) → Liquidity ✓`);

    await mine(liquidity.addToken(t.address, t.name, t.symbol, TX_OVERRIDES));
    console.log(`  ${t.symbol} registered in platform ✓`);

    await mine(liquidity.seedPool(t.address, seedTokens, { value: seedETH, ...DEPLOY_OVERRIDES }));
    console.log(`  Uniswap pool seeded: 100 MATIC + 100,000 ${t.symbol}  (1 ${t.symbol} = 0.001 MATIC = $1.00) ✓`);
  }

  // ─────────────────────────────────────────────────────────────
  // TWAP WARM-UP
  // Needs two observations ≥ 30 min apart (TWAP_PERIOD in contract).
  // On Amoy, wait real time instead of evm_increaseTime.
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  TWAP WARM-UP");
  console.log(sep());

  const obs0Receipt = await mine(liquidity.updateTWAP(TX_OVERRIDES));
  const obs0Block   = await provider.getBlock(obs0Receipt.blockNumber);
  console.log(
    `  Observation 0 recorded ✓  (block ${obs0Receipt.blockNumber}, ` +
    `${new Date(obs0Block.timestamp * 1000).toLocaleTimeString()})`
  );
  console.log(`  Waiting 31 sec for second observation…`);

  await waitForTwap(provider, obs0Block.timestamp);

  await mine(liquidity.updateTWAP(TX_OVERRIDES));
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
const WETH_ADDRESS            = "${UNI_WETH}";
const DEPLOY_BLOCK            = ${deployBlock};

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

  for (const g of groups) {
    const first = g.children[0];
    const last  = g.children[g.children.length - 1];
    console.log(
      `\n  account[${String(g.referrer).padStart(2)}]  →  ` +
      `${g.children.length} referral(s)  [${String(first).padStart(2)}..${String(last).padStart(2)}]`
    );
    for (const idx of g.children) {
      const ct = new hre.ethers.Contract(liquidityAddress, artifact.abi, signers[idx]);
      await mine(ct.register(signers[g.referrer].address, TX_OVERRIDES));
      console.log(
        `    [${String(idx).padStart(2)}] ${signers[idx].address}` +
        `  ← [${String(g.referrer).padStart(2)}] ✓`
      );
    }
  }

  const totalRegistered = groups.reduce((s, g) => s + g.children.length, 0);
  console.log(`\n  ${totalRegistered} accounts registered ✓\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 3 — INVEST  (BFS order: parents before children)
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 3 — INVESTMENTS  (100 USDT = 0.1 MATIC each, all 57 accounts)");
  console.log(sep());

  const iface = new hre.ethers.Interface([
    "event CommissionPaid(address indexed recipient, address indexed from, uint256 amount, uint256 level)",
  ]);

  const investOrder = [0, ...groups.flatMap(g => g.children)];

  let totalInvested    = 0n;
  let totalCommissions = 0n;

  for (const idx of investOrder) {
    const account = signers[idx];
    const ct      = new hre.ethers.Contract(liquidityAddress, artifact.abi, account);

    const receipt = await mine(ct.invest(tokenAddress, { value: PACKAGE_ETH, ...TX_OVERRIDES }));

    totalInvested += PACKAGE_ETH;

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
  console.log(`  Liquidity      : ${liquidityAddress}`);
  console.log(`  Router         : ${UNI_ROUTER}`);
  console.log(`  Factory        : ${UNI_FACTORY}`);
  console.log(`  WETH           : ${UNI_WETH}`);
  console.log(`  Accounts       : ${investOrder.length}  (accounts[0..56])`);
  console.log(`  Package        : 100 USDT (0.1 MATIC) each`);
  console.log(`  Total invested : $${toUSDT(totalInvested)} USDT`);
  console.log(`  Total comms    : $${toUSDT(totalCommissions)} USDT`);

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
