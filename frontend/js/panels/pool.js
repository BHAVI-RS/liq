const DEX_ROUTER  = ROUTER_ADDRESS;
const DEX_FACTORY = FACTORY_ADDRESS;
const DEX_WETH    = WETH_ADDRESS;

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory)",
  "function getAmountsIn(uint256 amountOut, address[] memory path) view returns (uint256[] memory)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)",
  "function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256 amountToken, uint256 amountETH)"
];
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address)"
];
const PAIR_ABI = [
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function totalSupply() view returns (uint256)"
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

window._poolSelectedToken = null;
window._poolSelectedPair  = null;
window._poolReserveETH    = 0n;
window._poolReserveToken  = 0n;
window._poolTokenDecimals = 18;
window._poolTokenSymbol   = '';
window._poolIsToken0      = false;
window._poolPollInterval  = null;
window._poolLastPrice     = 0;   // price from previous poll cycle
window._poolCurPrice      = 0;   // current price
window._poolListPrices    = {};  // addr -> { price, prevPrice } for token-list color
window._poolListInterval  = null;
window._poolChartLastBlock = 0;  // highest block already included in chart data
window._poolUserTokenBal  = 0;   // user's token balance for hybrid buy logic
window._poolMode          = 'buy'; // current buy/sell tab — controls trade history order
window._poolTradeBuys     = [];  // last-fetched buy trades (most-recent first)
window._poolTradeSells    = [];  // last-fetched sell trades (most-recent first)

let _poolRefreshCount = 0;

function _stopListPolling() {
  if (window._poolListInterval) { clearInterval(window._poolListInterval); window._poolListInterval = null; }
}

async function _refreshListPrices() {
  const panel = document.getElementById('panel-pool');
  if (!panel || !panel.classList.contains('active')) { _stopListPolling(); return; }
  const addrs = Object.keys(window._poolListPrices);
  await Promise.all(addrs.map(async addr => {
    const price = await _getTokenPoolPrice(addr);
    if (price === null) return;
    const prev = window._poolListPrices[addr]?.price;
    window._poolListPrices[addr] = { price, prevPrice: prev };
    const el = document.getElementById('poolListPrice-' + addr);
    if (!el) return;
    const color = (prev == null) ? 'var(--cream)' : price > prev ? '#4ade80' : price < prev ? '#f87171' : 'var(--cream)';
    el.style.color = color;
    el.textContent = '$' + price.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }));
}

function _stopPoolPolling() {
  if (window._poolPollInterval) { clearInterval(window._poolPollInterval); window._poolPollInterval = null; }
}

function _setStatText(id, value) {
  const el = document.getElementById(id);
  if (el && el.textContent !== value) el.textContent = value;
}

async function _refreshPoolData() {
  const panel = document.getElementById('panel-pool');
  if (!panel || !panel.classList.contains('active')) { _stopPoolPolling(); return; }
  const tokenAddr = window._poolSelectedToken;
  const pairAddr  = window._poolSelectedPair;
  if (!tokenAddr || !pairAddr || pairAddr === ethers.constants.AddressZero) return;
  try {
    const pair = getPairContract(pairAddr);
    const [[r0, r1], supply] = await Promise.all([pair.getReserves(), pair.totalSupply()]);
    const isToken0 = window._poolIsToken0;
    const dec      = window._poolTokenDecimals;
    const sym      = window._poolTokenSymbol;
    const resToken = isToken0 ? r0 : r1;
    const resETH   = isToken0 ? r1 : r0;
    window._poolReserveToken = resToken;
    window._poolReserveETH   = resETH;
    const resTokenF = parseFloat(ethers.utils.formatUnits(resToken, dec));
    const resETHF   = parseFloat(ethers.utils.formatEther(resETH));
    const supplyF   = parseFloat(ethers.utils.formatEther(supply));
    const priceUSDT = ethToUSDT(resETHF / resTokenF);

    // Track price direction for header badge
    window._poolLastPrice = window._poolCurPrice;
    window._poolCurPrice  = priceUSDT;
    _updateHeaderPrice(priceUSDT);

    _setStatText('poolStat-price',    priceUSDT.toLocaleString(undefined,{maximumFractionDigits:6}) + ' USDT');
    _setStatText('poolStat-tokenres', resTokenF.toLocaleString(undefined,{maximumFractionDigits:4}) + ' ' + sym);
    _setStatText('poolStat-usdtres',  (resETHF * USDT_PER_ETH).toLocaleString(undefined,{maximumFractionDigits:2}) + ' USDT');
    _setStatText('poolStat-lpsupply', supplyF.toFixed(6) + ' HDEX-LP');
    _updatePoolRateDisplay(priceUSDT, sym);
    updateBalances(tokenAddr, dec);
    loadTradeHistory(pairAddr, isToken0, dec, sym, true);
    _updateChartData(pairAddr, isToken0, dec);
  } catch(_) {}
}

async function _updateChartData(pairAddr, isToken0, dec) {
  const fromBlock = window._poolChartLastBlock + 1;
  try {
    const pair     = getPairContract(pairAddr);
    const newSwaps = await pair.queryFilter('Swap', fromBlock, 'latest').catch(() => []);
    if (!newSwaps.length) return;

    // Fetch timestamps only for unique new blocks
    const uniqueBlocks = [...new Set(newSwaps.map(e => e.blockNumber))];
    const blockMap = {};
    await Promise.all(uniqueBlocks.map(async bn => {
      try { const blk = await provider.getBlock(bn); blockMap[bn] = blk.timestamp * 1000; }
      catch(_) { blockMap[bn] = Date.now(); }
    }));

    const newPoints = newSwaps.map(ev => {
      const { amount0In, amount0Out, amount1In, amount1Out } = ev.args;
      let isBuy, tokenAmt, ethAmt;
      if (isToken0) {
        if (!amount1In.isZero()) {
          isBuy = true; tokenAmt = parseFloat(ethers.utils.formatUnits(amount0Out, dec)); ethAmt = parseFloat(ethers.utils.formatEther(amount1In));
        } else {
          isBuy = false; tokenAmt = parseFloat(ethers.utils.formatUnits(amount0In, dec)); ethAmt = parseFloat(ethers.utils.formatEther(amount1Out));
        }
      } else {
        if (!amount0In.isZero()) {
          isBuy = true; tokenAmt = parseFloat(ethers.utils.formatUnits(amount1Out, dec)); ethAmt = parseFloat(ethers.utils.formatEther(amount0In));
        } else {
          isBuy = false; tokenAmt = parseFloat(ethers.utils.formatUnits(amount1In, dec)); ethAmt = parseFloat(ethers.utils.formatEther(amount0Out));
        }
      }
      if (!tokenAmt || tokenAmt <= 0 || !ethAmt) return null;
      const usdtVol = ethToUSDT(ethAmt);
      return { time: blockMap[ev.blockNumber], price: usdtVol / tokenAmt, isBuy, tokenVol: tokenAmt, usdtVol };
    }).filter(Boolean);

    if (!newPoints.length) return;

    // Update last block and append to chart data
    window._poolChartLastBlock = Math.max(...newSwaps.map(e => e.blockNumber));
    window._poolChartData = [...window._poolChartData, ...newPoints]
      .sort((a, b) => a.time - b.time);

    // Re-render with current timeframe
    renderPriceChart(window._poolChartTimeframe);
  } catch(_) {}
}

function _updateHeaderPrice(priceUSDT) {
  const el  = document.getElementById('poolHeaderPrice');
  const chEl = document.getElementById('poolHeaderChange');
  if (!el) return;
  const prev = window._poolLastPrice;
  const up   = prev <= 0 || priceUSDT >= prev;
  const color = prev <= 0 ? 'var(--muted)' : up ? '#4ade80' : '#f87171';
  el.style.color = color;
  el.textContent = '$' + priceUSDT.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (chEl && prev > 0) {
    const pct = ((priceUSDT - prev) / prev) * 100;
    chEl.style.color = up ? '#4ade80' : '#f87171';
    chEl.textContent = (up ? '▲ +' : '▼ ') + pct.toFixed(4) + '%';
  }
}

function _startPoolPolling() {
  _stopPoolPolling();
  _poolRefreshCount = 0;
  window._poolPollInterval = setInterval(_refreshPoolData, 5000);
}

function getRouter()           { return new ethers.Contract(DEX_ROUTER,  ROUTER_ABI,  signer);   }
function getFactory()          { return new ethers.Contract(DEX_FACTORY, FACTORY_ABI, provider); }
function getPairContract(addr) { return new ethers.Contract(addr, PAIR_ABI, provider);            }

async function _getTokenPoolPrice(tokenAddr) {
  try {
    const factory  = getFactory();
    const pairAddr = await factory.getPair(tokenAddr, DEX_WETH);
    if (!pairAddr || pairAddr === ethers.constants.AddressZero) return null;
    const pair     = getPairContract(pairAddr);
    const [r0, r1] = await pair.getReserves();
    const token0   = await pair.token0();
    const isToken0 = token0.toLowerCase() === tokenAddr.toLowerCase();
    const resToken = isToken0 ? r0 : r1;
    const resETH   = isToken0 ? r1 : r0;
    const erc20    = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const dec      = Number(await erc20.decimals().catch(() => 18));
    const resTokenF = parseFloat(ethers.utils.formatUnits(resToken, dec));
    const resETHF   = parseFloat(ethers.utils.formatEther(resETH));
    if (resTokenF <= 0) return null;
    return ethToUSDT(resETHF / resTokenF);
  } catch(_) { return null; }
}

async function loadPoolPanel() {
  if (!requireConnected()) return;
  _stopPoolPolling();
  _stopListPolling();
  const list = document.getElementById('poolTokenList');
  list.innerHTML = '<div class="empty-state">Loading pools<span class="ld"><span></span><span></span><span></span></span></div>';
  try {
    const addrs = await contract.getRegisteredTokens();
    if (!addrs.length) { list.innerHTML = '<div class="empty-state">No registered tokens yet.</div>'; return; }

    const reversed = [...addrs].reverse();
    const [tokens, prices] = await Promise.all([
      Promise.all(reversed.map(a => contract.getToken(a))),
      Promise.all(reversed.map(a => _getTokenPoolPrice(a)))
    ]);

    list.innerHTML = '';
    for (let i = 0; i < reversed.length; i++) {
      const addr  = reversed[i];
      const t     = tokens[i];
      const price = prices[i];
      const meta  = getMeta(addr);

      // Determine price color vs cached previous
      const cached = window._poolListPrices[addr];
      const prev   = cached?.price ?? null;
      const priceColor = (prev === null || price === null)
        ? 'var(--cream)'
        : price > prev ? '#4ade80' : price < prev ? '#f87171' : 'var(--cream)';

      // Update cache
      window._poolListPrices[addr] = { price, prevPrice: prev };

      const div = document.createElement('div');
      div.className = 'token-item';
      div.style.cursor = 'pointer';
      div.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
          ${meta.logo
            ? `<img src="${meta.logo}" style="width:36px;height:36px;object-fit:contain;border-radius:8px;border:1px solid var(--border);background:var(--bg);padding:3px;flex-shrink:0;">`
            : `<div style="width:36px;height:36px;border-radius:8px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;">⬡</div>`}
          <div class="token-info" style="min-width:0;">
            <div class="token-symbol">${t.symbol} / USDT</div>
            <div class="token-addr" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${t.tokenAddress}">${t.tokenAddress.slice(0,10)}…${t.tokenAddress.slice(-6)}</div>
          </div>
        </div>
        ${price !== null
          ? `<div id="poolListPrice-${addr}" style="font-size:15px;color:${priceColor};font-family:var(--font-mono);font-weight:700;flex-shrink:0;letter-spacing:.03em;transition:color .4s;">$${price.toLocaleString(undefined,{maximumFractionDigits:6})}</div>`
          : `<div id="poolListPrice-${addr}" style="font-size:14px;color:var(--muted);font-family:var(--font-mono);flex-shrink:0;">—</div>`}`;
      div.onclick = () => loadPoolInfo(addr);
      list.appendChild(div);
    }

    // Live-update prices in the list every 5 s
    window._poolListInterval = setInterval(_refreshListPrices, 5000);
  } catch(e) {
    list.innerHTML = '<div class="empty-state">Failed to load pools.</div>';
    toast('Pool load error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function loadPoolInfo(tokenAddr) {
  if (!requireConnected()) return;
  _stopPoolPolling();
  window._poolSelectedToken  = tokenAddr;
  window._poolLastPrice      = 0;
  window._poolCurPrice       = 0;
  window._poolChartLastBlock = 0;
  window._poolChartData      = [];

  const card = document.getElementById('poolDetailCard');
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const statsEl = document.getElementById('poolStats');
  statsEl.innerHTML = '';
  statsEl.style.display = 'none';
  const toggleBtn = document.getElementById('poolStatsToggleBtn');
  if (toggleBtn) toggleBtn.textContent = 'SHOW MORE ▾';

  const histEl = document.getElementById('poolTradeHistory');
  if (histEl) histEl.innerHTML = '<div style="color:var(--muted);font-size:11px;font-family:var(--font-mono);padding:8px;">Loading…</div>';

  // Reset header price
  const hpEl = document.getElementById('poolHeaderPrice');
  const hcEl = document.getElementById('poolHeaderChange');
  if (hpEl) { hpEl.textContent = '—'; hpEl.style.color = 'var(--muted)'; }
  if (hcEl) { hcEl.textContent = '—'; hcEl.style.color = 'var(--muted)'; }

  try {
    const t    = await contract.getToken(tokenAddr);
    const meta = getMeta(tokenAddr);

    const iconEl = document.getElementById('poolTokenIcon');
    if (meta.logo) iconEl.innerHTML = `<img src="${meta.logo}" style="width:44px;height:44px;object-fit:contain;border-radius:10px;">`;
    else iconEl.innerHTML = '⬡';
    document.getElementById('poolTokenLabel').textContent = `${t.symbol} / USDT`;
    const addrEl = document.getElementById('poolTokenAddr');
    addrEl.textContent  = tokenAddr.slice(0,10) + '…' + tokenAddr.slice(-8);
    addrEl.dataset.full = tokenAddr;
    addrEl.title        = tokenAddr + ' (click to copy)';
    window._poolTokenSymbol = t.symbol;
    const symEl = document.getElementById('poolBuyOutSym');
    if (symEl) symEl.textContent = t.symbol;

    const factory  = getFactory();
    const pairAddr = await factory.getPair(tokenAddr, DEX_WETH);
    window._poolSelectedPair = pairAddr;

    if (pairAddr === ethers.constants.AddressZero) {
      document.getElementById('poolStats').innerHTML = '<div style="color:#ff5050;font-size:12px;font-family:var(--font-mono);">No liquidity pool exists for this token yet.</div>';
      return;
    }

    const pair     = getPairContract(pairAddr);
    const [r0, r1] = await pair.getReserves();
    const token0   = await pair.token0();
    const supply   = await pair.totalSupply();

    const isToken0 = token0.toLowerCase() === tokenAddr.toLowerCase();
    window._poolIsToken0 = isToken0;
    const resToken = isToken0 ? r0 : r1;
    const resETH   = isToken0 ? r1 : r0;

    window._poolReserveToken = resToken;
    window._poolReserveETH   = resETH;

    const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const dec = await erc20.decimals().catch(() => 18);
    window._poolTokenDecimals = dec;

    const resTokenF = parseFloat(ethers.utils.formatUnits(resToken, dec));
    const resETHF   = parseFloat(ethers.utils.formatEther(resETH));
    const supplyF   = parseFloat(ethers.utils.formatEther(supply));

    const priceETH  = resETHF / resTokenF;
    const priceUSDT = ethToUSDT(priceETH);

    const statItems = [
      { id: 'poolStat-price',    label: 'PRICE',         value: priceUSDT.toLocaleString(undefined,{maximumFractionDigits:6}) + ' USDT' },
      { id: 'poolStat-tokenres', label: 'TOKEN RESERVE', value: resTokenF.toLocaleString(undefined,{maximumFractionDigits:4}) + ' ' + t.symbol },
      { id: 'poolStat-usdtres',  label: 'USDT RESERVE',  value: (resETHF * USDT_PER_ETH).toLocaleString(undefined,{maximumFractionDigits:2}) + ' USDT' },
      { id: 'poolStat-lpsupply', label: 'LP SUPPLY',     value: supplyF.toFixed(6) + ' HDEX-LP' },
      { id: 'poolStat-pairaddr', label: 'PAIR ADDRESS',  value: pairAddr.slice(0,10) + '…' + pairAddr.slice(-8), full: pairAddr },
    ];

    document.getElementById('poolStats').innerHTML = statItems.map(s => `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px 14px;">
        <div style="font-size:9px;color:var(--muted);font-family:var(--font-mono);letter-spacing:1.5px;margin-bottom:6px;">${s.label}</div>
        <div id="${s.id}" style="font-size:13px;color:var(--cream);font-family:var(--font-mono);word-break:break-all;" ${s.full ? `title="${s.full}"` : ''}>${s.value}</div>
      </div>`).join('');

    window._poolCurPrice = priceUSDT;
    _updateHeaderPrice(priceUSDT);
    await updateBalances(tokenAddr, dec);
    _updatePoolRateDisplay(priceUSDT, t.symbol);
    loadTradeHistory(pairAddr, isToken0, dec, t.symbol);
    loadPriceChart(pairAddr, isToken0, dec);
    _startPoolPolling();

  } catch(e) {
    document.getElementById('poolStats').innerHTML = `<div style="color:#ff5050;font-size:12px;font-family:var(--font-mono);">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
    toast('Pool info error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function updateBalances(tokenAddr, dec) {
  try {
    const [tokenBal, ethBal] = await Promise.all([
      new ethers.Contract(tokenAddr, ERC20_ABI, provider).balanceOf(walletAddress),
      provider.getBalance(walletAddress)
    ]);
    const tokenF = parseFloat(ethers.utils.formatUnits(tokenBal, dec));
    const usdtF  = parseFloat(ethers.utils.formatEther(ethBal)) * USDT_PER_ETH;
    const sellEl = document.getElementById('poolSellBal');
    const buyEl  = document.getElementById('poolBuyUsdtBal');
    if (sellEl) sellEl.textContent = tokenF.toLocaleString(undefined, { maximumFractionDigits: 4 });
    if (buyEl)  buyEl.textContent  = usdtF.toLocaleString(undefined,  { maximumFractionDigits: 2 });
    window._poolUserUsdtBal  = usdtF;
    window._poolUserTokenBal = tokenF;
  } catch(_) {}
}

function _updatePoolRateDisplay(priceUSDT, tokenSymbol) {
  const buyEl  = document.getElementById('poolBuyRate');
  const sellEl = document.getElementById('poolSellRate');
  const text   = (!priceUSDT || priceUSDT <= 0)
    ? '—'
    : `1 ${tokenSymbol} = ${priceUSDT.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDT`;
  if (buyEl  && buyEl.textContent  !== text) buyEl.textContent  = text;
  if (sellEl && sellEl.textContent !== text) sellEl.textContent = text;
}

function _renderTradeHistory(tokenSymbol) {
  const histEl = document.getElementById('poolTradeHistory');
  if (!histEl) return;
  const buys  = window._poolTradeBuys;
  const sells = window._poolTradeSells;

  if (!buys.length && !sells.length) {
    histEl.innerHTML = `
      <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);letter-spacing:1.5px;margin-bottom:10px;">RECENT TRADES</div>
      <div style="color:var(--muted);font-size:11px;font-family:var(--font-mono);">No trades yet.</div>`;
    return;
  }

  const fmtAmt = n => n < 0.01
    ? n.toExponential(2)
    : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
  const fmtP = n => n < 0.000001
    ? n.toExponential(2)
    : n.toLocaleString(undefined, { maximumFractionDigits: 6 });

  const colHdr = color => `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px 6px;padding-bottom:4px;border-bottom:1px solid ${color}33;margin-bottom:2px;">
      <div style="font-size:9px;color:${color};font-family:var(--font-mono);letter-spacing:1px;opacity:.7;">PRICE</div>
      <div style="font-size:9px;color:${color};font-family:var(--font-mono);letter-spacing:1px;opacity:.7;">${tokenSymbol}</div>
      <div style="font-size:9px;color:${color};font-family:var(--font-mono);letter-spacing:1px;opacity:.7;">USDT</div>
    </div>`;

  const mkRows = (list, color) => list.length
    ? list.map(r => `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px 6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.03);">
          <div style="color:${color};font-family:var(--font-mono);font-size:11px;">$${fmtP(r.price)}</div>
          <div style="color:${color};font-family:var(--font-mono);font-size:11px;">${fmtAmt(r.tokenAmt)}</div>
          <div style="color:${color};font-family:var(--font-mono);font-size:11px;">$${fmtAmt(r.usdtAmt)}</div>
        </div>`).join('')
    : `<div style="color:var(--muted);font-family:var(--font-mono);font-size:11px;padding:5px 0;">—</div>`;

  const isBuyMode = window._poolMode === 'buy';
  const [topColor, topLabel, topList, botColor, botLabel, botList] = isBuyMode
    ? ['#4ade80', '▲ BUYS',  buys,  '#f87171', '▼ SELLS', sells]
    : ['#f87171', '▼ SELLS', sells, '#4ade80',  '▲ BUYS',  buys];

  const newHtml = `
    <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);letter-spacing:1.5px;margin-bottom:10px;">RECENT TRADES</div>
    <div style="margin-bottom:14px;">
      <div style="font-size:10px;color:${topColor};font-family:var(--font-mono);letter-spacing:1px;margin-bottom:6px;font-weight:700;">${topLabel}</div>
      ${colHdr(topColor)}
      ${mkRows(topList, topColor)}
    </div>
    <div>
      <div style="font-size:10px;color:${botColor};font-family:var(--font-mono);letter-spacing:1px;margin-bottom:6px;font-weight:700;">${botLabel}</div>
      ${colHdr(botColor)}
      ${mkRows(botList, botColor)}
    </div>`;

  if (histEl.innerHTML !== newHtml) histEl.innerHTML = newHtml;
}

async function loadTradeHistory(pairAddr, isToken0, dec, tokenSymbol, silent = false) {
  const histEl = document.getElementById('poolTradeHistory');
  if (!histEl) return;
  if (!silent) {
    histEl.innerHTML = '<div style="color:var(--muted);font-size:11px;font-family:var(--font-mono);padding:8px;">Loading…</div>';
  }

  try {
    const pair  = getPairContract(pairAddr);
    const swaps = await pair.queryFilter('Swap', 0, 'latest').catch(() => []);

    const allTrades = [...swaps].reverse().map(ev => {
      const { amount0In, amount0Out, amount1In, amount1Out } = ev.args;
      let isBuy, tokenAmt, ethAmt;
      if (isToken0) {
        if (!amount1In.isZero()) {
          isBuy = true;
          tokenAmt = parseFloat(ethers.utils.formatUnits(amount0Out, dec));
          ethAmt   = parseFloat(ethers.utils.formatEther(amount1In));
        } else {
          isBuy = false;
          tokenAmt = parseFloat(ethers.utils.formatUnits(amount0In, dec));
          ethAmt   = parseFloat(ethers.utils.formatEther(amount1Out));
        }
      } else {
        if (!amount0In.isZero()) {
          isBuy = true;
          tokenAmt = parseFloat(ethers.utils.formatUnits(amount1Out, dec));
          ethAmt   = parseFloat(ethers.utils.formatEther(amount0In));
        } else {
          isBuy = false;
          tokenAmt = parseFloat(ethers.utils.formatUnits(amount1In, dec));
          ethAmt   = parseFloat(ethers.utils.formatEther(amount0Out));
        }
      }
      const usdtAmt = ethToUSDT(ethAmt);
      const price   = tokenAmt > 0 ? usdtAmt / tokenAmt : 0;
      return { isBuy, tokenAmt, usdtAmt, price };
    });

    window._poolTradeBuys  = allTrades.filter(t =>  t.isBuy).slice(0, 5);
    window._poolTradeSells = allTrades.filter(t => !t.isBuy).slice(0, 5);
    _renderTradeHistory(tokenSymbol);

  } catch(e) {
    if (!silent) histEl.innerHTML = `<div style="color:#ff5050;font-size:11px;font-family:var(--font-mono);">Failed to load trades.</div>`;
  }
}

function togglePoolStats() {
  const el  = document.getElementById('poolStats');
  const btn = document.getElementById('poolStatsToggleBtn');
  if (!el) return;
  const open = el.style.display === 'none' || el.style.display === '';
  el.style.display  = open ? 'grid' : 'none';
  if (btn) btn.textContent = open ? 'SHOW LESS ▴' : 'SHOW MORE ▾';
}

function switchPoolMode(mode) {
  window._poolMode = mode;
  const isBuy = mode === 'buy';
  document.getElementById('poolBuyForm').style.display  = isBuy  ? 'block' : 'none';
  document.getElementById('poolSellForm').style.display = !isBuy ? 'block' : 'none';
  document.getElementById('poolBuyBtn').style.background  = isBuy  ? 'var(--success,#26d97f)' : 'var(--surface)';
  document.getElementById('poolBuyBtn').style.color       = isBuy  ? '#000' : 'var(--muted)';
  document.getElementById('poolSellBtn').style.background = !isBuy ? 'var(--gold)' : 'var(--surface)';
  document.getElementById('poolSellBtn').style.color      = !isBuy ? '#000' : 'var(--muted)';
  if (window._poolTradeBuys.length || window._poolTradeSells.length) {
    _renderTradeHistory(window._poolTokenSymbol);
  }
}

function _setBuyHint(out) {
  const hintEl = document.getElementById('poolBuyHint');
  if (!hintEl) return;
  hintEl.textContent = '';
}

async function onBuyUsdtInput() {
  const usdt = parseFloat(document.getElementById('poolBuyUSDT').value);
  const hintEl = document.getElementById('poolBuyHint');
  if (!usdt || usdt <= 0 || !window._poolSelectedToken) {
    document.getElementById('poolBuyToken').value = '';
    if (hintEl) hintEl.textContent = '';
    return;
  }
  try {
    const router  = getRouter();
    const amounts = await router.getAmountsOut(
      ethers.utils.parseEther((usdt / USDT_PER_ETH).toString()),
      [DEX_WETH, window._poolSelectedToken]
    );
    const out = parseFloat(ethers.utils.formatUnits(amounts[1], window._poolTokenDecimals));
    document.getElementById('poolBuyToken').value = out.toLocaleString(undefined, {maximumFractionDigits:6, useGrouping:false});
    _setBuyHint(out);
  } catch(_) { document.getElementById('poolBuyToken').value = ''; if (hintEl) hintEl.textContent = ''; }
}

async function onBuyTokenInput() {
  const tokVal = parseFloat(document.getElementById('poolBuyToken').value);
  const hintEl = document.getElementById('poolBuyHint');
  if (!tokVal || tokVal <= 0 || !window._poolSelectedToken) {
    document.getElementById('poolBuyUSDT').value = '';
    if (hintEl) hintEl.textContent = '';
    return;
  }
  try {
    const router  = getRouter();
    const amounts = await router.getAmountsIn(
      ethers.utils.parseUnits(tokVal.toString(), window._poolTokenDecimals),
      [DEX_WETH, window._poolSelectedToken]
    );
    const usdtNeeded = parseFloat(ethers.utils.formatEther(amounts[0])) * USDT_PER_ETH;
    document.getElementById('poolBuyUSDT').value = usdtNeeded.toFixed(2);
    _setBuyHint(tokVal);
  } catch(_) { document.getElementById('poolBuyUSDT').value = ''; if (hintEl) hintEl.textContent = ''; }
}

async function onSellTokenInput() {
  const amt = parseFloat(document.getElementById('poolSellAmt').value);
  if (!amt || amt <= 0 || !window._poolSelectedToken) {
    document.getElementById('poolSellUSDT').value = '';
    return;
  }
  try {
    const router  = getRouter();
    const amounts = await router.getAmountsOut(
      ethers.utils.parseUnits(amt.toString(), window._poolTokenDecimals),
      [window._poolSelectedToken, DEX_WETH]
    );
    const usdtOut = parseFloat(ethers.utils.formatEther(amounts[1])) * USDT_PER_ETH;
    document.getElementById('poolSellUSDT').value = usdtOut.toFixed(2);
  } catch(_) { document.getElementById('poolSellUSDT').value = ''; }
}

async function onSellUsdtInput() {
  const usdt = parseFloat(document.getElementById('poolSellUSDT').value);
  if (!usdt || usdt <= 0 || !window._poolSelectedToken) {
    document.getElementById('poolSellAmt').value = '';
    return;
  }
  try {
    const router  = getRouter();
    const amounts = await router.getAmountsIn(
      ethers.utils.parseEther((usdt / USDT_PER_ETH).toString()),
      [window._poolSelectedToken, DEX_WETH]
    );
    const tokNeeded = parseFloat(ethers.utils.formatUnits(amounts[0], window._poolTokenDecimals));
    document.getElementById('poolSellAmt').value = tokNeeded.toLocaleString(undefined, {maximumFractionDigits:6, useGrouping:false});
  } catch(_) { document.getElementById('poolSellAmt').value = ''; }
}

function poolSellMax() {
  const bal = document.getElementById('poolSellBal').textContent.replace(/,/g,'');
  if (bal && bal !== '—') {
    document.getElementById('poolSellAmt').value = bal;
    onSellTokenInput();
  }
}

function poolBuyMax() {
  const bal = (window._poolUserUsdtBal || 0).toFixed(2);
  if (parseFloat(bal) > 0) {
    document.getElementById('poolBuyUSDT').value = bal;
    onBuyUsdtInput();
  }
}

async function poolBuyTokens() {
  if (!requireConnected()) return;
  const usdtVal = parseFloat(document.getElementById('poolBuyUSDT').value);
  if (!usdtVal || usdtVal <= 0) { toast('Enter a USDT amount', 'warn'); return; }
  if (!window._poolSelectedToken) { toast('Select a token first', 'warn'); return; }
  _txBegin();
  try {
    const router = getRouter();
    const ethIn      = ethers.utils.parseEther((usdtVal / USDT_PER_ETH).toString());
    const amountsOut = await router.getAmountsOut(ethIn, [DEX_WETH, window._poolSelectedToken]);
    const minOut     = amountsOut[1].mul(990).div(1000); // 1% slippage
    const deadline   = Math.floor(Date.now()/1000) + 300;
    toast('Confirm transaction in MetaMask…', 'info');
    const tx = await router.swapExactETHForTokens(
      minOut, [DEX_WETH, window._poolSelectedToken], walletAddress, deadline, { value: ethIn }
    );
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    _txDone();
    toast('Buy successful!', 'success');
    document.getElementById('poolBuyUSDT').value  = '';
    document.getElementById('poolBuyToken').value = '';
    const hintEl = document.getElementById('poolBuyHint');
    if (hintEl) hintEl.textContent = '';
    loadPoolInfo(window._poolSelectedToken);
  } catch(e) {
    _txDone();
    toast('Buy failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function poolSellTokens() {
  if (!requireConnected()) return;
  const amt = parseFloat(document.getElementById('poolSellAmt').value);
  if (!amt || amt <= 0) { toast('Enter token amount', 'warn'); return; }
  if (!window._poolSelectedToken) { toast('Select a token first', 'warn'); return; }
  _txBegin();
  try {
    const erc20  = new ethers.Contract(window._poolSelectedToken, ERC20_ABI, signer);
    const amtIn  = ethers.utils.parseUnits(amt.toString(), window._poolTokenDecimals);
    const balance = await erc20.balanceOf(walletAddress);
    if (balance.lt(amtIn)) {
      const have = parseFloat(ethers.utils.formatUnits(balance, window._poolTokenDecimals));
      toast(`Insufficient balance — you have ${have.toLocaleString(undefined,{maximumFractionDigits:4})} ${window._poolTokenSymbol}`, 'error');
      _txDone();
      return;
    }
    const router   = getRouter();
    const amounts  = await router.getAmountsOut(amtIn, [window._poolSelectedToken, DEX_WETH]);
    const minETH   = amounts[1].mul(990).div(1000); // 1% slippage
    const deadline = Math.floor(Date.now()/1000) + 300;
    const allowance = await erc20.allowance(walletAddress, DEX_ROUTER);
    if (allowance.lt(amtIn)) {
      toast('Approve token spend in MetaMask…', 'info');
      const approveTx = await erc20.approve(DEX_ROUTER, amtIn);
      await approveTx.wait();
    }
    toast('Confirm swap in MetaMask…', 'info');
    const tx = await router.swapExactTokensForETH(
      amtIn, minETH, [window._poolSelectedToken, DEX_WETH], walletAddress, deadline
    );
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    _txDone();
    toast('Sell successful!', 'success');
    document.getElementById('poolSellAmt').value  = '';
    document.getElementById('poolSellUSDT').value = '';
    loadPoolInfo(window._poolSelectedToken);
  } catch(e) {
    _txDone();
    toast('Sell failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

// ── PRICE CHART ──────────────────────────────────────────────────────────────

window._poolChartData      = [];
window._poolChartTimeframe = '1h';
window._poolChartState     = null; // {data, padL, padR, padT, padB, W, H, tMin, tMax, vLo, vHi}

async function loadPriceChart(pairAddr, isToken0, dec) {
  const canvas = document.getElementById('poolPriceCanvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth || 500;
  const H = 200;
  canvas.width        = W * dpr;
  canvas.height       = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle    = 'rgba(148,163,184,0.4)';
  ctx.font         = '11px monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Loading price history…', W / 2, H / 2);
  _initChartHover(canvas);

  try {
    const pair  = getPairContract(pairAddr);
    const swaps = await pair.queryFilter('Swap', 0, 'latest').catch(() => []);
    if (!swaps.length) { window._poolChartData = []; renderPriceChart(window._poolChartTimeframe); return; }

    const uniqueBlocks = [...new Set(swaps.map(e => e.blockNumber))];
    const blockMap = {};
    await Promise.all(uniqueBlocks.map(async bn => {
      try { const blk = await provider.getBlock(bn); blockMap[bn] = blk.timestamp * 1000; }
      catch(_) { blockMap[bn] = bn * 15000; } // fallback: estimate at 15s/block
    }));

    const points = swaps.map(ev => {
      const { amount0In, amount0Out, amount1In, amount1Out } = ev.args;
      let isBuy, tokenAmt, ethAmt;
      if (isToken0) {
        if (!amount1In.isZero()) {
          isBuy    = true;
          tokenAmt = parseFloat(ethers.utils.formatUnits(amount0Out, dec));
          ethAmt   = parseFloat(ethers.utils.formatEther(amount1In));
        } else {
          isBuy    = false;
          tokenAmt = parseFloat(ethers.utils.formatUnits(amount0In, dec));
          ethAmt   = parseFloat(ethers.utils.formatEther(amount1Out));
        }
      } else {
        if (!amount0In.isZero()) {
          isBuy    = true;
          tokenAmt = parseFloat(ethers.utils.formatUnits(amount1Out, dec));
          ethAmt   = parseFloat(ethers.utils.formatEther(amount0In));
        } else {
          isBuy    = false;
          tokenAmt = parseFloat(ethers.utils.formatUnits(amount1In, dec));
          ethAmt   = parseFloat(ethers.utils.formatEther(amount0Out));
        }
      }
      if (!tokenAmt || tokenAmt <= 0 || !ethAmt) return null;
      const usdtVol = ethToUSDT(ethAmt);
      return { time: blockMap[ev.blockNumber], price: usdtVol / tokenAmt, isBuy, tokenVol: tokenAmt, usdtVol };
    }).filter(Boolean);

    points.sort((a, b) => a.time - b.time);
    window._poolChartData = points;
    // Record highest block so incremental updates know where to resume
    if (swaps.length) {
      window._poolChartLastBlock = Math.max(...swaps.map(e => e.blockNumber));
    }
  } catch(_) {
    window._poolChartData = [];
  }
  renderPriceChart(window._poolChartTimeframe);
}

function switchPriceChart(tf) {
  renderPriceChart(tf);
}

function renderPriceChart(tf) {
  window._poolChartTimeframe = tf;
  const ids = ['1h','4h','12h','24h','1w','1m','1y','all'];
  ids.forEach(t => {
    const btn = document.getElementById('pct-' + t);
    if (!btn) return;
    btn.style.background = t === tf ? 'var(--gold)' : 'var(--surface)';
    btn.style.color      = t === tf ? '#000' : 'var(--muted)';
  });
  const now   = Date.now();
  const spans = { '1h':3600e3, '4h':14400e3, '12h':43200e3, '24h':86400e3, '1w':604800e3, '1m':2592000e3, '1y':31536000e3 };
  const cutoff = tf === 'all' ? 0 : now - spans[tf];
  const data = window._poolChartData.filter(p => p.time >= cutoff);
  const canvas = document.getElementById('poolPriceCanvas');
  if (canvas) _drawPriceCanvas(canvas, data);
}

function _drawPriceCanvas(canvas, data, hoverIdx) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement.clientWidth || 500;
  const H   = 220;
  canvas.width        = W * dpr;
  canvas.height       = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  if (!data.length) {
    ctx.fillStyle    = 'rgba(148,163,184,0.45)';
    ctx.font         = '11px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No trades in this period', W / 2, H / 2);
    window._poolChartState = null;
    return;
  }

  const padL = 72, padR = 16, padT = 18, padB = 40;
  const cW   = W - padL - padR;
  const cH   = H - padT - padB;
  const times = data.map(p => p.time);
  const vals  = data.map(p => p.price);
  const tMin  = times[0], tMax = times[times.length - 1] || tMin + 1;
  const vMin  = Math.min(...vals);
  const vMax  = Math.max(...vals);
  const vPad  = (vMax - vMin) * 0.12 || vMax * 0.12 || 0.000001;
  const vLo   = vMin - vPad;
  const vHi   = vMax + vPad;
  const vRng  = vHi - vLo;

  const tx = t => padL + ((t - tMin) / (tMax - tMin || 1)) * cW;
  const ty = v => padT + cH - ((v - vLo) / vRng) * cH;

  // Save state for hover hit-testing
  window._poolChartState = { data, padL, padR, padT, padB, W, H, tMin, tMax, vLo, vHi, vRng, cW, cH };

  // Grid
  ctx.strokeStyle = 'rgba(201,168,76,0.08)';
  ctx.lineWidth   = 1;
  ctx.fillStyle   = 'rgba(148,163,184,0.55)';
  ctx.font        = '9px monospace';
  ctx.textAlign   = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = vLo + (vRng / 4) * i;
    const y = ty(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    const lbl = v < 0.001 ? v.toExponential(2) : v.toLocaleString(undefined, { maximumFractionDigits: 4 });
    ctx.fillText(lbl, padL - 4, y);
  }

  // Time axis
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  const span = tMax - tMin;
  for (let i = 0; i <= 4; i++) {
    const t = tMin + span / 4 * i;
    const x = tx(t);
    const d = new Date(t);
    const lbl = span < 86400e3
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    ctx.fillText(lbl, x, H - padB + 8);
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, padT, 0, padT + cH);
  grad.addColorStop(0, 'rgba(201,168,76,0.20)');
  grad.addColorStop(1, 'rgba(201,168,76,0.0)');
  ctx.beginPath();
  ctx.moveTo(tx(times[0]), ty(vals[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(tx(times[i]), ty(vals[i]));
  ctx.lineTo(tx(times[times.length - 1]), padT + cH);
  ctx.lineTo(tx(times[0]), padT + cH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Price line
  ctx.beginPath();
  ctx.moveTo(tx(times[0]), ty(vals[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(tx(times[i]), ty(vals[i]));
  ctx.strokeStyle = '#c9a84c';
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // Hover crosshair + highlight dot
  if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < data.length) {
    const hx = tx(times[hoverIdx]);
    const hy = ty(vals[hoverIdx]);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(201,168,76,0.35)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + cH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, hy); ctx.lineTo(W - padR, hy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, Math.PI * 2);
    ctx.fillStyle   = '#c9a84c';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();
  } else {
    // Last price dot
    const lx = tx(times[times.length - 1]);
    const ly = ty(vals[vals.length - 1]);
    ctx.beginPath();
    ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#c9a84c';
    ctx.fill();
  }
}

function _initChartHover(canvas) {
  if (canvas._hoverBound) return;
  canvas._hoverBound = true;

  const tooltip = document.getElementById('poolChartTooltip');
  let animFrame = null;
  let lastIdx   = null;

  canvas.addEventListener('mousemove', e => {
    const st = window._poolChartState;
    if (!st || !st.data.length) { if (tooltip) tooltip.style.display = 'none'; return; }

    const rect = canvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;

    // Find nearest data point by x distance
    const { data, padL, padR, padT, padB, W, H, tMin, tMax, cW } = st;
    if (mx < padL || mx > W - padR || my < padT || my > H - padB) {
      if (tooltip) tooltip.style.display = 'none';
      if (lastIdx !== null) { lastIdx = null; cancelAnimationFrame(animFrame); animFrame = requestAnimationFrame(() => _drawPriceCanvas(canvas, data)); }
      return;
    }

    const tAtMouse = tMin + ((mx - padL) / cW) * (tMax - tMin);
    let nearest = 0;
    let minDist = Infinity;
    for (let i = 0; i < data.length; i++) {
      const d = Math.abs(data[i].time - tAtMouse);
      if (d < minDist) { minDist = d; nearest = i; }
    }

    if (nearest !== lastIdx) {
      lastIdx = nearest;
      cancelAnimationFrame(animFrame);
      animFrame = requestAnimationFrame(() => _drawPriceCanvas(canvas, data, nearest));
    }

    if (tooltip) {
      const p  = data[nearest];
      const dt = new Date(p.time);
      const timeStr = dt.toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      const sym = window._poolTokenSymbol || 'TOKEN';
      tooltip.innerHTML =
        `<div style="color:var(--gold);margin-bottom:4px;">${timeStr}</div>` +
        `<div>Price &nbsp;&nbsp;: <b>$${p.price.toLocaleString(undefined,{maximumFractionDigits:6})}</b></div>` +
        `<div>Volume : <b>$${p.usdtVol != null ? p.usdtVol.toLocaleString(undefined,{maximumFractionDigits:2}) : '—'}</b></div>` +
        `<div>Amount : <b>${p.tokenVol != null ? p.tokenVol.toLocaleString(undefined,{maximumFractionDigits:4}) : '—'} ${sym}</b></div>` +
        `<div>Side &nbsp;&nbsp;&nbsp;: <b style="color:${p.isBuy?'#4ade80':'#f87171'}">${p.isBuy?'BUY':'SELL'}</b></div>`;

      // Position tooltip
      const cRect  = canvas.parentElement.getBoundingClientRect();
      let tipX = e.clientX - cRect.left + 14;
      let tipY = e.clientY - cRect.top  + 14;
      tooltip.style.display = 'block';
      const tw = tooltip.offsetWidth;
      const th = tooltip.offsetHeight;
      if (tipX + tw > cRect.width - 4) tipX = e.clientX - cRect.left - tw - 14;
      if (tipY + th > cRect.height - 4) tipY = e.clientY - cRect.top - th - 14;
      tooltip.style.left = tipX + 'px';
      tooltip.style.top  = tipY + 'px';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (tooltip) tooltip.style.display = 'none';
    if (lastIdx !== null) {
      lastIdx = null;
      cancelAnimationFrame(animFrame);
      const st = window._poolChartState;
      if (st) animFrame = requestAnimationFrame(() => _drawPriceCanvas(canvas, st.data));
    }
  });
}

window.loadPoolPanel     = loadPoolPanel;
window.loadPoolInfo      = loadPoolInfo;
window.switchPoolMode    = switchPoolMode;
window._stopPoolPolling  = _stopPoolPolling;
window._stopListPolling  = _stopListPolling;
window.onBuyUsdtInput    = onBuyUsdtInput;
window.onBuyTokenInput   = onBuyTokenInput;
window.onSellTokenInput  = onSellTokenInput;
window.onSellUsdtInput   = onSellUsdtInput;
window.poolSellMax       = poolSellMax;
window.poolBuyMax        = poolBuyMax;
window.poolBuyTokens     = poolBuyTokens;
window.poolSellTokens    = poolSellTokens;
window.switchPriceChart  = switchPriceChart;
window.togglePoolStats   = togglePoolStats;
