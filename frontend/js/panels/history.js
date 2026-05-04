let _activeHistTab = 'invest';

function switchHistoryTab(name) {
  _activeHistTab = name;
  document.querySelectorAll('.hist-subtab').forEach(b =>
    b.classList.toggle('active', b.id === 'histTab-' + name));
  document.getElementById('histPanel-invest').style.display = name === 'invest' ? '' : 'none';
  document.getElementById('histPanel-pool').style.display   = name === 'pool'   ? '' : 'none';
  if (name === 'invest') loadHistory();
  else                   loadPoolHistory();
}

function _refreshHistoryTab() {
  if (_activeHistTab === 'invest') loadHistory();
  else                             loadPoolHistory();
}

async function loadHistory() {
  if (!requireConnected()) return;
  _tabLoaded.add('history');
  const el = document.getElementById('historyList');
  el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  try {
    const filter = contract.filters.Invested(walletAddress);
    const events = await contract.queryFilter(filter);
    if (events.length === 0) {
      el.innerHTML = '<div class="empty-state">No investments found.</div>';
      return;
    }
    el.innerHTML = '';
    for (const ev of [...events].reverse()) {
      el.appendChild(await _buildHistoryItem(ev));
    }
  } catch(e) {
    el.innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
  }
}

async function _buildHistoryItem(ev) {
  const tokenAddr = ev.args.token;
  const ethAmount = ev.args.ethAmount;
  const lpTokens  = ev.args.lpTokens;
  const blockNum  = ev.blockNumber;
  const txHash    = ev.transactionHash;

  let tokenSymbol = tokenAddr.slice(0,6) + '…';
  try { tokenSymbol = (await contract.getToken(tokenAddr)).symbol; } catch(_) {}

  const block = await provider.getBlock(blockNum);
  const date  = new Date(block.timestamp * 1000).toLocaleString();

  const ethRaw  = parseFloat(ethers.utils.formatEther(ethAmount));
  const ethFmt  = (ethRaw * USDT_PER_ETH).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const lpFmt   = parseFloat(ethers.utils.formatEther(lpTokens)).toFixed(6);

  const div = document.createElement('div');
  div.className = 'history-item';
  div.innerHTML = `
    <div class="history-summary" onclick="toggleHistoryDetail(this)">
      <div style="display:flex;align-items:center;gap:14px;flex:1;min-width:0;">
        <div style="width:36px;height:36px;border-radius:50%;background:rgba(201,168,76,0.1);display:flex;align-items:center;justify-content:center;color:var(--gold);font-size:18px;flex-shrink:0;">⊕</div>
        <div style="min-width:0;">
          <div style="font-size:13px;color:var(--cream);font-weight:500;">${ethFmt} USDT → ${tokenSymbol}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px;">${date}</div>
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0;margin-right:12px;">
        <div style="font-size:12px;color:var(--gold);">${lpFmt} LP</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px;font-family:var(--font-mono);">${txHash.slice(0,10)}…</div>
      </div>
      <div class="history-chevron">›</div>
    </div>
    <div class="history-detail"
      data-txhash="${txHash}"
      data-block="${blockNum}"
      data-token="${tokenAddr}"
      data-eth="${ethAmount.toString()}"
      data-lp="${lpTokens.toString()}">
      <div class="hd-body" style="padding:16px;color:var(--muted);font-size:12px;text-align:center;">
        Loading details…
      </div>
    </div>`;
  return div;
}

