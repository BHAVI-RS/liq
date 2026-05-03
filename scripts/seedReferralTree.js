const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const configSrc = fs.readFileSync(path.join(__dirname, "..", "contract-config.js"), "utf8");
const addrMatch = configSrc.match(/const CONTRACT_ADDRESS\s*=\s*"([^"]+)"/);
if (!addrMatch) throw new Error("CONTRACT_ADDRESS not found in contract-config.js — run deploy.js first");
const CONTRACT_ADDRESS = addrMatch[1];
const CONTRACT_ABI     = hre.artifacts.readArtifactSync("Liquidity").abi;

// Builds a linear referral chain:
//   account[0] (deployer, auto-registered in constructor)
//     └─ account[1]
//          └─ account[2]
//               └─ ...
//                    └─ account[14]

async function main() {
  const signers = await hre.ethers.getSigners();

  console.log(`\nSeeding referral tree on ${hre.network.name}...`);
  console.log(`Contract: ${CONTRACT_ADDRESS}\n`);

  for (let i = 1; i <= 14; i++) {
    const account  = signers[i];
    const referrer = signers[i - 1];

    const contract = new hre.ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, account);

    const tx = await contract.register(referrer.address);
    await tx.wait();

    console.log(`  account[${i}]  ${account.address}  referred by  account[${i - 1}]  ${referrer.address}  ✓`);
  }

  console.log("\n── Referral tree complete ──────────────────────────────────────────");
  for (let i = 0; i <= 14; i++) {
    const depth = "  ".repeat(i);
    console.log(`${depth}account[${i}]  ${signers[i].address}`);
  }
  console.log("────────────────────────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
