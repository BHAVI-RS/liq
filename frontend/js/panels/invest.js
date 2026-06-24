// ── PACKAGE SELECTOR ──
const PACKAGES = {
  basic:         [25, 50, 100, 250, 500, 1000],
  elite:         [2500, 5000, 10000, 25000],
  institutional: [50000, 100000, 250000, 500000]
};
// RGB base colours for each category (border & tint shade)
const PKG_CAT_RGB = {
  basic:         [234, 179,   8],  // yellow
  elite:         [ 74, 222, 128],  // green
  institutional: [255,   0, 122],  // Uniswap pink (#FF007A)
};
const PKG_CATS = ['basic', 'elite', 'institutional'];
let _activePkgCat     = 'basic';
let _selectedPkgUSD   = null;
let _selectedInvestAddr = null;

// Mirror of HordexMath.calcMaxPoolBuy — returns the max ETH (as BigNumber wei) that can
// be swapped into the pool while keeping the resulting spot within TWAP_GUARD_BPS of TWAP.
// Uses spot price as TWAP approximation (valid for a recently-warmed stable pool).
function calcMaxPoolBuyWei(resToken, resETH, twapPrice, twapGuardBps = 500) {
  if (twapPrice.isZero()) return ethers.BigNumber.from(0);
  const alphaBps = 10000 - twapGuardBps;
  const numer = ethers.BigNumber.from(997).mul(resToken).mul(twapPrice).mul(10000);
  const sub   = ethers.utils.parseEther('1').mul(alphaBps).mul(resETH).mul(1000);
  if (numer.lte(sub)) return ethers.BigNumber.from(0);
  const denom = ethers.BigNumber.from(997).mul(ethers.utils.parseEther('1')).mul(alphaBps);
  return numer.sub(sub).div(denom);
}

function fetchEthPrice() {}   // USDT is always $1 — no price fetch needed
function _investStopPoll() {}
function _investStartPoll() {}

function switchPkgCat(cat) {
  _activePkgCat = cat;
  PKG_CATS.forEach(c => {
    const btn = document.getElementById('pkgBtn' + c.charAt(0).toUpperCase() + c.slice(1));
    if (!btn) return;
    btn.classList.toggle('pkg-cat-active', c === cat);
  });
  renderPkgGrid();
  renderTierInfo(cat);
}

// For basic, only packages >= $100 get category colour
const PKG_COLOUR_FROM = { basic: 100, elite: 0, institutional: 0 };
// Per-tier opacity range [min, max] — each tier starts stronger than the previous,
// so $2500 (elite min) reads heavier than $1000 (basic max) even across tab switches.
const PKG_OPACITY_RANGE = {
  basic:         [0.15, 0.50],
  elite:         [0.45, 0.78],
  institutional: [0.72, 1.00],
};

function renderPkgGrid() {
  const grid = document.getElementById('pkgGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const pkgs      = PACKAGES[_activePkgCat];
  const count     = pkgs.length;
  const [r, g, b] = PKG_CAT_RGB[_activePkgCat];

  grid.style.gridTemplateColumns = `repeat(${count}, 1fr)`;

  // Low-intensity tier background; neutral border (no coloured borders).
  const NEUTRAL = 'var(--border)';
  const HILITE  = 'rgba(255,255,255,0.3)';
  const bgClr   = `rgba(${r},${g},${b},0.10)`;
  const bgSel   = `rgba(${r},${g},${b},0.18)`;

  pkgs.forEach((usdt) => {
    const isSelected = usdt === _selectedPkgUSD;
    const usdtFmt    = usdt.toLocaleString('en-US');

    const card = document.createElement('div');
    card.className = 'pkg-card' + (isSelected ? ' selected' : '');
    card.style.borderColor = isSelected ? HILITE : NEUTRAL;
    card.style.background  = isSelected ? bgSel : bgClr;
    if (isSelected) {
      card.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.2), 0 0 10px rgba(255,255,255,0.12), 0 0 22px rgba(255,255,255,0.06)';
    }

    card.innerHTML = `
      <div class="pkg-card-usd">${usdtFmt} USDT</div>
    `;

    card.addEventListener('mouseenter', () => { card.style.borderColor = HILITE; });
    card.addEventListener('mouseleave', () => { card.style.borderColor = isSelected ? HILITE : NEUTRAL; });
    card.onclick = () => selectPackage(usdt);
    grid.appendChild(card);
  });
}

function selectPackage(usdt) {
  _selectedPkgUSD = usdt;
  document.getElementById('investAmount').value = parseFloat((usdt / USDT_PER_ETH).toFixed(5)).toString();
  renderPkgGrid();
  showInvestConfirmModal();
}

window._investPreviewData = null;