async function toggleHistoryDetail(summaryEl) {
  const item    = summaryEl.parentElement;
  const detail  = item.querySelector('.history-detail');
  const chevron = item.querySelector('.history-chevron');

  if (detail.classList.contains('open')) {
    detail.classList.remove('open');
    chevron.style.transform = '';
    return;
  }
  detail.classList.add('open');
  chevron.style.transform = 'rotate(90deg)';
  if (detail.dataset.loaded) return;
  detail.dataset.loaded = '1';

  try {
    detail.innerHTML = await _buildHistoryDetail(
      detail.dataset.txhash,
      parseInt(detail.dataset.block),
      detail.dataset.token,
      ethers.BigNumber.from(detail.dataset.eth),
      ethers.BigNumber.from(detail.dataset.lp)
    );
  } catch(e) {
    detail.innerHTML = `<div style="padding:14px;color:var(--danger);font-size:12px;">Failed to load details: ${e.message}</div>`;
  }
}

async function _buildHistoryDetail(txHash, blockNum, tokenAddr, ethAmount, lpTokens) {
  const halfETH = ethAmount.div(2);
  const A60     = halfETH.mul(60).div(100);
  const A40     = halfETH.sub(A60);
  const B       = ethAmount.sub(halfETH);

  let tokenSymbol = 'TOKEN', tokenDecimals = 18;
  try {
    const t = await contract.getToken(tokenAddr);
    tokenSymbol = t.symbol;
    const erc20 = new ethers.Contract(tokenAddr, ['function decimals() view returns (uint8)'], provider);
    tokenDecimals = Number(await erc20.decimals());
  } catch(_) {}

  const factoryAbi = ['function getPair(address,address) view returns (address)'];
  const factoryCt  = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, provider);
  const pairAddr   = await factoryCt.getPair(tokenAddr, WETH_ADDRESS);
  if (!pairAddr || pairAddr === ethers.constants.AddressZero)
    return '<div style="padding:14px;color:var(--muted);font-size:12px;">Pool address not found.</div>';

  const pairAbi = [
    'function getReserves() view returns (uint112,uint112,uint32)',
    'function token0() view returns (address)',
  ];
  const pairCt = new ethers.Contract(pairAddr, pairAbi, provider);

  const tok0Lower      = (await pairCt.token0()).toLowerCase();
  const tokenIsToken0  = tok0Lower === tokenAddr.toLowerCase();
  const toRes = ([r0, r1]) => tokenIsToken0
    ? { token: ethers.BigNumber.from(r0), eth: ethers.BigNumber.from(r1) }
    : { token: ethers.BigNumber.from(r1), eth: ethers.BigNumber.from(r0) };

  let resBefore = null, resAfter = null;
  try { resBefore = toRes(await pairCt.getReserves({ blockTag: blockNum - 1 })); } catch(_) {}
  try { resAfter  = toRes(await pairCt.getReserves({ blockTag: blockNum }));      } catch(_) {}

  const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
  const MINT_TOPIC = '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f';

  const receipt = await provider.getTransactionReceipt(txHash);
  let swapTokensOut = null, mintToken = null, mintETH = null;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pairAddr.toLowerCase()) continue;
    if (log.topics[0] === SWAP_TOPIC) {
      const [a0in, a1in, a0out, a1out] = ethers.utils.defaultAbiCoder.decode(
        ['uint256','uint256','uint256','uint256'], log.data);
      swapTokensOut = tokenIsToken0 ? a0out : a1out;
    }
    if (log.topics[0] === MINT_TOPIC) {
      const [a0, a1] = ethers.utils.defaultAbiCoder.decode(['uint256','uint256'], log.data);
      mintToken = tokenIsToken0 ? a0 : a1;
      mintETH   = tokenIsToken0 ? a1 : a0;
    }
  }

  const PAID_TOPIC = ethers.utils.id('CommissionPaid(address,address,uint256,uint256)');

  let ownerAddr = '';
  try { ownerAddr = (await contract.owner()).toLowerCase(); } catch(_) {}

  const refEvents = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) continue;
    if (log.topics[0] !== PAID_TOPIC) continue;
    const recipient = ethers.utils.defaultAbiCoder.decode(['address'], log.topics[1])[0];
    const [amount, level] = ethers.utils.defaultAbiCoder.decode(['uint256','uint256'], log.data);
    refEvents.push({ recipient, amount, level: Number(level), isPlatform: recipient.toLowerCase() === ownerAddr });
  }
  refEvents.sort((a, b) => a.level - b.level);

  // Pre-seeded tokens used = total deposited to pool minus what the swap produced.
  // The contract passes its entire token balance (swap tokens + owner-seeded supply) to addLiquidityETH.
  const preSeededTokens = (mintToken && swapTokensOut && mintToken.gt(swapTokensOut))
    ? mintToken.sub(swapTokensOut)
    : ethers.BigNumber.from(0);

  let resMid = null;
  if (resBefore && swapTokensOut)
    resMid = { eth: resBefore.eth.add(A60), token: resBefore.token.sub(swapTokensOut) };

  const fE = bn => bn ? parseFloat(ethers.utils.formatEther(bn)).toFixed(6) : '—';
  const fU = bn => bn ? (parseFloat(ethers.utils.formatEther(bn)) * USDT_PER_ETH).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDT' : '—';
  const fT = bn => {
    if (!bn) return '—';
    const n = parseFloat(ethers.utils.formatUnits(bn, tokenDecimals));
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  };
  const fPrice = res => {
    if (!res || res.eth.isZero()) return '—';
    const p = (parseFloat(ethers.utils.formatEther(res.eth)) * USDT_PER_ETH)
            / parseFloat(ethers.utils.formatUnits(res.token, tokenDecimals));
    return p.toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' USDT/' + tokenSymbol;
  };

  let effectiveSwapPrice = '—';
  if (swapTokensOut && !A60.isZero()) {
    const p = (parseFloat(ethers.utils.formatEther(A60)) * USDT_PER_ETH)
            / parseFloat(ethers.utils.formatUnits(swapTokensOut, tokenDecimals));
    effectiveSwapPrice = p.toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' USDT/' + tokenSymbol;
  }

  const totalTokens = mintToken || null;

  return `<div class="hd-body">

    <div class="hd-section">
      <div class="hd-section-title">INVESTMENT SPLIT</div>
      <div class="hd-tree">
        <div class="hd-row hd-root"><span class="hd-label">Total Investment</span><span class="hd-value">${fU(ethAmount)}</span></div>
        <div class="hd-row hd-branch"><span class="hd-label">├─ Token-side (A)</span><span class="hd-value">${fU(halfETH)} <span class="hd-pct">50%</span></span></div>
        <div class="hd-row hd-leaf"><span class="hd-label">│&nbsp;&nbsp;&nbsp;├─ Pool Buy via Uniswap (A60)</span><span class="hd-value">${fU(A60)} <span class="hd-pct">30% of T</span></span></div>
        <div class="hd-row hd-leaf"><span class="hd-label">│&nbsp;&nbsp;&nbsp;└─ Referral Commissions (A40)</span><span class="hd-value">${fU(A40)} <span class="hd-pct">20% of T</span></span></div>
        <div class="hd-row hd-branch"><span class="hd-label">└─ Liquidity USDT (B) → addLiquidityETH</span><span class="hd-value">${fU(B)} <span class="hd-pct">50%</span></span></div>
      </div>
    </div>

    <div class="hd-section">
      <div class="hd-section-title">TOKEN ACQUISITION</div>
      <div class="hd-grid2">
        <div class="hd-kv">
          <div class="hd-key">POOL BUY — Uniswap V2 (A60, 30% of T)</div>
          <div class="hd-val">${fT(swapTokensOut)} ${tokenSymbol}</div>
          <div class="hd-sub">Swapped ${fU(A60)} (incl. 0.3% Uniswap fee)</div>
          <div class="hd-sub">Effective price: ${effectiveSwapPrice}</div>
        </div>
        <div class="hd-kv">
          <div class="hd-key">PLATFORM SUPPLY — Contract pre-seeded balance</div>
          <div class="hd-val">${preSeededTokens.gt(0) ? fT(preSeededTokens) : '—'} ${tokenSymbol}</div>
          <div class="hd-sub">Owner-seeded tokens in contract used to pair with B ETH</div>
          <div class="hd-sub">Pre-swap spot price: ${fPrice(resBefore)}</div>
        </div>
      </div>
      ${totalTokens ? `<div class="hd-total-row"><span>Total tokens deposited to pool</span><span>${fT(totalTokens)} ${tokenSymbol}</span></div>` : ''}
    </div>

    <div class="hd-section">
      <div class="hd-section-title">POOL STATE (${tokenSymbol} / USDT)</div>
      <div class="hd-pool-table">
        <div class="hd-pt-head"><div></div><div>BEFORE INVEST</div><div>AFTER SWAP (60%)</div><div>AFTER ADD LIQUIDITY</div></div>
        <div class="hd-pt-row"><div class="hd-pt-label">USDT</div><div>${resBefore ? fU(resBefore.eth) : '—'}</div><div>${resMid ? fU(resMid.eth) : '—'}</div><div>${resAfter ? fU(resAfter.eth) : '—'}</div></div>
        <div class="hd-pt-row"><div class="hd-pt-label">${tokenSymbol}</div><div>${resBefore ? fT(resBefore.token) : '—'}</div><div>${resMid ? fT(resMid.token) : '—'}</div><div>${resAfter ? fT(resAfter.token) : '—'}</div></div>
        <div class="hd-pt-row hd-pt-price"><div class="hd-pt-label">PRICE</div><div>${fPrice(resBefore)}</div><div>${fPrice(resMid)}</div><div>${fPrice(resAfter)}</div></div>
      </div>
    </div>

    <div class="hd-section">
      <div class="hd-section-title">LIQUIDITY ADDED TO POOL</div>
      <div class="hd-grid2">
        <div class="hd-kv"><div class="hd-key">USDT DEPOSITED</div><div class="hd-val">${fU(mintETH)}</div><div class="hd-sub">B half of investment</div></div>
        <div class="hd-kv"><div class="hd-key">${tokenSymbol} DEPOSITED</div><div class="hd-val">${fT(mintToken)} ${tokenSymbol}</div><div class="hd-sub">A60 swap tokens + contract pre-seeded supply (any surplus stays in contract)</div></div>
        <div class="hd-kv"><div class="hd-key">LP TOKENS RECEIVED</div><div class="hd-val">${fE(lpTokens)} LP</div><div class="hd-sub">Locked in contract until unlock period ends</div></div>
      </div>
    </div>

    <div class="hd-section">
      <div class="hd-section-title">REFERRAL COMMISSION SPLIT</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:11px;font-family:var(--font-mono);">
        <span style="color:var(--muted);">Referral commissions (A40 — 20% of total investment)</span>
        <span style="color:var(--cream);">${fU(A40)}</span>
      </div>
      <div class="hd-ref-list">
        ${refEvents.length === 0
          ? `<div style="color:var(--muted);font-size:11px;font-family:var(--font-mono);padding:8px 0;">No commission events found in this transaction.</div>`
          : refEvents.map(ev => {
              const short = ev.recipient.slice(0,8) + '…' + ev.recipient.slice(-6);
              const poolFloat = parseFloat(ethers.utils.formatEther(A40));
              const amtFloat  = parseFloat(ethers.utils.formatEther(ev.amount));
              const pctOfPool = poolFloat > 0 ? amtFloat / poolFloat * 100 : 0;
              const rateLabel = pctOfPool > 0
                ? pctOfPool.toFixed(pctOfPool >= 1 ? 1 : 2).replace(/\.?0+$/, '') + '% of pool'
                : '';
              const addrDisplay = ev.isPlatform
                ? `<span style="color:var(--gold);font-family:var(--font-mono);" title="${ev.recipient}">${short}</span>`
                : `<span title="${ev.recipient}">${short}</span>`;
              return `<div class="hd-ref-row">
                <div class="hd-ref-lvl">L${ev.level}<br><span style="font-size:8px;">${rateLabel}</span></div>
                <div class="hd-ref-addr">${addrDisplay}</div>
                <div class="hd-ref-badge paid">✓ PAID</div>
                <div class="hd-ref-amt">${fU(ev.amount)}</div>
              </div>`;
            }).join('')
        }
      </div>
    </div>

    <div class="hd-tx-row">
      <span style="color:var(--muted);font-size:10px;letter-spacing:.06em;flex-shrink:0;">TX</span>
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--cream);word-break:break-all;">${txHash}</span>
    </div>

  </div>`;
}

