// ROI Commission System — Deploy, Invest, Inspect
//
// Deploys all contracts, seeds the pool, warms TWAP, builds a referral tree,
// invests for all 7 accounts, then prints the full ROI stream table so you
// can verify each stream's recipient matches the expected assignment.
//
// Referral tree:
//   account[0] (Owner, pre-registered)
//   └─ account[1]
//      ├─ account[2]
//      │   ├─ account[5]
//      │   └─ account[6]
//      ├─ account[3]
//      └─ account[4]
//
// Invest order (BFS): 0 → 1 → 2 → 3 → 4 → 5 → 6
//
// Expected ROI stream table after all 7 invest:
//   acc[0] lock: all nobody   (Owner has no referrers above)
//   acc[1] lock: L1=Owner     L2+=Owner
//   acc[2] lock: L1=acc[1]    L2+=Owner
//   acc[3] lock: L1=acc[1]    L2+=Owner
//   acc[4] lock: L1=acc[1]    L2+=Owner
//   acc[5] lock: L1=acc[2]    L2=acc[1]    L3+=Owner
//   acc[6] lock: L1=acc[2]    L2=acc[1]    L3+=Owner
//
// REQUIREMENTS:
//   account[0] needs ≥ 10 POL
//     (1 MATIC pool seed + 6 × 0.5 POL sub-wallet funding + gas)
//
// RUN:
//   npx hardhat run scripts/amoytestnet/roitest.js --network polygonAmoy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const UNI_ROUTER  = "0x85eaBB2740eD2f9e3b53c51D8e1E7BdA53672825";
const UNI_FACTORY = "0xa5d020Eb5a4D537f56F7314d2359f7770DE01a48";
const UNI_WETH    = "0x7Bd0A72d3A07353C91dDA48D2B78454248d281E6";

const TOTAL_WALLETS  = 7;
const SEED_ETH       = hre.ethers.parseEther("100");     // 100 MATIC seed (must be large enough so
const SEED_TOKENS    = hre.ethers.parseEther("100000");  // that each 0.1 MATIC invest causes < 5%
                                                          // spot price drift from TWAP (guard bps=500)
const PACKAGE_ETH    = hre.ethers.parseEther("0.1");     // 0.1 MATIC = $100
const FUND_AMOUNT    = hre.ethers.parseEther("0.5");     // fund each sub-wallet
const FUND_THRESHOLD = hre.ethers.parseEther("0.38");    // skip if already above this
const TWAP_WAIT_SECS = 31;                               // 31 s testnet; use 31*60 for mainnet

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

// Referral tree: { referrer → children }
const groups = [
  { referrer: 0, children: [1]       },
  { referrer: 1, children: [2, 3, 4] },
  { referrer: 2, children: [5, 6]    },
];
// BFS invest order
const INVEST_ORDER = [0, 1, 2, 3, 4, 5, 6];

// Level rates for display
const LEVEL_RATES = [50, 25, 10, 3, 2.5, 2.25, 2, 2, 1.75, 1.5];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sep(c = "─", n = 64) { return c.repeat(n); }
function toUSD(wei) {
  return "$" + (parseFloat(hre.ethers.formatEther(wei)) * 1000).toFixed(2);
}

function deriveWallets(rawKey, provider) {
  const pk = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
  const wallets = [new hre.ethers.Wallet(pk, provider)];
  for (let i = 1; i < TOTAL_WALLETS; i++) {
    wallets.push(new hre.ethers.Wallet(
      hre.ethers.keccak256(hre.ethers.solidityPacked(["bytes32", "uint256"], [pk, i])),
      provider
    ));
  }
  return wallets;
}

function isTransient(e) {
  return ["ECONNRESET","ETIMEDOUT","UND_ERR_SOCKET"].includes(e.code) ||
    ["ECONNRESET","ETIMEDOUT","timeout","network"].some(k => e.message?.includes(k));
}

async function mine(txFn, maxRetries = 6) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let tx;
    try { tx = await txFn(); }
    catch (e) {
      if (isTransient(e) && attempt < maxRetries - 1) {
        await sleep(4000 * (attempt + 1)); continue;
      }
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
      process.stdout.write(`\r  TWAP warm-up: ${String(Math.floor(rem/60)).padStart(2,"0")}:${String(rem%60).padStart(2,"0")} remaining…`);
    } catch (_) {}
    await sleep(2000);
  }
  process.stdout.write("\r  TWAP warm-up: complete!                             \n");
}

