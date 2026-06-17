// Verify all deployed Hordex contracts on Amoy PolygonScan (Etherscan V2 API).
//
// Standalone re-verify: reads the addresses from the LAST deploy and submits each
// contract for source verification. Use this to verify an existing deployment, or to
// retry if auto-verify (inside inithdx.js / simulateinit.js) was interrupted.
//
// Reads:
//   • scripts/amoytestnet/deploy-output.json  → libs, facets, main, tokens, router/factory
//   • contract-config.js                       → VIEW_FACET_ADDRESS (not in deploy-output.json)
//
// REQUIREMENTS:
//   • ETHERSCAN_API_KEY in .env   (one V2 key from etherscan.io/myapikey covers Amoy)
//   • The working-tree Solidity source must STILL match the deployed bytecode. If you
//     edited any contract since deploying, re-deploy first or verification will fail.
//
// USAGE:
//   npx hardhat run scripts/amoytestnet/verify-amoy.js --network polygonAmoy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { verifyAllContracts } = require("./_verify");

function sep(c = "─", n = 64) { return c.repeat(n); }

// Pull a `const NAME = "0x...."` address out of contract-config.js
function readConfigAddress(name) {
  const cfgPath = path.join(__dirname, "..", "..", "contract-config.js");
  const src = fs.readFileSync(cfgPath, "utf8");
  const m = src.match(new RegExp(`${name}\\s*=\\s*"(0x[0-9a-fA-F]{40})"`));
  return m ? m[1] : null;
}

async function main() {
  const out = JSON.parse(
    fs.readFileSync(path.join(__dirname, "deploy-output.json"), "utf8")
  );
  const viewFacetAddress = readConfigAddress("VIEW_FACET_ADDRESS");

  console.log(sep("═"));
  console.log("  VERIFY — Amoy PolygonScan source verification");
  console.log(sep("═"));
  console.log(`  Network : ${hre.network.name} (chainId ${hre.network.config.chainId})`);
  console.log(`  Deployed: ${out.deployedAt}\n`);

  await verifyAllContracts(hre, {
    router:    out.routerAddress,
    factory:   out.factoryAddress,
    usdt:      out.usdtAddress,
    token:     out.tokenAddress,
    liquidity: out.liquidityAddress,
    facet:     out.facetAddress,
    roiFacet:  out.roiFacetAddress,
    lib:       out.libAddress,
    libView:   out.libViewAddress,
    viewFacet: viewFacetAddress,
  });

  console.log("\n" + sep("═"));
  console.log("  DONE — check https://amoy.polygonscan.com/address/" + out.liquidityAddress + "#code");
  console.log(sep("═") + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
