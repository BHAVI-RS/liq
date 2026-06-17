// Shared source-verification helper for Amoy / Polygon PolygonScan (Etherscan V2 API).
//
// Used by:
//   • inithdx.js, simulateinit.js   → auto-verify right after deploy
//   • verify-amoy.js                → standalone re-verify from deploy-output.json
//
// Requires ETHERSCAN_API_KEY in .env (one V2 key from etherscan.io/myapikey covers
// Amoy 80002 and Polygon 137). If the key is missing, verifyAllContracts() logs a
// notice and returns WITHOUT throwing, so a deploy is never blocked by verification.
//
// IMPORTANT: the working-tree Solidity source must still match the deployed bytecode.
// These scripts verify immediately after deploying from that same source, so they match.

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Verify one contract, tolerating "already verified" and short explorer-indexer lag.
async function verifyOne(hre, { name, address, constructorArguments = [] }) {
  if (!address) { console.log(`  ⚠️  ${name}: no address — skipped`); return; }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await hre.run("verify:verify", { address, constructorArguments });
      console.log(`  ✅ ${name.padEnd(18)} ${address}  verified`);
      return;
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).toLowerCase();
      if (msg.includes("already verified")) {
        console.log(`  ✔️  ${name.padEnd(18)} ${address}  already verified`);
        return;
      }
      // Explorer hasn't indexed the freshly-deployed bytecode yet → wait and retry.
      if ((msg.includes("does not have bytecode") || msg.includes("not yet indexed") ||
           msg.includes("unable to locate") || msg.includes("hasn't been deployed")) && attempt < 5) {
        console.log(`  …  ${name}: explorer not ready (try ${attempt}/5), waiting 15s`);
        await sleep(15000);
        continue;
      }
      console.error(`  ❌ ${name}: ${e.message ? e.message.split("\n")[0] : e}`);
      return;
    }
  }
}

// Verify the full Hordex contract set.
// addrs: { router, factory, usdt, token, liquidity, facet, roiFacet, lib, libView, viewFacet }
// Never throws — verification problems are logged but must not abort a deploy.
async function verifyAllContracts(hre, addrs) {
  if (!process.env.ETHERSCAN_API_KEY) {
    console.log("  ⚠️  ETHERSCAN_API_KEY not set in .env — skipping source verification.");
    console.log("      Add the key, then run:");
    console.log(`      npx hardhat run scripts/amoytestnet/verify-amoy.js --network ${hre.network.name}`);
    return;
  }

  const { router, factory, usdt, token, liquidity, facet, roiFacet, lib, libView, viewFacet } = addrs;

  // Libraries first, then facets, then the main contract (gives the newest contracts
  // the most time to be indexed; also makes the explorer's linked-library view tidy).
  const targets = [
    { name: "HordexMath",      address: lib,       constructorArguments: [] },
    { name: "HordexViewLib",   address: libView,   constructorArguments: [] },
    { name: "HordexROIFacet",  address: roiFacet,  constructorArguments: [] },
    { name: "HordexFacet",     address: facet,
      constructorArguments: [router, factory, usdt, token] },
    { name: "HordexViewFacet", address: viewFacet,
      constructorArguments: [factory, usdt, token] },
    { name: "Hordex",          address: liquidity,
      constructorArguments: [router, factory, usdt, token, facet, roiFacet] },
  ];

  for (const t of targets) {
    try { await verifyOne(hre, t); }
    catch (e) { console.error(`  ❌ ${t.name}: ${e.message || e}`); }
  }
}

module.exports = { verifyAllContracts, verifyOne };