// ── Print ROI stream table ────────────────────────────────────────────────────
async function printROITable(liquidity, signers) {
  console.log("\n" + sep());
  console.log("  ROI STREAM TABLE  (first lock for each investor, levels L1–L5)");
  console.log(sep());
  console.log(
    "  " +
    "INVESTOR".padEnd(14) +
    "LEVEL".padEnd(10) +
    "RATE".padEnd(8) +
    "RECIPIENT".padEnd(14) +
    "CAP (USDT)"
  );
  console.log("  " + sep("·", 62));

  for (const idx of INVEST_ORDER) {
    const addr  = signers[idx].address;
    const locks = await liquidity.getUserLPLocks(addr);
    if (locks.length === 0) { continue; }

    let firstRow = true;
    for (let level = 0; level < 5; level++) {
      const info = await liquidity.getROIStreamInfo(addr, 0, level);
      const recvIdx = signers.findIndex(
        s => s.address.toLowerCase() === info.recipient.toLowerCase()
      );
      const recvLabel =
        info.recipient === hre.ethers.ZeroAddress ? "nobody"
        : recvIdx >= 0                            ? `acc[${recvIdx}]`
        :                                            "acc[0] (Owner)";

      const cap    = parseFloat(hre.ethers.formatEther(info.capETH)) * 1000;
      const capStr = cap === 0 ? "—" : `$${cap.toFixed(2)}`;

      console.log(
        "  " +
        (firstRow ? `acc[${idx}] lock#0`.padEnd(14) : "".padEnd(14)) +
        `L${level + 1}`.padEnd(10) +
        `${LEVEL_RATES[level]}%`.padEnd(8) +
        recvLabel.padEnd(14) +
        capStr
      );
      firstRow = false;
    }
  }
  console.log("  " + sep("·", 62));
}

