// Derives 20,000 wallets from PRIVATE_KEY and maintains balances.
// - POL  : if below 0.02, top up to 0.05 from acc[0]
// - USDT : maintain exactly 5,000 — reclaim excess to acc[0], top up deficit from acc[0]
//
// Runs in 3 parallel phases for speed:
//   Phase 1 — Read all 19,999 balances in parallel (READ_BATCH at a time)
//   Phase 2 — Categorize into action buckets
//   Phase 3 — Two independent pipelines run simultaneously:
//               [DEPLOYER] POL sends + USDT sends (explicit nonce management)
//               [RECLAIM ] Sub-wallet USDT reclaims (no nonce conflict)
//
// USAGE:
//   npx hardhat run scripts/amoytestnet/fullnodeamoy.js --network polygonAmoy

const hre = require("hardhat");

const TOTAL          = 20_000;
const POL_TARGET     = hre.ethers.parseEther("0.05");
const POL_THRESHOLD  = hre.ethers.parseEther("0.02");

const USDT_ADDRESS   = "0x5b0Eaea74F03ED873B03d6C6ce54f6d5eDE75F9c";
const USDT_TARGET    = hre.ethers.parseEther("5000");
const USDT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const TX_OVERRIDES = {
  maxFeePerGas:         hre.ethers.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: hre.ethers.parseUnits("30", "gwei"),
  gasLimit: 100_000,
};

const READ_BATCH   = 30;    // simultaneous balance reads per chunk (keep low to avoid RPC rate limits)
const WRITE_BATCH  = 50;    // simultaneous tx submissions per chunk
const RPC_TIMEOUT  = 15_000; // ms before a hung RPC call is forcibly rejected
const READ_RETRIES = 3;     // retry a failed/timed-out read this many times

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sep(c = "─", n = 72) { return c.repeat(n); }
function pad(n, w = 5) { return String(n).padStart(w); }
function fmt(n) { return n.toLocaleString().padStart(7); }

