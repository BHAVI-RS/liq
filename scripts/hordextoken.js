const { ethers } = require("hardhat");

// ── Token configuration ────────────────────────────────────────────────────────
const NAME           = "TIKTOK";
const SYMBOL         = "TIKTOK";
const INITIAL_SUPPLY = 9_000_000_000; // human-readable (18 decimals applied by constructor)

// Platform contract to register with and approve spending for
const CONTRACT_ADDRESS = "0xc2214d88C9ae33DfC275F088a5808b321AF43972";

const PLATFORM_ABI = [
  "function addToken(address _tokenAddress, string calldata _name, string calldata _symbol) external"
];

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer :", deployer.address);

    // 1. Deploy token
    console.log("\n[1/3] Deploying HordexToken…");
    const Token = await ethers.getContractFactory("HordexToken");
    const token = await Token.deploy(NAME, SYMBOL, INITIAL_SUPPLY);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();
    console.log("      Token deployed :", tokenAddress);

    const balance = await token.balanceOf(deployer.address);
    console.log("      Deployer balance:", ethers.formatUnits(balance, 18), SYMBOL);

    // 2. Register token in the platform (onlyOwner)
    console.log("\n[2/3] Registering token in platform…");
    const platform = new ethers.Contract(CONTRACT_ADDRESS, PLATFORM_ABI, deployer);
    const addTx = await platform.addToken(tokenAddress, NAME, SYMBOL);
    await addTx.wait();
    console.log("      Registered. tx:", addTx.hash);

    // 3. Approve platform to spend all tokens on behalf of deployer
    console.log("\n[3/3] Approving platform spending limit…");
    const approveTx = await token.approve(CONTRACT_ADDRESS, ethers.MaxUint256);
    await approveTx.wait();
    console.log("      Approved (unlimited). tx:", approveTx.hash);

    console.log("\n✓ Done.");
    console.log("  Token   :", tokenAddress);
    console.log("  Platform:", CONTRACT_ADDRESS);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
