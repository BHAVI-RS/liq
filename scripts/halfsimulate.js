const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const UNI_ROUTER  = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const UNI_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const UNI_WETH    = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const USDT_PER_ETH = 1000;
const PACKAGE_ETH  = hre.ethers.parseEther("0.1"); // 100 USDT

// BPS rates applied to A40 (= 20% of T). Divide by 500 for % of total investment.
const COMM_RATES_BPS = [5000, 2500, 1000, 300, 250, 225, 200, 200, 175, 150];

//  Referral tree:
//  account[0]  →  [1, 2, 3]
//  account[1]  →  [4, 5]
//  account[4]  →  [6]
//  Total: 7 accounts (0–6)

const groups = [
  { referrer: 0, children: [1, 2, 3] },
  { referrer: 1, children: [4, 5]    },
  { referrer: 4, children: [6]       },
];

const referrerOf = new Map();
referrerOf.set(0, null);
for (const g of groups) {
  for (const c of g.children) referrerOf.set(c, g.referrer);
}

const TOTAL_ACCOUNTS = 7;

function toUSDT(ethBigInt) {
  return (parseFloat(hre.ethers.formatEther(ethBigInt)) * USDT_PER_ETH).toFixed(2);
}

function sep(char = "─", len = 60) { return char.repeat(len); }

