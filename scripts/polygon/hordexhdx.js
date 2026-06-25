// Fund + activate the deployed Hordex contract on Polygon mainnet:
//   1. Transfer the HDX reward inventory (default 10,000,000 HDX) into the contract.
//   2. Register HDX as a tradable token        (addToken).
//   3. Seed the HDX/USDT pool                   (seedPool) with 2 HDX + 1 USDT  → 0.5 USDT/HDX.
//
// It does NOT warm the TWAP — run scripts/polygon/twap.js AFTER this script for that
// (the pool must be seeded first, which this script does).
//
// Addresses (contract / HDX / USDT / router / factory) are read from contract-config.js,
// so this always targets the latest deployment written by hordexdeploy.js.
//
// USAGE:
//   npx hardhat run scripts/polygon/hordexhdx.js --network polygon
//   …then:
//   npx hardhat run scripts/polygon/twap.js      --network polygon
//
// REQUIREMENTS:
//   • PRIVATE_KEY in .env  = the contract OWNER (addToken / seedPool are onlyOwner)
//   • Deployer holds ≥ 10,000,000 HDX (inventory; covers the 2 HDX seed) + ≥ 1 USDT (seed)
//     + a little POL for gas
//   • Optional overrides (human units):
//       HDX_INVENTORY=10000000   SEED_HDX=2   SEED_USDT=1
//       POLYGON_MAX_FEE_GWEI=200  POLYGON_PRIORITY_GWEI=40

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Amounts (human units; token decimals queried on-chain) ─────────────────────────
const HDX_INVENTORY_STR = process.env.HDX_INVENTORY || "10000000"; // 10 M HDX → contract
const SEED_HDX_STR      = process.env.SEED_HDX      || "2";        // 2 HDX into the pool
const SEED_USDT_STR     = process.env.SEED_USDT     || "1";        // 1 USDT into the pool → 0.5 USDT/HDX

// ── Gas overrides (fees auto-estimate unless set) ──────────────────────────────────
const GWEI = n => hre.ethers.parseUnits(String(n), "gwei");
const TX_OVERRIDES = { gasLimit: 5_000_000 };
if (process.env.POLYGON_MAX_FEE_GWEI)  TX_OVERRIDES.maxFeePerGas         = GWEI(process.env.POLYGON_MAX_FEE_GWEI);
if (process.env.POLYGON_PRIORITY_GWEI) TX_OVERRIDES.maxPriorityFeePerGas = GWEI(process.env.POLYGON_PRIORITY_GWEI);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];

