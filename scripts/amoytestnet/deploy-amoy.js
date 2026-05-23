// Deployment script for Polygon Amoy testnet.
// Deploys the full Uniswap V2 stack (WETH9 + Factory + Router) from source,
// then deploys HordexToken and the Liquidity platform on top.
//
// Run order:
//   1. npm run compile
//   2. npm run fix-init-hash      ← patches Router with correct pair bytecode hash
//   3. npm run compile -- --force ← recompile Router with patched hash
//   4. npm run deploy:amoy
const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const CANONICAL_HASH = "96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";

// maxFeePerGas × gasLimit must stay under 1 POL (the RPC provider's fee cap).
// Actual fee paid = baseFee × gasUsed — always much lower than the ceiling.
const DEPLOY_OVERRIDES = {
  maxFeePerGas:         hre.ethers.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: hre.ethers.parseUnits("30", "gwei"),
  gasLimit: 15_000_000,  // 60 gwei × 15M = 0.9 POL < 1 POL cap
};

async function main() {
  const network = hre.network.name;
  console.log(`\nDeploying to ${network}...`);

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "MATIC\n");

  // ── Guard: ensure Router init code hash is patched ──────────────────────
  const pairArtifact = await hre.artifacts.readArtifact("UniswapV2Pair");
  const actualHash = hre.ethers.keccak256(pairArtifact.bytecode).slice(2);
  if (actualHash !== CANONICAL_HASH) {
    const routerSrc = fs.readFileSync(
      path.join(__dirname, "..", "..", "contracts", "uniswapamoy", "UniswapV2Router02.sol"),
      "utf8"
    );
    if (!routerSrc.includes(actualHash)) {
      console.error("❌ Router init code hash is stale.");
      console.error("   Run `npm run fix-init-hash` then `npm run compile -- --force` first.");
      process.exit(1);
    }
  }

  // ── Deploy WETH9 ──────────────────────────────────────────────────────────
  const WETH9 = await hre.ethers.getContractFactory("WETH9");
  const weth9 = await WETH9.deploy(DEPLOY_OVERRIDES);
  await weth9.waitForDeployment();
  const wethAddress = await weth9.getAddress();
  console.log("WETH9            :", wethAddress);

  // ── Deploy UniswapV2Factory ───────────────────────────────────────────────
  const UniswapV2Factory = await hre.ethers.getContractFactory("UniswapV2Factory");
  const factory = await UniswapV2Factory.deploy(deployer.address, DEPLOY_OVERRIDES);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("UniswapV2Factory :", factoryAddress);

  // ── Deploy UniswapV2Router02 ──────────────────────────────────────────────
  const UniswapV2Router02 = await hre.ethers.getContractFactory("UniswapV2Router02");
  const router = await UniswapV2Router02.deploy(factoryAddress, wethAddress, DEPLOY_OVERRIDES);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  console.log("UniswapV2Router02:", routerAddress);

  // ── Deploy HordexToken ────────────────────────────────────────────────────
  const HordexToken = await hre.ethers.getContractFactory("HordexToken");
  const hordexToken = await HordexToken.deploy("Hordex Token", "HORDEX", 10_000_000, DEPLOY_OVERRIDES);
  await hordexToken.waitForDeployment();
  const tokenAddress = await hordexToken.getAddress();
  console.log("HordexToken      :", tokenAddress);

  // ── Deploy LiquidityMath ──────────────────────────────────────────────────
  const LiquidityMath = await hre.ethers.getContractFactory("LiquidityMath");
  const liquidityMath = await LiquidityMath.deploy(DEPLOY_OVERRIDES);
  await liquidityMath.waitForDeployment();
  const libAddress = await liquidityMath.getAddress();
  console.log("LiquidityMath    :", libAddress);

  // ── Deploy LiquidityViewLib ───────────────────────────────────────────────
  const LiquidityViewLib = await hre.ethers.getContractFactory("LiquidityViewLib", {
    libraries: { LiquidityMath: libAddress },
  });
  const liquidityViewLib = await LiquidityViewLib.deploy(DEPLOY_OVERRIDES);
  await liquidityViewLib.waitForDeployment();
  const libViewAddress = await liquidityViewLib.getAddress();
  console.log("LiquidityViewLib :", libViewAddress);

  // ── Deploy Liquidity ──────────────────────────────────────────────────────
  const Liquidity = await hre.ethers.getContractFactory("Liquidity", {
    libraries: { LiquidityMath: libAddress, LiquidityViewLib: libViewAddress },
  });
  const liquidity = await Liquidity.deploy(routerAddress, factoryAddress, wethAddress, tokenAddress, DEPLOY_OVERRIDES);
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  console.log("Liquidity        :", liquidityAddress);

  // ── Transfer tokens & seed pool ───────────────────────────────────────────
  const totalSupply = await hordexToken.totalSupply();
  console.log("\nTransferring", hre.ethers.formatEther(totalSupply), "HORDEX to Liquidity...");
  await (await hordexToken.transfer(liquidityAddress, totalSupply)).wait();
  console.log("  ✓ Transfer confirmed");

  console.log("Registering HordexToken...");
  await (await liquidity.addToken(tokenAddress, "Hordex Token", "HORDEX")).wait();
  console.log("  ✓ Token registered");

  // Seed: 100 MATIC + 100,000 HORDEX → 1 HORDEX = 0.001 MATIC
  const seedMATIC  = hre.ethers.parseEther("100");
  const seedTokens = hre.ethers.parseEther("100000");
  console.log("Seeding pool: 100 MATIC + 100,000 HORDEX...");
  await (await liquidity.seedPool(tokenAddress, seedTokens, { value: seedMATIC })).wait();
  console.log("  ✓ Pool seeded");

  // ── Write contract-config.js ──────────────────────────────────────────────
  const artifact = hre.artifacts.readArtifactSync("Liquidity");
  const configContent =
`// AUTO-GENERATED by scripts/deploy-amoy.js — do not edit manually
// Network: ${network} | Deployed: ${new Date().toLocaleString()}

const CONTRACT_ADDRESS  = "${liquidityAddress}";
const TOKEN_ADDRESS     = "${tokenAddress}";
const ROUTER_ADDRESS    = "${routerAddress}";
const FACTORY_ADDRESS   = "${factoryAddress}";
const WETH_ADDRESS      = "${wethAddress}";

const CONTRACT_ABI = ${JSON.stringify(artifact.abi, null, 2)};
`;
  const configPath    = path.join(__dirname, "..", "..", "contract-config.js");
  const frontendConfig = path.join(__dirname, "..", "..", "frontend", "contract-config.js");
  fs.writeFileSync(configPath,     configContent);
  fs.writeFileSync(frontendConfig, configContent);

  const indexPath = path.join(__dirname, "..", "..", "frontend", "index.html");
  if (fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath,
      fs.readFileSync(indexPath, "utf8")
        .replace(/contract-config\.js\?v=\d+/g, `contract-config.js?v=${Date.now()}`)
    );
  }
  console.log("\ncontract-config.js updated ✓ (root + frontend)");

  console.log("\n── Deployment Summary ──────────────────────────");
  console.log("Network:         Polygon Amoy (chainId 80002)");
  console.log("WETH9:          ", wethAddress);
  console.log("Factory:        ", factoryAddress);
  console.log("Router:         ", routerAddress);
  console.log("HordexToken:    ", tokenAddress);
  console.log("Liquidity:      ", liquidityAddress);
  console.log("Pool seeded:     100 MATIC + 100,000 HORDEX");
  console.log("────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
