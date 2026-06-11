// HordexToken address is fixed — this script ensures hordex-token.json always
// points to the canonical token and never deploys a new one.
//
// RUN:
//   npx hardhat run scripts/amoytestnet/othordex.js --network polygonAmoy

const fs   = require("fs");
const path = require("path");

const OUT_FILE     = path.join(__dirname, "hordex-token.json");
const TOKEN_NAME   = "Hordex Token";
const TOKEN_SYMBOL = "HORDEX";

// Fixed canonical address — never change this.
const FIXED_TOKEN_ADDRESS = "0xC05362EF8396C1761A9591bbf0Bd0f5bfFB163A7";

async function main() {
  if (fs.existsSync(OUT_FILE)) {
    const existing = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
    if (existing.tokenAddress.toLowerCase() !== FIXED_TOKEN_ADDRESS.toLowerCase()) {
      console.error(`\n❌  hordex-token.json has wrong address: ${existing.tokenAddress}`);
      console.error(`   Expected: ${FIXED_TOKEN_ADDRESS}`);
      console.error("   Overwriting with the correct fixed address.\n");
    } else {
      console.log("\n  hordex-token.json is correct — no changes needed.");
      console.log(`  Address : ${existing.tokenAddress}\n`);
      return;
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    network:      "polygonAmoy",
    tokenAddress: FIXED_TOKEN_ADDRESS,
    name:         TOKEN_NAME,
    symbol:       TOKEN_SYMBOL,
    totalSupply:  "10000000000",
    note:         "Fixed canonical address — do not redeploy.",
  }, null, 2));

  console.log("────────────────────────────────────────────────────");
  console.log(`  Token address : ${FIXED_TOKEN_ADDRESS}`);
  console.log(`  Saved to      : scripts/amoytestnet/hordex-token.json`);
  console.log("────────────────────────────────────────────────────\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
