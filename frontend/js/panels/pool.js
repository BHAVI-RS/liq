const DEX_ROUTER  = ROUTER_ADDRESS;
const DEX_FACTORY = FACTORY_ADDRESS;
const DEX_WETH    = WETH_ADDRESS;

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory)",
  "function getAmountsIn(uint256 amountOut, address[] memory path) view returns (uint256[] memory)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256, uint256)",
  "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256)"
];
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address)"
];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)"
];
// Uniswap V2 event topic hashes — used with provider.getLogs (more reliable than queryFilter on Amoy)
const SYNC_TOPIC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

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
    el.textContent = '$' + fmtNum(price);
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

    _setStatText('poolStat-price',    fmtNum(priceUSDT) + ' USDT');
    _setStatText('poolStat-tokenres', fmtNum(resTokenF) + ' ' + sym);
    _setStatText('poolStat-usdtres',  fmtNum(resETHF * USDT_PER_ETH) + ' USDT');
    _setStatText('poolStat-lpsupply', fmtNum(supplyF) + ' HDEX-LP');
    _updatePoolRateDisplay(priceUSDT, sym);
    updateBalances(tokenAddr, dec);
    loadTradeHistory(pairAddr, isToken0, dec, sym, true);
    _updateChartData(pairAddr, isToken0, dec);
  } catch(_) {}
}

