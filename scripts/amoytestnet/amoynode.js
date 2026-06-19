// Derives 515 wallets from PRIVATE_KEY and maintains balances across all sub-accounts.
// Run this ONCE before simulateamoy.js.
//
// account[0]    = your actual wallet (treasury / funder)
// account[1..514] = deterministic wallets derived from your private key
//
// POL target  : 2 POL per sub-account; excess above target is returned to account[0]
// USDT target : 500,000 USDT per sub-account
//
// USAGE:
//   npx hardhat run scripts/amoytestnet/amoynode.js --network polygonAmoy

const hre = require("hardhat");

const TOTAL        = 515;
const POL_TARGET   = hre.ethers.parseEther("2"); // exact POL target per sub-wallet

// ── USDT ──────────────────────────────────────────────────────────────────────
const USDT_ADDRESS       = "0xcDC1119387AE7cE0cDb2A84CB8be2D6C8F0F5CB9";
const USDT_PER_ACCOUNT   = hre.ethers.parseEther("500000"); // exact target per sub-wallet (18 decimals)
const USDT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

// ── Platform token (Hordex) — collect all back to deployer ────────────────────
const PLATFORM_TOKEN_ADDRESS = "0x39544CBb2aB89E64aD74c731Ee690D2923bB209f";

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
  const rawKey = process.env.AMOY_PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  AMOY_PRIVATE_KEY missing or wrong length in .env (need 64 hex chars, no 0x)");
    process.exit(1);
  }

  const provider     = hre.ethers.provider;
  const wallets      = deriveWallets(rawKey, provider);
  const deployer     = wallets[0];
  const usdtContract = new hre.ethers.Contract(USDT_ADDRESS, USDT_ABI, deployer);

  console.log(sep("═"));
  console.log("  AMOY NODE — 515 Derived Accounts");
  console.log(sep("═"));

  const platformContract = new hre.ethers.Contract(PLATFORM_TOKEN_ADDRESS, USDT_ABI, deployer);

  let maticFunded = 0, maticSkipped = 0;
  let usdtFunded  = 0, usdtSkipped  = 0;
  let hdxRecovered = 0;

  for (let i = 0; i < TOTAL; i++) {
    const wallet = wallets[i];
    const tag    = i === 0 ? " (funder)" : "";

    const [maticBal, usdtBal, hdxBal] = await Promise.all([
      provider.getBalance(wallet.address),
      usdtContract.balanceOf(wallet.address),
      platformContract.balanceOf(wallet.address),
    ]);

    console.log(`\n  Account [${String(i).padStart(2, "0")}]${tag}`);
    console.log(sep());
    console.log(`  Address     : ${wallet.address}`);
    console.log(`  Private Key : ${wallet.privateKey}`);
    console.log(`  USDT Balance: ${hre.ethers.formatEther(usdtBal)} USDT`);
    console.log(`  HDX Balance : ${hre.ethers.formatEther(hdxBal)} HDX`);
    console.log(`  ETH Balance : ${hre.ethers.formatEther(maticBal)} POL`);

    if (i === 0) continue; // deployer is the funder — never refill

    // ── POL balance maintenance (target = 2 POL) ──────────────────────────
    if (maticBal === POL_TARGET) {
      console.log(`  POL         : exact — skipped`);
      maticSkipped++;
    } else if (maticBal > POL_TARGET) {
      const excess = maticBal - POL_TARGET;
      const tx = await wallet.connect(provider).sendTransaction({ to: deployer.address, value: excess });
      await tx.wait();
      console.log(`  POL         : returned ${hre.ethers.formatEther(excess)} POL to account[0] ✓  (tx: ${tx.hash.slice(0, 18)}…)`);
      maticFunded++;
    } else {
      const deficit = POL_TARGET - maticBal;
      const tx = await deployer.sendTransaction({ to: wallet.address, value: deficit });
      await tx.wait();
      console.log(`  POL         : sent ${hre.ethers.formatEther(deficit)} POL ✓  (tx: ${tx.hash.slice(0, 18)}…)`);
      maticFunded++;
    }

    // ── USDT exact balance maintenance ────────────────────────────────────
    if (usdtBal === USDT_PER_ACCOUNT) {
      console.log(`  USDT        : exact — skipped`);
      usdtSkipped++;
    } else if (usdtBal > USDT_PER_ACCOUNT) {
      const excess = usdtBal - USDT_PER_ACCOUNT;
      const subContract = new hre.ethers.Contract(USDT_ADDRESS, USDT_ABI, wallet);
      const tx = await subContract.transfer(deployer.address, excess);
      await tx.wait();
      console.log(`  USDT        : returned ${hre.ethers.formatEther(excess)} USDT to account[0] ✓  (tx: ${tx.hash.slice(0, 18)}…)`);
      usdtFunded++;
    } else {
      const deficit = USDT_PER_ACCOUNT - usdtBal;
      const tx = await usdtContract.transfer(wallet.address, deficit);
      await tx.wait();
      console.log(`  USDT        : sent ${hre.ethers.formatEther(deficit)} USDT ✓  (tx: ${tx.hash.slice(0, 18)}…)`);
      usdtFunded++;
    }

    // ── HDX — collect all back to deployer ───────────────────────────────
    if (hdxBal > 0n) {
      const subPlatform = new hre.ethers.Contract(PLATFORM_TOKEN_ADDRESS, USDT_ABI, wallet);
      const tx = await subPlatform.transfer(deployer.address, hdxBal);
      await tx.wait();
      console.log(`  HDX         : recovered ${hre.ethers.formatEther(hdxBal)} HDX to account[0] ✓  (tx: ${tx.hash.slice(0, 18)}…)`);
      hdxRecovered++;
    } else {
      console.log(`  HDX         : zero — skipped`);
    }
  }

  const [finalMatic, finalUSDT, finalHDX] = await Promise.all([
    provider.getBalance(deployer.address),
    usdtContract.balanceOf(deployer.address),
    platformContract.balanceOf(deployer.address),
  ]);

  console.log("\n" + sep("═"));
  console.log("  SUMMARY");
  console.log(sep("═"));
  console.log(`  POL  funded : ${maticFunded}  skipped: ${maticSkipped}`);
  console.log(`  USDT funded : ${usdtFunded}  skipped: ${usdtSkipped}`);
  console.log(`  HDX recovered: ${hdxRecovered} wallets`);
  console.log(`  account[00] POL  remaining: ${hre.ethers.formatEther(finalMatic)} POL`);
  console.log(`  account[00] USDT remaining: ${hre.ethers.formatEther(finalUSDT)} USDT`);
  console.log(`  account[00] HDX  balance  : ${hre.ethers.formatEther(finalHDX)} HDX`);
  console.log(sep("═"));
  console.log("  Done. Run simulateamoy.js next (515 accounts funded):");
  console.log("  npx hardhat run scripts/amoytestnet/simulateamoy.js --network polygonAmoy");
  console.log(sep("═") + "\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
