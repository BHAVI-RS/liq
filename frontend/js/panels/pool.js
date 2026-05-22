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
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
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
    const [tokenBal, ethBal] = await Promise.all([
      new ethers.Contract(tokenAddr, ERC20_ABI, provider).balanceOf(walletAddress),
      provider.getBalance(walletAddress)
    ]);
    const tokenF = parseFloat(ethers.utils.formatUnits(tokenBal, dec));
    const usdtF  = parseFloat(ethers.utils.formatEther(ethBal)) * USDT_PER_ETH;
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
    const pair        = getPairContract(pairAddr);
    const latestBlock = await provider.getBlockNumber();
    const fromBlock   = getFromBlock(latestBlock);
    const swaps = await pair.queryFilter('Swap', fromBlock, 'latest').catch(() => []);

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
    document.getElementById('poolBuyToken').value = parseFloat(out.toFixed(5)).toString();
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
    document.getElementById('poolBuyUSDT').value = parseFloat(usdtNeeded.toFixed(2)).toString();
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
    const router = getRouter();
    const ethIn      = ethers.utils.parseEther((usdtVal / USDT_PER_ETH).toString());
    const amountsOut = await router.getAmountsOut(ethIn, [DEX_WETH, window._poolSelectedToken]);
    const minOut   = amountsOut[1].mul(990).div(1000); // 1% slippage
    const deadline = (await provider.getBlock('latest')).timestamp + 86400;
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
      toast(`Insufficient balance — you have ${fmtNum(have)} ${window._poolTokenSymbol}`, 'error');
      _txDone();
      return;
    }
    const router   = getRouter();
    const amounts  = await router.getAmountsOut(amtIn, [window._poolSelectedToken, DEX_WETH]);
    const minETH   = amounts[1].mul(990).div(1000); // 1% slippage
    const deadline = (await provider.getBlock('latest')).timestamp + 86400;
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
window._poolChartTimeframe = 'all';
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
    const pair        = getPairContract(pairAddr);
    const latestBlock = await provider.getBlockNumber();
    const fromBlock   = getFromBlock(latestBlock);
    const swaps = await pair.queryFilter('Swap', fromBlock, 'latest').catch(() => []);
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
  if (canvas) _drawPriceCanvas(canvas, data, viewMin, viewMax);
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

function _drawPriceCanvas(canvas, data, viewMin, viewMax, hoverIdx) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement.clientWidth || 500;
  const H   = 268;
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

  // Layout: price area only
  const padL   = 70, padR = 14, padT = 18, padB = 34;
  const priceH = H - padT - padB;
  const cW     = W - padL - padR;

  const tMin  = viewMin;
  const tMax  = viewMax;
  const times = data.map(p => p.time);
  const vals  = data.map(p => p.price);

  const vMin = Math.min(...vals);
  const vMax = Math.max(...vals);
  const vPad = (vMax - vMin) * 0.15 || vMax * 0.15 || 0.000001;
  const vLo  = vMin - vPad;
  const vHi  = vMax + vPad;
  const vRng = vHi - vLo;

  const tx = t => padL + ((t - tMin) / (tMax - tMin || 1)) * cW;
  const ty = v => padT + priceH - ((v - vLo) / vRng) * priceH;

  const isUp    = vals[vals.length - 1] >= vals[0];
  const lineClr = isUp ? '#4ade80' : '#f87171';

  window._poolChartState = { data, viewMin, viewMax, padL, padR, padT, padB, W, H, tMin, tMax, vLo, vHi, vRng, cW, cH: priceH };

  // ── Price grid (horizontal) ──
  ctx.font         = '9px monospace';
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
    ctx.fillText(lbl, padL - 5, y);
  }

  // ── Time grid (vertical) + time labels ──
  const span = tMax - tMin;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 5; i++) {
    const t = tMin + (span / 5) * i;
    const x = padL + (i / 5) * cW;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + priceH); ctx.stroke();

    const d = new Date(t);
    let lbl;
    if      (span < 7200e3)   lbl = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    else if (span < 86400e3)  lbl = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    else if (span < 604800e3) lbl = d.toLocaleDateString([], { month:'short', day:'numeric' }) + ' ' + d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    else                      lbl = d.toLocaleDateString([], { month:'short', day:'numeric' });
    ctx.fillStyle = 'rgba(148,163,184,0.38)';
    ctx.fillText(lbl, x, H - padB + 5);
  }

// ── Clip to price area ──
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL - 1, padT - 1, cW + 2, priceH + 2);
  ctx.clip();


  // Price line with glow
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

  // ── Current price tag on y-axis ──
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

  // ── Hover crosshair & dot ──
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
      const dt      = new Date(p.time);
      const timeStr = dt.toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      const sym     = window._poolTokenSymbol || 'TOKEN';
      const sideClr = p.isBuy ? '#4ade80' : '#f87171';
      tooltip.innerHTML =
        `<div style="color:rgba(201,168,76,0.9);margin-bottom:5px;font-size:10px;">${timeStr}</div>` +
        `<div>Price  <b>$${fmtNum(p.price)}</b></div>` +
        `<div>Volume <b>$${p.usdtVol != null ? fmtNum(p.usdtVol) : '—'}</b></div>` +
        `<div>Amount <b>${p.tokenVol != null ? fmtNum(p.tokenVol) : '—'} ${sym}</b></div>` +
        `<div>Side   <b style="color:${sideClr}">${p.isBuy ? 'BUY' : 'SELL'}</b></div>`;

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
