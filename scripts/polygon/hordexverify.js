// Verify all deployed Hordex contracts on Polygon mainnet PolygonScan (Etherscan V2 API).
//
// Standalone re-verify: reads the addresses written by hordexdeploy.js and submits each
// contract for source verification. Use this to verify an existing deployment, or to retry
// if auto-verify inside hordexdeploy.js was skipped (no API key) or interrupted.
//
// Reads:
//   • scripts/polygon/hordex-deploy-output.json  (libs, facets, core, router/factory/usdt/token)
//
// REQUIREMENTS:
//   • ETHERSCAN_API_KEY in .env   (one V2 key from etherscan.io/myapikey covers Polygon 137)
//   • The working-tree Solidity source must STILL match the deployed bytecode. If any
//     contract was edited since deploying, re-deploy first or verification will fail.
//
// USAGE:
//   npx hardhat run scripts/polygon/hordexverify.js --network polygon

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { verifyAllContracts } = require("../amoytestnet/_verify");

function sep(c = "─", n = 64) { return c.repeat(n); }

async function main() {
  const out = JSON.parse(
    fs.readFileSync(path.join(__dirname, "hordex-deploy-output.json"), "utf8")
  );
  const a = out.addresses;

  console.log(sep("═"));
  console.log("  HORDEXVERIFY — Polygon mainnet PolygonScan source verification");
  console.log(sep("═"));
  console.log(`  Network : ${hre.network.name} (chainId ${hre.network.config.chainId})`);
  console.log(`  Deployed: ${out.deployedAt}`);
  console.log(`  Core    : ${a.Hordex}\n`);

  await verifyAllContracts(hre, {
    router:    out.router,
    factory:   out.factory,
    usdt:      out.usdt,
    token:     out.platformToken,
    liquidity: a.Hordex,
    facet:     a.HordexFacet,
    roiFacet:  a.HordexROIFacet,
    lib:       a.HordexMath,
    libView:   a.HordexViewLib,
    viewFacet: a.HordexViewFacet,
  });

  console.log("\n" + sep("═"));
  console.log("  DONE — check https://polygonscan.com/address/" + a.Hordex + "#code");
  console.log(sep("═") + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