// ── Print pending ROI for each account ───────────────────────────────────────
async function printROIPending(liquidity, signers) {
  console.log("\n" + sep());
  console.log("  ROI PENDING  (settled + currently accruing; claimable now)");
  console.log(sep());
  for (let idx = 0; idx < signers.length; idx++) {
    const pending = await liquidity.getROIPending(signers[idx].address);
    if (pending === 0n) continue;
    const usd = (parseFloat(hre.ethers.formatEther(pending)) * 1000).toFixed(6);
    console.log(`  acc[${idx}]  ${hre.ethers.formatEther(pending)} MATIC  (~$${usd})`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x","").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env"); process.exit(1);
  }

  const provider = hre.ethers.provider;
  const signers  = deriveWallets(rawKey, provider);
  const deployer = signers[0];
  const network  = hre.network.name;

  console.log(sep("═"));
  console.log("  ROITEST — Deploy · Register · Invest · Inspect ROI Streams");
  console.log(sep("═"));
  console.log(`  Network  : ${network}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Accounts : ${TOTAL_WALLETS}  (0–6)\n`);

  const bal0 = await provider.getBalance(deployer.address);
  console.log(`  Balance  : ${hre.ethers.formatEther(bal0)} POL\n`);
  if (bal0 < hre.ethers.parseEther("10")) {
    console.error("❌  account[0] needs ≥ 10 POL"); process.exit(1);
  }

  // ── PHASE 0: Fund sub-wallets ──────────────────────────────────────────────
  console.log(sep()); console.log("  PHASE 0 — FUND SUB-WALLETS [1..6]"); console.log(sep());
  for (let i = 1; i < TOTAL_WALLETS; i++) {
    const bal = await provider.getBalance(signers[i].address);
    if (bal >= FUND_THRESHOLD) {
      console.log(`  [${i}] ${hre.ethers.formatEther(bal).padStart(8)} POL — skip`);
      continue;
    }
    await mine(() => deployer.sendTransaction({
      to: signers[i].address, value: FUND_AMOUNT,
      maxFeePerGas: TX_OVERRIDES.maxFeePerGas,
      maxPriorityFeePerGas: TX_OVERRIDES.maxPriorityFeePerGas,
    }));
    console.log(`  [${i}] funded ${hre.ethers.formatEther(FUND_AMOUNT)} POL ✓`);
  }

  // ── PHASE 1: Platform token ────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 1 — PLATFORM TOKEN"); console.log(sep());
  const HordexToken = await hre.ethers.getContractFactory("HordexToken", deployer);
  const token = await HordexToken.deploy("Hordex", "HDX", 10_000_000, DEPLOY_OVERRIDES);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`  HORDEX  : ${tokenAddress}`);

  // ── PHASE 2: Contracts ─────────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 2 — CONTRACTS"); console.log(sep());

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
    UNI_ROUTER, UNI_FACTORY, UNI_WETH, tokenAddress,
    facetAddress, roiFacetAddress, DEPLOY_OVERRIDES
  );
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  const deployReceipt = await liquidity.deploymentTransaction().wait();
  const deployBlock   = deployReceipt.blockNumber;
  console.log(`  Liquidity        : ${liquidityAddress}  (block ${deployBlock})`);

  const artifact = hre.artifacts.readArtifactSync("Liquidity");
  const liq      = new hre.ethers.Contract(liquidityAddress, artifact.abi, deployer);

  // ── PHASE 3: Token setup ───────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 3 — TOKEN SETUP"); console.log(sep());
  const supply = await token.totalSupply();
  await mine(() => token.transfer(liquidityAddress, supply, TX_OVERRIDES));
  console.log(`  ${hre.ethers.formatEther(supply)} HORDEX → Liquidity ✓`);
  await mine(() => liq.addToken(tokenAddress, "Hordex", "HDX", TX_OVERRIDES));
  console.log(`  Token registered ✓`);
  await mine(() => liq.seedPool(tokenAddress, SEED_TOKENS, { value: SEED_ETH, ...TX_OVERRIDES }));
  console.log(`  Pool seeded: ${hre.ethers.formatEther(SEED_ETH)} MATIC + ${hre.ethers.formatEther(SEED_TOKENS)} HORDEX`);
  console.log(`  Price: 1 HORDEX = 0.001 MATIC = $1.00 ✓`);

  // ── PHASE 4: TWAP warm-up ─────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 4 — TWAP WARM-UP"); console.log(sep());
  const obs0Receipt = await mine(() => liq.updateTWAP(TX_OVERRIDES));
  const obs0Block   = await provider.getBlock(obs0Receipt.blockNumber);
  console.log(`  Observation 0  (block ${obs0Receipt.blockNumber}) ✓`);
  console.log(`  Waiting ${TWAP_WAIT_SECS}s for second observation…`);
  await waitForTwap(provider, obs0Block.timestamp);
  await mine(() => liq.updateTWAP(TX_OVERRIDES));
  console.log("  Observation 1 ✓  —  TWAP ready, staking + ROI claims enabled");

  // ── PHASE 5: Register ─────────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  PHASE 5 — REGISTER"); console.log(sep());
  for (const g of groups) {
    for (const idx of g.children) {
      const ct = new hre.ethers.Contract(liquidityAddress, artifact.abi, signers[idx]);
      await mine(() => ct.register(signers[g.referrer].address, TX_OVERRIDES));
      console.log(`  [${idx}] registered under [${g.referrer}] ✓`);
    }
  }

  // ── PHASE 6: Invest ───────────────────────────────────────────────────────
  console.log("\n" + sep());
  console.log("  PHASE 6 — INVEST  (0.1 MATIC = $100 each, BFS order)");
  console.log(sep());

  const commIface = new hre.ethers.Interface([
    "event CommissionPaid(address indexed recipient, address indexed from, uint256 amount, uint256 level)",
  ]);

  for (const idx of INVEST_ORDER) {
    const ct = new hre.ethers.Contract(liquidityAddress, artifact.abi, signers[idx]);
    const receipt = await mine(() => ct.invest(tokenAddress, { value: PACKAGE_ETH, ...TX_OVERRIDES }));

    const comms = [];
    for (const log of receipt.logs) {
      try {
        const p = commIface.parseLog({ topics: log.topics, data: log.data });
        if (p?.name === "CommissionPaid") comms.push(p.args);
      } catch (_) {}
    }

    const refGroup = groups.find(g => g.children.includes(idx));
    const refLabel = refGroup ? `ref by [${refGroup.referrer}]` : "no referrer (Owner)";
    console.log(`\n  acc[${idx}]  (${refLabel})`);

    if (comms.length === 0) {
      console.log("    no spot commissions");
    } else {
      for (const c of comms) {
        const rIdx = signers.findIndex(s => s.address.toLowerCase() === c.recipient.toLowerCase());
        const rLabel = rIdx >= 0 ? `acc[${rIdx}]` : c.recipient.slice(0, 10) + "…";
        console.log(`    L${c.level}  ${toUSD(c.amount).padStart(7)}  → ${rLabel}`);
      }
    }
  }

  // ── PHASE 7: ROI stream inspection ────────────────────────────────────────
  await printROITable(liq, signers);
  await printROIPending(liq, signers);

  // ── Write contract-config.js ──────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  WRITE CONFIG"); console.log(sep());
  const configContent =
