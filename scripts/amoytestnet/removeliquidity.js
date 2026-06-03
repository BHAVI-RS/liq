// Removes all liquidity from the Amoy testnet simulation and returns USDT/tokens to deployer.
// Addresses are loaded automatically from contract-config.js (written by simulateamoy.js).
//
// What it does:
//   Phase 1 — Withdraw USDT and platform tokens held inside the Liquidity contract
//   Phase 2 — Remove seed LP from Uniswap pools (only LP in deployer wallet from seedPool)
//
// NOTE: User-invested LP tokens are locked in the contract and cannot be swept — only
//       each user can claim/remove their own LP after the lock period expires (3 min in testing).
//
// RUN:
//   npx hardhat run scripts/amoytestnet/removeliquidity.js --network polygonAmoy

const hre  = require("hardhat");
const path = require("path");
const fs   = require("fs");

// Pre-deployed Uniswap V2 on Polygon Amoy — do not edit
const UNI_ROUTER  = "0x85eaBB2740eD2f9e3b53c51D8e1E7BdA53672825";
const UNI_FACTORY = "0xa5d020Eb5a4D537f56F7314d2359f7770DE01a48";

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
    USDT_ADDRESS:           extract("USDT_ADDRESS") || extract("WETH_ADDRESS"),
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
  "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256 amountA, uint256 amountB)",
];
const LIQUIDITY_ABI = [
  "function withdrawToken(address token, uint256 amount) external",
];

// maxFeePerGas × gasLimit must stay under 1 POL (RPC provider fee cap).
const TX_OVERRIDES = {
  maxFeePerGas:         hre.ethers.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: hre.ethers.parseUnits("30", "gwei"),
  gasLimit: 2_000_000,   // 60 gwei × 2M = 0.12 POL < 1 POL cap
};

function sep(c = "─", n = 62) { return c.repeat(n); }
function fmt(wei, sym = "USDT") { return hre.ethers.formatEther(wei) + " " + sym; }

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

  const USDT_ADDRESS = cfg.USDT_ADDRESS;
  if (!USDT_ADDRESS) {
    console.error("❌  USDT_ADDRESS / WETH_ADDRESS not found in contract-config.js");
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
  const usdtToken = new hre.ethers.Contract(USDT_ADDRESS, ERC20_ABI, deployer);

  console.log(`  Deployer  : ${deployer.address}`);
  console.log(`  Liquidity : ${LIQUIDITY_ADDRESS}`);
  console.log(`  USDT      : ${USDT_ADDRESS}`);
  console.log(`  Tokens    : ${tokenDefs.map(t => t.name).join(", ")}`);
  const usdtBefore = await usdtToken.balanceOf(deployer.address);
  console.log(`  USDT before: ${fmt(usdtBefore)}\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 1 — Withdraw USDT and tokens from Liquidity contract
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 1 — Withdraw USDT + tokens from Liquidity contract");
  console.log(sep());

  const contractUSDT = await usdtToken.balanceOf(LIQUIDITY_ADDRESS);
  if (contractUSDT > 0n) {
    console.log(`  Contract USDT: ${fmt(contractUSDT)} → withdrawing…`);
    await (await liquidityContract.withdrawToken(USDT_ADDRESS, 0, TX_OVERRIDES)).wait();
    console.log(`  ✓ USDT withdrawn`);
  } else {
    console.log(`  Contract USDT: 0`);
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
  // PHASE 2 — Remove seed LP from Uniswap pools
  // ─────────────────────────────────────────────────────────────
  console.log("\n" + sep());
  console.log("  PHASE 2 — Remove seed LP from Uniswap pools (deployer wallet only)");
  console.log(sep());

  const pairAddresses = [];

  for (const t of tokenDefs) {
    const pairAddr = await factory.getPair(t.address, USDT_ADDRESS);
    if (pairAddr === hre.ethers.ZeroAddress) {
      console.log(`  ${t.name}: no Uniswap pair found — skipping`);
      pairAddresses.push(null);
    } else {
      pairAddresses.push(pairAddr);
    }
  }

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

    console.log(`    Calling removeLiquidity…`);
    const tx = await router.removeLiquidity(
      t.address,
      USDT_ADDRESS,
      deployerLP,
      0,              // amountTokenMin (0 = accept any, testnet only)
      0,              // amountUSDTMin
      deployer.address,
      deadline(),
      TX_OVERRIDES
    );
    const receipt = await tx.wait();

    const transferIface = new hre.ethers.Interface([
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    ]);
    let tokensReceived = 0n;
    let usdtReceived   = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = transferIface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "Transfer" && parsed.args.to.toLowerCase() === deployer.address.toLowerCase()) {
          if (log.address.toLowerCase() === t.address.toLowerCase())
            tokensReceived = parsed.args.value;
          else if (log.address.toLowerCase() === USDT_ADDRESS.toLowerCase())
            usdtReceived = parsed.args.value;
        }
      } catch (_) {}
    }
    console.log(`    ✓ LP removed  (tx: ${receipt.hash.slice(0, 20)}…)`);
    if (tokensReceived > 0n) console.log(`    ↳ ${fmt(tokensReceived, t.name)} returned to deployer`);
    if (usdtReceived   > 0n) console.log(`    ↳ ${fmt(usdtReceived)} returned to deployer`);
  }

  // ─────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────
  const usdtAfter = await usdtToken.balanceOf(deployer.address);

  console.log("\n" + sep("═"));
  console.log("  COMPLETE");
  console.log(sep("═"));
  console.log(`  USDT before : ${fmt(usdtBefore)}`);
  console.log(`  USDT after  : ${fmt(usdtAfter)}`);
  if (usdtAfter >= usdtBefore) {
    console.log(`  USDT gained : +${fmt(usdtAfter - usdtBefore)}`);
  }

  console.log(`\n  Deployer balances after:`);
  console.log(`    ${"USDT".padEnd(10)}: ${hre.ethers.formatEther(usdtAfter)}`);
  for (const t of tokenDefs) {
    const tok = new hre.ethers.Contract(t.address, ERC20_ABI, deployer);
    const bal = await tok.balanceOf(deployer.address);
    console.log(`    ${t.name.padEnd(10)}: ${hre.ethers.formatEther(bal)}`);
  }
  console.log(sep("═") + "\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
