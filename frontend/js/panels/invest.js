// ── PACKAGE SELECTOR ──
const PACKAGES = {
  basic:         [25, 50, 100, 250, 500, 1000],
  elite:         [2500, 5000, 10000, 25000],
  institutional: [50000, 100000, 250000, 500000]
};
const PKG_CATS = ['basic', 'elite', 'institutional'];
let _ethPriceUSD  = null;
let _activePkgCat = 'basic';
let _selectedPkgUSD = null;
let _userSelectedToken = false;

async function fetchEthPrice() {
  try {
    const res  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json();
    _ethPriceUSD = data.ethereum.usd;
    const el = document.getElementById('ethPriceVal');
    if (el) el.textContent = '$' + _ethPriceUSD.toLocaleString();
    renderPkgGrid();
  } catch(_) {
    const el = document.getElementById('ethPriceVal');
    if (el) el.textContent = 'unavailable';
  }
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
  updateInvestBreakdown(parseFloat(ethAmt), usdt);
}

function updateInvestBreakdown(totalEth, totalUsdt) {
  if (!totalEth || totalEth <= 0) {
    document.getElementById('investBreakdown').style.display = 'none';
    return;
  }
  const usdt = totalUsdt || totalEth * USDT_PER_ETH;
  const halfA = totalEth / 2;   const halfAU = usdt / 2;
  const A60   = halfA * 0.60;   const A60U   = halfAU * 0.60;
  const A40   = halfA - A60;    const A40U   = halfAU - A60U;
  const B     = totalEth - halfA; const BU   = usdt - halfAU;

  function fmt(eth, u) {
    return `${u.toLocaleString('en-US', {maximumFractionDigits:2})} USDT <span style="color:var(--muted);font-size:10px;">(${eth.toFixed(6)} ETH)</span>`;
  }
  document.getElementById('brkA').innerHTML   = fmt(halfA, halfAU);
  document.getElementById('brkA60').innerHTML = fmt(A60,   A60U);
  document.getElementById('brkA40').innerHTML = fmt(A40,   A40U);
  document.getElementById('brkB').innerHTML   = fmt(B,     BU);
  document.getElementById('investBreakdown').style.display = 'block';
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
    document.getElementById('investBreakdown').style.display = 'none';
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
  try {
    const addrs = await contract.getRegisteredTokens();
    if (addrs.length === 0) {
      list.innerHTML = '<div class="empty-state">No tokens registered yet.</div>';
      return;
    }
    list.innerHTML = '';
    const sortedAddrs = [...addrs].reverse();
    for (let i = 0; i < sortedAddrs.length; i++) {
      const addr       = sortedAddrs[i];
      const isFeatured = i === 0;
      const t    = await contract.getToken(addr);
      const meta = getMeta(addr);

      investTokenData.set(addr.toLowerCase(), { symbol: t.symbol, name: t.name, logo: meta.logo || '', addr: t.tokenAddress });

      const opt = document.createElement('option');
      opt.value = t.tokenAddress;
      opt.textContent = `${t.symbol} — ${t.name}`;
      select.appendChild(opt);

      if (menu) {
        const item = document.createElement('div');
        item.style.cssText = `display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;border-bottom:1px solid var(--border);transition:background 0.15s;${isFeatured ? 'border-left:3px solid var(--success,#26d97f);' : ''}`;
        item.onmouseenter = () => item.style.background = 'var(--bg)';
        item.onmouseleave = () => item.style.background = '';
        item.innerHTML = `
          ${meta.logo ? `<img src="${meta.logo}" style="width:38px;height:38px;object-fit:contain;border-radius:8px;border:1px solid var(--border);background:var(--bg);padding:3px;flex-shrink:0;">` : `<div style="width:38px;height:38px;border-radius:8px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">⬡</div>`}
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px;">
              <span style="color:var(--cream);font-family:var(--font-mono);font-size:13px;font-weight:400;">${t.symbol} — ${t.name}</span>
              ${isFeatured ? `<span style="background:var(--success,#26d97f);color:#000;font-size:10px;font-weight:700;letter-spacing:.07em;padding:2px 8px;border-radius:4px;text-transform:uppercase;white-space:nowrap;">Featured</span>` : ''}
            </div>
            <div style="color:var(--gold);font-size:10px;font-family:var(--font-mono);word-break:break-all;">${t.tokenAddress}</div>
          </div>
        `;
        item.onclick = () => {
          _userSelectedToken = true;
          select.value = t.tokenAddress;
          syncInvestDropdownTrigger(t.tokenAddress);
          document.getElementById('investDropdownMenu').style.display = 'none';
          document.getElementById('investDropdownArrow').textContent = '▾';
          select.dispatchEvent(new Event('change'));
        };
        menu.appendChild(item);
      }

      const div = document.createElement('div');
      div.className = 'token-item';
      div.style.cursor = 'pointer';
      if (isFeatured) {
        div.style.border = '1.5px solid var(--success, #26d97f)';
        div.style.boxShadow = '0 0 0 2px rgba(38,217,127,0.12)';
      }
      div.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex:1;">
          ${meta.logo ? `<img src="${meta.logo}" style="width:36px;height:36px;object-fit:contain;border-radius:8px;border:1px solid var(--border);background:var(--bg);padding:3px;flex-shrink:0;"/>` : `<div style="width:36px;height:36px;border-radius:8px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;">⬡</div>`}
          <div class="token-info">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="token-symbol" style="cursor:pointer;text-decoration:underline;text-underline-offset:3px;" onclick="event.stopPropagation();openTokenDetail('${addr}')">${t.symbol} — ${t.name}</span>
              ${isFeatured ? `<span style="background:var(--success,#26d97f);color:#000;font-size:10px;font-weight:700;letter-spacing:.07em;padding:2px 8px;border-radius:4px;text-transform:uppercase;">Featured</span>` : ''}
            </div>
            <div class="token-addr">${t.tokenAddress}</div>
          </div>
        </div>
        <div class="token-badge">SELECT</div>
      `;
      div.onclick = () => {
        _userSelectedToken = true;
        select.value = t.tokenAddress;
        syncInvestDropdownTrigger(t.tokenAddress);
        select.dispatchEvent(new Event('change'));
        document.getElementById('investDropdownWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      list.appendChild(div);
    }

    if (!_userSelectedToken && sortedAddrs.length > 0) {
      const featuredAddr = sortedAddrs[0];
      select.value = featuredAddr;
      syncInvestDropdownTrigger(featuredAddr);
      select.dispatchEvent(new Event('change'));
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
    const supplyFormatted = parseFloat(ethers.utils.formatUnits(totalSupply, dec)).toLocaleString(undefined, { maximumFractionDigits: 4 });
    document.getElementById('tdSupply').textContent = `${supplyFormatted} ${t.symbol}`;

    const rawBal = await contract.getContractTokenBalance(addr);
    const balFormatted = parseFloat(ethers.utils.formatUnits(rawBal, dec));
    document.getElementById('tdAvailable').textContent = balFormatted >= 0.0001
      ? `${balFormatted.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${t.symbol}`
      : `${Number(rawBal.toString()).toLocaleString()} ${t.symbol}`;
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

function selectTokenFromDetail() {
  if (!_detailTokenAddr) return;
  _userSelectedToken = true;
  const select = document.getElementById('investTokenSelect');
  select.value = _detailTokenAddr;
  syncInvestDropdownTrigger(_detailTokenAddr);
  select.dispatchEvent(new Event('change'));
  closeTokenDetail();
  document.getElementById('investDropdownWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('Token selected. Enter ETH amount to invest.', 'info');
}

document.getElementById('tokenDetailOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('tokenDetailOverlay')) closeTokenDetail();
});

window.fetchEthPrice        = fetchEthPrice;
window.switchPkgCat         = switchPkgCat;
window.renderPkgGrid        = renderPkgGrid;
window.selectPackage        = selectPackage;
window.updateInvestBreakdown = updateInvestBreakdown;
window.invest               = invest;
window.loadInvestTokens     = loadInvestTokens;
window.openTokenDetail      = openTokenDetail;
window.closeTokenDetail     = closeTokenDetail;
window.selectTokenFromDetail = selectTokenFromDetail;