async function computeInvestPreview() {
  const tokenAddr = document.getElementById('investTokenSelect').value || _selectedInvestAddr;
  const ethAmtStr = document.getElementById('investAmount').value;
  const ethAmt    = parseFloat(ethAmtStr);
  const previewEl = document.getElementById('investTokenPreview');

  if (!tokenAddr || !ethAmt || ethAmt <= 0) {
    if (previewEl) previewEl.style.display = 'none';
    window._investPreviewData = null;
    return;
  }

  if (previewEl) previewEl.style.display = 'block';
  const poolEl     = document.getElementById('previewPoolTokens');
  const platEl     = document.getElementById('previewPlatformTokens');
  const totEl      = document.getElementById('previewTotalTokens');
  const stakingEl  = document.getElementById('previewStakingUSDT');
  const stakingPct = document.getElementById('previewStakingPct');
  if (poolEl)     poolEl.textContent     = '…';
  if (platEl)     platEl.textContent     = '…';
  if (totEl)      totEl.textContent      = '…';
  if (stakingEl)  stakingEl.textContent  = '…';
  if (stakingPct) stakingPct.textContent = '';

  try {
    const totalWei = parseUSDT(ethAmtStr);
    const A60max = totalWei.div(2).mul(60).div(100);  // max 30% for pool buy
    const A40eth = totalWei.div(2).mul(40).div(100);  // fixed 20% for commissions

    const routerAbi  = ['function getAmountsOut(uint256,address[]) view returns (uint256[])'];
    const factoryAbi = ['function getPair(address,address) view returns (address)'];
    const pairAbi    = ['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)'];
    const erc20Abi   = ['function decimals() view returns (uint8)'];

    const router  = new ethers.Contract(ROUTER_ADDRESS,  routerAbi,  provider);
    const factory = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, provider);

    const pairAddr = await factory.getPair(tokenAddr, WETH_ADDRESS);
    let poolTokensF = 0;
    let platformTokensF = 0;
    let dec = 18;

    if (pairAddr && pairAddr !== ethers.constants.AddressZero) {
      const pair  = new ethers.Contract(pairAddr, pairAbi, provider);
      const erc20 = new ethers.Contract(tokenAddr, erc20Abi, provider);
      const [[r0, r1], tok0, d] = await Promise.all([pair.getReserves(), pair.token0(), erc20.decimals().catch(() => 18)]);
      dec = Number(d);
      const isToken0  = tok0.toLowerCase() === tokenAddr.toLowerCase();
      const resToken  = isToken0 ? r0 : r1;
      const resETH    = isToken0 ? r1 : r0;
      if (!resETH.isZero() && !resToken.isZero()) {
        const twapPrice   = resETH.mul(ethers.utils.parseEther('1')).div(resToken);
        const maxFeasible = calcMaxPoolBuyWei(resToken, resETH, twapPrice);
        const A60actual   = A60max.lt(maxFeasible) ? A60max : maxFeasible;
        const excess      = A60max.sub(A60actual);
        if (A60actual.gt(0)) {
          const out = await router.getAmountsOut(A60actual, [WETH_ADDRESS, tokenAddr]);
          poolTokensF = parseFloat(ethers.utils.formatUnits(out[1], dec));
        }
        platformTokensF = parseFloat(ethers.utils.formatUnits(
          A40eth.add(excess).mul(resToken).div(resETH), dec
        ));
      }
    }

    const totalTokensF = poolTokensF + platformTokensF;
    const td  = typeof investTokenData !== 'undefined' ? investTokenData.get(tokenAddr.toLowerCase()) : null;
    const sym = td ? td.symbol : '—';
    const fmt = n => fmtNum(n);

    if (poolEl) poolEl.textContent = fmt(poolTokensF)  + ' ' + sym;
    if (platEl) platEl.textContent = fmt(platformTokensF) + ' ' + sym;
    if (totEl)  totEl.textContent  = fmt(totalTokensF) + ' ' + sym;

    // Fetch the 90-day base staking rate for this package (what user earns on initial lock)
    try {
      const [durDays, ratesPPM] = await contract.getStakingRatesForAmount(totalWei);
      const idx90 = Array.from(durDays).findIndex(d => Number(d) === 90);
      if (idx90 !== -1) {
        const ratePPM   = Number(ratesPPM[idx90]);
        const investUSDT = ethAmt * USDT_PER_ETH;
        const rewardUSDT = investUSDT * ratePPM / 1_000_000;
        const pct        = fmtNum(ratePPM / 10_000, 1);
        if (stakingEl)  stakingEl.textContent  = rewardUSDT > 0 ? '+$' + fmtNum(rewardUSDT) + ' USDT' : '—';
        if (stakingPct) stakingPct.textContent = rewardUSDT > 0 ? pct + '% return' : '';
      }
    } catch(_) {
      if (stakingEl)  stakingEl.textContent  = '—';
      if (stakingPct) stakingPct.textContent = '';
    }

    window._investPreviewData = { poolTokensF, platformTokensF, totalTokensF, sym };
  } catch(_) {
    if (poolEl)     poolEl.textContent     = '—';
    if (platEl)     platEl.textContent     = '—';
    if (totEl)      totEl.textContent      = '—';
    if (stakingEl)  stakingEl.textContent  = '—';
    if (stakingPct) stakingPct.textContent = '';
    window._investPreviewData = null;
  }
}

