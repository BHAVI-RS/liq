// ── PACKAGE SELECTOR ──
const PACKAGES = {
  basic:         [25, 50, 100, 250, 500, 1000],
  elite:         [2500, 5000, 10000, 25000],
  institutional: [50000, 100000, 250000, 500000]
};
const PKG_CATS = ['basic', 'elite', 'institutional'];
let _ethPriceUSD      = null;
let _activePkgCat     = 'basic';
let _selectedPkgUSD   = null;
let _selectedInvestAddr = null;
let _ethPricePollInterval = null;

async function fetchEthPrice() {
  try {
    const res  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json();
    _ethPriceUSD = data.ethereum.usd;
    const el = document.getElementById('ethPriceVal');
    if (el) el.textContent = '$' + _ethPriceUSD.toLocaleString();
    renderPkgGrid();
    // Recompute invest preview if one is shown, since price affects display
    if (parseFloat(document.getElementById('investAmount')?.value) > 0) computeInvestPreview();
  } catch(_) {
    const el = document.getElementById('ethPriceVal');
    if (el) el.textContent = 'unavailable';
  }
}

function _investStopPoll() {
  if (_ethPricePollInterval) { clearInterval(_ethPricePollInterval); _ethPricePollInterval = null; }
}

function _investStartPoll() {
  _investStopPoll();
  // Refresh ETH price every 30 s while invest tab is active
  _ethPricePollInterval = setInterval(() => {
    const panel = document.getElementById('panel-invest');
    if (!panel || !panel.classList.contains('active')) { _investStopPoll(); return; }
    fetchEthPrice();
  }, 30000);
}

function switchPkgCat(cat) {
  _activePkgCat = cat;
  PKG_CATS.forEach(c => {
    const btn = document.getElementById('pkgBtn' + c.charAt(0).toUpperCase() + c.slice(1));
    if (!btn) return;
    btn.classList.toggle('pkg-cat-active', c === cat);
  });
  renderPkgGrid();
}

function renderPkgGrid() {
  const grid = document.getElementById('pkgGrid');
  if (!grid) return;
  grid.innerHTML = '';
  PACKAGES[_activePkgCat].forEach(usdt => {
    const ethAmt = (usdt / USDT_PER_ETH).toFixed(usdt < 1000 ? 4 : 2);
    const usdtFmt = usdt.toLocaleString('en-US');
    const card = document.createElement('div');
    card.className = 'pkg-card' + (usdt === _selectedPkgUSD ? ' selected' : '');
    card.innerHTML = `
      <div class="pkg-card-usd">${usdtFmt} USDT</div>
      <div class="pkg-card-eth">${ethAmt} ETH</div>
    `;
    card.onclick = () => selectPackage(usdt);
    grid.appendChild(card);
  });
}

function selectPackage(usdt) {
  _selectedPkgUSD = usdt;
  _resetInvestBtn();
  const ethAmt = (usdt / USDT_PER_ETH).toFixed(6);
  document.getElementById('investAmount').value = ethAmt;
  document.getElementById('pkgSummaryUSD').textContent = usdt.toLocaleString('en-US') + ' USDT';
  document.getElementById('pkgSummaryETH').textContent = ethAmt;
  document.getElementById('pkgSummary').style.display = 'block';
  renderPkgGrid();
  computeInvestPreview();
}

window._investPreviewData = null;

async function computeInvestPreview() {
  const tokenAddr = document.getElementById('investTokenSelect').value;
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
    const totalWei = ethers.utils.parseEther(ethAmtStr);
    const A60 = totalWei.div(2).mul(60).div(100);
    const A40 = totalWei.div(2).mul(40).div(100);

    const routerAbi  = ['function getAmountsOut(uint256,address[]) view returns (uint256[])'];
    const factoryAbi = ['function getPair(address,address) view returns (address)'];
    const pairAbi    = ['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)'];
    const erc20Abi   = ['function decimals() view returns (uint8)'];

    const router  = new ethers.Contract(ROUTER_ADDRESS,  routerAbi,  provider);
    const factory = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, provider);

    const amountsOut   = await router.getAmountsOut(A60, [WETH_ADDRESS, tokenAddr]);
    const poolTokensBN = amountsOut[1];

    const pairAddr = await factory.getPair(tokenAddr, WETH_ADDRESS);
    let platformTokensF = 0;
    let dec = 18;

    if (pairAddr && pairAddr !== ethers.constants.AddressZero) {
      const pair  = new ethers.Contract(pairAddr, pairAbi, provider);
      const erc20 = new ethers.Contract(tokenAddr, erc20Abi, provider);
      const [[r0, r1], tok0, d] = await Promise.all([pair.getReserves(), pair.token0(), erc20.decimals().catch(() => 18)]);
      dec = Number(d);
      const isToken0 = tok0.toLowerCase() === tokenAddr.toLowerCase();
      const resToken = isToken0 ? r0 : r1;
      const resETH   = isToken0 ? r1 : r0;
      if (!resETH.isZero()) {
        platformTokensF = parseFloat(ethers.utils.formatUnits(A40.mul(resToken).div(resETH), dec));
      }
    }

    const poolTokensF  = parseFloat(ethers.utils.formatUnits(poolTokensBN, dec));
    const totalTokensF = poolTokensF + platformTokensF;
    const td  = typeof investTokenData !== 'undefined' ? investTokenData.get(tokenAddr.toLowerCase()) : null;
    const sym = td ? td.symbol : '—';
    const fmt = n => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

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
        const pct        = (ratePPM / 10_000).toFixed(1);
        if (stakingEl)  stakingEl.textContent  = rewardUSDT > 0 ? '+$' + rewardUSDT.toLocaleString(undefined, {maximumFractionDigits: 2}) + ' USDT' : '—';
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