async function loadPoolHistory() {
  if (!requireConnected()) return;
  const el = document.getElementById('poolHistoryList');
  el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';

  try {
    const [claimedEvs, removedEvs] = await Promise.all([
      contract.queryFilter(contract.filters.LPClaimed(walletAddress)),
      contract.queryFilter(contract.filters.LPRemoved(walletAddress)),
    ]);

    const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
    const paddedUser = ethers.utils.hexZeroPad(walletAddress.toLowerCase(), 32);
    const factoryAbi = ['function getPair(address,address) view returns (address)'];
    const factoryCt  = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, provider);
    const pairAbi    = ['function token0() view returns (address)'];

    const tokenAddrs  = await contract.getRegisteredTokens();
    const swapEntries = [];

    for (const tokenAddr of tokenAddrs) {
      const pairAddr = await factoryCt.getPair(tokenAddr, WETH_ADDRESS);
      if (!pairAddr || pairAddr === ethers.constants.AddressZero) continue;

      const logs = await provider.getLogs({
        address: pairAddr,
        topics:  [SWAP_TOPIC, null, paddedUser],
        fromBlock: 0,
        toBlock: 'latest',
      });
      if (!logs.length) continue;

      const pairCt = new ethers.Contract(pairAddr, pairAbi, provider);
      const tok0   = (await pairCt.token0()).toLowerCase();
      const tokenIsToken0 = tok0 === tokenAddr.toLowerCase();

      let tokenSymbol = tokenAddr.slice(0,6) + '…';
      let tokenDecimals = 18;
      try {
        const t = await contract.getToken(tokenAddr);
        tokenSymbol = t.symbol;
        const erc20 = new ethers.Contract(tokenAddr, ['function decimals() view returns (uint8)'], provider);
        tokenDecimals = Number(await erc20.decimals());
      } catch(_) {}

      for (const log of logs) {
        const [a0in, a1in, a0out, a1out] = ethers.utils.defaultAbiCoder.decode(
          ['uint256','uint256','uint256','uint256'], log.data);
        const tokenIn  = tokenIsToken0 ? a0in  : a1in;
        const tokenOut = tokenIsToken0 ? a0out : a1out;
        const ethIn    = tokenIsToken0 ? a1in  : a0in;
        const ethOut   = tokenIsToken0 ? a1out : a0out;
        const isBuy    = ethIn.gt(0) && tokenOut.gt(0);
        swapEntries.push({
          type: isBuy ? 'buy' : 'sell',
          tokenAddr, tokenSymbol, tokenDecimals,
          tokenAmt: isBuy ? tokenOut : tokenIn,
          ethAmt:   isBuy ? ethIn    : ethOut,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
        });
      }
    }

    const all = [
      ...swapEntries,
      ...claimedEvs.map(ev => ({
        type: 'claim', tokenAddr: ev.args.token,
        lpAmount: ev.args.lpAmount, blockNumber: ev.blockNumber, txHash: ev.transactionHash,
      })),
      ...removedEvs.map(ev => ({
        type: 'remove', tokenAddr: ev.args.token,
        ethReceived: ev.args.ethReceived, lpAmount: ev.args.lpAmount,
        blockNumber: ev.blockNumber, txHash: ev.transactionHash,
      })),
    ].sort((a, b) => b.blockNumber - a.blockNumber);

    if (!all.length) {
      el.innerHTML = '<div class="empty-state">No pool activity found.</div>';
      return;
    }

    const blockNums = [...new Set(all.map(e => e.blockNumber))];
    const blockMap  = {};
    await Promise.all(blockNums.map(async n => {
      const b = await provider.getBlock(n);
      blockMap[n] = new Date(b.timestamp * 1000).toLocaleString();
    }));

    for (const e of all) {
      if (!e.tokenSymbol) {
        try { e.tokenSymbol = (await contract.getToken(e.tokenAddr)).symbol; }
        catch(_) { e.tokenSymbol = e.tokenAddr.slice(0,6) + '…'; }
      }
    }

    el.innerHTML = all.map(e => {
      const date = blockMap[e.blockNumber] || '';
      const tx   = e.txHash.slice(0,10) + '…';
      const fE   = bn => parseFloat(ethers.utils.formatEther(bn)).toFixed(6);
      const fT   = (bn, dec) => parseFloat(ethers.utils.formatUnits(bn, dec || 18))
                                  .toLocaleString(undefined, { maximumFractionDigits: 4 });

      const fEU = bn => (parseFloat(ethers.utils.formatEther(bn)) * USDT_PER_ETH).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDT';
      if (e.type === 'buy') return `
        <div class="ph-row">
          <div class="ph-badge buy">BUY</div>
          <div class="ph-main"><div class="ph-title">${fEU(e.ethAmt)} → ${fT(e.tokenAmt, e.tokenDecimals)} ${e.tokenSymbol}</div><div class="ph-sub">Uniswap swap — USDT in, ${e.tokenSymbol} out</div></div>
          <div class="ph-meta"><div class="ph-date">${date}</div><div class="ph-tx">${tx}</div></div>
        </div>`;
      if (e.type === 'sell') return `
        <div class="ph-row">
          <div class="ph-badge sell">SELL</div>
          <div class="ph-main"><div class="ph-title">${fT(e.tokenAmt, e.tokenDecimals)} ${e.tokenSymbol} → ${fEU(e.ethAmt)}</div><div class="ph-sub">Uniswap swap — ${e.tokenSymbol} in, USDT out</div></div>
          <div class="ph-meta"><div class="ph-date">${date}</div><div class="ph-tx">${tx}</div></div>
        </div>`;
      if (e.type === 'claim') return `
        <div class="ph-row">
          <div class="ph-badge claim">LP CLAIM</div>
          <div class="ph-main"><div class="ph-title">${parseFloat(ethers.utils.formatEther(e.lpAmount)).toFixed(6)} LP — ${e.tokenSymbol}</div><div class="ph-sub">LP tokens transferred to your wallet (lock expired)</div></div>
          <div class="ph-meta"><div class="ph-date">${date}</div><div class="ph-tx">${tx}</div></div>
        </div>`;
      if (e.type === 'remove') return `
        <div class="ph-row">
          <div class="ph-badge remove">LP REMOVE</div>
          <div class="ph-main"><div class="ph-title">${parseFloat(ethers.utils.formatEther(e.lpAmount)).toFixed(6)} LP removed — ${e.tokenSymbol}</div><div class="ph-sub">Received ${fEU(e.ethReceived)} + tokens back from pool</div></div>
          <div class="ph-meta"><div class="ph-date">${date}</div><div class="ph-tx">${tx}</div></div>
        </div>`;
      return '';
    }).join('');

  } catch(e) {
    el.innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
  }
}

window.switchHistoryTab    = switchHistoryTab;
window._refreshHistoryTab  = _refreshHistoryTab;
window.loadHistory         = loadHistory;
window.toggleHistoryDetail = toggleHistoryDetail;
window.loadPoolHistory     = loadPoolHistory;
