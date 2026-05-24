// Deploys HordexToken as "Ammoy" with 1,000,000,000 supply on Polygon Amoy.
//
// RUN:
//   npx hardhat run scripts/amoytestnet/tokenamoy.js --network polygonAmoy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const DEPLOY_OVERRIDES = {
  maxFeePerGas:         hre.ethers.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: hre.ethers.parseUnits("30", "gwei"),
  gasLimit: 3_000_000,
};

async function main() {
  const network = hre.network.name;
  console.log(`\nDeploying Ammoy token to ${network}...`);

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "POL\n");

  const HordexToken = await hre.ethers.getContractFactory("HordexToken");
  const token = await HordexToken.deploy("Ammoy", "AMMO", 1_000_000_000, DEPLOY_OVERRIDES);
  await token.waitForDeployment();

  const tokenAddress = await token.getAddress();
  const totalSupply  = await token.totalSupply();

  console.log("Token address :", tokenAddress);
  console.log("Name          :", await token.name());
  console.log("Symbol        :", await token.symbol());
  console.log("Total supply  :", hre.ethers.formatEther(totalSupply), "AMMO");
  console.log("Owner         :", await token.owner());

  // Save address to a local file for reference
  const outPath = path.join(__dirname, "ammoy-token-address.json");
  fs.writeFileSync(outPath, JSON.stringify({
    network,
    tokenAddress,
    name: "Ammoy",
    symbol: "AMMO",
    totalSupply: "1000000000",
    deployedAt: new Date().toISOString(),
  }, null, 2));

  console.log(`\nAddress saved to scripts/amoytestnet/ammoy-token-address.json`);
  console.log("\n── Deployment complete ──────────────────────────");
  console.log("Network   : Polygon Amoy (chainId 80002)");
  console.log("Token     :", tokenAddress);
  console.log("Minted    : 1,000,000,000 AMMO → deployer");
  console.log("────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