async function showInvestConfirmModal() {
  if (!requireConnected()) return;
  // Fall back to the selected-token state if the hidden <select> value didn't stick
  const tokenAddr = document.getElementById('investTokenSelect').value || _selectedInvestAddr;
  if (!tokenAddr) { toast('Select a token first', 'warn'); return; }
  const ethAmtStr = document.getElementById('investAmount').value;
  const ethAmt = parseFloat(ethAmtStr);
  if (!ethAmt || ethAmt <= 0) { toast('Select an investment package first', 'warn'); return; }

  const content    = document.getElementById('investPreviewContent');
  const confirmBtn = document.getElementById('investConfirmBtn');

  if (content) content.innerHTML = `<div style="text-align:center;padding:28px;color:var(--muted);font-family:var(--font-mono);font-size:12px;letter-spacing:.08em;">Computing details<span class="ld"><span></span><span></span><span></span></span></div>`;
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'LOADING…'; }
  document.getElementById('investConfirmModal').style.display = 'flex';

  const td      = typeof investTokenData !== 'undefined' ? investTokenData.get(tokenAddr.toLowerCase()) : null;
  const sym     = td ? td.symbol : '—';
  const usdt    = _selectedPkgUSD || (ethAmt * USDT_PER_ETH);
  const fmt     = n => fmtNum(n);
  const fmtU    = n => fmtNum(n);

  try {
    const totalWei     = parseUSDT(ethAmtStr);
    const A60max       = totalWei.div(2).mul(60).div(100);  // max 30% for pool buy
    const A40eth       = totalWei.div(2).mul(40).div(100);  // fixed 20% for commissions
    const liquidityETH = totalWei.div(2);

    const routerAbi  = ['function getAmountsOut(uint256,address[]) view returns (uint256[])'];
    const factoryAbi = ['function getPair(address,address) view returns (address)'];
    const pairAbi    = [
      'function getReserves() view returns (uint112,uint112,uint32)',
      'function token0() view returns (address)',
      'function totalSupply() view returns (uint256)',
    ];
    const erc20Abi = ['function decimals() view returns (uint8)'];

    const router  = new ethers.Contract(ROUTER_ADDRESS,  routerAbi,  provider);
    const factory = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, provider);

    const pairAddr = await factory.getPair(tokenAddr, WETH_ADDRESS);

    let poolTokensBN     = ethers.BigNumber.from(0);
    let platformTokensBN = ethers.BigNumber.from(0);
    let excessBN         = ethers.BigNumber.from(0);
    let A60actual        = ethers.BigNumber.from(0);
    let lpMintedF        = null;
    let dec = 18;

    if (pairAddr && pairAddr !== ethers.constants.AddressZero) {
      const pair  = new ethers.Contract(pairAddr, pairAbi, provider);
      const erc20 = new ethers.Contract(tokenAddr, erc20Abi, provider);
      const [[r0, r1], tok0, d, lpSupply] = await Promise.all([
        pair.getReserves(), pair.token0(), erc20.decimals().catch(() => 18), pair.totalSupply(),
      ]);
      dec = Number(d);
      const isToken0 = tok0.toLowerCase() === tokenAddr.toLowerCase();
      const resToken  = isToken0 ? r0 : r1;
      const resETH    = isToken0 ? r1 : r0;
      if (!resETH.isZero() && !resToken.isZero()) {
        const twapPrice   = resETH.mul(ethers.utils.parseEther('1')).div(resToken);
        const maxFeasible = calcMaxPoolBuyWei(resToken, resETH, twapPrice);
        A60actual         = A60max.lt(maxFeasible) ? A60max : maxFeasible;
        excessBN          = A60max.sub(A60actual);
        platformTokensBN  = A40eth.add(excessBN).mul(resToken).div(resETH);

        if (A60actual.gt(0)) {
          const out    = await router.getAmountsOut(A60actual, [WETH_ADDRESS, tokenAddr]);
          poolTokensBN = out[1];
        }

        if (!lpSupply.isZero()) {
          const totalTokensBN = poolTokensBN.add(platformTokensBN);
          // Post-swap reserves for accurate LP estimate
          const resETH_post   = resETH.add(A60actual);
          const resToken_post = resToken.sub(poolTokensBN);
          const lpFromTokens  = lpSupply.mul(totalTokensBN).div(resToken_post.gt(0) ? resToken_post : resToken);
          const lpFromETH     = lpSupply.mul(liquidityETH).div(resETH_post);
          const lpMintedBN    = lpFromTokens.lt(lpFromETH) ? lpFromTokens : lpFromETH;
          lpMintedF = parseFloat(ethers.utils.formatEther(lpMintedBN));
        }
      }
    }

    const poolTokensF     = parseFloat(ethers.utils.formatUnits(poolTokensBN, dec));
    const platformTokensF = parseFloat(ethers.utils.formatUnits(platformTokensBN, dec));
    const excessUSDT      = usdtToFloat(excessBN) * USDT_PER_ETH;
    const poolCapped      = excessBN.gt(0);
    const totalTokensF    = poolTokensF + platformTokensF;

    let stakingBox = '';
    try {
      const [durDays, ratesPPM] = await contract.getStakingRatesForAmount(totalWei);
      const idx90 = Array.from(durDays).findIndex(d => Number(d) === 90);
      if (idx90 !== -1) {
        const ratePPM    = Number(ratesPPM[idx90]);
        const rewardUSDT = usdt * ratePPM / 1_000_000;
        const pct        = fmtNum(ratePPM / 10_000, 1);
        stakingBox = `
          <div style="text-align:center;color:rgba(255,255,255,0.15);font-size:9px;line-height:1;margin:0;">▼</div>
          <div style="border:1px solid rgba(74,222,128,0.4);border-radius:6px;background:rgba(74,222,128,0.04);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px 10px;text-align:center;">
            <div style="font-size:8px;color:rgba(74,222,128,0.7);letter-spacing:1.4px;margin-bottom:7px;">STAKING REWARD · 90-DAY BASE RATE</div>
            <div style="font-family:var(--font-display);font-size:20px;letter-spacing:1px;color:#4ade80;line-height:1.1;">+${fmtU(rewardUSDT)} USDT</div>
            <div style="font-size:9px;color:var(--muted);margin-top:6px;font-family:var(--font-mono);">${pct}% return on investment</div>
          </div>`;
      }
    } catch(_) {}

    const arrow = `<div style="text-align:center;color:rgba(255,255,255,0.15);font-size:9px;line-height:1;margin:0;">▼</div>`;
    const cell  = (clr, label, value, sub) => `
      <div style="border:1px solid rgba(${clr},0.4);border-radius:6px;background:rgba(${clr},0.04);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px 10px;text-align:center;">
        <div style="font-size:8px;color:rgba(${clr},0.7);letter-spacing:1.4px;margin-bottom:7px;">${label}</div>
        <div style="font-family:var(--font-display);font-size:20px;letter-spacing:1px;line-height:1.1;">${value}</div>
        ${sub ? `<div style="font-size:9px;color:var(--muted);margin-top:6px;font-family:var(--font-mono);">${sub}</div>` : ''}
      </div>`;

    if (content) {
      content.style.maxHeight = '';
      content.style.overflowY = '';
      content.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:4px;">
          ${cell('201,168,76', 'INVESTED AMOUNT', `<span style="color:var(--gold);">${usdt.toLocaleString('en-US',{maximumFractionDigits:0})} USDT</span>`, null)}
          ${arrow}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            ${cell('96,165,250', 'TOKEN ACQUISITION', `<span style="color:var(--cream);">${fmt(totalTokensF)} ${sym}</span>`, null)}
            ${cell('96,165,250', 'USDT PAIRING', `<span style="color:var(--cream);">${fmtU(usdt / 2)} USDT</span>`, null)}
          </div>
          ${arrow}
          <div style="border:1px solid rgba(236,72,153,0.4);border-radius:6px;background:rgba(236,72,153,0.04);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px 10px;text-align:center;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:7px;">
              <span style="width:6px;height:6px;border-radius:50%;background:#ec4899;box-shadow:0 0 6px rgba(236,72,153,0.8);flex-shrink:0;display:inline-block;"></span>
              <span style="font-size:8px;color:rgba(236,72,153,0.8);letter-spacing:1.4px;">UNISWAP V2 POOL</span>
            </div>
            <div style="font-family:var(--font-display);font-size:20px;letter-spacing:1px;color:#f472b6;line-height:1.1;">${lpMintedF !== null ? fmt(lpMintedF) + ' LP' : '—'}</div>
            <div style="font-size:9px;color:var(--muted);margin-top:6px;font-family:var(--font-mono);">estimated LP tokens minted</div>
          </div>
          ${arrow}
          ${cell('45,212,191', 'LOCK-IN', `<span style="color:#2dd4bf;">90 days</span>`, null)}
          ${stakingBox}
        </div>
      `;
    }

    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'CONFIRM & INVEST'; }
  } catch(e) {
    if (content) content.innerHTML = `<div style="padding:16px 0;color:#f87171;font-family:var(--font-mono);font-size:12px;">Failed to load details. You may still proceed.</div>`;
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'CONFIRM & INVEST'; }
  }
}

function closeInvestConfirmModal() {
  document.getElementById('investConfirmModal').style.display = 'none';
  const btn = document.getElementById('investConfirmBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'CONFIRM & INVEST'; }
}

function confirmInvest() {
  closeInvestConfirmModal();
  invest();
}


async function invest() {
  if (!requireConnected()) return;

  const tokenAddr = document.getElementById('investTokenSelect').value || _selectedInvestAddr;
  if (!tokenAddr) { toast('Select a token first', 'warn'); return; }

  const ethAmtStr = document.getElementById('investAmount').value;
  const ethAmt    = parseFloat(ethAmtStr);
  if (!ethAmt || ethAmt <= 0) { toast('Select an investment package first', 'warn'); return; }

  // If the user holds any reserve, ask whether to use it before sending the tx.
  let reserveWei = ethers.BigNumber.from(0);
  try {
    const rs = await contract.getReserveStats(walletAddress);
    reserveWei = rs.total ?? rs[0];
  } catch (_) {}
  if (reserveWei && reserveWei.gt(0)) {
    _showReserveChoiceModal(tokenAddr, ethAmtStr, reserveWei);
    return;
  }
  _executeInvest(tokenAddr, ethAmtStr, false);
}

// "Use reserve balance?" prompt shown after CONFIRM & INVEST when the user has reserve.
function _showReserveChoiceModal(tokenAddr, ethAmtStr, reserveWei) {
  const existing = document.getElementById('investReserveChoice');
  if (existing) existing.remove();

  const pkg        = parseFloat(ethAmtStr);
  const reserve    = usdtToFloat(reserveWei) * USDT_PER_ETH;
  const fromRes    = Math.min(reserve, pkg);
  const fromWallet = Math.max(0, pkg - reserve);
  const breakdown  = fromWallet > 0
    ? `<span style="color:#60a5fa;">$${fromRes.toFixed(2)}</span> from reserve + <span style="color:var(--cream);">$${fromWallet.toFixed(2)}</span> from your wallet`
    : `the full <span style="color:#60a5fa;">$${pkg.toFixed(2)}</span> from reserve · wallet untouched`;

  const overlay = document.createElement('div');
  overlay.id = 'investReserveChoice';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:1100;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:22px;max-width:420px;width:100%;box-sizing:border-box;font-family:var(--font-mono);position:relative;">
      <button onclick="document.getElementById('investReserveChoice').remove()"
        style="position:absolute;top:12px;right:12px;width:26px;height:26px;border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:4px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;">✕</button>
      <div style="font-size:11px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">USE RESERVE BALANCE?</div>
      <div style="font-size:13px;color:var(--cream);margin-bottom:14px;line-height:1.6;">
        You have <strong style="color:#60a5fa;">$${reserve.toFixed(2)}</strong> in commission reserve.
        Use it for this <strong style="color:var(--gold);">$${pkg.toFixed(2)}</strong> package?
      </div>
      <div style="font-size:11px;color:var(--muted);padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);margin-bottom:16px;line-height:1.6;">
        If you use reserve: ${breakdown}.
      </div>
      <div style="display:flex;gap:8px;">
        <button onclick="document.getElementById('investReserveChoice').remove(); _executeInvest('${tokenAddr}','${ethAmtStr}',true)"
          style="flex:1;padding:11px;font-family:var(--font-mono);font-size:12px;letter-spacing:1px;border:1px solid rgba(96,165,250,0.5);border-radius:5px;background:rgba(96,165,250,0.12);color:#60a5fa;cursor:pointer;">USE RESERVE</button>
        <button onclick="document.getElementById('investReserveChoice').remove(); _executeInvest('${tokenAddr}','${ethAmtStr}',false)"
          style="flex:1;padding:11px;font-family:var(--font-mono);font-size:12px;letter-spacing:1px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--cream);cursor:pointer;">PAY FROM WALLET</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

// Sends the invest tx. useReserve=false → all wallet (invest); true → reserve first, wallet for the
// shortfall (investUseReserve). Only the wallet portion needs an approval.
async function _executeInvest(tokenAddr, ethAmtStr, useReserve) {
  if (!requireConnected()) return;
  _txBegin();
  try {
    const totalWei  = parseUSDT(ethAmtStr);
    const usdtAddr  = typeof USDT_ADDRESS !== 'undefined' ? USDT_ADDRESS : WETH_ADDRESS;
    const usdtAbi   = ['function approve(address spender, uint256 amount) external returns (bool)'];
    const usdtToken = new ethers.Contract(usdtAddr, usdtAbi, signer);
    const _inv      = contract.connect(signer);

    let method = 'invest';
    let walletPortion = totalWei;             // amount that needs an approval
    if (useReserve) {
      method = 'investUseReserve';
      let reserveWei = ethers.BigNumber.from(0);
      try { const rs = await contract.getReserveStats(walletAddress); reserveWei = rs.total ?? rs[0]; } catch (_) {}
      walletPortion = totalWei.gt(reserveWei) ? totalWei.sub(reserveWei) : ethers.BigNumber.from(0);
    }

    if (walletPortion.gt(0)) {
      toast('Step 1/2 — Approve USDT spending in your wallet…', 'info');
      await (await usdtToken.approve(CONTRACT_ADDRESS, walletPortion, _GAS)).wait();
      toast('Step 2/2 — Confirm investment in your wallet…', 'info');
    } else {
      toast('Confirm investment (from reserve) in your wallet…', 'info');
    }

    // Estimate gas with headroom BEFORE prompting the wallet so any revert (price stale, slippage,
    // low cap, insufficient reserve) surfaces up front, plus 30% for the variable ROI settlement loops.
    const _gasLimit = await gasLimitWithBuffer(_inv, method, [tokenAddr, totalWei], 30);
    const tx        = await _inv[method](tokenAddr, totalWei, { ..._GAS, gasLimit: _gasLimit });

    toast('Transaction sent — waiting for confirmation…', 'info');
    const receipt = await tx.wait();

    let lpReceived = null;
    try {
      const iface = new ethers.utils.Interface([
        'event Invested(address indexed user, address indexed token, uint256 ethAmount, uint256 lpTokens)'
      ]);
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed.name === 'Invested') {
            lpReceived = fmtNum(parseFloat(ethers.utils.formatEther(parsed.args.lpTokens)));
            break;
          }
        } catch(_) {}
      }
    } catch(_) {}

    _txDone();
    toast(
      lpReceived
        ? `Liquidity provided! LP tokens received: ${lpReceived} HDEX-LP (locked)`
        : 'Liquidity provided successfully!',
      'success'
    );

    document.getElementById('investAmount').value = '';
    _selectedPkgUSD = null;
    renderPkgGrid();

    invalidateTabs('dashboard', 'investments', 'rewards');
    loadDashboard();
    switchTabByName('investments');

  } catch(e) {
    _txDone();
    console.error('[invest] failed:', e);
    toast('Investment failed: ' + decodeContractError(e, contract && contract.interface), 'error');
  }
}

let _loadInvestTokensGen = 0;

async function loadInvestTokens() {
  if (!requireConnected()) return;
  const myGen = ++_loadInvestTokensGen;  // any older in-flight call will see myGen !== _loadInvestTokensGen and bail
  const list   = document.getElementById('investTokenList');
  const select = document.getElementById('investTokenSelect');
  const menu   = document.getElementById('investDropdownMenu');
  list.innerHTML = '<div class="empty-state">Loading available tokens<span class="ld"><span></span><span></span><span></span></span></div>';
  while (select.options.length > 1) select.remove(1);
  if (menu) menu.innerHTML = '';
  investTokenData.clear();
  _selectedInvestAddr = null;
  const provCard = document.getElementById('provideLiquidityCard');
  if (provCard) provCard.style.display = 'none';
  try {
    const addrs = await contract.getRegisteredTokens();
    if (myGen !== _loadInvestTokensGen) return;
    if (addrs.length === 0) {
      list.innerHTML = '<div class="empty-state">No tokens registered yet.</div>';
      return;
    }
    // Fetch all token data in parallel instead of sequential awaits
    const sortedAddrs = [...addrs].reverse();
    const allTokens   = await Promise.all(sortedAddrs.map(a => contract.getToken(a)));
    if (myGen !== _loadInvestTokensGen) return;

    const activeAddrs = sortedAddrs.filter((_, i) => !allTokens[i].removed);
    const activeTokens = activeAddrs.map(a => allTokens[sortedAddrs.indexOf(a)]);

    if (activeAddrs.length === 0) {
      list.innerHTML = '<div class="empty-state">No tokens available for investment.</div>';
      return;
    }
    let featuredAddr = '';
    try { featuredAddr = (await contract.featuredToken()).toLowerCase(); } catch(_) {}
    if (myGen !== _loadInvestTokensGen) return;

    // Always feature the Hordex platform token when no featured token is set on-chain
    // (or it's the zero address), provided it's among the active investable tokens.
    if ((!featuredAddr || featuredAddr === ethers.constants.AddressZero) &&
        typeof TOKEN_ADDRESS === 'string') {
      const _hx = TOKEN_ADDRESS.toLowerCase();
      if (activeAddrs.some(a => a.toLowerCase() === _hx)) featuredAddr = _hx;
    }

    const featuredIdx = activeAddrs.findIndex(a => a.toLowerCase() === featuredAddr);
    if (featuredIdx > 0) {
      activeAddrs.unshift(activeAddrs.splice(featuredIdx, 1)[0]);
      activeTokens.unshift(activeTokens.splice(featuredIdx, 1)[0]);
    }

    // Sort: inProgress tokens to the bottom (all data already in activeTokens)
    const inProgressLabels = new Map(activeAddrs.map((a, i) => [a.toLowerCase(), activeTokens[i].inProgressLabel || '']));
    const order = activeAddrs.map((a, i) => i).sort((a, b) => {
      return (inProgressLabels.get(activeAddrs[a].toLowerCase()) ? 1 : 0) - (inProgressLabels.get(activeAddrs[b].toLowerCase()) ? 1 : 0);
    });
    const sortedActive = order.map(i => activeAddrs[i]);
    const sortedTokens = order.map(i => activeTokens[i]);

    list.innerHTML = '';
    for (let i = 0; i < sortedActive.length; i++) {
      if (myGen !== _loadInvestTokensGen) return;
      const addr         = sortedActive[i];
      const t            = sortedTokens[i];
      const isFeatured   = featuredAddr !== '' ? addr.toLowerCase() === featuredAddr : i === 0;
      const inProgressLabel = inProgressLabels.get(addr.toLowerCase()) || '';
      const isInProgress    = inProgressLabel.length > 0;
      const meta         = getMeta(addr);

      if (!isInProgress) {
        investTokenData.set(addr.toLowerCase(), { symbol: t.symbol, name: t.name, logo: meta.logo || '', addr: t.tokenAddress });

        const opt = document.createElement('option');
        opt.value = t.tokenAddress;
        opt.textContent = `${t.symbol} — ${t.name}`;
        select.appendChild(opt);
      }

      const div = document.createElement('div');
      div.className = 'token-item';
      div.setAttribute('data-token-addr', addr);
      div.setAttribute('data-is-featured', isFeatured ? 'true' : 'false');
      if (isFeatured && !isInProgress) {
        div.style.border = '1.5px solid var(--success, #26d97f)';
        div.style.boxShadow = '0 0 0 2px rgba(38,217,127,0.12)';
      }
      if (isInProgress) {
        div.style.border = '1.5px solid rgba(234,179,8,0.35)';
        div.style.opacity = '0.85';
      }
      div.style.cursor = isInProgress ? 'default' : 'pointer';
      div.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex:1;">
          ${meta.logo ? `<img src="${meta.logo}" style="width:36px;height:36px;object-fit:contain;border-radius:8px;border:1px solid var(--border);background:var(--bg);padding:3px;flex-shrink:0;"/>` : `<div style="width:36px;height:36px;border-radius:8px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;">⬡</div>`}
          <div class="token-info">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="token-symbol">${t.symbol} — ${t.name}</span>
              ${isFeatured && !isInProgress ? `<span style="background:var(--success,#26d97f);color:#000;font-size:8.5px;font-weight:700;letter-spacing:.05em;padding:1px 5px;border-radius:3px;text-transform:uppercase;">Featured</span>` : ''}
              ${isInProgress ? `<span style="background:rgba(234,179,8,0.15);color:#eab308;border:1px solid rgba(234,179,8,0.45);font-size:8.5px;font-weight:600;letter-spacing:.05em;padding:1px 5px;border-radius:3px;">${inProgressLabel}</span>` : ''}
            </div>
            <div class="token-addr">${t.tokenAddress}</div>
          </div>
        </div>
        <div class="token-badge" style="border-color:var(--gold);color:var(--gold);" onclick="event.stopPropagation();openTokenDetail('${addr}')">SHOW DETAILS</div>
      `;
      if (!isInProgress) {
        div.onclick = () => {
          // Select the token directly (both desktop and mobile) and reveal packages.
          // Details remain available via the explicit "SHOW DETAILS" badge.
          _setSelectedInvestToken(addr);
          const card = document.getElementById('provideLiquidityCard');
          if (card) {
            card.style.display = '';
            setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
          }
        };
      }
      list.appendChild(div);
    }

  } catch(e) {
    toast('Error loading tokens: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
    list.innerHTML = '<div class="empty-state">Failed to load tokens.</div>';
  }
}

