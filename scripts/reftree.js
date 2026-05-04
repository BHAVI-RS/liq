// reftree.js — run after deploy.js
// Builds a triangular referral tree and has every account invest 100 USDT.
//
// Tree shape (each referrer's direct-referral count decreases by 1):
//   account[0]  → refers 10 accounts : [1..10]
//   account[1]  → refers  9 accounts : [11..19]
//   account[2]  → refers  8 accounts : [20..27]
//   account[3]  → refers  7 accounts : [28..34]
//   account[4]  → refers  6 accounts : [35..40]
//   account[5]  → refers  5 accounts : [41..45]
//   account[6]  → refers  4 accounts : [46..49]
//   account[7]  → refers  3 accounts : [50..52]
//   account[8]  → refers  2 accounts : [53..54]
//   account[9]  → refers  1 account  : [55]
//   account[10] → refers  0 accounts
//
// Total: 56 accounts (0–55).  Hardhat is configured with 60 — fine.
//
// Usage:
//   npx hardhat node                           (terminal 1)
//   npx hardhat run scripts/deploy.js   --network localhost  (terminal 2)
//   npx hardhat run scripts/reftree.js  --network localhost  (terminal 2)

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const USDT_PER_ETH = 1000;
const PACKAGE_ETH  = hre.ethers.parseEther("0.1"); // 100 USDT

// Commission rates (BPS applied to A40 = 20 % of investment).
// Divide by 500 to get % of total investment.
const COMM_RATES_BPS = [5000, 2500, 1000, 300, 250, 225, 200, 200, 175, 150];

// ─── helpers ────────────────────────────────────────────────────────────────

function toUSDT(bigintWei) {
  return (parseFloat(hre.ethers.formatEther(bigintWei)) * USDT_PER_ETH).toFixed(2);
}

function pad(n, w = 2) { return String(n).padStart(w); }
function sep(c = "─", n = 66) { return c.repeat(n); }

// ─── build tree ─────────────────────────────────────────────────────────────
//
// Returns an array of { referee, referrer } sorted top-down (breadth-first).
// referrer index 0..10, referee index 1..55.