async function main() {
  const signers  = await hre.ethers.getSigners();
  const deployer = signers[0];
  const network  = hre.network.name;

  if (signers.length < TOTAL_ACCOUNTS)
    throw new Error(`Need ${TOTAL_ACCOUNTS} signers — only ${signers.length} available.`);

  console.log(sep("═"));
  console.log("  HALFSIMULATE — Deploy · Referral Tree · Investments");
  console.log(sep("═"));
  console.log(`  Network  : ${network}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Accounts : ${TOTAL_ACCOUNTS} (0–6)\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 1 — DEPLOY
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 1 — DEPLOY");
  console.log(sep());

  const tokenDefs = [
    { name: "Hordex",   symbol: "HDX"   },
    { name: "Jiggy",    symbol: "JGY"    },
    { name: "PanWorld", symbol: "PwD" },
  ];
  const TOKEN_SUPPLY = 10_000_000;

  const HordexToken = await hre.ethers.getContractFactory("HordexToken");
  const deployedTokens = [];

  for (const def of tokenDefs) {
    const token = await HordexToken.deploy(def.name, def.symbol, TOKEN_SUPPLY);
    await token.waitForDeployment();
    const addr = await token.getAddress();
    deployedTokens.push({ ...def, contract: token, address: addr });
    console.log(`  ${def.symbol.padEnd(8)}: ${addr}`);
  }

  // Hordex is the platform token (used for staking rewards)
  const tokenAddress = deployedTokens[0].address;

  const LiquidityMath = await hre.ethers.getContractFactory("LiquidityMath");
  const liquidityMath = await LiquidityMath.deploy();
  await liquidityMath.waitForDeployment();
  const libAddress = await liquidityMath.getAddress();
  console.log(`  LiquidityMath   : ${libAddress}`);

  const LiquidityViewLib = await hre.ethers.getContractFactory("LiquidityViewLib", {
    libraries: { LiquidityMath: libAddress },
  });
  const liquidityViewLib = await LiquidityViewLib.deploy();
  await liquidityViewLib.waitForDeployment();
  const libViewAddress = await liquidityViewLib.getAddress();
  console.log(`  LiquidityViewLib: ${libViewAddress}`);

  const Liquidity = await hre.ethers.getContractFactory("Liquidity", {
    libraries: { LiquidityMath: libAddress, LiquidityViewLib: libViewAddress },
  });
  const liquidity = await Liquidity.deploy(UNI_ROUTER, UNI_FACTORY, UNI_WETH, tokenAddress);
  await liquidity.waitForDeployment();
  const liquidityAddress = await liquidity.getAddress();
  const deployTx      = liquidity.deploymentTransaction();
  const deployReceipt = await deployTx.wait();
  const deployBlock   = deployReceipt.blockNumber;
  console.log(`  Liquidity   : ${liquidityAddress}  (block ${deployBlock})`);

  // Transfer full supply of each token to Liquidity, register, and seed pool
  const seedETH    = hre.ethers.parseEther("100");
  const seedTokens = hre.ethers.parseEther("100000");

  for (const t of deployedTokens) {
    const supply = await t.contract.totalSupply();
    await (await t.contract.transfer(liquidityAddress, supply)).wait();
    console.log(`  Token supply (${hre.ethers.formatEther(supply)} ${t.symbol}) → Liquidity ✓`);

    await (await liquidity.addToken(t.address, t.name, t.symbol)).wait();
    console.log(`  ${t.symbol} registered in platform ✓`);

    await (await liquidity.seedPool(t.address, seedTokens, { value: seedETH })).wait();
    console.log(`  Uniswap pool seeded: 100 ETH + 100,000 ${t.symbol}  (1 ${t.symbol} = $1.00 USDT) ✓`);
  }

  // ─────────────────────────────────────────────────────────────
  // TWAP WARM-UP
  // updateTWAP needs two observations ≥ 30 min apart before
  // _twapReady = true.  On Hardhat, advance time manually.
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  TWAP WARM-UP");
  console.log(sep());
  await (await liquidity.updateTWAP()).wait();
  console.log("  Observation 0 recorded ✓");
  await hre.network.provider.send("evm_increaseTime", [31 * 60]);
  await hre.network.provider.send("evm_mine");
  await (await liquidity.updateTWAP()).wait();
  console.log("  Time advanced 31 min · Observation 1 recorded ✓");
  console.log("  TWAP ready — staking rewards are claimable ✓\n");

  const artifact      = hre.artifacts.readArtifactSync("Liquidity");
  const configContent =
`// AUTO-GENERATED by scripts/halfsimulate.js — do not edit manually
// Network: ${network} | Deployed: ${new Date().toLocaleString()}

const CONTRACT_ADDRESS        = "${liquidityAddress}";
const TOKEN_ADDRESS           = "${deployedTokens[0].address}";
const TOKEN_ADDRESS_JIGGY     = "${deployedTokens[1].address}";
const TOKEN_ADDRESS_PANWORLD  = "${deployedTokens[2].address}";
const ROUTER_ADDRESS          = "${UNI_ROUTER}";
const FACTORY_ADDRESS         = "${UNI_FACTORY}";
const WETH_ADDRESS            = "${UNI_WETH}";
const DEPLOY_BLOCK            = ${deployBlock};

const CONTRACT_ABI = ${JSON.stringify(artifact.abi, null, 2)};
`;
  fs.writeFileSync(path.join(__dirname, "..", "contract-config.js"),             configContent);
  fs.writeFileSync(path.join(__dirname, "..", "frontend", "contract-config.js"), configContent);

  const indexPath = path.join(__dirname, "..", "frontend", "index.html");
  fs.writeFileSync(indexPath,
    fs.readFileSync(indexPath, "utf8")
      .replace(/contract-config\.js\?v=\d+/g, `contract-config.js?v=${Date.now()}`)
  );
  console.log(`  contract-config.js written ✓ (root + frontend)\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 2 — REGISTER
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 2 — REGISTER  (account[0] pre-registered in constructor)");
  console.log(sep());

  for (const g of groups) {
    console.log(
      `\n  account[${g.referrer}]  →  ${g.children.length} referral(s)  [${g.children.join(", ")}]`
    );
    for (const idx of g.children) {
      const ct = new hre.ethers.Contract(liquidityAddress, artifact.abi, signers[idx]);
      await (await ct.register(signers[g.referrer].address)).wait();
      console.log(`    [${idx}] ${signers[idx].address}  ← [${g.referrer}] ✓`);
    }
  }

  const totalRegistered = groups.reduce((s, g) => s + g.children.length, 0);
  console.log(`\n  ${totalRegistered} accounts registered ✓\n`);

  // ─────────────────────────────────────────────────────────────
  // PHASE 3 — INVEST  (BFS order: parents before children)
  // ─────────────────────────────────────────────────────────────
  console.log(sep());
  console.log("  PHASE 3 — INVESTMENTS  (100 USDT = 0.1 ETH each, all 7 accounts)");
  console.log(sep());

  const iface = new hre.ethers.Interface([
    "event CommissionPaid(address indexed recipient, address indexed from, uint256 amount, uint256 level)",
  ]);

  // BFS order: account[0] first, then each group's children in order
  const investOrder = [0, ...groups.flatMap(g => g.children)];

  let totalInvested    = 0n;
  let totalCommissions = 0n;

  for (const idx of investOrder) {
    const account = signers[idx];
    const ct      = new hre.ethers.Contract(liquidityAddress, artifact.abi, account);

    const tx      = await ct.invest(tokenAddress, { value: PACKAGE_ETH });
    const receipt = await tx.wait();

    totalInvested += PACKAGE_ETH;

    const comms = [];
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "CommissionPaid") {
          comms.push({
            recipient : parsed.args.recipient,
            amount    : parsed.args.amount,
            level     : Number(parsed.args.level),
          });
        }
      } catch (_) {}
    }

    const txTotal     = comms.reduce((s, c) => s + c.amount, 0n);
    totalCommissions += txTotal;

    const refIdx   = referrerOf.get(idx);
    const refLabel = refIdx === null ? "no referrer" : `ref by [${refIdx}]`;
    console.log(`\n  account[${idx}]  ${account.address}  (${refLabel})`);
    console.log(`  ${sep("·", 56)}`);

    if (comms.length === 0) {
      console.log(`    (no commission events)`);
    } else {
      for (const c of comms) {
        const ratePct   = (COMM_RATES_BPS[c.level - 1] / 500).toFixed(2).replace(/\.?0+$/, "");
        const usdtAmt   = toUSDT(c.amount);
        const recvIdx   = signers.findIndex(s => s.address.toLowerCase() === c.recipient.toLowerCase());
        const isOwner   = recvIdx === 0;
        const recvLabel = isOwner
          ? `account[0]  (owner / platform)`
          : `account[${recvIdx}]  ${c.recipient.slice(0, 10)}…`;
        console.log(
          `    L${String(c.level).padEnd(2)}  ${String(ratePct).padStart(5)}% of T` +
          `  $${usdtAmt.padStart(7)} USDT  →  ${recvLabel}`
        );
      }
      console.log(`    ── total: $${toUSDT(txTotal)} USDT`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────
  console.log(`\n${sep("═")}`);
  console.log("  HALFSIMULATION COMPLETE");
  console.log(sep("═"));
  for (const t of deployedTokens) {
    console.log(`  ${t.symbol.padEnd(10)}: ${t.address}`);
  }
  console.log(`  Liquidity      : ${liquidityAddress}`);
  console.log(`  Accounts       : ${investOrder.length}  (accounts[0..6])`);
  console.log(`  Package        : 100 USDT (0.1 ETH) each`);
  console.log(`  Total invested : $${toUSDT(totalInvested)} USDT`);
  console.log(`  Total comms    : $${toUSDT(totalCommissions)} USDT`);

  console.log(`\n  Tree structure:`);
  console.log(`  ${"REFERRER".padEnd(12)} ${"COUNT".padEnd(7)} CHILDREN`);
  console.log(`  ${sep("·", 36)}`);
  for (const g of groups) {
    console.log(
      `  account[${g.referrer}]    ` +
      `${String(g.children.length).padEnd(7)}` +
      `[${g.children.join(", ")}]`
    );
  }

  const contractETH = await hre.ethers.provider.getBalance(liquidityAddress);
  console.log(`\n  Contract balances:`);
  console.log(`    ETH      : ${hre.ethers.formatEther(contractETH)}`);
  for (const t of deployedTokens) {
    const bal = await t.contract.balanceOf(liquidityAddress);
    console.log(`    ${t.symbol.padEnd(8)}: ${hre.ethers.formatEther(bal)}`);
  }
  console.log(sep("═") + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