// ── TOKEN DETAIL MODAL ──
let _detailTokenAddr = null;

async function openTokenDetail(addr) {
  _detailTokenAddr = addr;
  const overlay = document.getElementById('tokenDetailOverlay');
  overlay.style.display = 'flex';

  document.getElementById('tdSupply').textContent = '...';
  document.getElementById('tdAvailable').textContent = '...';
  document.getElementById('tdLinks').innerHTML = '';
  document.getElementById('tdDescBlock').style.display = 'none';

  const t    = await contract.getToken(addr);
  const meta = getMeta(addr);

  const logoEl = document.getElementById('tdLogo');
  if (meta.logo) {
    logoEl.innerHTML = `<img src="${meta.logo}" style="width:100%;height:100%;object-fit:contain;"/>`;
  } else {
    logoEl.textContent = '⬡';
  }

  document.getElementById('tdSymbol').textContent = t.symbol;
  document.getElementById('tdName').textContent   = t.name;
  document.getElementById('tdAddr').textContent   = t.tokenAddress;

  // If the owner has set a tag (inProgressLabel), this token is not open for investment.
  // Replace the "SELECT THIS TOKEN" button with a plain "CLOSE" button.
  const selectBtn = document.getElementById('tdSelectBtn');
  if (selectBtn) {
    const hasOwnerTag = (t.inProgressLabel || '').length > 0;
    if (hasOwnerTag) {
      selectBtn.textContent = t.inProgressLabel.toUpperCase();
      selectBtn.style.background    = 'transparent';
      selectBtn.style.border        = '1px solid rgba(234,179,8,0.35)';
      selectBtn.style.color         = '#eab308';
      selectBtn.style.cursor        = 'default';
      selectBtn.style.pointerEvents = 'none';
    } else {
      selectBtn.textContent         = 'SELECT THIS TOKEN';
      selectBtn.style.background    = 'var(--gold)';
      selectBtn.style.border        = 'none';
      selectBtn.style.color         = 'var(--bg)';
      selectBtn.style.cursor        = 'pointer';
      selectBtn.style.pointerEvents = '';
      selectBtn.onclick             = selectTokenFromDetail;
    }
  }

  try {
    const tokenAbi = [
      "function totalSupply() view returns (uint256)",
      "function decimals() view returns (uint8)"
    ];
    const tokenContract = new ethers.Contract(addr, tokenAbi, provider);
    const [totalSupply, decimals] = await Promise.all([
      tokenContract.totalSupply(),
      tokenContract.decimals().catch(() => 18)
    ]);
    const dec = Number(decimals);
    const supplyFloat = parseFloat(ethers.utils.formatUnits(totalSupply, dec));
    const supplyFormatted = fmtNum(supplyFloat);
    document.getElementById('tdSupply').textContent = `${supplyFormatted} ${t.symbol}`;

    const price = await _getTokenPoolPrice(addr);
    if (price !== null) {
      const marketVol = supplyFloat * price;
      document.getElementById('tdAvailable').textContent = '$' + marketVol.toLocaleString(undefined, { maximumFractionDigits: 2 });
    } else {
      document.getElementById('tdAvailable').textContent = '—';
    }
  } catch(_) {
    document.getElementById('tdSupply').textContent    = '—';
    document.getElementById('tdAvailable').textContent = '—';
  }

  if (meta.description) {
    document.getElementById('tdDesc').textContent = meta.description;
    document.getElementById('tdDescBlock').style.display = 'block';
  }

  const linksEl = document.getElementById('tdLinks');
  if (meta.website) {
    const url = ensureHttps(meta.website);
    linksEl.innerHTML += `<a href="${url}" target="_blank" rel="noopener noreferrer" style="font-family:var(--font-mono);font-size:11px;letter-spacing:1px;padding:8px 16px;border:1px solid rgba(201,168,76,0.3);border-radius:4px;color:var(--gold);text-decoration:none;transition:all 0.2s;" onmouseover="this.style.background='rgba(201,168,76,0.08)'" onmouseout="this.style.background='none'">🌐 WEBSITE</a>`;
  }
  if (meta.whitepaper) {
    const url = ensureHttps(meta.whitepaper);
    linksEl.innerHTML += `<a href="${url}" target="_blank" rel="noopener noreferrer" style="font-family:var(--font-mono);font-size:11px;letter-spacing:1px;padding:8px 16px;border:1px solid rgba(201,168,76,0.3);border-radius:4px;color:var(--gold);text-decoration:none;transition:all 0.2s;" onmouseover="this.style.background='rgba(201,168,76,0.08)'" onmouseout="this.style.background='none'">📄 WHITEPAPER</a>`;
  }
}

