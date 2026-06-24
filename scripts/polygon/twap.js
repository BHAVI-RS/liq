// Update / warm up the on-chain TWAP price oracle on Polygon mainnet.
//
// The platform values ROI & staking payouts in HDX and gates invest() on a Uniswap V2 TWAP.
// That TWAP only becomes "ready" after TWO observations at least one TWAP period apart. This
// script pushes those observations — updateTWAP() for the platform token, plus updateTokenTWAP()
// for every registered token — waiting TWAP_WAIT_SECS between them, then confirms readiness via
// getTWAPPrice(). (The pool must already be seeded, or the updates are no-ops.)
//
// USAGE — full warm-up (2 observations, makes the TWAP ready):
//   npx hardhat run scripts/polygon/twap.js --network polygon
//
// Single refresh (1 observation, no wait) — e.g. a periodic keeper to keep the TWAP fresh
// so it never goes stale (TWAP_MAX_STALE) between invests:
//   TWAP_SINGLE=1 npx hardhat run scripts/polygon/twap.js --network polygon
//
// Override the gap between observations (must EXCEED the contract's TWAP period; default 920s):
//   TWAP_WAIT_SECS=920 npx hardhat run scripts/polygon/twap.js --network polygon

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// Minimal ABI — getRegisteredTokens() is reached through the contract's fallback (view facet).
const ABI = [
  "function updateTWAP()",
  "function updateTokenTWAP(address)",
  "function getRegisteredTokens() view returns (address[])",
  "function getTWAPPrice() view returns (uint256)",
];

const TWAP_WAIT_SECS = parseInt(process.env.TWAP_WAIT_SECS || "920", 10); // > TWAP_PERIOD (15 min = 900 s)
const SINGLE         = process.env.TWAP_SINGLE === "1";

// Fees auto-estimate from the network by default; override via env if a tx gets stuck.
const GWEI = n => hre.ethers.parseUnits(String(n), "gwei");
const TX_OVERRIDES = {};
if (process.env.POLYGON_MAX_FEE_GWEI)  TX_OVERRIDES.maxFeePerGas         = GWEI(process.env.POLYGON_MAX_FEE_GWEI);
if (process.env.POLYGON_PRIORITY_GWEI) TX_OVERRIDES.maxPriorityFeePerGas = GWEI(process.env.POLYGON_PRIORITY_GWEI);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readDeployedContract() {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "contract-config.js"), "utf8");
  const m = src.match(/CONTRACT_ADDRESS\s*=\s*"(0x[0-9a-fA-F]{40})"/);
  if (!m) throw new Error("CONTRACT_ADDRESS not found in contract-config.js — run mdeploy.js first");
  return hre.ethers.getAddress(m[1]);
}

// One observation: refresh the platform-token TWAP and every registered token's TWAP.
async function observe(liq, label) {
  console.log(`\n  ${label}:`);
  const tx = await liq.updateTWAP(TX_OVERRIDES);
  await tx.wait();
  console.log(`    updateTWAP()                    ✓  (${tx.hash})`);

  let tokens = [];
  try { tokens = await liq.getRegisteredTokens(); } catch (_) {}
  for (const t of tokens) {
    try {
      const ttx = await liq.updateTokenTWAP(t, TX_OVERRIDES);
      await ttx.wait();
      console.log(`    updateTokenTWAP(${t}) ✓`);
    } catch (e) {
      console.log(`    updateTokenTWAP(${t}) skipped: ${(e.shortMessage || e.message || "").slice(0, 50)}`);
    }
  }
}

async function main() {
  if (hre.network.config.chainId !== 137) {
    console.error(`❌  Wrong network "${hre.network.name}" (chainId ${hre.network.config.chainId}).`);
    console.error(`   Run with:  npx hardhat run scripts/polygon/twap.js --network polygon`);
    process.exit(1);
  }
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env"); process.exit(1);
  }

  const provider = hre.ethers.provider;
  const caller   = new hre.ethers.Wallet(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey, provider);
  const CONTRACT_ADDRESS = readDeployedContract();
  const liq = new hre.ethers.Contract(CONTRACT_ADDRESS, ABI, caller);

  const sep = "─".repeat(64);
  console.log(sep);
  console.log("  TWAP — update on-chain price oracle (Polygon mainnet)");
  console.log(sep);
  console.log(`  Caller   : ${caller.address}`);
  console.log(`  Contract : ${CONTRACT_ADDRESS}`);
  console.log(`  Mode     : ${SINGLE ? "single refresh (1 observation)" : `warm-up (2 observations, ${TWAP_WAIT_SECS}s apart)`}`);

  if ((await provider.getBalance(caller.address)) === 0n) {
    console.error("❌  Caller has 0 POL for gas."); process.exit(1);
  }

  await observe(liq, "Observation 1");

  if (!SINGLE) {
    console.log(`\n  Waiting ${TWAP_WAIT_SECS}s for the second observation (must exceed the TWAP period)…`);
    await sleep(TWAP_WAIT_SECS * 1000);
    await observe(liq, "Observation 2");
  }

  try {
    const price = await liq.getTWAPPrice();
    console.log(`\n  ✓ TWAP ready — platform-token price: ${hre.ethers.formatEther(price)} USDT per token`);
  } catch (e) {
    console.log(`\n  ⚠ TWAP not ready: ${(e.shortMessage || e.message || "").slice(0, 80)}`);
    console.log("    Ensure the pool is seeded (seedPool), then run the full 2-observation warm-up.");
  }
  console.log(sep + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