// Core/view functions used here (addToken/seedPool on core; getRegisteredTokens via fallback).
const LIQ_ABI = [
  "function addToken(address,string,string)",
  "function seedPool(address,uint256,uint256)",
  "function getRegisteredTokens() view returns (address[])",
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sep(c = "─", n = 64) { return c.repeat(n); }

function isTransient(e) {
  return ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(e.code) ||
    ["ECONNRESET", "ETIMEDOUT", "timeout", "network"].some(k => e.message?.includes(k));
}

// Send a tx and wait for it to mine, retrying transient RPC hiccups.
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

// Pull a `const NAME = "0x...."` address out of contract-config.js.
function readConfigAddress(src, name) {
  const m = src.match(new RegExp(`${name}\\s*=\\s*"(0x[0-9a-fA-F]{40})"`));
  if (!m) throw new Error(`${name} not found in contract-config.js — run hordexdeploy.js first`);
  return hre.ethers.getAddress(m[1]);
}

async function main() {
  if (hre.network.config.chainId !== 137) {
    console.error(`❌  Wrong network "${hre.network.name}" (chainId ${hre.network.config.chainId}).`);
    console.error(`   Run with:  npx hardhat run scripts/polygon/hordexhdx.js --network polygon`);
    process.exit(1);
  }
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env"); process.exit(1);
  }

  const provider = hre.ethers.provider;
  const deployer = new hre.ethers.Wallet(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey, provider);

  const cfg = fs.readFileSync(path.join(__dirname, "..", "..", "contract-config.js"), "utf8");
  const CONTRACT_ADDRESS = readConfigAddress(cfg, "CONTRACT_ADDRESS");
  const TOKEN_ADDRESS    = readConfigAddress(cfg, "TOKEN_ADDRESS");
  const USDT_ADDRESS     = readConfigAddress(cfg, "USDT_ADDRESS");
  const ROUTER_ADDRESS   = readConfigAddress(cfg, "ROUTER_ADDRESS");
  const FACTORY_ADDRESS  = readConfigAddress(cfg, "FACTORY_ADDRESS");

  console.log(sep("═"));
  console.log("  HORDEXHDX — fund inventory · register token · seed pool (Polygon mainnet)");
  console.log(sep("═"));
  console.log(`  Owner    : ${deployer.address}`);
  console.log(`  Contract : ${CONTRACT_ADDRESS}`);
  console.log(`  HDX      : ${TOKEN_ADDRESS}`);
  console.log(`  USDT     : ${USDT_ADDRESS}\n`);

  if ((await provider.getBalance(deployer.address)) === 0n) {
    console.error("❌  owner has 0 POL for gas"); process.exit(1);
  }

  const hdx  = new hre.ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, deployer);
  const usdt = new hre.ethers.Contract(USDT_ADDRESS, ERC20_ABI, deployer);
  const liq  = new hre.ethers.Contract(CONTRACT_ADDRESS, LIQ_ABI, deployer);

  const hdxDec  = Number(await hdx.decimals());
  const usdtDec = Number(await usdt.decimals());
  const HDX_TO_CONTRACT = hre.ethers.parseUnits(HDX_INVENTORY_STR, hdxDec);
  const SEED_TOKENS     = hre.ethers.parseUnits(SEED_HDX_STR, hdxDec);
  const SEED_USDT       = hre.ethers.parseUnits(SEED_USDT_STR, usdtDec);

  // Fail fast on balances (inventory already covers the seed HDX, so just need the inventory).
  const hdxBal  = await hdx.balanceOf(deployer.address);
  const usdtBal = await usdt.balanceOf(deployer.address);
  console.log(`  HDX  balance: ${hre.ethers.formatUnits(hdxBal, hdxDec)} HDX  (need ${HDX_INVENTORY_STR})`);
  console.log(`  USDT balance: ${hre.ethers.formatUnits(usdtBal, usdtDec)} USDT (need ${SEED_USDT_STR})`);
  if (hdxBal < HDX_TO_CONTRACT) { console.error(`❌  need ≥ ${HDX_INVENTORY_STR} HDX`); process.exit(1); }
  if (usdtBal < SEED_USDT)      { console.error(`❌  need ≥ ${SEED_USDT_STR} USDT`); process.exit(1); }

  // ── 1) Transfer HDX inventory into the contract ────────────────────────────────
  console.log("\n" + sep()); console.log("  1) HDX INVENTORY"); console.log(sep());
  await mine(() => hdx.transfer(CONTRACT_ADDRESS, HDX_TO_CONTRACT, TX_OVERRIDES));
  console.log(`  ${HDX_INVENTORY_STR} HDX → contract ✓`);

  // ── 2) Register HDX as a tradable token (skip if already registered) ───────────
  console.log("\n" + sep()); console.log("  2) REGISTER TOKEN"); console.log(sep());
  let already = false;
  try {
    const regd = await liq.getRegisteredTokens();
    already = regd.map(a => a.toLowerCase()).includes(TOKEN_ADDRESS.toLowerCase());
  } catch (_) {}
  if (already) {
    console.log("  HDX already registered — skipping addToken");
  } else {
    let name = "Hordex", symbol = "HDX";
    try { name = await hdx.name(); symbol = await hdx.symbol(); } catch (_) {}
    await mine(() => liq.addToken(TOKEN_ADDRESS, name, symbol, TX_OVERRIDES));
    console.log(`  addToken("${name}", "${symbol}") ✓`);
  }

  // ── 3) Seed the HDX/USDT pool ──────────────────────────────────────────────────
  // If the deployer holds LP in a pre-existing HDX/USDT pair, drain it first so this seed
  // establishes a clean 0.5 USDT/HDX starting price (no-op on a fresh token with no pair).
  console.log("\n" + sep()); console.log("  3) SEED POOL"); console.log(sep());
  {
    const factory = new hre.ethers.Contract(
      FACTORY_ADDRESS, ["function getPair(address,address) view returns (address)"], deployer);
    const pair = await factory.getPair(TOKEN_ADDRESS, USDT_ADDRESS);
    if (pair !== hre.ethers.ZeroAddress) {
      const pairCt = new hre.ethers.Contract(
        pair,
        ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
        deployer);
      const lpBal = await pairCt.balanceOf(deployer.address);
      if (lpBal > 0n) {
        console.log(`  Existing pair — draining deployer LP (${hre.ethers.formatEther(lpBal)} LP)…`);
        await mine(() => pairCt.approve(ROUTER_ADDRESS, lpBal, TX_OVERRIDES));
        const router = new hre.ethers.Contract(
          ROUTER_ADDRESS,
          ["function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)"],
          deployer);
        await mine(() => router.removeLiquidity(
          TOKEN_ADDRESS, USDT_ADDRESS, lpBal, 0, 0, deployer.address,
          BigInt(Math.floor(Date.now() / 1000) + 300), TX_OVERRIDES));
        console.log("  Existing LP drained → pair reset ✓");
      } else {
        console.log("  Pair exists but deployer holds no LP — proceeding");
      }
    } else {
      console.log("  No existing pair — fresh pool");
    }
  }

  // Move the seed USDT into the contract (seedPool pulls both legs from the contract balance),
  // then seed: 2 HDX + 1 USDT → 0.5 USDT per HDX.
  await mine(() => usdt.transfer(CONTRACT_ADDRESS, SEED_USDT, TX_OVERRIDES));
  console.log(`  ${SEED_USDT_STR} USDT → contract ✓`);
  await mine(() => liq.seedPool(TOKEN_ADDRESS, SEED_TOKENS, SEED_USDT, TX_OVERRIDES));
  const price = Number(SEED_USDT_STR) / Number(SEED_HDX_STR);
  console.log(`  seedPool: ${SEED_HDX_STR} HDX + ${SEED_USDT_STR} USDT  →  1 HDX = ${price} USDT ✓`);

  console.log("\n" + sep("═"));
  console.log("  DONE — inventory funded · token registered · pool seeded");
  console.log(sep("═"));
  console.log(`  Pool price : ${price} USDT/HDX`);
  console.log("  NEXT: warm the TWAP (2 observations > 15 min apart) so invest() works:");
  console.log("        npx hardhat run scripts/polygon/twap.js --network polygon");
  console.log(sep("═") + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