`// AUTO-GENERATED by scripts/amoytestnet/roitest.js
// Network: ${network} | Deployed: ${new Date().toLocaleString()}

const CONTRACT_ADDRESS        = "${liquidityAddress}";
const TOKEN_ADDRESS           = "${tokenAddress}";
const TOKEN_ADDRESS_JIGGY     = "";
const TOKEN_ADDRESS_PANWORLD  = "";
const ROUTER_ADDRESS          = "${UNI_ROUTER}";
const FACTORY_ADDRESS         = "${UNI_FACTORY}";
const WETH_ADDRESS            = "${UNI_WETH}";
const DEPLOY_BLOCK            = ${deployBlock};
const FACET_ADDRESS           = "${facetAddress}";
const ROI_FACET_ADDRESS       = "${roiFacetAddress}";

const CONTRACT_ABI = ${JSON.stringify(artifact.abi, null, 2)};
`;
  fs.writeFileSync(path.join(__dirname, "..", "..", "contract-config.js"), configContent);
  fs.writeFileSync(path.join(__dirname, "..", "..", "frontend", "contract-config.js"), configContent);
  const idx = path.join(__dirname, "..", "..", "frontend", "index.html");
  if (fs.existsSync(idx)) {
    fs.writeFileSync(idx, fs.readFileSync(idx, "utf8")
      .replace(/contract-config\.js\?v=\d+/g, `contract-config.js?v=${Date.now()}`));
  }
  console.log("  contract-config.js written ✓");

  // Save addresses
  const outPath = path.join(__dirname, "deploy-output.json");
  fs.writeFileSync(outPath, JSON.stringify({
    network, deployedAt: new Date().toISOString(), deployBlock,
    tokenAddress, liquidityAddress, facetAddress, roiFacetAddress,
    libAddress, libViewAddress,
    accounts: signers.map((s, i) => ({
      index: i,
      address: s.address,
      referrer: groups.find(g => g.children.includes(i))?.referrer ?? null,
    })),
  }, null, 2));
  console.log("  deploy-output.json written ✓  (all 7 addresses + referral map)");

  // ── TESTING GUIDE ─────────────────────────────────────────────────────────
  console.log("\n" + sep("═", 64));
  console.log("  TESTING GUIDE");
  console.log(sep("═", 64));
  console.log(`
  Contracts and wallets are now live. Use any of the methods below.

  ── A. VERIFY STREAM ASSIGNMENT ─────────────────────────────────

  The ROI stream table above shows who is accumulating ROI for each
  investor's lock at each level. Verify using Hardhat console or
  your own script:

    const liq = await ethers.getContractAt("Liquidity", "${liquidityAddress}");
    const info = await liq.getROIStreamInfo(investorAddr, 0, 0);
    // info.recipient  — who is accumulating L1 ROI right now
    // info.capETH     — max total ETH-equiv this stream will ever pay
    // info.roiPaidETH — already settled to past+current recipients

  Expected recipients (see table above):
    acc[5] lock L1 → acc[2]    acc[5] lock L2 → acc[1]
    acc[6] lock L1 → acc[2]    acc[6] lock L2 → acc[1]
    acc[3] lock L1 → acc[1]
    acc[4] lock L1 → acc[1]

  ── B. WAIT AND CHECK ACCUMULATION ──────────────────────────────

  After waiting a few minutes, call getROIPending or getROIAccrued:

    // All settled + currently accumulating for an address:
    const pending = await liq.getROIPending(acc2Address);

    // Accrued for a specific stream right now (live, not settled):
    const accrued = await liq.getROIAccrued(acc5Address, 0, 0); // L1

  ROI amounts are in ETH (MATIC). At $100 investment, 90-day lock,
  26% staking reward:
    L1 total over 90 days = $2.60  →  ≈ $0.029/day ≈ $0.00003/min
    L2 total over 90 days = $1.30  →  ≈ $0.014/day

  ── C. CLAIM ROI ────────────────────────────────────────────────

  From the frontend: connect acc[2]'s wallet and click "Claim ROI".
  Or via script:

    const ct = new ethers.Contract("${liquidityAddress}", abi, acc2Signer);
    await ct.claimAllROI();                         // claim all levels
    await ct.claimROIFromStream(acc5Addr, 0, 0);   // claim acc5 lock L1 only

  This converts the accumulated ETH-equivalent to HORDEX tokens at
  the current TWAP price and transfers them to the caller.

  ── D. TEST ELIGIBILITY CASCADE (gain) ──────────────────────────

  Register a new account [7] under acc[2] and invest $100.
  This makes acc[2].activeReferralCount go from 2 → 3.

  What to observe:
  1. acc[2] was deferred for L2 of both acc[5] and acc[6] locks
     (acc[2] holds L1 but is eligible for L2 — "one at a time").
  2. The GAIN does NOT immediately give acc[2] their L2 — because
     acc[2] is still busy with L1 for those locks.
  3. Only when someone BELOW acc[2] becomes eligible for L1 (e.g.,
     register + invest under acc[5]) will acc[2] drop L1 and
     cascade to take L2, while acc[1] cascades to take L3, etc.

  Try this: register acc[7] under acc[5], then invest with acc[7].
    → acc[5].count becomes 1 → eligible for L1.
    → acc[5] takes L1 of "acc[7]'s lock" from acc[2].

  Wait — acc[5]'s L1 from acc[5]'s OWN lock is a DIFFERENT lock.
  Each investor's lock has its own set of 10 streams.

  ── E. TEST ELIGIBILITY CASCADE (loss) ──────────────────────────

  If acc[5] removes LP and their investment goes to 0:
    → acc[2].activeReferralCount drops from 2 → 1.
    → onLossReferralExt(acc[2]) fires.
    → acc[2] was holding L1 of acc[5]'s lock — it gets released.
    → _assignStream walks from acc[6] (acc[5]'s referrer chain)...
       wait, acc[5]'s lock: investor=acc[5], referrer=acc[2].
       Walk: acc[2] now count=1, still eligible (1>0). acc[2] is
       NOT in the active list for L1 any more (just released). So
       acc[2] takes L1 again if eligible + free.
    Actually: removing acc[5]'s LP ends all streams for acc[5]'s
    lock (endROIStreamsExt), and reduces acc[2]'s count so
    onLossReferralExt fires for acc[6]'s lock's L1 (if acc[2] also
    held L1 for acc[6]'s lock, which acc[2] does).
    → acc[6]'s L1 is re-assigned: walk finds acc[2]=1, still eligible.
    → acc[2] re-takes L1 for acc[6]'s lock. Net effect: no visible change
      since acc[2] remains eligible.

  ── F. FRONTEND TESTING ─────────────────────────────────────────

  1. Open the frontend, connect each account's wallet.
  2. Check the "ROI" panel to see active streams and pending amounts.
  3. After a few minutes, "Claim All ROI" for acc[1] and acc[2]
     (they are the main L2 and L1 recipients respectively).
  4. Verify the HORDEX token balance of those accounts increased.
  5. Check transaction on PolygonScan: confirm ROIClaimed event was
     emitted with the correct tokensAmount and ethEquivalent.

  ── G. ADDRESS REFERENCE ────────────────────────────────────────
`);

  for (let i = 0; i < signers.length; i++) {
    const refGroup = groups.find(g => g.children.includes(i));
    const refLabel = refGroup ? `ref by [${refGroup.referrer}]` : "Owner (no referrer)";
    console.log(`  acc[${i}]  ${signers[i].address}  (${refLabel})`);
  }

  console.log(`
  Liquidity : ${liquidityAddress}
  Token     : ${tokenAddress}
  Deploy    : block ${deployBlock}
`);
  console.log(sep("═", 64) + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
