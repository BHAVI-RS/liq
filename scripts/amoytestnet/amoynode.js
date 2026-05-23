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
const FUND_TARGET    = hre.ethers.parseEther("2");   // top-up target per sub-wallet
const FUND_THRESHOLD = hre.ethers.parseEther("0.5"); // skip if already has this much

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

  const provider = hre.ethers.provider;
  const wallets  = deriveWallets(rawKey, provider);
  const deployer = wallets[0];

  console.log(sep("═"));
  console.log("  AMOY NODE — 60 Derived Accounts");
  console.log(sep("═"));
  console.log(`  Funder (account[00]): ${deployer.address}\n`);

  // ── Print all 60 addresses, private keys, and balances ──────────────────────
  console.log("  All derived accounts:");
  console.log(sep());
  for (let i = 0; i < TOTAL; i++) {
    const bal = await provider.getBalance(wallets[i].address);
    const tag = i === 0 ? "  ← your wallet" : "";
    console.log(
      `  [${String(i).padStart(2, "0")}] ${wallets[i].address}` +
      `  ${hre.ethers.formatEther(bal).padStart(12)} POL${tag}`
    );
    console.log(
      `       PK: ${wallets[i].privateKey}`
    );
  }

  // ── Balance check ─────────────────────────────────────────────────────────
  const deployerBal = await provider.getBalance(deployer.address);
  const required    = FUND_TARGET * BigInt(TOTAL - 1) + hre.ethers.parseEther("3"); // worst-case gas buffer
  console.log(sep());
  console.log(`  account[00] balance : ${hre.ethers.formatEther(deployerBal)} POL`);
  console.log(`  Required (worst case): ${hre.ethers.formatEther(required)} POL`);
  console.log(`    (59 × 2 POL to fund + ~3 POL gas buffer)`);

  if (deployerBal < required) {
    console.error(`\n❌  Insufficient POL in account[00].`);
    console.error(`   Need at least ${hre.ethers.formatEther(required)} POL.`);
    console.error(`   Get testnet POL: https://faucet.polygon.technology/`);
    process.exit(1);
  }

  // ── Fund accounts [1..59] ─────────────────────────────────────────────────
  console.log(`\n  Funding accounts [01..59] — target 2 POL, skip if ≥ 0.5 POL…`);
  console.log(sep());

  let funded = 0;
  let skipped = 0;

  for (let i = 1; i < TOTAL; i++) {
    const bal = await provider.getBalance(wallets[i].address);

    if (bal >= FUND_THRESHOLD) {
      console.log(
        `  [${String(i).padStart(2, "0")}] already has ${hre.ethers.formatEther(bal)} POL — skipped`
      );
      skipped++;
      continue;
    }

    const toSend = FUND_TARGET - bal; // top up to exactly 2 POL
    const tx = await deployer.sendTransaction({
      to: wallets[i].address,
      value: toSend,
    });
    await tx.wait();
    console.log(
      `  [${String(i).padStart(2, "0")}] funded ✓  sent ${hre.ethers.formatEther(toSend)} POL` +
      `  (tx: ${tx.hash.slice(0, 18)}…)`
    );
    funded++;
  }

  const finalBal = await provider.getBalance(deployer.address);
  console.log(sep());
  console.log(`  Funded  : ${funded} accounts`);
  console.log(`  Skipped : ${skipped} accounts (already had ≥ 0.5 POL)`);
  console.log(`  account[00] remaining: ${hre.ethers.formatEther(finalBal)} POL`);
  console.log(sep("═"));
  console.log("  Done. Run simulateamoy.js next:");
  console.log("  npx hardhat run scripts/amoytestnet/simulateamoy.js --network polygonAmoy");
  console.log(sep("═") + "\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