function buildTree() {
  const entries = [];
  let next = 1;
  for (let referrer = 0; referrer <= 9; referrer++) {
    const count = 10 - referrer;   // 10, 9, 8 … 1
    for (let k = 0; k < count; k++) {
      entries.push({ referee: next, referrer });
      next++;
    }
  }
  return entries; // 55 entries; accounts 0..55 total
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  // ── load contract-config.js ──────────────────────────────────────────────
  const cfgPath = path.join(__dirname, "..", "contract-config.js");
  if (!fs.existsSync(cfgPath))
    throw new Error("contract-config.js not found — run deploy.js first.");

  const cfgSrc = fs.readFileSync(cfgPath, "utf8");

  const contractMatch = cfgSrc.match(/const CONTRACT_ADDRESS\s*=\s*"([^"]+)"/);
  const tokenMatch    = cfgSrc.match(/const TOKEN_ADDRESS\s*=\s*"([^"]+)"/);
  if (!contractMatch || !tokenMatch)
    throw new Error("CONTRACT_ADDRESS or TOKEN_ADDRESS missing from contract-config.js");

  const CONTRACT_ADDRESS = contractMatch[1];
  const TOKEN_ADDRESS    = tokenMatch[1];
  const ABI              = hre.artifacts.readArtifactSync("Liquidity").abi;

  const signers = await hre.ethers.getSigners();
  const TOTAL   = 56; // accounts 0–55

  if (signers.length < TOTAL)
    throw new Error(`Need ${TOTAL} signers — only ${signers.length} available.`);

  console.log(sep("═"));
  console.log("  REFTREE — Referral Tree + 100 USDT Investments");
  console.log(sep("═"));
  console.log(`  Network  : ${hre.network.name}`);
  console.log(`  Contract : ${CONTRACT_ADDRESS}`);
  console.log(`  Token    : ${TOKEN_ADDRESS}`);
  console.log(`  Accounts : ${TOTAL}  (signers[0..${TOTAL - 1}])\n`);

  const tree = buildTree(); // 55 registration entries

  // ── PHASE 1 — REGISTER ───────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 1 — REGISTER  (account[0] is pre-registered by constructor)");
  console.log(sep());

  // group entries by referrer for the tree-print header
  const byReferrer = {};
  for (const e of tree) {
    (byReferrer[e.referrer] ??= []).push(e.referee);
  }

  for (const [refStr, referees] of Object.entries(byReferrer)) {
    const refIdx = Number(refStr);
    const first  = referees[0];
    const last   = referees[referees.length - 1];
    console.log(`\n  account[${pad(refIdx)}]  refers ${referees.length} account(s) → [${pad(first)}..${pad(last)}]`);

    for (const referee of referees) {
      const account  = signers[referee];
      const referrer = signers[refIdx];
      const ct = new hre.ethers.Contract(CONTRACT_ADDRESS, ABI, account);
      await (await ct.register(referrer.address)).wait();
      console.log(
        `    [${pad(referee)}] ${account.address}  ← [${pad(refIdx)}] ${referrer.address}  ✓`
      );
    }
  }

  const totalRegistered = tree.length;
  console.log(`\n  ${totalRegistered} accounts registered ✓\n`);

  // ── PHASE 2 — INVEST ────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 2 — INVEST  (100 USDT = 0.1 ETH each, all 56 accounts)");
  console.log(sep());

  const iface = new hre.ethers.Interface([
    "event CommissionPaid(address indexed recipient, address indexed from, uint256 amount, uint256 level)",
  ]);

  // index → referrer index (for display)
  const referrerOf = { 0: null };
  for (const e of tree) referrerOf[e.referee] = e.referrer;

  let grandTotalInvested    = 0n;
  let grandTotalCommissions = 0n;

  // Invest account[0] first, then all others in registration order
  const investOrder = [0, ...tree.map(e => e.referee)];

  for (const idx of investOrder) {
    const account = signers[idx];
    const ct      = new hre.ethers.Contract(CONTRACT_ADDRESS, ABI, account);

    const tx      = await ct.invest(TOKEN_ADDRESS, { value: PACKAGE_ETH });
    const receipt = await tx.wait();

    grandTotalInvested += PACKAGE_ETH;

    // parse CommissionPaid events
    const comms = [];
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "CommissionPaid") {
          comms.push({
            recipient : parsed.args.recipient,
            amount    : parsed.args.amount,
            level     : Number(parsed.args.level),
          });
        }
      } catch (_) {}
    }

    const txComm      = comms.reduce((s, c) => s + c.amount, 0n);
    grandTotalCommissions += txComm;

    const refLabel = referrerOf[idx] === null
      ? "no referrer (owner)"
      : `ref by [${pad(referrerOf[idx])}]`;

    console.log(
      `\n  account[${pad(idx)}]  ${account.address}` +
      `  (${refLabel})`
    );
    console.log(`  ${sep("·", 62)}`);

    if (comms.length === 0) {
      console.log(`    (no commission events)`);
    } else {
      for (const c of comms) {
        const ratePct  = (COMM_RATES_BPS[c.level - 1] / 500).toFixed(2).replace(/\.?0+$/, "");
        const usdtAmt  = toUSDT(c.amount);
        const recvIdx  = signers.findIndex(
          s => s.address.toLowerCase() === c.recipient.toLowerCase()
        );
        const isOwner  = recvIdx === 0;
        const recvLabel = isOwner
          ? `account[00]  (owner / platform)`
          : `account[${pad(recvIdx)}]  ${c.recipient.slice(0, 10)}…`;
        console.log(
          `    L${String(c.level).padEnd(2)}  ${String(ratePct).padStart(5)}% → ` +
          `$${usdtAmt.padStart(7)} USDT  → ${recvLabel}`
        );
      }
      console.log(`    ─── total distributed: $${toUSDT(txComm)} USDT`);
    }
  }

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  console.log(`\n${sep("═")}`);
  console.log("  COMPLETE");
  console.log(sep("═"));
  console.log(`  Accounts invested   : ${investOrder.length}  (accounts[0..55])`);
  console.log(`  Package per account : 100 USDT  (0.1 ETH)`);
  console.log(`  Total invested      : $${toUSDT(grandTotalInvested)} USDT`);
  console.log(`  Total commissions   : $${toUSDT(grandTotalCommissions)} USDT`);

  // print tree summary
  console.log(`\n  Tree summary:`);
  console.log(`  ${"REFERRER".padEnd(14)} ${"REFERRALS".padEnd(12)} RANGE`);
  console.log(`  ${sep("·", 42)}`);
  for (const [refStr, referees] of Object.entries(byReferrer)) {
    const refIdx = Number(refStr);
    const first  = referees[0];
    const last   = referees[referees.length - 1];
    console.log(
      `  account[${pad(refIdx)}]   ${String(referees.length).padEnd(12)}` +
      `[${pad(first)}..${pad(last)}]`
    );
  }
  console.log(sep("═") + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
