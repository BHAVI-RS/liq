const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const USDT_PER_ETH  = 10000;
const RESTAKE_SECS  = 360;
const LOCK_INDEX    = 0;   // each account has exactly one investment from simulate.js
const FIRST_ACCOUNT = 0;
const LAST_ACCOUNT  = 55;  // inclusive

function toUSDT(ethBigInt) {
  return (parseFloat(hre.ethers.formatEther(ethBigInt)) * USDT_PER_ETH).toFixed(3);
}

function sep(char = "─", len = 60) { return char.repeat(len); }

async function main() {
  const signers = await hre.ethers.getSigners();
  const network = hre.network.name;

  const accountCount = LAST_ACCOUNT - FIRST_ACCOUNT + 1;
  if (signers.length < LAST_ACCOUNT + 1)
    throw new Error(`Need ${LAST_ACCOUNT + 1} signers — only ${signers.length} available.`);

  // ─────────────────────────────────────────────────────────────
  // Read contract address written by simulate.js
  // ─────────────────────────────────────────────────────────────
  const configPath = path.join(__dirname, "..", "contract-config.js");
  if (!fs.existsSync(configPath))
    throw new Error("contract-config.js not found — run simulate.js first.");
  const configContent    = fs.readFileSync(configPath, "utf8");
  const addrMatch        = configContent.match(/CONTRACT_ADDRESS\s*=\s*"(0x[0-9a-fA-F]+)"/);
  if (!addrMatch) throw new Error("CONTRACT_ADDRESS not found in contract-config.js.");
  const liquidityAddress = addrMatch[1];

  const artifact = hre.artifacts.readArtifactSync("Liquidity");

  console.log(sep("═"));
  console.log("  360SECS AFTER SIMULATE — Restake 0–55 for 360s");
  console.log(sep("═"));
  console.log(`  Network   : ${network}`);
  console.log(`  Contract  : ${liquidityAddress}`);
  console.log(`  Accounts  : [0..55]  (${accountCount} accounts)`);
  console.log(`  Duration  : ${RESTAKE_SECS}s\n`);

  // ─────────────────────────────────────────────────────────────
  // Advance time past the initial 90s lock expiry
  // Initial lock from simulate.js = 90s. Subsequent restakes = 360s.
  // Advancing 361s expires both, so the script is safe to run multiple times.
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  ADVANCE TIME PAST LOCK EXPIRY");
  console.log(sep());
  await hre.network.provider.send("evm_increaseTime", [361]);
  await hre.network.provider.send("evm_mine");
  const latestBlock = await hre.ethers.provider.getBlock("latest");
  console.log(`  +361s mined  ·  chain timestamp: ${latestBlock.timestamp} ✓\n`);

  // ─────────────────────────────────────────────────────────────
  // RESTAKE — accounts 0..55, lock 0, 360 seconds
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log(`  RESTAKE  ·  ${accountCount} accounts  ·  ${RESTAKE_SECS}s each`);
  console.log(sep());

  let successCount = 0;
  let failCount    = 0;

  for (let idx = FIRST_ACCOUNT; idx <= LAST_ACCOUNT; idx++) {
    const ct = new hre.ethers.Contract(liquidityAddress, artifact.abi, signers[idx]);
    try {
      const tx      = await ct.restakeLP(LOCK_INDEX, RESTAKE_SECS);
      const receipt = await tx.wait();

      // Read updated lock to show new unlock time
      const locks      = await ct.getUserLPLocks(signers[idx].address);
      const lock       = locks[LOCK_INDEX];
      const unlockTime = new Date(Number(lock.unlockTime) * 1000).toLocaleTimeString();

      console.log(
        `  [${String(idx).padStart(2)}] ${signers[idx].address}` +
        `  restaked ${RESTAKE_SECS}s  ·  unlocks ${unlockTime} ✓`
      );
      successCount++;
    } catch (e) {
      const reason = e.errorName || e.reason || e?.error?.message || e.message;
      console.log(`  [${String(idx).padStart(2)}] ${signers[idx].address}  FAILED: ${reason}`);
      failCount++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────
  console.log(`\n${sep("═")}`);
  console.log("  RESTAKE COMPLETE");
  console.log(sep("═"));
  console.log(`  Contract  : ${liquidityAddress}`);
  console.log(`  Restaked  : ${successCount} / ${accountCount}`);
  if (failCount > 0) console.log(`  Failed    : ${failCount}`);
  console.log(`  Duration  : ${RESTAKE_SECS}s per lock`);
  console.log(sep("═") + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
