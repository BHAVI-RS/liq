// Removes all liquidity from the Amoy testnet simulation and returns POL to deployer.
// Addresses are loaded automatically from contract-config.js (written by simulateamoy.js).
//
// What it does:
//   Phase 1 — Withdraw MATIC and tokens held inside the Liquidity contract
//   Phase 2 — Sweep LP tokens held inside the Liquidity contract (invested positions)
//   Phase 3 — Remove all LP from Uniswap pools (seed LP in deployer wallet + swept LP)
//
// RUN:
//   npx hardhat run scripts/amoytestnet/removeliquidity.js --network polygonAmoy

const hre  = require("hardhat");
const path = require("path");
const fs   = require("fs");

// Pre-deployed Uniswap V2 on Polygon Amoy — do not edit
const UNI_ROUTER  = "0x85eaBB2740eD2f9e3b53c51D8e1E7BdA53672825";
const UNI_FACTORY = "0xa5d020Eb5a4D537f56F7314d2359f7770DE01a48";
const UNI_WETH    = "0x7Bd0A72d3A07353C91dDA48D2B78454248d281E6";

// ─── Load deployed addresses from contract-config.js ──────────────────────────
const CONFIG_PATH = path.join(__dirname, "..", "..", "contract-config.js");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌  contract-config.js not found. Run simulateamoy.js or deploy-amoy.js first.");
    process.exit(1);
  }
  const src     = fs.readFileSync(CONFIG_PATH, "utf8");
  const extract = (name) => {
    const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*"(0x[0-9a-fA-F]+)"`));
    return m ? m[1] : undefined;
  };
  return {
    CONTRACT_ADDRESS:       extract("CONTRACT_ADDRESS"),
    TOKEN_ADDRESS:          extract("TOKEN_ADDRESS"),
    TOKEN_ADDRESS_JIGGY:    extract("TOKEN_ADDRESS_JIGGY"),
    TOKEN_ADDRESS_PANWORLD: extract("TOKEN_ADDRESS_PANWORLD"),
  };
}

// ─── Minimal ABIs ──────────────────────────────────────────────────────────────
const ERC20_ABI = [
  "function balanceOf(address) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
];
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
];
const ROUTER_ABI = [
  "function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) external returns (uint256 amountToken, uint256 amountETH)",
];
const LIQUIDITY_ABI = [
  "function withdrawETH(uint256 amount) external",
  "function withdrawToken(address token, uint256 amount) external",
];

// maxFeePerGas × gasLimit must stay under 1 POL (RPC provider fee cap).
const TX_OVERRIDES = {
  maxFeePerGas:         hre.ethers.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: hre.ethers.parseUnits("30", "gwei"),
  gasLimit: 2_000_000,   // 60 gwei × 2M = 0.12 POL < 1 POL cap
};

function sep(c = "─", n = 62) { return c.repeat(n); }
function fmt(wei) { return hre.ethers.formatEther(wei) + " POL"; }
function fmtTok(wei, sym) { return hre.ethers.formatEther(wei) + " " + sym; }

async function main() {
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey || rawKey.replace("0x", "").length !== 64) {
    console.error("❌  PRIVATE_KEY missing or wrong length in .env");
    process.exit(1);
  }

  // ── Load config ───────────────────────────────────────────────────────────────
  const cfg = loadConfig();

  const LIQUIDITY_ADDRESS = cfg.CONTRACT_ADDRESS;
  if (!LIQUIDITY_ADDRESS) {
    console.error("❌  CONTRACT_ADDRESS not found in contract-config.js");
    process.exit(1);
  }

  // Build token list — skip any that are missing from config
  const tokenDefs = [
    cfg.TOKEN_ADDRESS          && { name: "HORDEX",   address: cfg.TOKEN_ADDRESS          },
    cfg.TOKEN_ADDRESS_JIGGY    && { name: "JIGGY",    address: cfg.TOKEN_ADDRESS_JIGGY    },
    cfg.TOKEN_ADDRESS_PANWORLD && { name: "PANWORLD", address: cfg.TOKEN_ADDRESS_PANWORLD },
  ].filter(Boolean);

  if (tokenDefs.length === 0) {
    console.error("❌  No token addresses found in contract-config.js");
    process.exit(1);
  }

  const provider = hre.ethers.provider;
  const pk       = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
  const deployer = new hre.ethers.Wallet(pk, provider);

  const factory           = new hre.ethers.Contract(UNI_FACTORY,       FACTORY_ABI,   deployer);
  const router            = new hre.ethers.Contract(UNI_ROUTER,        ROUTER_ABI,    deployer);
  const liquidityContract = new hre.ethers.Contract(LIQUIDITY_ADDRESS, LIQUIDITY_ABI, deployer);

  const deadline = () => Math.floor(Date.now() / 1000) + 600; // 10 min from now

  console.log(sep("═"));
  console.log("  REMOVE LIQUIDITY — Polygon Amoy");
  console.log(sep("═"));
  console.log(`  Deployer  : ${deployer.address}`);
  console.log(`  Liquidity : ${LIQUIDITY_ADDRESS}`);
  console.log(`  Tokens    : ${tokenDefs.map(t => t.name).join(", ")}`);
  const balBefore = await provider.getBalance(deployer.address);
  console.log(`  POL before: ${fmt(balBefore)}\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 1 — Withdraw MATIC and tokens from Liquidity contract
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 1 — Withdraw MATIC + tokens from Liquidity contract");
  console.log(sep());

  const contractMATIC = await provider.getBalance(LIQUIDITY_ADDRESS);
  if (contractMATIC > 0n) {
    console.log(`  Contract MATIC: ${fmt(contractMATIC)} → withdrawing…`);
    await (await liquidityContract.withdrawETH(0, TX_OVERRIDES)).wait();
    console.log(`  ✓ MATIC withdrawn`);
  } else {
    console.log(`  Contract MATIC: 0`);
  }

  for (const t of tokenDefs) {
    const tok = new hre.ethers.Contract(t.address, ERC20_ABI, deployer);
    const bal = await tok.balanceOf(LIQUIDITY_ADDRESS);
    if (bal > 0n) {
      console.log(`  Contract ${t.name.padEnd(8)}: ${hre.ethers.formatEther(bal)} → withdrawing…`);
      await (await liquidityContract.withdrawToken(t.address, 0, TX_OVERRIDES)).wait();
      console.log(`  ✓ ${t.name} withdrawn`);
    } else {
      console.log(`  Contract ${t.name.padEnd(8)}: 0`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PHASE 2 — Sweep LP tokens from Liquidity contract
  // ─────────────────────────────────────────────────────────────
  console.log("\n" + sep());
  console.log("  PHASE 2 — Sweep LP tokens from Liquidity contract");
  console.log(sep());

  const pairAddresses = [];

  for (const t of tokenDefs) {
    const pairAddr = await factory.getPair(t.address, UNI_WETH);
    if (pairAddr === hre.ethers.ZeroAddress) {
      console.log(`  ${t.name}: no Uniswap pair found — skipping`);
      pairAddresses.push(null);
      continue;
    }
    pairAddresses.push(pairAddr);

    const lpToken    = new hre.ethers.Contract(pairAddr, ERC20_ABI, deployer);
    const contractLP = await lpToken.balanceOf(LIQUIDITY_ADDRESS);
    if (contractLP > 0n) {
      console.log(`  ${t.name.padEnd(8)} LP in contract: ${hre.ethers.formatEther(contractLP)} → sweeping…`);
      await (await liquidityContract.withdrawToken(pairAddr, 0)).wait();
      console.log(`  ✓ ${t.name} LP swept to deployer`);
    } else {
      console.log(`  ${t.name.padEnd(8)} LP in contract: 0`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PHASE 3 — Remove all LP from Uniswap pools
  // ─────────────────────────────────────────────────────────────
  console.log("\n" + sep());
  console.log("  PHASE 3 — Remove all LP from Uniswap pools");
  console.log(sep());

  for (let i = 0; i < tokenDefs.length; i++) {
    const t        = tokenDefs[i];
    const pairAddr = pairAddresses[i];

    if (!pairAddr) continue;

    const lpToken    = new hre.ethers.Contract(pairAddr, ERC20_ABI, deployer);
    const deployerLP = await lpToken.balanceOf(deployer.address);

    if (deployerLP === 0n) {
      console.log(`\n  ${t.name}: deployer LP balance = 0 — nothing to remove`);
      continue;
    }

    console.log(`\n  ${t.name}`);
    console.log(`    Pair      : ${pairAddr}`);
    console.log(`    LP amount : ${hre.ethers.formatEther(deployerLP)}`);

    console.log(`    Approving router…`);
    await (await lpToken.approve(UNI_ROUTER, deployerLP, TX_OVERRIDES)).wait();
    console.log(`    ✓ Approved`);

    console.log(`    Calling removeLiquidityETH…`);
    const tx = await router.removeLiquidityETH(
      t.address,
      deployerLP,
      0,                  // amountTokenMin  (0 = accept any, testnet only)
      0,                  // amountETHMin
      deployer.address,
      deadline(),
      TX_OVERRIDES
    );
    const receipt = await tx.wait();

    const routerIface = new hre.ethers.Interface([
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    ]);
    let tokensReceived = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = routerIface.parseLog({ topics: log.topics, data: log.data });
        if (
          parsed?.name === "Transfer" &&
          parsed.args.to.toLowerCase() === deployer.address.toLowerCase() &&
          log.address.toLowerCase() === t.address.toLowerCase()
        ) {
          tokensReceived = parsed.args.value;
        }
      } catch (_) {}
    }
    console.log(`    ✓ LP removed  (tx: ${receipt.hash.slice(0, 20)}…)`);
    if (tokensReceived > 0n) {
      console.log(`    ↳ ${fmtTok(tokensReceived, t.name)} returned to deployer`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────
  const balAfter = await provider.getBalance(deployer.address);

  console.log("\n" + sep("═"));
  console.log("  COMPLETE");
  console.log(sep("═"));
  console.log(`  POL before : ${fmt(balBefore)}`);
  console.log(`  POL after  : ${fmt(balAfter)}`);

  if (balAfter >= balBefore) {
    console.log(`  Net gain   : +${fmt(balAfter - balBefore)}  (gas already deducted)`);
  } else {
    console.log(`  Net gas    : -${fmt(balBefore - balAfter)}`);
  }

  console.log(`\n  Deployer token balances after:`);
  for (const t of tokenDefs) {
    const tok = new hre.ethers.Contract(t.address, ERC20_ABI, deployer);
    const bal = await tok.balanceOf(deployer.address);
    console.log(`    ${t.name.padEnd(10)}: ${hre.ethers.formatEther(bal)}`);
  }
  console.log(sep("═") + "\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
