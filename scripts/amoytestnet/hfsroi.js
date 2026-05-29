// Polygon Amoy half-simulation with ROI commission system.
//
// Same flow as halfsimulateamoy.js PLUS:
//   • Deploys LiquidityFacet and LiquidityROIFacet before Liquidity
//   • Liquidity constructor takes (router, factory, weth, platformToken, facet, roiFacet)
//   • Phase 4: inspect ROI streams and pending ETH for all accounts
//
// RUN:
//   1. npx hardhat run scripts/amoytestnet/amoynode.js --network polygonAmoy
//   2. npx hardhat run scripts/amoytestnet/hfsroi.js   --network polygonAmoy
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
const PACKAGE_ETH  = hre.ethers.parseEther("0.1");
const SEED_ETH     = hre.ethers.parseEther("100");
const SEED_TOKENS  = hre.ethers.parseEther("100000");

const TOTAL_WALLETS  = 32;
const TWAP_WAIT_SECS = 31;

const DEPLOY_OVERRIDES = {
  maxFeePerGas:         hre.ethers.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: hre.ethers.parseUnits("30", "gwei"),
  gasLimit: 15_000_000,
};
const TX_OVERRIDES = {
  maxFeePerGas:         hre.ethers.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: hre.ethers.parseUnits("30", "gwei"),
  gasLimit: 5_000_000,  // invest() makes multiple DELEGATECALLs + ROI stream SSTOREs
};

