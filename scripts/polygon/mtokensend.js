// Send HDX (platform token) to the deployed Liquidity contract on Polygon mainnet.
//
// Transfers AMOUNT_TOKENS *whole* HDX from the deployer wallet (PRIVATE_KEY in .env) to the
// Liquidity contract, whose address is read from contract-config.js (the latest mdeploy.js run).
// The contract needs an HDX reserve to pay ROI / staking rewards and to seed pools.
//
// USAGE:
//   npx hardhat run scripts/polygon/mtokensend.js --network polygon
//
// REQUIREMENTS:
//   • PRIVATE_KEY in .env holds enough HDX (and a little POL for gas)
//   • contract-config.js already points at the deployed mainnet contract

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Config ──────────────────────────────────────────────────────────────────
const TOKEN_ADDRESS = "0xCD575ebAEb4f5DC4E84CA324D936C37e8538cFBf"; // HDX platform token

// Amount in WHOLE tokens (scaled by the token's decimals below).
// "10000000000000" = 10,000,000,000,000 (10 trillion) HDX.
// If you instead meant a raw on-chain integer (wei), see the NOTE near amountWei.
const AMOUNT_TOKENS = "10000000000000";

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

// Fees auto-estimate from the network by default; override via env if a tx gets stuck.
const GWEI = n => hre.ethers.parseUnits(String(n), "gwei");
const TX_OVERRIDES = {};
if (process.env.POLYGON_MAX_FEE_GWEI)  TX_OVERRIDES.maxFeePerGas         = GWEI(process.env.POLYGON_MAX_FEE_GWEI);
if (process.env.POLYGON_PRIORITY_GWEI) TX_OVERRIDES.maxPriorityFeePerGas = GWEI(process.env.POLYGON_PRIORITY_GWEI);

// Read the deployed Liquidity contract address straight from contract-config.js so this
// always targets the latest deploy (no hardcoded address to keep in sync).
function readDeployedContract() {
  const cfgPath = path.join(__dirname, "..", "..", "contract-config.js");
  const src = fs.readFileSync(cfgPath, "utf8");
  const m = src.match(/CONTRACT_ADDRESS\s*=\s*"(0x[0-9a-fA-F]{40})"/);
  if (!m) throw new Error("CONTRACT_ADDRESS not found in contract-config.js — run mdeploy.js first");
  return hre.ethers.getAddress(m[1]);
}

async function main() {
  // Mainnet-only safety.
  if (hre.network.config.chainId !== 137) {
    console.error(`❌  Wrong network "${hre.network.name}" (chainId ${hre.network.config.chainId}).`);
    console.error(`   Run with:  npx hardhat run scripts/polygon/mtokensend.js --network polygon`);
    process.exit(1);
  }

  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env"); process.exit(1);
  }

  const provider = hre.ethers.provider;
  const sender   = new hre.ethers.Wallet(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey, provider);

  const CONTRACT_ADDRESS = readDeployedContract();
  const token = new hre.ethers.Contract(hre.ethers.getAddress(TOKEN_ADDRESS), ERC20_ABI, sender);

  const [dec, sym] = await Promise.all([token.decimals(), token.symbol().catch(() => "HDX")]);

  // NOTE: whole-token amount → wei. To send a raw integer instead, replace this with:
  //   const amountWei = BigInt(AMOUNT_TOKENS);
  const amountWei = hre.ethers.parseUnits(AMOUNT_TOKENS, dec);

  const sep = "─".repeat(64);
  console.log(sep);
  console.log("  MTOKENSEND — send HDX → Liquidity contract (Polygon mainnet)");
  console.log(sep);
  console.log(`  Sender   : ${sender.address}`);
  console.log(`  Token    : ${TOKEN_ADDRESS}  (${sym}, ${dec} decimals)`);
  console.log(`  Contract : ${CONTRACT_ADDRESS}`);
  console.log(`  Amount   : ${AMOUNT_TOKENS} ${sym}   (${amountWei} wei)`);

  const polBal = await provider.getBalance(sender.address);
  const hdxBal = await token.balanceOf(sender.address);
  console.log(`  POL bal  : ${hre.ethers.formatEther(polBal)} POL`);
  console.log(`  ${sym} bal  : ${hre.ethers.formatUnits(hdxBal, dec)} ${sym}\n`);

  if (polBal === 0n) {
    console.error("❌  Sender has 0 POL — needs a little POL for gas."); process.exit(1);
  }
  if (hdxBal < amountWei) {
    console.error(`❌  Insufficient ${sym}: need ${AMOUNT_TOKENS}, have ${hre.ethers.formatUnits(hdxBal, dec)}`);
    process.exit(1);
  }

  console.log("  Sending transfer…");
  const tx = await token.transfer(CONTRACT_ADDRESS, amountWei, TX_OVERRIDES);
  console.log(`  tx hash  : ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  ✓ confirmed in block ${receipt.blockNumber}`);

  const contractBal = await token.balanceOf(CONTRACT_ADDRESS);
  console.log(`\n  Contract ${sym} balance now: ${hre.ethers.formatUnits(contractBal, dec)} ${sym}`);
  console.log(sep + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
