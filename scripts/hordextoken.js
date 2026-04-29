const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();

    console.log("Deploying with:", deployer.address);

    const NAME = "Hordex Token";
    const SYMBOL = "HDEX";
    const INITIAL_SUPPLY = 1000000; // 1M tokens (human readable)

    const Token = await ethers.getContractFactory("HordexToken");

    const token = await Token.deploy(
        NAME,
        SYMBOL,
        INITIAL_SUPPLY
    );

    await token.waitForDeployment();

    const address = await token.getAddress();

    console.log("Token deployed at:", address);

    // Check balance
    const balance = await token.balanceOf(deployer.address);
    console.log("Deployer balance:", ethers.formatUnits(balance, 18));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});