async function _updateChartData(pairAddr, isToken0, dec) {
  try {
    const tokenAddr = window._poolSelectedToken;
    if (!tokenAddr) return;
    const pair = getPairContract(pairAddr);

    const [snapHistory, [r0, r1]] = await Promise.all([
      contract.getPriceHistory(tokenAddr),
      pair.getReserves(),
    ]);

    const points = [];

    for (const snap of snapHistory) {
      const resETHF   = parseFloat(ethers.utils.formatEther(snap.resETH));
      const resTokenF = parseFloat(ethers.utils.formatUnits(snap.resToken, dec));
      if (!resTokenF || resTokenF <= 0) continue;
      const price = ethToUSDT(resETHF / resTokenF);
      if (!price || price <= 0) continue;
      points.push({ time: snap.ts.toNumber() * 1000, price, isBuy: null, tokenVol: 0, usdtVol: 0 });
    }

    // Append live current-price point from getReserves()
    const resTokenF = parseFloat(ethers.utils.formatUnits(isToken0 ? r0 : r1, dec));
    const resETHF   = parseFloat(ethers.utils.formatEther(isToken0 ? r1 : r0));
    if (resTokenF > 0) {
      const curPrice = ethToUSDT(resETHF / resTokenF);
      const now = Date.now();
      const last = points[points.length - 1];
      if (!last || Math.abs(last.price - curPrice) / curPrice > 0.0001 || now - last.time > 60000) {
        points.push({ time: now, price: curPrice, isBuy: null, tokenVol: 0, usdtVol: 0 });
      }
    }

    if (!points.length) return;

    if (points.length === 1) points.unshift({ ...points[0], time: points[0].time - 60000 });
    points.sort((a, b) => a.time - b.time);

    window._poolChartData = points;
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
  el.textContent = '$' + fmtNum(priceUSDT);
  if (chEl && prev > 0) {
    const pct = ((priceUSDT - prev) / prev) * 100;
    chEl.style.color = up ? '#4ade80' : '#f87171';
    chEl.textContent = (up ? '▲ +' : '▼ ') + fmtNum(pct) + '%';
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
      if (t.inProgressLabel) continue;
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
            <div class="token-addr" style="word-break:break-all;">${t.tokenAddress}</div>
          </div>
        </div>
        ${price !== null
          ? `<div id="poolListPrice-${addr}" style="font-size:12px;color:${priceColor};font-family:var(--font-mono);font-weight:400;flex-shrink:0;letter-spacing:.03em;transition:color .4s;">$${fmtNum(price)}</div>`
          : `<div id="poolListPrice-${addr}" style="font-size:12px;color:var(--muted);font-family:var(--font-mono);flex-shrink:0;">—</div>`}`;
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
  window._poolChartAnimated  = false; // allow one animation per token selection

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
    addrEl.textContent  = tokenAddr;
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
      { id: 'poolStat-price',    label: 'PRICE',         value: fmtNum(priceUSDT) + ' USDT' },
      { id: 'poolStat-tokenres', label: 'TOKEN RESERVE', value: fmtNum(resTokenF) + ' ' + t.symbol },
      { id: 'poolStat-usdtres',  label: 'USDT RESERVE',  value: fmtNum(resETHF * USDT_PER_ETH) + ' USDT' },
      { id: 'poolStat-lpsupply', label: 'LP SUPPLY',     value: fmtNum(supplyF) + ' HDEX-LP' },
      { id: 'poolStat-pairaddr', label: 'PAIR ADDRESS',  value: pairAddr, full: pairAddr },
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
    const usdtAddr = typeof USDT_ADDRESS !== 'undefined' ? USDT_ADDRESS : WETH_ADDRESS;
    const [tokenBal, usdtBal] = await Promise.all([
      new ethers.Contract(tokenAddr, ERC20_ABI, provider).balanceOf(walletAddress),
      new ethers.Contract(usdtAddr, ERC20_ABI, provider).balanceOf(walletAddress),
    ]);
    const tokenF = parseFloat(ethers.utils.formatUnits(tokenBal, dec));
    const usdtF  = parseFloat(ethers.utils.formatEther(usdtBal));
    const sellEl = document.getElementById('poolSellBal');
    const buyEl  = document.getElementById('poolBuyUsdtBal');
    if (sellEl) sellEl.textContent = fmtNum(tokenF);
    if (buyEl)  buyEl.textContent  = fmtNum(usdtF);
    window._poolUserUsdtBal  = usdtF;
    window._poolUserTokenBal = tokenF;
  } catch(_) {}
}

function _updatePoolRateDisplay(priceUSDT, tokenSymbol) {
  const buyEl  = document.getElementById('poolBuyRate');
  const sellEl = document.getElementById('poolSellRate');
  const text   = (!priceUSDT || priceUSDT <= 0)
    ? '—'
    : `1 ${tokenSymbol} = ${fmtNum(priceUSDT)} USDT`;
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
    : fmtNum(n);
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
    if (!pairAddr || pairAddr === ethers.constants.AddressZero) return;

    // Read the actual Uniswap V2 Swap events for this pair — reflects every on-chain trade for the
    // token (platform-routed pool swaps AND direct DEX trades), not just contract-recorded ones.
    // The main read RPC (Alchemy free tier) caps eth_getLogs at 10 blocks, so log queries go through
    // a dedicated public node (getLogsProvider) that allows ~10k-block ranges. Walk backward in
    // chunks, stop once we have enough recent trades; per-chunk errors just skip that chunk.
    const logsP = (typeof getLogsProvider === 'function' && getLogsProvider()) || provider;
    const latest     = await logsP.getBlockNumber();
    const CHUNK      = 9000;   // stay within the public node's 10k-block getLogs limit
    const MAX_CHUNKS = 5;      // scan back at most ~45k blocks per refresh

    const buys = [], sells = [];
    let end = latest, scanned = 0;
    while (end > 0 && scanned < MAX_CHUNKS && (buys.length < 5 || sells.length < 5)) {
      const start = Math.max(0, end - CHUNK + 1);
      const batch = await logsP.getLogs({
        address: pairAddr, topics: [SWAP_TOPIC], fromBlock: start, toBlock: end
      }).catch(() => null);
      if (batch && batch.length) {
        for (let i = batch.length - 1; i >= 0; i--) {   // newest-first within the chunk
          const [a0In, a1In, a0Out, a1Out] = ethers.utils.defaultAbiCoder.decode(
            ['uint256', 'uint256', 'uint256', 'uint256'], batch[i].data
          );
          const tokOut = isToken0 ? a0Out : a1Out;
          const tokIn  = isToken0 ? a0In  : a1In;
          const ethIn  = isToken0 ? a1In  : a0In;
          const ethOut = isToken0 ? a1Out : a0Out;
          if (tokOut.gt(0)) {                       // token left the pool → BUY
            if (buys.length >= 5) continue;
            const tokF = parseFloat(ethers.utils.formatUnits(tokOut, dec));
            if (tokF <= 0) continue;
            const usdtAmt = ethToUSDT(parseFloat(ethers.utils.formatEther(ethIn)));
            buys.push({ tokenAmt: tokF, usdtAmt, price: usdtAmt / tokF });
          } else if (tokIn.gt(0)) {                 // token entered the pool → SELL
            if (sells.length >= 5) continue;
            const tokF = parseFloat(ethers.utils.formatUnits(tokIn, dec));
            if (tokF <= 0) continue;
            const usdtAmt = ethToUSDT(parseFloat(ethers.utils.formatEther(ethOut)));
            sells.push({ tokenAmt: tokF, usdtAmt, price: usdtAmt / tokF });
          }
          if (buys.length >= 5 && sells.length >= 5) break;
        }
      }
      end = start - 1;
      scanned++;
    }
    console.log('[trades] uniswap swaps — buys:', buys.length, 'sells:', sells.length);

    window._poolTradeBuys  = buys.slice(0, 5);
    window._poolTradeSells = sells.slice(0, 5);
    _renderTradeHistory(tokenSymbol);

  } catch(e) {
    console.error('[trades] loadTradeHistory error:', e);
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

// Forward quote (USDT → tokens). Uses the on-chain hybrid quote so "tokens to receive" matches
// exactly what swapBuy will deliver: pool leg (≤2% slippage) + treasury-inventory leg at spot.
async function onBuyUsdtInput() {
  const usdt = parseFloat(document.getElementById('poolBuyUSDT').value);
  const hintEl = document.getElementById('poolBuyHint');
  if (!usdt || usdt <= 0 || !window._poolSelectedToken) {
    document.getElementById('poolBuyToken').value = '';
    if (hintEl) hintEl.textContent = '';
    return;
  }
  try {
    const ethIn = ethers.utils.parseEther((usdt / USDT_PER_ETH).toString());
    const q     = await contract.quoteSwapBuy(window._poolSelectedToken, ethIn);
    const out   = parseFloat(ethers.utils.formatUnits(q.tokensOut, window._poolTokenDecimals));
    document.getElementById('poolBuyToken').value = parseFloat(out.toFixed(5)).toString();
    _renderBuyHint(q, ethIn);
  } catch(_) { document.getElementById('poolBuyToken').value = ''; if (hintEl) hintEl.textContent = ''; }
}

// Buy section shows no hint text below the price (refund notice intentionally suppressed).
function _renderBuyHint(q, ethIn) {
  const hintEl = document.getElementById('poolBuyHint');
  if (!hintEl) return;
  hintEl.innerHTML = '';
}

// Reverse quote (tokens → USDT). Mirrors calcHybridBuy: fill the pool up to the 2% cap, then price
// the remainder at the post-pool spot (the treasury price). Inventory limits are not enforced here —
// any shortfall is refunded on-chain at execution time.
async function onBuyTokenInput() {
  const tokVal = parseFloat(document.getElementById('poolBuyToken').value);
  const hintEl = document.getElementById('poolBuyHint');
  if (!tokVal || tokVal <= 0 || !window._poolSelectedToken) {
    document.getElementById('poolBuyUSDT').value = '';
    if (hintEl) hintEl.textContent = '';
    return;
  }
  try {
    const dec     = window._poolTokenDecimals;
    const resTokF = parseFloat(ethers.utils.formatUnits(window._poolReserveToken, dec));
    const resETHF = parseFloat(ethers.utils.formatEther(window._poolReserveETH));
    if (resTokF <= 0 || resETHF <= 0) { document.getElementById('poolBuyUSDT').value = ''; return; }
    const bps          = 200;
    const maxPoolUsdt  = resETHF * (997 * bps - 30000) / 9970000;       // 2% cap (incl. 0.3% fee)
    const poolTokAtMax = (maxPoolUsdt * 997 * resTokF) / (resETHF * 1000 + maxPoolUsdt * 997);
    let usdtIn;
    if (tokVal <= poolTokAtMax && tokVal < resTokF) {
      // Within the slippage cap — invert Uniswap getAmountOut.
      usdtIn = (resETHF * 1000 * tokVal) / ((resTokF - tokVal) * 997);
    } else {
      // Pool maxed at 2%; remainder priced at the post-pool spot (treasury).
      const newResETH = resETHF + maxPoolUsdt;
      const newResTok = resTokF - poolTokAtMax;
      const extra     = tokVal - poolTokAtMax;
      usdtIn = maxPoolUsdt + (extra * newResETH / newResTok);
    }
    const usdtDisplay = usdtIn * USDT_PER_ETH;
    document.getElementById('poolBuyUSDT').value = parseFloat(usdtDisplay.toFixed(2)).toString();
    if (hintEl) hintEl.textContent = '';
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
    document.getElementById('poolSellUSDT').value = parseFloat(usdtOut.toFixed(2)).toString();
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
    document.getElementById('poolSellAmt').value = parseFloat(tokNeeded.toFixed(5)).toString();
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
    const usdtAddr  = typeof USDT_ADDRESS !== 'undefined' ? USDT_ADDRESS : WETH_ADDRESS;
    const usdtAbi   = ['function approve(address,uint256) returns (bool)'];
    const usdtCt    = new ethers.Contract(usdtAddr, usdtAbi, signer);
    const ethIn     = ethers.utils.parseEther((usdtVal / USDT_PER_ETH).toString());
    // Authoritative hybrid quote (pool + treasury) drives the minimum tokens out.
    const q         = await contract.quoteSwapBuy(window._poolSelectedToken, ethIn);
    if (q.tokensOut.isZero()) { _txDone(); toast('No liquidity available for this token', 'error'); return; }
    const minOut    = q.tokensOut.mul(990).div(1000); // 1% slippage
    toast('Step 1/2 — Approve USDT in MetaMask…', 'info');
    await (await usdtCt.approve(CONTRACT_ADDRESS, ethIn, _GAS)).wait();
    toast('Step 2/2 — Confirm buy in MetaMask…', 'info');
    // Route through contract so the trade is recorded in getTradeHistory
    const tx = await contract.connect(signer).swapBuy(
      window._poolSelectedToken, ethIn, minOut, _GAS
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
      toast(`Insufficient balance — you have ${fmtNum(have)} ${window._poolTokenSymbol}`, 'error');
      _txDone();
      return;
    }
    const router  = getRouter();
    const amounts = await router.getAmountsOut(amtIn, [window._poolSelectedToken, DEX_WETH]);
    const minETH  = amounts[1].mul(990).div(1000); // 1% slippage
    // Approve platform contract (not router) — contract proxies the swap and records the trade
    const allowance = await erc20.allowance(walletAddress, CONTRACT_ADDRESS);
    if (allowance.lt(amtIn)) {
      toast('Approve token spend in MetaMask…', 'info');
      const approveTx = await erc20.approve(CONTRACT_ADDRESS, amtIn, _GAS);
      await approveTx.wait();
    }
    toast('Confirm swap in MetaMask…', 'info');
    const tx = await contract.connect(signer).swapSell(
      window._poolSelectedToken, amtIn, minETH, _GAS
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
window._poolChartTimeframe = 'all';
window._poolChartState     = null; // {data, padL, padR, padT, padB, W, H, tMin, tMax, vLo, vHi}
window._poolChartAnimId    = null; // rAF handle for draw animation

async function loadPriceChart(pairAddr, isToken0, dec) {
  const canvas = document.getElementById('poolPriceCanvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth || 500;
  const H = Math.max(60, canvas.parentElement.clientHeight - 16);
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
    const tokenAddr = window._poolSelectedToken;
    const pair      = getPairContract(pairAddr);

    const [snapHistory, reserves] = await Promise.all([
      contract.getPriceHistory(tokenAddr),
      pair.getReserves(),
    ]);

    const points = [];

    for (const snap of snapHistory) {
      const resETHF   = parseFloat(ethers.utils.formatEther(snap.resETH));
      const resTokenF = parseFloat(ethers.utils.formatUnits(snap.resToken, dec));
      if (!resTokenF || resTokenF <= 0) continue;
      const price = ethToUSDT(resETHF / resTokenF);
      if (!price || price <= 0) continue;
      points.push({ time: snap.ts.toNumber() * 1000, price, isBuy: null, tokenVol: 0, usdtVol: 0 });
    }

    // Always append current reserves as the most recent price point.
    const [r0, r1] = reserves;
    const resTokenF = parseFloat(ethers.utils.formatUnits(isToken0 ? r0 : r1, dec));
    const resETHF   = parseFloat(ethers.utils.formatEther(isToken0 ? r1 : r0));
    if (resTokenF > 0) {
      const price = ethToUSDT(resETHF / resTokenF);
      const now   = Date.now();
      const last  = points[points.length - 1];
      if (!last || now > last.time) {
        points.push({ time: now, price, isBuy: null, tokenVol: 0, usdtVol: 0 });
      }
    }

    points.sort((a, b) => a.time - b.time);

    // A single point has no line segment — extend it into a flat line 60 s back.
    if (points.length === 1) {
      points.unshift({ ...points[0], time: points[0].time - 60000 });
    }

    window._poolChartData = points;
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
  const ids = ['24h','1w','1m','1y','all'];
  ids.forEach(t => {
    const btn = document.getElementById('pct-' + t);
    if (!btn) return;
    btn.style.background  = t === tf ? 'rgba(201,168,76,0.85)' : 'transparent';
    btn.style.color       = t === tf ? '#0a1628'               : 'rgba(148,163,184,0.65)';
    btn.style.borderColor = t === tf ? 'rgba(201,168,76,0.85)' : 'rgba(255,255,255,0.1)';
  });

  const now   = Date.now();
  const spans = { '24h':86400e3,'1w':604800e3,'1m':2592000e3,'1y':31536000e3 };
  const all   = window._poolChartData;

  let viewMin, viewMax;
  if (tf === 'all') {
    if (!all.length) { viewMin = now - 3600e3; viewMax = now; }
    else {
      viewMin = all[0].time;
      viewMax = all[all.length - 1].time;
      const pad = (viewMax - viewMin) * 0.03 || 60000;
      viewMin -= pad; viewMax += pad;
    }
  } else {
    viewMax = now;
    viewMin = now - spans[tf];
  }

  const data   = all.filter(p => p.time >= viewMin && p.time <= viewMax);
  const canvas = document.getElementById('poolPriceCanvas');
  if (canvas) _animatePriceChart(canvas, data, viewMin, viewMax);
}

function _animatePriceChart(canvas, data, viewMin, viewMax) {
  if (window._poolChartAnimId) { cancelAnimationFrame(window._poolChartAnimId); window._poolChartAnimId = null; }
  if (!data.length) { _drawPriceCanvas(canvas, data, viewMin, viewMax); return; }
  // Animate only on the first render per token selection; poll refreshes draw instantly
  if (window._poolChartAnimated) {
    _drawPriceCanvas(canvas, data, viewMin, viewMax);
    return;
  }
  window._poolChartAnimated = true;
  const start = performance.now();
  const dur   = 700;
  function step(ts) {
    const raw  = Math.min(1, (ts - start) / dur);
    const ease = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
    _drawPriceCanvas(canvas, data, viewMin, viewMax, null, ease);
    if (raw < 1) { window._poolChartAnimId = requestAnimationFrame(step); }
    else         { window._poolChartAnimId = null; }
  }
  window._poolChartAnimId = requestAnimationFrame(step);
}

// Helper: rounded rect path
function _rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function _drawPriceCanvas(canvas, data, viewMin, viewMax, hoverIdx, animProgress) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement.clientWidth || 500;
  const H   = Math.max(60, canvas.parentElement.clientHeight - 16);
  canvas.width        = W * dpr;
  canvas.height       = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  if (!data.length) {
    ctx.fillStyle    = 'rgba(148,163,184,0.4)';
    ctx.font         = '11px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No trades in this period', W / 2, H / 2);
    window._poolChartState = null;
    return;
  }

  const padR = 14, padT = 14, padB = 8;

  const times = data.map(p => p.time);
  const vals  = data.map(p => p.price);
  const tMin  = viewMin;
  const tMax  = viewMax;
  const vMin  = Math.min(...vals);
  const vMax  = Math.max(...vals);
  const vPad  = (vMax - vMin) * 0.15 || vMax * 0.15 || 0.000001;
  const vLo   = vMin - vPad;
  const vHi   = vMax + vPad;
  const vRng  = vHi - vLo;

  // Measure y-labels first so padL is tight but not cramped
  ctx.font = '9px monospace';
  let maxLabelW = 0;
  for (let i = 0; i <= 5; i++) {
    const v = vLo + (vRng / 5) * i;
    const lbl = v < 0.0001 ? v.toExponential(2) : fmtNum(v);
    const w = ctx.measureText(lbl).width;
    if (w > maxLabelW) maxLabelW = w;
  }
  const padL   = Math.ceil(maxLabelW) + 10;
  const priceH = H - padT - padB;
  const cW     = W - padL - padR;

  const tx = t => padL + ((t - tMin) / (tMax - tMin || 1)) * cW;
  const ty = v => padT + priceH - ((v - vLo) / vRng) * priceH;

  const isUp    = vals[vals.length - 1] >= vals[0];
  const lineClr = isUp ? '#4ade80' : '#f87171';

  window._poolChartState = { data, viewMin, viewMax, padL, padR, padT, padB, W, H, tMin, tMax, vLo, vHi, vRng, cW, cH: priceH };

  // ── Y-axis grid + labels (always full width — not clipped to animation) ──
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'right';
  for (let i = 0; i <= 5; i++) {
    const v = vLo + (vRng / 5) * i;
    const y = ty(v);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    const lbl = v < 0.0001 ? v.toExponential(2) : fmtNum(v);
    ctx.fillStyle = 'rgba(148,163,184,0.42)';
    ctx.font = '9px monospace';
    ctx.fillText(lbl, padL - 5, y);
  }

  // ── Price line clipped to animation progress ──
  const progress = (animProgress == null) ? 1 : animProgress;
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT - 1, cW * progress, priceH + 2);
  ctx.clip();

  ctx.shadowColor = lineClr;
  ctx.shadowBlur  = 5;
  ctx.beginPath();
  ctx.moveTo(tx(times[0]), ty(vals[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(tx(times[i]), ty(vals[i]));
  ctx.strokeStyle = lineClr;
  ctx.lineWidth   = 1.8;
  ctx.lineJoin    = 'round';
  ctx.stroke();
  ctx.shadowBlur  = 0;

  ctx.restore();

  // ── Price tag + trailing dot (shown only when animation is complete) ──
  if (progress >= 1) {
    const lastVal = vals[vals.length - 1];
    const lastY   = ty(lastVal);

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = lineClr + '44';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(padL, lastY); ctx.lineTo(W - padR, lastY); ctx.stroke();
    ctx.setLineDash([]);

    const pFmt = lastVal < 0.0001 ? lastVal.toExponential(2) : fmtNum(lastVal);
    ctx.font = 'bold 9px monospace';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    const tagW = ctx.measureText(pFmt).width + 12;
    ctx.fillStyle = lineClr;
    _rrect(ctx, padL - tagW - 1, lastY - 8, tagW, 16, 3);
    ctx.fill();
    ctx.fillStyle = '#0a1628';
    ctx.fillText(pFmt, padL - 5, lastY);

    // ── Hover crosshair + dot ──
    if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < data.length) {
      const hx = tx(times[hoverIdx]);
      const hy = ty(vals[hoverIdx]);
      ctx.save();
      ctx.beginPath(); ctx.rect(padL, padT, cW, priceH); ctx.clip();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + priceH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, hy); ctx.lineTo(W - padR, hy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowColor = lineClr; ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
      ctx.fillStyle   = lineClr;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 1.5;
      ctx.fill(); ctx.stroke();
      ctx.shadowBlur  = 0;
      ctx.restore();
    } else {
      const lx = tx(times[times.length - 1]);
      ctx.save();
      ctx.beginPath(); ctx.rect(padL, padT, cW, priceH); ctx.clip();
      ctx.shadowColor = lineClr; ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(lx, lastY, 4, 0, Math.PI * 2);
      ctx.fillStyle = lineClr;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
    }
  }
}

function _initChartHover(canvas) {
  if (canvas._hoverBound) return;
  canvas._hoverBound = true;

  // No hover on touch/mobile — avoids sticky crosshairs and unnecessary redraws
  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;

  const tooltip = document.getElementById('poolChartTooltip');
  let animFrame = null;
  let lastIdx   = null;

  canvas.addEventListener('mousemove', e => {
    // Cancel any draw animation so hover takes over cleanly
    if (window._poolChartAnimId) { cancelAnimationFrame(window._poolChartAnimId); window._poolChartAnimId = null; }
    const st = window._poolChartState;
    if (!st || !st.data.length) { if (tooltip) tooltip.style.display = 'none'; return; }

    const rect = canvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;

    const { data, padL, padR, padT, W, tMin, tMax, cW, cH } = st;
    if (mx < padL || mx > W - padR || my < padT || my > padT + cH) {
      if (tooltip) tooltip.style.display = 'none';
      if (lastIdx !== null) {
        lastIdx = null;
        cancelAnimationFrame(animFrame);
        animFrame = requestAnimationFrame(() => _drawPriceCanvas(canvas, data, tMin, tMax));
      }
      return;
    }

    const tAtMouse = tMin + ((mx - padL) / cW) * (tMax - tMin);
    let nearest = 0, minDist = Infinity;
    for (let i = 0; i < data.length; i++) {
      const d = Math.abs(data[i].time - tAtMouse);
      if (d < minDist) { minDist = d; nearest = i; }
    }

    if (nearest !== lastIdx) {
      lastIdx = nearest;
      cancelAnimationFrame(animFrame);
      animFrame = requestAnimationFrame(() => _drawPriceCanvas(canvas, data, tMin, tMax, nearest));
    }

    if (tooltip) {
      const p       = data[nearest];
      const timeStr = String(Math.floor(p.time / 1000));
      const sym     = window._poolTokenSymbol || 'TOKEN';
      const sideClr = p.isBuy === null ? 'var(--muted)' : p.isBuy ? '#4ade80' : '#f87171';
      const sideLabel = p.isBuy === null ? 'LP' : p.isBuy ? 'BUY' : 'SELL';
      tooltip.innerHTML =
        `<div style="color:rgba(201,168,76,0.9);margin-bottom:5px;font-size:10px;">${timeStr}</div>` +
        `<div>Price  <b>$${fmtNum(p.price)}</b></div>` +
        (p.usdtVol  ? `<div>Volume <b>$${fmtNum(p.usdtVol)}</b></div>` : '') +
        (p.tokenVol ? `<div>Amount <b>${fmtNum(p.tokenVol)} ${sym}</b></div>` : '') +
        `<div>Side   <b style="color:${sideClr}">${sideLabel}</b></div>`;

      const cRect = canvas.parentElement.getBoundingClientRect();
      let tipX = e.clientX - cRect.left + 16;
      let tipY = e.clientY - cRect.top  + 16;
      tooltip.style.display = 'block';
      const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
      if (tipX + tw > cRect.width  - 4) tipX = e.clientX - cRect.left - tw - 16;
      if (tipY + th > cRect.height - 4) tipY = e.clientY - cRect.top  - th - 16;
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
      if (st) animFrame = requestAnimationFrame(() => _drawPriceCanvas(canvas, st.data, st.tMin, st.tMax));
    }
  });
}

async function poolUpdateTWAP() {
  if (!requireConnected()) return;
  const tokenAddr = window._poolSelectedToken;
  const btn = document.getElementById('poolUpdateTwapBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'UPDATING…'; }
  try {
    toast('Confirm TWAP update in MetaMask…', 'info');
    const calls = [contract.updateTWAP(_GAS)];
    if (tokenAddr) calls.push(contract.updateTokenTWAP(tokenAddr, _GAS));
    const txs = await Promise.all(calls);
    await Promise.all(txs.map(tx => tx.wait()));
    toast('TWAP updated successfully!', 'success');
  } catch(e) {
    toast('TWAP update failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'UPDATE TWAP'; }
  }
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
window.poolUpdateTWAP    = poolUpdateTWAP;
