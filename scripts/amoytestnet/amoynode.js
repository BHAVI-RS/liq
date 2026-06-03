// Derives 60 wallets from PRIVATE_KEY and funds accounts [1..59] with 1 POL each.
// Run this ONCE before simulateamoy.js.
//
// account[0]  = your actual wallet (must have ≥ 65 POL)
// account[1..59] = deterministic wallets derived from your private key
//
// USAGE:
//   npx hardhat run scripts/amoytestnet/amoynode.js --network polygonAmoy

const hre = require("hardhat");

const TOTAL          = 60;
const FUND_TARGET    = hre.ethers.parseEther("5");   // top-up target per sub-wallet
const FUND_THRESHOLD = hre.ethers.parseEther("0.5"); // skip if already has this much

// ── USDT ──────────────────────────────────────────────────────────────────────
const USDT_ADDRESS       = "0x5b0Eaea74F03ED873B03d6C6ce54f6d5eDE75F9c";
const USDT_PER_ACCOUNT   = hre.ethers.parseEther("2000000"); // 10 lakh USDT (18 decimals)
const USDT_THRESHOLD     = hre.ethers.parseEther("1000000");  // skip if already has ≥ 9 lakh
const USDT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

function sep(c = "─", n = 60) { return c.repeat(n); }

// account[0]  = rawKey itself
// account[i]  = keccak256(rawKey ++ i)  for i = 1..59
function deriveWallets(rawKey, provider) {
  const pk = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
  const wallets = [new hre.ethers.Wallet(pk, provider)];
  for (let i = 1; i < TOTAL; i++) {
    const derived = hre.ethers.keccak256(
      hre.ethers.solidityPacked(["bytes32", "uint256"], [pk, i])
    );
    wallets.push(new hre.ethers.Wallet(derived, provider));
  }
  return wallets;
}

async function main() {
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env (need 64 hex chars, no 0x)");
    process.exit(1);
  }

  const provider     = hre.ethers.provider;
  const wallets      = deriveWallets(rawKey, provider);
  const deployer     = wallets[0];
  const usdtContract = new hre.ethers.Contract(USDT_ADDRESS, USDT_ABI, deployer);

  console.log(sep("═"));
  console.log("  AMOY NODE — 60 Derived Accounts");
  console.log(sep("═"));

  let maticFunded = 0, maticSkipped = 0;
  let usdtFunded  = 0, usdtSkipped  = 0;

  for (let i = 0; i < TOTAL; i++) {
    const wallet = wallets[i];
    const tag    = i === 0 ? " (funder)" : "";

    const [maticBal, usdtBal] = await Promise.all([
      provider.getBalance(wallet.address),
      usdtContract.balanceOf(wallet.address),
    ]);

    console.log(`\n  Account [${String(i).padStart(2, "0")}]${tag}`);
    console.log(sep());
    console.log(`  Address     : ${wallet.address}`);
    console.log(`  Private Key : ${wallet.privateKey}`);
    console.log(`  USDT Balance: ${hre.ethers.formatEther(usdtBal)} USDT`);
    console.log(`  ETH Balance : ${hre.ethers.formatEther(maticBal)} POL`);

    if (i === 0) continue; // deployer is the funder — never refill

    // ── MATIC top-up ──────────────────────────────────────────────────────
    if (maticBal >= FUND_THRESHOLD) {
      console.log(`  POL         : sufficient — skipped`);
      maticSkipped++;
    } else {
      const toSend = FUND_TARGET - maticBal;
      const tx = await deployer.sendTransaction({ to: wallet.address, value: toSend });
      await tx.wait();
      console.log(`  POL         : sent ${hre.ethers.formatEther(toSend)} POL ✓  (tx: ${tx.hash.slice(0, 18)}…)`);
      maticFunded++;
    }

    // ── USDT top-up ───────────────────────────────────────────────────────
    if (usdtBal >= USDT_THRESHOLD) {
      console.log(`  USDT        : sufficient — skipped`);
      usdtSkipped++;
    } else {
      const toSend = USDT_PER_ACCOUNT - usdtBal;
      const tx = await usdtContract.transfer(wallet.address, toSend);
      await tx.wait();
      console.log(`  USDT        : sent ${hre.ethers.formatEther(toSend)} USDT ✓  (tx: ${tx.hash.slice(0, 18)}…)`);
      usdtFunded++;
    }
  }

  const [finalMatic, finalUSDT] = await Promise.all([
    provider.getBalance(deployer.address),
    usdtContract.balanceOf(deployer.address),
  ]);

  console.log("\n" + sep("═"));
  console.log("  SUMMARY");
  console.log(sep("═"));
  console.log(`  POL  funded : ${maticFunded}  skipped: ${maticSkipped}`);
  console.log(`  USDT funded : ${usdtFunded}  skipped: ${usdtSkipped}`);
  console.log(`  account[00] POL  remaining: ${hre.ethers.formatEther(finalMatic)} POL`);
  console.log(`  account[00] USDT remaining: ${hre.ethers.formatEther(finalUSDT)} USDT`);
  console.log(sep("═"));
  console.log("  Done. Run simulateamoy.js next:");
  console.log("  npx hardhat run scripts/amoytestnet/simulateamoy.js --network polygonAmoy");
  console.log(sep("═") + "\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