function showInvestConfirmModal() {
  if (!requireConnected()) return;
  const tokenAddr = document.getElementById('investTokenSelect').value;
  if (!tokenAddr) { toast('Select a token first', 'warn'); return; }
  const ethAmtStr = document.getElementById('investAmount').value;
  if (!parseFloat(ethAmtStr) > 0) { toast('Select an investment package first', 'warn'); return; }

  const d    = window._investPreviewData;
  const td   = typeof investTokenData !== 'undefined' ? investTokenData.get(tokenAddr.toLowerCase()) : null;
  const sym  = td ? td.symbol : '—';
  const usdt = (parseFloat(ethAmtStr) * USDT_PER_ETH).toLocaleString('en-US');
  const fmt  = n => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

  const content = document.getElementById('investPreviewContent');
  if (content) {
    content.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;">
        <div style="font-size:9px;color:var(--muted);letter-spacing:1.5px;margin-bottom:4px;">PACKAGE</div>
        <div style="font-family:var(--font-mono);font-size:15px;color:var(--gold);">${usdt} USDT</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;">
          <div style="font-size:9px;color:var(--muted);letter-spacing:1.5px;margin-bottom:4px;">POOL BUY</div>
          <div style="font-family:var(--font-mono);font-size:13px;color:var(--cream);">${d ? fmt(d.poolTokensF) + ' ' + sym : '—'}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;">
          <div style="font-size:9px;color:var(--muted);letter-spacing:1.5px;margin-bottom:4px;">PLATFORM BUY</div>
          <div style="font-family:var(--font-mono);font-size:13px;color:var(--cream);">${d ? fmt(d.platformTokensF) + ' ' + sym : '—'}</div>
        </div>
      </div>
      <div style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.3);border-radius:6px;padding:12px;">
        <div style="font-size:9px;color:var(--muted);letter-spacing:1.5px;margin-bottom:4px;">TOTAL TOKENS ACQUIRED</div>
        <div style="font-family:var(--font-mono);font-size:18px;color:var(--gold);">${d ? fmt(d.totalTokensF) + ' ' + sym : 'Computing…'}</div>
      </div>`;
  }
  document.getElementById('investConfirmModal').style.display = 'flex';
}

function closeInvestConfirmModal() {
  document.getElementById('investConfirmModal').style.display = 'none';
}

function confirmInvest() {
  closeInvestConfirmModal();
  invest();
}

function _resetInvestBtn() {
  const btn = document.getElementById('investBtn');
  if (btn) { btn.textContent = 'PROVIDE LIQUIDITY'; btn.style.background = ''; btn.disabled = false; }
}

async function invest() {
  if (!requireConnected()) return;

  const tokenAddr = document.getElementById('investTokenSelect').value;
  if (!tokenAddr) { toast('Select a token first', 'warn'); return; }

  const ethAmtStr = document.getElementById('investAmount').value;
  const ethAmt    = parseFloat(ethAmtStr);
  if (!ethAmt || ethAmt <= 0) { toast('Select an investment package first', 'warn'); return; }

  const btn = document.getElementById('investBtn');
  btn.disabled    = true;
  btn.textContent = 'PROCESSING…';

  _txBegin();
  try {
    const totalWei = ethers.utils.parseEther(ethAmtStr);

    const A60U  = ((ethAmt / 2 * 0.60) * USDT_PER_ETH).toLocaleString('en-US', {maximumFractionDigits:2});
    const A40U  = ((ethAmt / 2 * 0.40) * USDT_PER_ETH).toLocaleString('en-US', {maximumFractionDigits:2});
    const BU    = ((ethAmt / 2)         * USDT_PER_ETH).toLocaleString('en-US', {maximumFractionDigits:2});
    toast(`Pool buy: ${A60U} USDT | Commissions: ${A40U} USDT | Liquidity: ${BU} USDT`, 'info');

    toast('Confirm transaction in MetaMask…', 'info');
    const tx = await contract.invest(tokenAddr, { value: totalWei });

    btn.textContent = 'WAITING FOR CONFIRMATION…';
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
            lpReceived = parseFloat(ethers.utils.formatEther(parsed.args.lpTokens)).toFixed(8);
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
    document.getElementById('investTokenPreview').style.display = 'none';
    document.getElementById('pkgSummary').style.display = 'none';
    _selectedPkgUSD = null;
    renderPkgGrid();
    _resetInvestBtn();

    invalidateTabs('dashboard', 'investments');
    loadDashboard();
    switchTabByName('investments');

  } catch(e) {
    _txDone();
    const msg = e.reason || e?.error?.message || e.message || 'Unknown error';
    toast('Investment failed: ' + msg, 'error');
    _resetInvestBtn();
  }
}

async function loadInvestTokens() {
  if (!requireConnected()) return;
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
    if (addrs.length === 0) {
      list.innerHTML = '<div class="empty-state">No tokens registered yet.</div>';
      return;
    }
    list.innerHTML = '';
    const sortedAddrs = [...addrs].reverse();
    const activeAddrs = [];
    for (const addr of sortedAddrs) {
      const t = await contract.getToken(addr);
      if (!t.removed) activeAddrs.push(addr);
    }
    if (activeAddrs.length === 0) {
      list.innerHTML = '<div class="empty-state">No tokens available for investment.</div>';
      return;
    }
    let featuredAddr = '';
    try { featuredAddr = (await contract.featuredToken()).toLowerCase(); } catch(_) {}
    const featuredIdx = activeAddrs.findIndex(a => a.toLowerCase() === featuredAddr);
    if (featuredIdx > 0) activeAddrs.unshift(activeAddrs.splice(featuredIdx, 1)[0]);

    // fetch inProgress flags once, then sink those tokens to the bottom
    const inProgressLabels = new Map();
    for (const addr of activeAddrs) {
      const t = await contract.getToken(addr);
      inProgressLabels.set(addr.toLowerCase(), t.inProgressLabel || '');
    }
    activeAddrs.sort((a, b) => {
      const aIP = inProgressLabels.get(a.toLowerCase()) ? 1 : 0;
      const bIP = inProgressLabels.get(b.toLowerCase()) ? 1 : 0;
      return aIP - bIP;
    });
    for (let i = 0; i < activeAddrs.length; i++) {
      const addr         = activeAddrs[i];
      const isFeatured   = featuredAddr !== '' ? addr.toLowerCase() === featuredAddr : i === 0;
      const t            = await contract.getToken(addr);
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
              ${isFeatured && !isInProgress ? `<span style="background:var(--success,#26d97f);color:#000;font-size:10px;font-weight:700;letter-spacing:.07em;padding:2px 8px;border-radius:4px;text-transform:uppercase;">Featured</span>` : ''}
              ${isInProgress ? `<span style="background:rgba(234,179,8,0.15);color:#eab308;border:1px solid rgba(234,179,8,0.45);font-size:10px;font-weight:700;letter-spacing:.07em;padding:2px 8px;border-radius:4px;">${inProgressLabel}</span>` : ''}
            </div>
            <div class="token-addr">${t.tokenAddress}</div>
          </div>
        </div>
        <div class="token-badge" style="border-color:var(--gold);color:var(--gold);" onclick="event.stopPropagation();openTokenDetail('${addr}')">SHOW DETAILS</div>
      `;
      if (!isInProgress) {
        div.onclick = () => {
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
    const supplyFormatted = supplyFloat.toLocaleString(undefined, { maximumFractionDigits: 4 });
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
  _resetInvestBtn();

  const infoEl = document.getElementById('investSelectedTokenInfo');
  if (infoEl) {
    const d = investTokenData.get(addr.toLowerCase());
    if (d) {
      infoEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          ${d.logo ? `<img src="${d.logo}" style="width:28px;height:28px;object-fit:contain;border-radius:6px;border:1px solid var(--border);flex-shrink:0;">` : `<div style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;">⬡</div>`}
          <div>
            <div style="color:var(--cream);font-size:13px;font-family:var(--font-mono);">${d.symbol} — ${d.name}</div>
            <div style="color:var(--gold);font-size:10px;font-family:var(--font-mono);word-break:break-all;">${d.addr}</div>
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
