// Shared helper for the HordexViewFacet split.
//
// Hordex.sol no longer contains the read-only getters/batch views — they live in
// HordexViewFacet and are reached through Hordex's fallback(). So every deploy script
// must (1) deploy HordexViewFacet with the same router/factory/weth/token immutables,
// (2) call liquidity.setViewFacet(addr), and (3) write a CONTRACT_ABI that is the union of
// Hordex's ABI and the view facet's ABI so the frontend can call the moved functions.
//
// Usage in a deploy script (hre, deployer, liquidity contract, addresses, overrides):
//   const { deployAndWireViewFacet, mergedLiquidityAbi } = require("./_viewfacet");
//   const viewFacetAddress = await deployAndWireViewFacet(hre, {
//     deployer, liquidity, factory: UNI_FACTORY, weth: DEPLOYED_USDT, token: tokenAddress,
//     mathAddr: libAddress, viewLibAddr: libViewAddress, overrides: DEPLOY_OVERRIDES, mine,
//   });
//   ...then write `const CONTRACT_ABI = ${JSON.stringify(mergedLiquidityAbi(hre), null, 2)}`

async function deployAndWireViewFacet(hre, opts) {
  const {
    deployer, liquidity, factory, weth, token,
    mathAddr, viewLibAddr, overrides = {}, mine,
  } = opts;

  const ViewFacet = await hre.ethers.getContractFactory("HordexViewFacet", {
    signer: deployer,
    libraries: { HordexMath: mathAddr, HordexViewLib: viewLibAddr },
  });
  const viewFacet = await ViewFacet.deploy(factory, weth, token, overrides);
  await viewFacet.waitForDeployment();
  const viewFacetAddress = await viewFacet.getAddress();

  // Wire it into the live contract. Use the provided mine() retry wrapper when available.
  const txOverrides = overrides && overrides.gasLimit ? { gasLimit: overrides.gasLimit } : {};
  if (typeof mine === "function") {
    await mine(() => liquidity.setViewFacet(viewFacetAddress, txOverrides));
  } else {
    await (await liquidity.setViewFacet(viewFacetAddress, txOverrides)).wait();
  }

  return viewFacetAddress;
}

// Union of Hordex's ABI and HordexViewFacet's ABI, de-duplicated by function/event/error
// signature. The frontend builds its ethers.Contract from this so the moved getters and the
// new batch views (getDownline, *Batch) resolve through the fallback.
function mergedLiquidityAbi(hre) {
  const liq  = hre.artifacts.readArtifactSync("Hordex").abi;
  const view = hre.artifacts.readArtifactSync("HordexViewFacet").abi;
  // Keep Hordex's full ABI (incl. its constructor/fallback/receive); from the view facet
  // only pull functions/events/errors so we don't end up with a second constructor.
  const viewMergeable = view.filter(e =>
    e.type === "function" || e.type === "event" || e.type === "error");
  const seen = new Set();
  const key = e =>
    (e.type || "function") + ":" + (e.name || "") + "(" +
    (e.inputs || []).map(i => i.type).join(",") + ")";
  const out = [];
  for (const e of [...liq, ...viewMergeable]) {
    const k = key(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

module.exports = { deployAndWireViewFacet, mergedLiquidityAbi };
