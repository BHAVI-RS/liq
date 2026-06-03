// Deploy a mock USDT token on Polygon Amoy testnet.
// Reuses HordexToken.sol (standard ERC-20 with mint/burn).
// Supply: 10,000,000,000 USDT  (18 decimals, testnet only).
//
// RUN:
//   npx hardhat run scripts/amoytestnet/deploy-usdt.js --network polygonAmoy
//
// WHAT IT DOES:
//   1. Deploys HordexToken("Tether USD", "USDT", 10_000_000_000) from PRIVATE_KEY wallet
//   2. Logs the deployed USDT address
//   3. Writes usdt-deploy-output.json alongside this file
//   4. Patches USDT_ADDRESS into contract-config.js (root + frontend)

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const USDT_NAME   = "Tether USD";
const USDT_SYMBOL = "USDT";
const USDT_SUPPLY = 10_000_000_000;   // 10 billion (18 decimals applied in constructor)

const DEPLOY_OVERRIDES = {
  maxFeePerGas:         hre.ethers.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: hre.ethers.parseUnits("30", "gwei"),
  gasLimit: 3_000_000,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function sep(c = "─", n = 60) { return c.repeat(n); }

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env");
    process.exit(1);
  }

  const provider = hre.ethers.provider;
  const pk       = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
  const deployer = new hre.ethers.Wallet(pk, provider);
  const network  = hre.network.name;

  console.log(sep("═"));
  console.log("  DEPLOY MOCK USDT — Polygon Amoy");
  console.log(sep("═"));
  console.log(`  Network  : ${network}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Token    : ${USDT_NAME} (${USDT_SYMBOL})`);
  console.log(`  Supply   : ${USDT_SUPPLY.toLocaleString()} ${USDT_SYMBOL}  (18 decimals)\n`);

  const bal = await provider.getBalance(deployer.address);
  console.log(`  POL balance : ${hre.ethers.formatEther(bal)} POL`);
  if (bal < hre.ethers.parseEther("0.05")) {
    console.error("❌  Need at least 0.05 POL for gas.");
    process.exit(1);
  }

  // ── Deploy ────────────────────────────────────────────────────────────────
  console.log("\n" + sep());
  console.log("  Deploying USDT token…");
  console.log(sep());

  const HordexToken = await hre.ethers.getContractFactory("HordexToken", deployer);
  const usdt = await HordexToken.deploy(USDT_NAME, USDT_SYMBOL, USDT_SUPPLY, DEPLOY_OVERRIDES);
  await usdt.waitForDeployment();
  const usdtAddress = await usdt.getAddress();

  const deployReceipt = await usdt.deploymentTransaction().wait();
  const deployBlock   = deployReceipt.blockNumber;

  const totalSupply = await usdt.totalSupply();
  const balance     = await usdt.balanceOf(deployer.address);

  console.log(`\n  ✓  USDT deployed at : ${usdtAddress}`);
  console.log(`     Block           : ${deployBlock}`);
  console.log(`     Total supply    : ${hre.ethers.formatEther(totalSupply)} USDT`);
  console.log(`     Deployer holds  : ${hre.ethers.formatEther(balance)} USDT`);

  // ── Write usdt-deploy-output.json ─────────────────────────────────────────
  const outPath = path.join(__dirname, "usdt-deploy-output.json");
  fs.writeFileSync(outPath, JSON.stringify({
    network,
    deployedAt:  new Date().toISOString(),
    deployBlock,
    usdtAddress,
    usdtName:    USDT_NAME,
    usdtSymbol:  USDT_SYMBOL,
    usdtSupply:  USDT_SUPPLY.toString(),
    decimals:    18,
    deployer:    deployer.address,
  }, null, 2));
  console.log(`\n  usdt-deploy-output.json written ✓`);

  // ── Patch contract-config.js (root + frontend) ────────────────────────────
  const configs = [
    path.join(__dirname, "..", "..", "contract-config.js"),
    path.join(__dirname, "..", "..", "frontend", "contract-config.js"),
  ];

  for (const cfgPath of configs) {
    if (!fs.existsSync(cfgPath)) {
      console.log(`  ⚠  ${cfgPath} not found — skipping patch`);
      continue;
    }
    let src = fs.readFileSync(cfgPath, "utf8");
    // Replace the USDT_ADDRESS line if it exists, otherwise append it
    if (/const USDT_ADDRESS\s*=/.test(src)) {
      src = src.replace(
        /const USDT_ADDRESS\s*=\s*"[^"]*";/,
        `const USDT_ADDRESS           = "${usdtAddress}";`
      );
    } else {
      // Insert after the last const ... = "..." line
      src = src.replace(
        /(const ROI_FACET_ADDRESS\s*=\s*"[^"]*";)/,
        `$1\nconst USDT_ADDRESS           = "${usdtAddress}";`
      );
    }
    fs.writeFileSync(cfgPath, src);
    console.log(`  contract-config.js patched (USDT_ADDRESS) ✓  — ${cfgPath}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + sep("═"));
  console.log("  DONE");
  console.log(sep("═"));
  console.log(`  USDT address : ${usdtAddress}`);
  console.log(`  Network      : ${network} (chainId 80002)`);
  console.log(`  Supply       : ${USDT_SUPPLY.toLocaleString()} USDT  (all held by deployer)`);
  console.log(sep("═") + "\n");

  console.log("  NEXT STEPS — see comments below");
  console.log("  ─────────────────────────────────────────────────────────");
  console.log("  1. USDT_ADDRESS is now in contract-config.js.");
  console.log("  2. Approve + seed USDT/MATIC pool on Uniswap V2 (optional,");
  console.log("     only needed if platform token pairs against USDT not POL).");
  console.log("  3. Call liq.addToken(usdtAddress, 'Tether USD', 'USDT') from");
  console.log("     the owner wallet to register USDT in the Liquidity contract.");
  console.log("  4. Transfer enough USDT to the Liquidity contract address so");
  console.log("     invest() can source USDT for commissions.");
  console.log("  5. Update USDT_PER_ETH in Liquidity.sol and redeploy if you");
  console.log("     want the package amounts recalculated against real USDT.");
  console.log("  ─────────────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