const COMM_RATES_BPS = [5000, 2500, 1000, 300, 250, 225, 200, 200, 175, 150];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mine(txPromise) {
  const tx = await txPromise;
  while (true) {
    try {
      const receipt = await tx.wait();
      await sleep(500);
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
function toETH(wei) {
  return parseFloat(hre.ethers.formatEther(wei)).toFixed(6);
}
function sep(c = "─", n = 60) { return c.repeat(n); }

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

//  Referral tree (5-4-3-2-1 pattern, 2 cycles):
//  account[0]   →  [1]
//  -- cycle 1 --
//  account[1]   →  [2, 3, 4, 5, 6]       (5)
//  account[2]   →  [7, 8, 9, 10]          (4)
//  account[7]   →  [11, 12, 13]           (3)
//  account[11]  →  [14, 15]               (2)
//  account[14]  →  [16]                   (1)
//  -- cycle 2 --
//  account[16]  →  [17, 18, 19, 20, 21]  (5)
//  account[17]  →  [22, 23, 24, 25]       (4)
//  account[22]  →  [26, 27, 28]           (3)
//  account[26]  →  [29, 30]               (2)
//  account[29]  →  [31]                   (1)
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

const referrerOf = new Map();
referrerOf.set(0, null);
for (const g of groups) {
  for (const c of g.children) referrerOf.set(c, g.referrer);
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
  console.log("  HFSROI — Deploy · Referral Tree · Investments · ROI Streams");
  console.log(sep("═"));
  console.log(`  Network  : ${network}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Accounts : 32 (0–31)\n`);

  const bal0  = await provider.getBalance(signers[0].address);
  const bal31 = await provider.getBalance(signers[31].address);
  if (bal0 < hre.ethers.parseEther("310")) {
    console.error("❌  account[00] needs ≥ 310 POL (3 × 100 MATIC seed + gas). Run amoynode.js first.");
    process.exit(1);
  }
  if (bal31 < hre.ethers.parseEther("0.15")) {
    console.error("❌  account[31] has < 0.15 POL. Run amoynode.js first to fund sub-wallets.");
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────
  // PHASE 1 — DEPLOY
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 1 — DEPLOY");
  console.log(sep());

  const tokenDefs = [
    { name: "Hordex",   symbol: "HDX" },
    { name: "Jiggy",    symbol: "JGY" },
    { name: "PanWorld", symbol: "PwD" },
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

  const tokenAddress = deployedTokens[0].address;   // HDX = platform token

  // ── Libraries ──────────────────────────────────────────────────────────────
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
    UNI_ROUTER, UNI_FACTORY, UNI_WETH, tokenAddress, DEPLOY_OVERRIDES
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
    UNI_ROUTER, UNI_FACTORY, UNI_WETH, tokenAddress, facetAddress, roiFacetAddress,
    DEPLOY_OVERRIDES
  );
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  const deployTx      = liquidity.deploymentTransaction();
  const deployReceipt = await deployTx.wait();
  const deployBlock   = deployReceipt.blockNumber;
  console.log(`  Liquidity       : ${liquidityAddress}  (block ${deployBlock})`);

  // ── Token setup ────────────────────────────────────────────────────────────
  for (const t of deployedTokens) {
    const supply = await t.contract.totalSupply();
    await mine(t.contract.transfer(liquidityAddress, supply, TX_OVERRIDES));
    console.log(`  Token supply (${hre.ethers.formatEther(supply)} ${t.symbol}) → Liquidity ✓`);

    await mine(liquidity.addToken(t.address, t.name, t.symbol, TX_OVERRIDES));
    console.log(`  ${t.symbol} registered in platform ✓`);

    await mine(liquidity.seedPool(t.address, SEED_TOKENS, { value: SEED_ETH, ...DEPLOY_OVERRIDES }));
    console.log(`  Uniswap pool seeded: 100 MATIC + 100,000 ${t.symbol}  (1 ${t.symbol} = 0.001 MATIC = $1.00) ✓`);
  }

  // ─────────────────────────────────────────────────────────────
  // TWAP WARM-UP
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
  console.log("  TWAP ready — staking rewards and ROI claims are enabled ✓\n");

  // ─────────────────────────────────────────────────────────────
  // Write contract-config.js
  // ─────────────────────────────────────────────────────────────
  const artifact      = hre.artifacts.readArtifactSync("Liquidity");
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

  for (const g of groups) {
    console.log(
      `\n  account[${g.referrer}]  →  ${g.children.length} referral(s)  [${g.children.join(", ")}]`
    );
    for (const idx of g.children) {
      const ct = new hre.ethers.Contract(liquidityAddress, artifact.abi, signers[idx]);
      await mine(ct.register(signers[g.referrer].address, TX_OVERRIDES));
      console.log(`    [${idx}] ${signers[idx].address}  ← [${g.referrer}] ✓`);
    }
  }

  const totalRegistered = groups.reduce((s, g) => s + g.children.length, 0);
  console.log(`\n  ${totalRegistered} accounts registered ✓\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 3 — INVEST  (BFS order: parents before children)
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 3 — INVESTMENTS  (100 USDT = 0.1 MATIC each, all 7 accounts)");
  console.log(sep());

  const commIface = new hre.ethers.Interface([
    "event CommissionPaid(address indexed recipient, address indexed from, uint256 amount, uint256 level)",
  ]);

  const investOrder = [0, ...groups.flatMap(g => g.children)];
  const lockIndexOf = new Map();   // investor idx → lock index used

  let totalInvested    = 0n;
  let totalCommissions = 0n;

  for (const idx of investOrder) {
    const account = signers[idx];
    const ct      = new hre.ethers.Contract(liquidityAddress, artifact.abi, account);

    // Record lock count before invest to determine which lock index was created
    const locksBefore = await liquidity.getUserLPLocks(account.address);
    const lockIndex   = locksBefore.length;   // new lock will be at this index
    lockIndexOf.set(idx, lockIndex);

    const receipt = await mine(ct.invest(tokenAddress, { value: PACKAGE_ETH, ...TX_OVERRIDES }));

    totalInvested += PACKAGE_ETH;

    const comms = [];
    for (const log of receipt.logs) {
      try {
        const parsed = commIface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "CommissionPaid") {
          comms.push({
            recipient : parsed.args.recipient,
            amount    : parsed.args.amount,
            level     : Number(parsed.args.level),
          });
        }
      } catch (_) {}
    }

    const txTotal     = comms.reduce((s, c) => s + c.amount, 0n);
    totalCommissions += txTotal;

    const refIdx   = referrerOf.get(idx);
    const refLabel = refIdx === null ? "no referrer" : `ref by [${refIdx}]`;
    console.log(`\n  account[${idx}]  ${account.address}  (${refLabel})`);
    console.log(`  ${sep("·", 56)}`);

    if (comms.length === 0) {
      console.log(`    (no commission events)`);
    } else {
      for (const c of comms) {
        const ratePct   = (COMM_RATES_BPS[c.level - 1] / 500).toFixed(2).replace(/\.?0+$/, "");
        const usdtAmt   = toUSDT(c.amount);
        const recvIdx   = signers.findIndex(s => s.address.toLowerCase() === c.recipient.toLowerCase());
        const isOwner   = recvIdx === 0;
        const recvLabel = isOwner
          ? `account[0]  (owner / platform)`
          : `account[${recvIdx}]  ${c.recipient.slice(0, 10)}…`;
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
  console.log(`\n${sep()}`);
  console.log("  PHASE 4 — ROI STREAMS");
  console.log(`  ${sep("·", 58)}`);
  console.log("  Each investment creates 10 per-level ROI streams.");
  console.log("  The stream accumulates ETH-equivalent for the eligible");
  console.log("  referrer at that level, claimable as platform tokens.\n");
  console.log(sep());

  const LEVEL_NAMES = ["L1 (50%)", "L2 (25%)", "L3 (10%)", "L4 (3%)", "L5 (2.5%)",
                       "L6 (2.25%)", "L7 (2%)", "L8 (2%)", "L9 (1.75%)", "L10 (1.5%)"];

  // Show active streams held by each account (as recipient)
  console.log("  ── Active streams per account (as recipient) ──\n");
  for (let idx = 0; idx < signers.length; idx++) {
    const addr    = signers[idx].address;
    const streams = await liquidity.getActiveROIStreams(addr);
    const pending = await liquidity.getROIPending(addr);

    if (streams.length === 0) continue;

    console.log(`  account[${idx}]  ${addr}`);
    console.log(`  ${sep("·", 56)}`);
    console.log(`  Receiving ${streams.length} stream(s) as ROI recipient:`);

    for (const s of streams) {
      const investorIdx = signers.findIndex(
        w => w.address.toLowerCase() === s.investor.toLowerCase()
      );
      const investorLabel = investorIdx >= 0 ? `account[${investorIdx}]` : s.investor.slice(0, 10) + "…";
      const lvl     = Number(s.level);
      const accrued = await liquidity.getROIAccrued(s.investor, s.lockIndex, s.level);
      const info    = await liquidity.getROIStreamInfo(s.investor, s.lockIndex, s.level);
      const capUSDT = toUSDT(info.capETH);

      console.log(
        `    ${LEVEL_NAMES[lvl].padEnd(12)}  investor=${investorLabel}` +
        `  lock=${s.lockIndex}` +
        `  accrued=${toETH(accrued)} MATIC` +
        `  cap=$${capUSDT}`
      );
    }

    console.log(`  Pending (settled): ${toETH(pending)} MATIC\n`);
  }

  // Show each investor's lock's full stream table (levels 1–5 only for brevity)
  console.log("  ── Stream recipients per investment (levels 1–5) ──\n");
  for (const idx of investOrder) {
    const addr      = signers[idx].address;
    const lockIndex = lockIndexOf.get(idx);
    const locks     = await liquidity.getUserLPLocks(addr);
    const lock      = locks[lockIndex];
    const ethInv    = lock.ethInvested;
    const refIdx    = referrerOf.get(idx);
    if (refIdx === null) {
      console.log(`  account[${idx}]  (owner — no referrer chain, no ROI streams)`);
      continue;
    }
    console.log(`  account[${idx}] lock#${lockIndex}  ethInvested=${toETH(ethInv)} MATIC`);
    for (let lvl = 0; lvl < 5; lvl++) {
      const info = await liquidity.getROIStreamInfo(addr, lockIndex, lvl);
      const recvIdx = signers.findIndex(
        w => w.address.toLowerCase() === info.recipient.toLowerCase()
      );
      const recvLabel = recvIdx >= 0 ? `account[${recvIdx}]` : info.recipient.slice(0, 10) + "…";
      const capUSDT   = toUSDT(info.capETH);
      console.log(
        `    ${LEVEL_NAMES[lvl].padEnd(12)}  → ${recvLabel}` +
        `  cap=$${capUSDT}  ended=${info.ended}`
      );
    }
    console.log();
  }

  // ─────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────
  console.log(sep("═"));
  console.log("  HFSROI COMPLETE");
  console.log(sep("═"));
  for (const t of deployedTokens) {
    console.log(`  ${t.symbol.padEnd(10)}: ${t.address}`);
  }
  console.log(`  LiquidityFacet   : ${facetAddress}`);
  console.log(`  LiquidityROIFacet: ${roiFacetAddress}`);
  console.log(`  Liquidity        : ${liquidityAddress}`);
  console.log(`  Router           : ${UNI_ROUTER}`);
  console.log(`  Factory          : ${UNI_FACTORY}`);
  console.log(`  WETH             : ${UNI_WETH}`);
  console.log(`  Accounts         : 32  (accounts[0..31])`);
  console.log(`  Package          : 100 USDT (0.1 MATIC) each`);
  console.log(`  Total invested   : $${toUSDT(totalInvested)} USDT`);
  console.log(`  Total comms      : $${toUSDT(totalCommissions)} USDT`);

  console.log(`\n  Tree structure:`);
  console.log(`  ${"REFERRER".padEnd(12)} ${"COUNT".padEnd(7)} CHILDREN`);
  console.log(`  ${sep("·", 36)}`);
  for (const g of groups) {
    console.log(
      `  account[${g.referrer}]    ` +
      `${String(g.children.length).padEnd(7)}` +
      `[${g.children.join(", ")}]`
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