function closeTokenDetail() {
  document.getElementById('tokenDetailOverlay').style.display = 'none';
  _detailTokenAddr = null;
}

function _setSelectedInvestToken(addr) {
  _selectedInvestAddr = addr;
  const select = document.getElementById('investTokenSelect');
  if (select) select.value = addr;

  const infoEl = document.getElementById('investSelectedTokenInfo');
  if (infoEl) {
    const d = investTokenData.get(addr.toLowerCase());
    if (d) {
      infoEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          ${d.logo ? `<img src="${d.logo}" style="width:28px;height:28px;object-fit:contain;border-radius:6px;border:1px solid var(--border);flex-shrink:0;">` : `<div style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;">⬡</div>`}
          <div>
            <div style="color:var(--cream);font-size:13px;font-family:var(--font-mono);">${d.symbol} — ${d.name}</div>
            <div class="invest-sel-addr" style="color:var(--gold);font-size:10px;font-family:var(--font-mono);word-break:break-all;">${d.addr}</div>
          </div>
        </div>`;
    }
  }

  _updateTokenListBorders(addr);
  if (select) select.dispatchEvent(new Event('change'));
}

function _updateTokenListBorders(selectedAddr) {
  const list = document.getElementById('investTokenList');
  if (!list) return;
  list.querySelectorAll('[data-token-addr]').forEach(item => {
    const addr = item.getAttribute('data-token-addr');
    const isFeatured = item.getAttribute('data-is-featured') === 'true';
    if (isFeatured) {
      item.style.border = '1.5px solid var(--success, #26d97f)';
      item.style.boxShadow = '0 0 0 2px rgba(38,217,127,0.12)';
    } else if (selectedAddr && addr.toLowerCase() === selectedAddr.toLowerCase()) {
      item.style.border = '1.5px solid var(--gold, #c9a84c)';
      item.style.boxShadow = '0 0 0 2px rgba(201,168,76,0.12)';
    } else {
      item.style.border = '';
      item.style.boxShadow = '';
    }
  });
}

function selectTokenFromDetail() {
  if (!_detailTokenAddr) return;
  _setSelectedInvestToken(_detailTokenAddr);
  closeTokenDetail();
  const card = document.getElementById('provideLiquidityCard');
  if (card) {
    card.style.display = '';
    setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }
  toast('Token selected. Choose an investment package.', 'info');
}

document.getElementById('tokenDetailOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('tokenDetailOverlay')) closeTokenDetail();
});

document.getElementById('investTokenSelect').addEventListener('change', () => {
  if (parseFloat(document.getElementById('investAmount').value) > 0) computeInvestPreview();
});

window.fetchEthPrice          = fetchEthPrice;
window._investStartPoll       = _investStartPoll;
window._investStopPoll        = _investStopPoll;
window.switchPkgCat           = switchPkgCat;
// Terms text removed — keep the box empty and hidden.
document.addEventListener('DOMContentLoaded', () => {
  const box = document.getElementById('investTermsBox');
  if (box) { box.innerHTML = ''; box.style.display = 'none'; }
});

window.renderPkgGrid          = renderPkgGrid;
window.selectPackage          = selectPackage;
window.computeInvestPreview   = computeInvestPreview;
window.showInvestConfirmModal = showInvestConfirmModal;
window.closeInvestConfirmModal = closeInvestConfirmModal;
window.confirmInvest          = confirmInvest;
window.invest                 = invest;
window.loadInvestTokens       = loadInvestTokens;
window.openTokenDetail        = openTokenDetail;
window.closeTokenDetail       = closeTokenDetail;
window.selectTokenFromDetail  = selectTokenFromDetail;