// Races a promise against a hard timeout so hung RPC calls don't freeze the script
function withTimeout(promise, ms = RPC_TIMEOUT) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms`)), ms)
    ),
  ]);
}

// Read one account's balances with retries
async function readBalance(idx, wallet, provider, usdtCt) {
  for (let attempt = 1; attempt <= READ_RETRIES; attempt++) {
    try {
      const [polBal, usdtBal] = await Promise.all([
        withTimeout(provider.getBalance(wallet.address)),
        withTimeout(usdtCt.balanceOf(wallet.address)),
      ]);
      return { idx, polBal, usdtBal };
    } catch (e) {
      if (attempt < READ_RETRIES) {
        await sleep(2000 * attempt); // 2s, 4s backoff
      } else {
        return { idx, polBal: 0n, usdtBal: 0n, readError: true };
      }
    }
  }
}

function deriveWallets(rawKey, provider) {
  const pk = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
  const wallets = [new hre.ethers.Wallet(pk, provider)];
  for (let i = 1; i < TOTAL; i++) {
    wallets.push(new hre.ethers.Wallet(
      hre.ethers.keccak256(hre.ethers.solidityPacked(["bytes32", "uint256"], [pk, i])),
      provider
    ));
  }
  return wallets;
}

async function main() {
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env"); process.exit(1);
  }

  const provider = hre.ethers.provider;

  console.log(sep("═"));
  console.log("  FULL NODE AMOY — 20,000 Accounts  (parallel mode)");
  console.log("  Deriving wallets… (takes a moment)");
  console.log(sep("═"));

  const wallets  = deriveWallets(rawKey, provider);
  const deployer = wallets[0];
  const usdtCt   = new hre.ethers.Contract(USDT_ADDRESS, USDT_ABI, deployer);

  console.log(`  Funder   : ${deployer.address}`);
  const [funderPOL, funderUSDT] = await Promise.all([
    provider.getBalance(deployer.address),
    usdtCt.balanceOf(deployer.address),
  ]);
  console.log(`  POL      : ${hre.ethers.formatEther(funderPOL)}`);
  console.log(`  USDT     : ${hre.ethers.formatEther(funderUSDT)}`);

  // ── PHASE 1: Read all balances in parallel ────────────────────────────────
  console.log("\n" + sep());
  console.log("  PHASE 1 — READ BALANCES  (parallel, READ_BATCH=" + READ_BATCH + ")");
  console.log(sep());
  console.log(
    "  " + "PROGRESS".padEnd(24) + "READ"
  );
  console.log("  " + sep("·", 50));

  const balances = [];
  const totalAccounts = TOTAL - 1; // acc[1..19999]
  const readBatches = Math.ceil(totalAccounts / READ_BATCH);

  for (let b = 0; b < readBatches; b++) {
    const start = b * READ_BATCH + 1;
    const end   = Math.min(start + READ_BATCH, TOTAL);
    const idxs  = Array.from({ length: end - start }, (_, i) => i + start);

    // Each account has its own timeout + retry — one hung call can't freeze the batch
    const batch = await Promise.all(
      idxs.map(idx => readBalance(idx, wallets[idx], provider, usdtCt))
    );

    balances.push(...batch);

    if ((b + 1) % 10 === 0 || b === readBatches - 1) {
      const read  = end - 1;
      const pct   = ((read / totalAccounts) * 100).toFixed(1);
      const prog  = `[${String(read).padStart(5)}/${totalAccounts}] ${pct.padStart(5)}%`;
      const errs  = batch.filter(r => r.readError).length;
      const note  = errs > 0 ? `  ⚠ ${errs} read error(s) in this batch` : "";
      console.log(`  ${prog.padEnd(24)} ${read.toLocaleString()} accounts read${note}`);
    }
  }

  // ── PHASE 2: Categorize ───────────────────────────────────────────────────
  console.log("\n" + sep());
  console.log("  PHASE 2 — CATEGORIZE");
  console.log(sep());

  // deployerSends: POL + USDT sends from acc[0] — share a nonce pool
  const deployerSends = [];
  // reclaimSends: USDT reclaims from sub-wallets — fully independent
  const reclaimSends  = [];
  let polOk = 0, usdtOk = 0, readErrors = 0;

  for (const { idx, polBal, usdtBal, readError } of balances) {
    if (readError) { readErrors++; continue; }

    if (polBal < POL_THRESHOLD) {
      deployerSends.push({ idx, type: "pol", amount: POL_TARGET - polBal });
    } else {
      polOk++;
    }

    if (usdtBal < USDT_TARGET) {
      deployerSends.push({ idx, type: "usdt", amount: USDT_TARGET - usdtBal });
    } else if (usdtBal > USDT_TARGET) {
      reclaimSends.push({ idx, amount: usdtBal - USDT_TARGET });
    } else {
      usdtOk++;
    }
  }

  const polSendCount  = deployerSends.filter(s => s.type === "pol").length;
  const usdtSendCount = deployerSends.filter(s => s.type === "usdt").length;

  console.log(`  POL   : ${fmt(polSendCount)} need top-up       ${fmt(polOk)} already ok`);
  console.log(`  USDT  : ${fmt(usdtSendCount)} need top-up       ${fmt(reclaimSends.length)} need reclaim     ${fmt(usdtOk)} already ok`);
  if (readErrors > 0) console.log(`  Read errors : ${readErrors}`);

  if (deployerSends.length === 0 && reclaimSends.length === 0) {
    console.log("\n  All accounts already at target. Nothing to do.");
  } else {
    // ── PHASE 3: Execute — two parallel pipelines ─────────────────────────────
    console.log("\n" + sep());
    console.log("  PHASE 3 — EXECUTE  (two pipelines running simultaneously)");
    console.log(sep());

    // Pipeline A: Deployer sends (POL + USDT) with explicit nonce management
    async function deployerPipeline() {
      if (deployerSends.length === 0) return { ok: 0, fail: 0 };
      let ok = 0, fail = 0;
      const batches = Math.ceil(deployerSends.length / WRITE_BATCH);

      for (let b = 0; b < batches; b++) {
        const batch     = deployerSends.slice(b * WRITE_BATCH, (b + 1) * WRITE_BATCH);
        const baseNonce = await provider.getTransactionCount(deployer.address, "pending");

        const txs = await Promise.all(batch.map((s, i) => {
          const overrides = { ...TX_OVERRIDES, nonce: baseNonce + i };
          const p = s.type === "pol"
            ? deployer.sendTransaction({ to: wallets[s.idx].address, value: s.amount, ...overrides })
            : usdtCt.transfer(wallets[s.idx].address, s.amount, overrides);
          return p.catch(e => {
            console.log(`\n  ✗ [DEPLOYER] acc[${pad(s.idx)}] ${s.type}: ${(e.reason || e.message || "").slice(0, 50)}`);
            return null;
          });
        }));

        await Promise.all(txs.map((tx, i) => {
          if (!tx) { fail++; return Promise.resolve(); }
          return tx.wait()
            .then(() => { ok++; })
            .catch(e => {
              fail++;
              console.log(`\n  ✗ [DEPLOYER] acc[${pad(batch[i].idx)}] wait: ${(e.message || "").slice(0, 50)}`);
            });
        }));

        const pct = (((b + 1) / batches) * 100).toFixed(1);
        console.log(
          `  [DEPLOYER] batch ${String(b + 1).padStart(4)}/${batches}  (${pct.padStart(5)}%)` +
          `   ✓ ${String(ok).padStart(6)}   ✗ ${String(fail).padStart(4)}`
        );
      }
      return { ok, fail };
    }

    // Pipeline B: Sub-wallet reclaims (no nonce conflict — fully parallel)
    async function reclaimPipeline() {
      if (reclaimSends.length === 0) return { ok: 0, fail: 0 };
      let ok = 0, fail = 0;
      const batches = Math.ceil(reclaimSends.length / WRITE_BATCH);

      for (let b = 0; b < batches; b++) {
        const batch = reclaimSends.slice(b * WRITE_BATCH, (b + 1) * WRITE_BATCH);

        const txs = await Promise.all(batch.map(s => {
          const subCt = new hre.ethers.Contract(USDT_ADDRESS, USDT_ABI, wallets[s.idx]);
          return subCt.transfer(deployer.address, s.amount, TX_OVERRIDES).catch(e => {
            console.log(`\n  ✗ [RECLAIM ] acc[${pad(s.idx)}]: ${(e.reason || e.message || "").slice(0, 50)}`);
            return null;
          });
        }));

        await Promise.all(txs.map((tx, i) => {
          if (!tx) { fail++; return Promise.resolve(); }
          return tx.wait()
            .then(() => { ok++; })
            .catch(e => {
              fail++;
              console.log(`\n  ✗ [RECLAIM ] acc[${pad(batch[i].idx)}] wait: ${(e.message || "").slice(0, 50)}`);
            });
        }));

        const pct = (((b + 1) / batches) * 100).toFixed(1);
        console.log(
          `  [RECLAIM ] batch ${String(b + 1).padStart(4)}/${batches}  (${pct.padStart(5)}%)` +
          `   ✓ ${String(ok).padStart(6)}   ✗ ${String(fail).padStart(4)}`
        );
      }
      return { ok, fail };
    }

    // Run both pipelines simultaneously
    const [dRes, rRes] = await Promise.all([deployerPipeline(), reclaimPipeline()]);

    const [finalPOL, finalUSDT] = await Promise.all([
      provider.getBalance(deployer.address),
      usdtCt.balanceOf(deployer.address),
    ]);

    console.log("\n" + sep("═"));
    console.log("  SUMMARY");
    console.log(sep("═"));
    console.log(`  Deployer sends (POL+USDT)  : ✓ ${String(dRes.ok).padStart(6)}   ✗ ${dRes.fail}`);
    console.log(`  Reclaim sends (sub→acc[0]) : ✓ ${String(rRes.ok).padStart(6)}   ✗ ${rRes.fail}`);
    console.log(`  Already ok  POL            :   ${fmt(polOk)}`);
    console.log(`  Already ok  USDT           :   ${fmt(usdtOk)}`);
    console.log(sep());
    console.log(`  acc[0] POL  remaining : ${hre.ethers.formatEther(finalPOL)} POL`);
    console.log(`  acc[0] USDT remaining : ${hre.ethers.formatEther(finalUSDT)} USDT`);
    console.log(sep("═") + "\n");
    return;
  }

  const [finalPOL, finalUSDT] = await Promise.all([
    provider.getBalance(deployer.address),
    usdtCt.balanceOf(deployer.address),
  ]);

  console.log("\n" + sep("═"));
  console.log("  SUMMARY");
  console.log(sep("═"));
  console.log(`  POL  ok  : ${fmt(polOk)}   USDT ok : ${fmt(usdtOk)}`);
  console.log(`  acc[0] POL  remaining : ${hre.ethers.formatEther(finalPOL)} POL`);
  console.log(`  acc[0] USDT remaining : ${hre.ethers.formatEther(finalUSDT)} USDT`);
  console.log(sep("═") + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
