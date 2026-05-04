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

function getRouter()  { return new ethers.Contract(DEX_ROUTER,  ROUTER_ABI,  signer); }
function getFactory() { return new ethers.Contract(DEX_FACTORY, FACTORY_ABI, provider); }
function getPairContract(addr) { return new ethers.Contract(addr, PAIR_ABI, provider); }

async function loadPoolPanel() {
  if (!requireConnected()) return;
  const list = document.getElementById('poolTokenList');
  list.innerHTML = '<div class="empty-state">Loading pools<span class="ld"><span></span><span></span><span></span></span></div>';
  try {
    const addrs = await contract.getRegisteredTokens();
    if (!addrs.length) { list.innerHTML = '<div class="empty-state">No registered tokens yet.</div>'; return; }
    list.innerHTML = '';
    for (const addr of [...addrs].reverse()) {
      const t    = await contract.getToken(addr);
      const meta = getMeta(addr);
      const div  = document.createElement('div');
      div.className = 'token-item';
      div.style.cursor = 'pointer';
      div.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex:1;">
          ${meta.logo
            ? `<img src="${meta.logo}" style="width:36px;height:36px;object-fit:contain;border-radius:8px;border:1px solid var(--border);background:var(--bg);padding:3px;flex-shrink:0;">`
            : `<div style="width:36px;height:36px;border-radius:8px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;">⬡</div>`}
          <div class="token-info">
            <div class="token-symbol">${t.symbol} — ${t.name}</div>
            <div class="token-addr">${t.tokenAddress}</div>
          </div>
        </div>
        <div class="token-badge">VIEW POOL</div>`;
      div.onclick = () => loadPoolInfo(addr);
      list.appendChild(div);
    }
  } catch(e) {
    list.innerHTML = '<div class="empty-state">Failed to load pools.</div>';
    toast('Pool load error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function loadPoolInfo(tokenAddr) {
  if (!requireConnected()) return;
  window._poolSelectedToken = tokenAddr;

  const card = document.getElementById('poolDetailCard');
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('poolStats').innerHTML = '<div style="color:var(--muted);font-size:12px;font-family:var(--font-mono);">Loading pool data…</div>';

  try {
    const t    = await contract.getToken(tokenAddr);
    const meta = getMeta(tokenAddr);

    const iconEl = document.getElementById('poolTokenIcon');
    if (meta.logo) iconEl.innerHTML = `<img src="${meta.logo}" style="width:44px;height:44px;object-fit:contain;border-radius:10px;">`;
    document.getElementById('poolTokenLabel').textContent = `${t.symbol} / USDT`;
    document.getElementById('poolTokenAddr').textContent  = tokenAddr;
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

    const pair = getPairContract(pairAddr);
    const [r0, r1] = await pair.getReserves();
    const token0   = await pair.token0();
    const supply   = await pair.totalSupply();

    const isToken0 = token0.toLowerCase() === tokenAddr.toLowerCase();
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
    const liqUSDT   = ethToUSDT(resETHF * 2);

    const statItems = [
      { label: 'PRICE',           value: priceUSDT.toLocaleString(undefined,{maximumFractionDigits:6}) + ' USDT' },
      { label: 'TOKEN RESERVE',   value: resTokenF.toLocaleString(undefined,{maximumFractionDigits:4}) + ' ' + t.symbol },
      { label: 'USDT RESERVE',    value: (resETHF * USDT_PER_ETH).toLocaleString(undefined,{maximumFractionDigits:2}) + ' USDT' },
      { label: 'TOTAL LIQUIDITY', value: liqUSDT.toLocaleString(undefined,{maximumFractionDigits:2}) + ' USDT' },
      { label: 'LP SUPPLY',       value: supplyF.toFixed(6) + ' HDEX-LP' },
      { label: 'PAIR ADDRESS',    value: pairAddr.slice(0,10) + '…' + pairAddr.slice(-8), full: pairAddr },
    ];

    document.getElementById('poolStats').innerHTML = statItems.map(s => `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px 14px;">
        <div style="font-size:9px;color:var(--muted);font-family:var(--font-mono);letter-spacing:1.5px;margin-bottom:6px;">${s.label}</div>
        <div style="font-size:13px;color:var(--cream);font-family:var(--font-mono);word-break:break-all;" ${s.full ? `title="${s.full}"` : ''}>${s.value}</div>
      </div>`).join('');

    await updateSellBalance(tokenAddr, dec);

  } catch(e) {
    document.getElementById('poolStats').innerHTML = `<div style="color:#ff5050;font-size:12px;font-family:var(--font-mono);">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
    toast('Pool info error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function updateSellBalance(tokenAddr, dec) {
  try {
    const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const bal   = await erc20.balanceOf(walletAddress);
    const balF  = parseFloat(ethers.utils.formatUnits(bal, dec));
    document.getElementById('poolSellBal').textContent = balF.toLocaleString(undefined,{maximumFractionDigits:4});
  } catch(_) {}
}

function switchPoolMode(mode) {
  const isBuy = mode === 'buy';
  document.getElementById('poolBuyForm').style.display  = isBuy  ? 'block' : 'none';
  document.getElementById('poolSellForm').style.display = !isBuy ? 'block' : 'none';
  document.getElementById('poolBuyBtn').style.background  = isBuy  ? 'var(--success,#26d97f)' : 'var(--surface)';
  document.getElementById('poolBuyBtn').style.color       = isBuy  ? '#000' : 'var(--muted)';
  document.getElementById('poolSellBtn').style.background = !isBuy ? 'var(--gold)' : 'var(--surface)';
  document.getElementById('poolSellBtn').style.color      = !isBuy ? '#000' : 'var(--muted)';
}

async function onBuyEthInput() {
  const ethVal = parseFloat(document.getElementById('poolBuyETH').value);
  if (!ethVal || ethVal <= 0 || !window._poolSelectedToken) {
    document.getElementById('poolBuyToken').value = '';
    return;
  }
  try {
    const router  = getRouter();
    const amounts = await router.getAmountsOut(
      ethers.utils.parseEther(ethVal.toString()),
      [DEX_WETH, window._poolSelectedToken]
    );
    const out = parseFloat(ethers.utils.formatUnits(amounts[1], window._poolTokenDecimals));
    document.getElementById('poolBuyToken').value = out.toLocaleString(undefined, {maximumFractionDigits:6, useGrouping:false});
  } catch(_) { document.getElementById('poolBuyToken').value = ''; }
}

async function onBuyTokenInput() {
  const tokVal = parseFloat(document.getElementById('poolBuyToken').value);
  if (!tokVal || tokVal <= 0 || !window._poolSelectedToken) {
    document.getElementById('poolBuyETH').value = '';
    return;
  }
  try {
    const router  = getRouter();
    const amounts = await router.getAmountsIn(
      ethers.utils.parseUnits(tokVal.toString(), window._poolTokenDecimals),
      [DEX_WETH, window._poolSelectedToken]
    );
    const ethNeeded = parseFloat(ethers.utils.formatEther(amounts[0]));
    document.getElementById('poolBuyETH').value = ethNeeded.toLocaleString(undefined, {maximumFractionDigits:6, useGrouping:false});
  } catch(_) { document.getElementById('poolBuyETH').value = ''; }
}

async function onSellTokenInput() {
  const amt = parseFloat(document.getElementById('poolSellAmt').value);
  if (!amt || amt <= 0 || !window._poolSelectedToken) {
    document.getElementById('poolSellETH').value = '';
    return;
  }
  try {
    const router  = getRouter();
    const amounts = await router.getAmountsOut(
      ethers.utils.parseUnits(amt.toString(), window._poolTokenDecimals),
      [window._poolSelectedToken, DEX_WETH]
    );
    const out = parseFloat(ethers.utils.formatEther(amounts[1]));
    document.getElementById('poolSellETH').value = out.toLocaleString(undefined, {maximumFractionDigits:8, useGrouping:false});
  } catch(_) { document.getElementById('poolSellETH').value = ''; }
}

async function onSellEthInput() {
  const ethVal = parseFloat(document.getElementById('poolSellETH').value);
  if (!ethVal || ethVal <= 0 || !window._poolSelectedToken) {
    document.getElementById('poolSellAmt').value = '';
    return;
  }
  try {
    const router  = getRouter();
    const amounts = await router.getAmountsIn(
      ethers.utils.parseEther(ethVal.toString()),
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

async function poolBuyTokens() {
  if (!requireConnected()) return;
  const ethVal  = parseFloat(document.getElementById('poolBuyETH').value);
  const slipPct = parseInt(document.getElementById('poolBuySlip').value);
  if (!ethVal || ethVal <= 0) { toast('Enter an ETH amount', 'warn'); return; }
  if (!window._poolSelectedToken) { toast('Select a token first', 'warn'); return; }
  _txBegin();
  try {
    const router   = getRouter();
    const ethIn    = ethers.utils.parseEther(ethVal.toString());
    const amounts  = await router.getAmountsOut(ethIn, [DEX_WETH, window._poolSelectedToken]);
    const minOut   = amounts[1].mul(1000 - slipPct * 10).div(1000);
    const deadline = Math.floor(Date.now()/1000) + 300;

    toast('Confirm transaction in MetaMask…', 'info');
    const tx = await router.swapExactETHForTokens(
      minOut,
      [DEX_WETH, window._poolSelectedToken],
      walletAddress,
      deadline,
      { value: ethIn }
    );
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    _txDone();
    toast('Buy successful!', 'success');
    document.getElementById('poolBuyETH').value = '';
    document.getElementById('poolBuyToken').value = '';
    loadPoolInfo(window._poolSelectedToken);
  } catch(e) {
    _txDone();
    toast('Buy failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function poolSellTokens() {
  if (!requireConnected()) return;
  const amt     = parseFloat(document.getElementById('poolSellAmt').value);
  const slipPct = parseInt(document.getElementById('poolSellSlip').value);
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

    const router  = getRouter();
    const amounts = await router.getAmountsOut(amtIn, [window._poolSelectedToken, DEX_WETH]);
    const minETH  = amounts[1].mul(1000 - slipPct * 10).div(1000);
    const deadline = Math.floor(Date.now()/1000) + 300;

    const allowance = await erc20.allowance(walletAddress, DEX_ROUTER);
    if (allowance.lt(amtIn)) {
      toast('Approve token spend in MetaMask…', 'info');
      const approveTx = await erc20.approve(DEX_ROUTER, amtIn);
      await approveTx.wait();
    }

    toast('Confirm swap in MetaMask…', 'info');
    const tx = await router.swapExactTokensForETH(
      amtIn, minETH,
      [window._poolSelectedToken, DEX_WETH],
      walletAddress,
      deadline
    );
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    _txDone();
    toast('Sell successful!', 'success');
    document.getElementById('poolSellAmt').value = '';
    document.getElementById('poolSellETH').value = '';
    loadPoolInfo(window._poolSelectedToken);
  } catch(e) {
    _txDone();
    toast('Sell failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

window.loadPoolPanel    = loadPoolPanel;
window.loadPoolInfo     = loadPoolInfo;
window.switchPoolMode   = switchPoolMode;
window.onBuyEthInput    = onBuyEthInput;
window.onBuyTokenInput  = onBuyTokenInput;
window.onSellTokenInput = onSellTokenInput;
window.onSellEthInput   = onSellEthInput;
window.poolSellMax      = poolSellMax;
window.poolBuyTokens    = poolBuyTokens;
window.poolSellTokens   = poolSellTokens;
