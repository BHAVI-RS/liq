// Deploy HordexToken.sol to Polygon mainnet using PRIVATE_KEY from .env, then verify its
// source on PolygonScan (Etherscan V2 API) with ETHERSCAN_API_KEY.
//
// This deploys ONLY the platform token (HordexToken). It does NOT touch the Hordex platform
// contracts, pool, or config — use scripts/polygon/mdeploy.js for the full platform (and point
// its PLATFORM_TOKEN at the address printed here if you want this token to be the platform token).
//
// What it does:
//   1. Deploys HordexToken(name, symbol, initialSupply) — the deployer becomes owner and receives
//      initialSupply * 10**18 tokens.
//   2. Verifies the source on PolygonScan (skipped with a notice if ETHERSCAN_API_KEY is unset).
//   3. Writes scripts/polygon/token-deploy-output.json for record-keeping.
//
// USAGE:
//   npx hardhat run scripts/polygon/tokendeploy.js --network polygon
//
// REQUIREMENTS:
//   • PRIVATE_KEY in .env       (64 hex chars, the deployer → token owner)
//   • ETHERSCAN_API_KEY in .env (one V2 key from etherscan.io/myapikey covers Polygon 137)
//   • Deployer holds a little POL for gas
//   • Optional overrides (human units / gwei):
//       TOKEN_NAME="Hordex Token"  TOKEN_SYMBOL="HDX"  TOKEN_SUPPLY="100000000"
//       POLYGON_MAX_FEE_GWEI=200   POLYGON_PRIORITY_GWEI=40

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { verifyOne } = require("../amoytestnet/_verify");

// ── Token constructor args (override via env) ──────────────────────────────────
const TOKEN_NAME   = process.env.TOKEN_NAME   || "Hordex";
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || "HDX";
// Human units — the constructor multiplies by 10**decimals (18) internally.
const TOKEN_SUPPLY = BigInt(process.env.TOKEN_SUPPLY || "100000000"); // 100,000,000 HDX

// ── Gas overrides ──────────────────────────────────────────────────────────────
// Fee fields omitted by default so ethers auto-estimates EIP-1559 fees from the live network.
const GWEI = n => hre.ethers.parseUnits(String(n), "gwei");
const FEE_OVERRIDES = {};
if (process.env.POLYGON_MAX_FEE_GWEI)  FEE_OVERRIDES.maxFeePerGas         = GWEI(process.env.POLYGON_MAX_FEE_GWEI);
if (process.env.POLYGON_PRIORITY_GWEI) FEE_OVERRIDES.maxPriorityFeePerGas = GWEI(process.env.POLYGON_PRIORITY_GWEI);
const DEPLOY_OVERRIDES = { ...FEE_OVERRIDES, gasLimit: 3_000_000 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sep(c = "─", n = 64) { return c.repeat(n); }

async function main() {
  // Safety: mainnet-only (PRIVATE_KEY maps to the `polygon` network in hardhat.config.js).
  if (hre.network.config.chainId !== 137) {
    console.error(`❌  Wrong network "${hre.network.name}" (chainId ${hre.network.config.chainId}).`);
    console.error(`   Run with:  npx hardhat run scripts/polygon/tokendeploy.js --network polygon`);
    process.exit(1);
  }

  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env"); process.exit(1);
  }

  const provider = hre.ethers.provider;
  const deployer = new hre.ethers.Wallet(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey, provider);

  console.log(sep("═"));
  console.log("  TOKENDEPLOY — Polygon mainnet · deploy + verify HordexToken");
  console.log(sep("═"));
  console.log(`  Network  : ${hre.network.name} (chainId 137)`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Name     : ${TOKEN_NAME}`);
  console.log(`  Symbol   : ${TOKEN_SYMBOL}`);
  console.log(`  Supply   : ${TOKEN_SUPPLY.toString()} (× 10^18)\n`);

  const bal = await provider.getBalance(deployer.address);
  console.log(`  POL balance : ${hre.ethers.formatEther(bal)} POL`);
  if (bal === 0n) { console.error("❌  deployer needs POL for gas"); process.exit(1); }

  // ── Deploy ───────────────────────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  DEPLOY"); console.log(sep());
  const HordexToken = await hre.ethers.getContractFactory("HordexToken", deployer);
  const token = await HordexToken.deploy(TOKEN_NAME, TOKEN_SYMBOL, TOKEN_SUPPLY, DEPLOY_OVERRIDES);
  await token.waitForDeployment();
  const tokenAddress  = await token.getAddress();
  const deployReceipt = await token.deploymentTransaction().wait();
  console.log(`  HordexToken : ${tokenAddress}  (block ${deployReceipt.blockNumber})`);

  // Record for later re-verify / reference.
  const outPath = path.join(__dirname, "token-deploy-output.json");
  fs.writeFileSync(outPath, JSON.stringify({
    network: hre.network.name,
    chainId: 137,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    tokenAddress,
    constructorArguments: [TOKEN_NAME, TOKEN_SYMBOL, TOKEN_SUPPLY.toString()],
    deployBlock: deployReceipt.blockNumber,
  }, null, 2));
  console.log(`  token-deploy-output.json written ✓`);

  // ── Verify on PolygonScan ─────────────────────────────────────────────────────
  console.log("\n" + sep()); console.log("  VERIFY (PolygonScan / Etherscan V2)"); console.log(sep());
  if (!process.env.ETHERSCAN_API_KEY) {
    console.log("  ⚠️  ETHERSCAN_API_KEY not set in .env — skipping source verification.");
    console.log("      Add the key, then run:");
    console.log(`      npx hardhat verify --network polygon ${tokenAddress} "${TOKEN_NAME}" "${TOKEN_SYMBOL}" ${TOKEN_SUPPLY.toString()}`);
  } else {
    // Give PolygonScan a moment to index the freshly-deployed bytecode (verifyOne also retries).
    await sleep(8000);
    await verifyOne(hre, {
      name: "HordexToken",
      address: tokenAddress,
      constructorArguments: [TOKEN_NAME, TOKEN_SYMBOL, TOKEN_SUPPLY],
    });
  }

  console.log("\n" + sep("═"));
  console.log("  DONE");
  console.log(sep("═"));
  console.log(`  HordexToken : ${tokenAddress}`);
  console.log(`  Explorer    : https://polygonscan.com/address/${tokenAddress}#code`);
  console.log(sep("═") + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
