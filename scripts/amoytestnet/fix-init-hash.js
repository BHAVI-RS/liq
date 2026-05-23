// Run this once after `npm run compile` to patch the Router02 init code hash.
// The Router uses CREATE2 to predict pair addresses; the hardcoded hash must
// match the actual UniswapV2Pair bytecode produced by YOUR compiler settings.
// Canonical mainnet hash (runs:999999) differs from ours (runs:1).
const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const ROUTER_PATH = path.join(__dirname, "..", "..", "contracts", "uniswapamoy", "UniswapV2Router02.sol");
const CANONICAL   = "96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";

async function main() {
  const pairArtifact = await hre.artifacts.readArtifact("UniswapV2Pair");
  const actual = hre.ethers.keccak256(pairArtifact.bytecode).slice(2); // strip 0x

  console.log("Canonical hash:", CANONICAL);
  console.log("Actual hash:   ", actual);

  if (actual === CANONICAL) {
    console.log("✓ Hashes match — Router needs no change.");
    return;
  }

  let src = fs.readFileSync(ROUTER_PATH, "utf8");
  if (!src.includes(CANONICAL) && !src.includes(actual)) {
    console.error("❌ Neither hash found in Router source. Please update manually.");
    process.exit(1);
  }
  if (src.includes(actual)) {
    console.log("✓ Router already has the correct hash.");
    return;
  }

  src = src.replace(CANONICAL, actual);
  fs.writeFileSync(ROUTER_PATH, src, "utf8");
  console.log("✓ Router patched. Run `npx hardhat compile --force` then deploy.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
