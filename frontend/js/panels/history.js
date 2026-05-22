let _activeHistTab = 'invest';

function switchHistoryTab(name) {
  _activeHistTab = name;
  document.querySelectorAll('.hist-subtab').forEach(b =>
    b.classList.toggle('active', b.id === 'histTab-' + name));
  document.getElementById('histPanel-rewards').style.display = name === 'rewards' ? '' : 'none';
  document.getElementById('histPanel-invest').style.display  = name === 'invest'  ? '' : 'none';
  document.getElementById('histPanel-pool').style.display    = name === 'pool'    ? '' : 'none';
  if (name === 'rewards') loadRewardHistory();
  else if (name === 'invest') loadHistory();
  else                        loadPoolHistory();
}

function _refreshHistoryTab() {
  if (_activeHistTab === 'rewards') loadRewardHistory();
  else if (_activeHistTab === 'invest') loadHistory();
  else                                  loadPoolHistory();
}

async function loadHistory() {
  if (!requireConnected()) return;
  _tabLoaded.add('history');
  const el = document.getElementById('historyList');
  el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  try {
    const latestBlock = await provider.getBlockNumber();
    const fromBlock   = getFromBlock(latestBlock);
    const filter = contract.filters.Invested(walletAddress);
    const events = await contract.queryFilter(filter, fromBlock, 'latest');
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

  let tokenSymbol = tokenAddr;
  try { tokenSymbol = (await contract.getToken(tokenAddr)).symbol; } catch(_) {}

  const block = await provider.getBlock(blockNum);
  const date  = new Date(block.timestamp * 1000).toLocaleString();

  const ethRaw  = parseFloat(ethers.utils.formatEther(ethAmount));
  const ethFmt  = fmtNum(ethRaw * USDT_PER_ETH);
  const lpFmt   = fmtNum(parseFloat(ethers.utils.formatEther(lpTokens)));

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

  // Collapse any other open item
  document.querySelectorAll('#historyList .history-detail.open').forEach(other => {
    other.classList.remove('open');
    const otherChevron = other.closest('.history-item')?.querySelector('.history-chevron');
    if (otherChevron) otherChevron.style.transform = '';
  });

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

  const fE = bn => bn ? fmtNum(parseFloat(ethers.utils.formatEther(bn))) : '—';
  const fU  = bn => bn ? fmtNum(parseFloat(ethers.utils.formatEther(bn)) * USDT_PER_ETH) + ' USDT' : '—';
  const fU3 = bn => bn ? fmtNum(parseFloat(ethers.utils.formatEther(bn)) * USDT_PER_ETH) + ' USDT' : '—';
  const fT = bn => {
    if (!bn) return '—';
    const n = parseFloat(ethers.utils.formatUnits(bn, tokenDecimals));
    return fmtNum(n);
  };
  const fPrice = res => {
    if (!res || res.eth.isZero()) return '—';
    const p = (parseFloat(ethers.utils.formatEther(res.eth)) * USDT_PER_ETH)
            / parseFloat(ethers.utils.formatUnits(res.token, tokenDecimals));
    return fmtNum(p) + ' USDT/' + tokenSymbol;
  };

  let effectiveSwapPrice = '—';
  if (swapTokensOut && !A60.isZero()) {
    const p = (parseFloat(ethers.utils.formatEther(A60)) * USDT_PER_ETH)
            / parseFloat(ethers.utils.formatUnits(swapTokensOut, tokenDecimals));
    effectiveSwapPrice = fmtNum(p) + ' USDT/' + tokenSymbol;
  }

  const totalTokens = mintToken || null;
  const hdArrow = `<div style="text-align:center;color:rgba(255,255,255,0.15);font-size:9px;line-height:1;margin:0;">▼</div>`;
  const hdCell  = (clr, label, value, sub) => `<div style="border:1px solid rgba(${clr},0.4);border-radius:6px;background:rgba(${clr},0.04);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px 10px;text-align:center;"><div style="font-size:8px;color:rgba(${clr},0.7);letter-spacing:1.4px;margin-bottom:7px;">${label}</div><div style="font-family:var(--font-display);font-size:18px;letter-spacing:1px;line-height:1.1;">${value}</div>${sub ? `<div style="font-size:9px;color:var(--muted);margin-top:6px;font-family:var(--font-mono);">${sub}</div>` : ''}</div>`;
  const refSplitId = 'hdRef_' + txHash.slice(2, 10);

  return `<div class="hd-body">

    <div class="hd-section">
      <div class="hd-section-title">INVESTMENT FLOW</div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        ${hdCell('201,168,76', 'INVESTED AMOUNT', `<span style="color:var(--gold);">${fU(ethAmount)}</span>`, null)}
        ${hdArrow}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          ${hdCell('96,165,250', 'TOKEN ACQUISITION', `<span style="color:var(--cream);">${mintToken ? fT(mintToken) : (swapTokensOut ? fT(swapTokensOut) : '—')} ${tokenSymbol}</span>`, 'swap + platform supply')}
          ${hdCell('96,165,250', 'USDT PAIRING', `<span style="color:var(--cream);">${fU(B)}</span>`, '50% of investment')}
        </div>
        ${hdArrow}
        <div style="border:1px solid rgba(236,72,153,0.4);border-radius:6px;background:rgba(236,72,153,0.04);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px 10px;text-align:center;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:7px;">
            <span style="width:6px;height:6px;border-radius:50%;background:#ec4899;box-shadow:0 0 6px rgba(236,72,153,0.8);flex-shrink:0;display:inline-block;"></span>
            <span style="font-size:8px;color:rgba(236,72,153,0.8);letter-spacing:1.4px;">UNISWAP V2 POOL</span>
          </div>
          <div style="font-family:var(--font-display);font-size:18px;letter-spacing:1px;color:#f472b6;line-height:1.1;">${fE(lpTokens)} LP</div>
          <div style="font-size:9px;color:var(--muted);margin-top:6px;font-family:var(--font-mono);">actual LP tokens minted</div>
        </div>
      </div>
    </div>

    <div class="hd-section">
      <div class="hd-section-title">TOKEN ACQUISITION</div>
      <div class="hd-grid2">
        <div class="hd-kv">
          <div class="hd-key">POOL BUY</div>
          <div class="hd-val">${fT(swapTokensOut)} ${tokenSymbol}</div>
          <div class="hd-sub">${effectiveSwapPrice}</div>
        </div>
        <div class="hd-kv">
          <div class="hd-key">PLATFORM SUPPLY</div>
          <div class="hd-val">${preSeededTokens.gt(0) ? fT(preSeededTokens) : '—'} ${tokenSymbol}</div>
          <div class="hd-sub">${fPrice(resBefore)}</div>
        </div>
      </div>
    </div>

    <div class="hd-tx-row" style="flex-wrap:wrap;gap:8px;">
      <span style="color:var(--muted);font-size:10px;letter-spacing:.06em;flex-shrink:0;">TX</span>
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--cream);word-break:break-all;flex:1;">${txHash}</span>
      <button onclick="openHistRefSplitPopup('${refSplitId}')" style="flex-shrink:0;padding:5px 12px;background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.3);border-radius:4px;color:var(--gold);font-family:var(--font-mono);font-size:10px;letter-spacing:1.2px;cursor:pointer;">REFERRAL SPLIT ›</button>
    </div>

    <div id="${refSplitId}_pop" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(4,8,15,0.82);backdrop-filter:blur(12px);align-items:center;justify-content:center;pointer-events:all;" onclick="if(event.target===this)closeHistRefSplitPopup('${refSplitId}')">
      <div class="hd-ref-popup-body" style="background:var(--panel);border:1px solid rgba(201,168,76,0.3);border-radius:12px;max-width:680px;width:94%;padding:22px;">
        <div style="font-family:var(--font-display);font-size:18px;letter-spacing:2px;color:var(--gold);margin-bottom:4px;">REFERRAL SPLIT</div>
        <div style="font-size:11px;color:var(--muted);font-family:var(--font-mono);margin-bottom:18px;">Commissions split across eligible levels &nbsp;·&nbsp; ${fU3(A40)}</div>
        <div class="hd-ref-list" style="max-height:55vh;overflow-y:auto;margin-bottom:16px;">
          ${refEvents.length === 0
            ? `<div style="color:var(--muted);font-size:11px;font-family:var(--font-mono);padding:8px 0;">No commission events found in this transaction.</div>`
            : refEvents.map(ev => {
                const short = ev.recipient;
                const poolFloat = parseFloat(ethers.utils.formatEther(A40));
                const amtFloat  = parseFloat(ethers.utils.formatEther(ev.amount));
                const pctOfPool = poolFloat > 0 ? amtFloat / poolFloat * 100 : 0;
                const rateLabel = pctOfPool > 0
                  ? pctOfPool.toFixed(pctOfPool >= 1 ? 1 : 2).replace(/\.?0+$/, '') + '% of pool'
                  : '';
                const addrDisplay = ev.isPlatform
                  ? `<span class="addr-text" style="color:var(--gold);" title="${ev.recipient}">${ev.recipient}</span>`
                  : `<span class="addr-text" title="${ev.recipient}">${ev.recipient}</span>`;
                return `<div class="hd-ref-row">
                  <div class="hd-ref-lvl">L${ev.level}<br><span style="font-size:8px;color:var(--muted);white-space:nowrap;">${rateLabel}</span></div>
                  <div class="hd-ref-addr">${addrDisplay}<button class="hd-copy-btn" onclick="navigator.clipboard.writeText('${ev.recipient}')" title="Copy address">⧉</button></div>
                  <div class="hd-ref-badge paid">✓ PAID</div>
                  <div class="hd-ref-amt">${fU3(ev.amount)}</div>
                </div>`;
              }).join('')
          }
        </div>
        <button onclick="closeHistRefSplitPopup('${refSplitId}')" style="width:100%;padding:12px;font-family:var(--font-mono);font-size:12px;letter-spacing:1px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer;">CLOSE</button>
      </div>
    </div>

  </div>`;
}

async function loadPoolHistory() {
  if (!requireConnected()) return;
  const el = document.getElementById('poolHistoryList');
  el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';

  try {
    const latestBlock = await provider.getBlockNumber();
    const fromBlock   = getFromBlock(latestBlock);

    const [claimedEvs, removedEvs] = await Promise.all([
      contract.queryFilter(contract.filters.LPClaimed(walletAddress), fromBlock, 'latest'),
      contract.queryFilter(contract.filters.LPRemoved(walletAddress), fromBlock, 'latest'),
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
        fromBlock,
        toBlock: 'latest',
      });
      if (!logs.length) continue;

      const pairCt = new ethers.Contract(pairAddr, pairAbi, provider);
      const tok0   = (await pairCt.token0()).toLowerCase();
      const tokenIsToken0 = tok0 === tokenAddr.toLowerCase();

      let tokenSymbol = tokenAddr;
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
        ethReturned: ev.args.ethReturned, lpAmount: ev.args.lpAmount,
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
        catch(_) { e.tokenSymbol = e.tokenAddr; }
      }
    }

    el.innerHTML = all.map(e => {
      const date = blockMap[e.blockNumber] || '';
      const tx   = e.txHash.slice(0,10) + '…';
      const fE   = bn => fmtNum(parseFloat(ethers.utils.formatEther(bn)));
      const fT   = (bn, dec) => fmtNum(parseFloat(ethers.utils.formatUnits(bn, dec || 18)));
      const fEU = bn => fmtNum(parseFloat(ethers.utils.formatEther(bn)) * USDT_PER_ETH) + ' USDT';
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
          <div class="ph-main"><div class="ph-title">${fmtNum(parseFloat(ethers.utils.formatEther(e.lpAmount)))} LP — ${e.tokenSymbol}</div><div class="ph-sub">LP tokens transferred to your wallet (lock expired)</div></div>
          <div class="ph-meta"><div class="ph-date">${date}</div><div class="ph-tx">${tx}</div></div>
        </div>`;
      if (e.type === 'remove') return `
        <div class="ph-row">
          <div class="ph-badge remove">LP REMOVE</div>
          <div class="ph-main"><div class="ph-title">${fmtNum(parseFloat(ethers.utils.formatEther(e.lpAmount)))} LP removed — ${e.tokenSymbol}</div><div class="ph-sub">Received ${fEU(e.ethReturned)} + tokens back from pool</div></div>
          <div class="ph-meta"><div class="ph-date">${date}</div><div class="ph-tx">${tx}</div></div>
        </div>`;
      return '';
    }).join('');

  } catch(e) {
    el.innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
  }
}

async function loadRewardHistory() {
  if (!requireConnected()) return;
  _tabLoaded.add('history');
  const el = document.getElementById('rewardHistoryList');
  el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';

  try {
    const latestBlock = await provider.getBlockNumber();
    const fromBlock   = getFromBlock(latestBlock);
    const events = await contract.queryFilter(contract.filters.StakingRewardClaimed(walletAddress), fromBlock, 'latest');

    if (!events.length) {
      el.innerHTML = '<div class="empty-state">No reward claims found.</div>';
      return;
    }

    const sorted = [...events].sort((a, b) => b.blockNumber - a.blockNumber);

    // Fetch block timestamps in parallel
    const blockNums = [...new Set(sorted.map(e => e.blockNumber))];
    const blockMap  = {};
    await Promise.all(blockNums.map(async n => {
      const b = await provider.getBlock(n);
      blockMap[n] = b.timestamp;
    }));

    // Fetch all user locks for position details
    let locks = [];
    try { locks = await contract.getUserLPLocks(walletAddress); } catch(_) {}

    // Build token symbol cache
    const symCache = {};
    for (const lock of locks) {
      if (!symCache[lock.token]) {
        try { symCache[lock.token] = (await contract.getToken(lock.token)).symbol; }
        catch(_) { symCache[lock.token] = lock.token; }
      }
    }

    // Platform token symbol (for the reward token itself)
    let platformSym = 'TOKEN';
    try {
      const erc20 = new ethers.Contract(TOKEN_ADDRESS, ['function symbol() view returns (string)'], provider);
      platformSym = await erc20.symbol();
    } catch(_) {}

    // Function selectors used to detect which lock triggered the claim
    const SEL_CLAIM_ALL  = ethers.utils.id('claimStakingReward()').slice(0, 10);
    const SEL_CLAIM_LOCK = ethers.utils.id('claimStakingRewardForLock(uint256)').slice(0, 10);
    const SEL_REMOVE_LP  = ethers.utils.id('removeLP(uint256)').slice(0, 10);
    const SEL_REMOVE_DIR = ethers.utils.id('removeLPDirect(uint256)').slice(0, 10);

    // Fetch tx input data for each unique tx hash
    const txDataMap = {};
    await Promise.all([...new Set(sorted.map(e => e.transactionHash))].map(async hash => {
      try {
        const tx = await provider.getTransaction(hash);
        txDataMap[hash] = tx ? tx.data : null;
      } catch(_) { txDataMap[hash] = null; }
    }));

    const fEth = bn => parseFloat(ethers.utils.formatEther(bn));

    el.innerHTML = sorted.map(ev => {
      const ts      = blockMap[ev.blockNumber];
      const date    = ts ? new Date(ts * 1000).toLocaleString() : '';
      const tokens  = fEth(ev.args.tokensAmount);
      const ethEq   = fEth(ev.args.ethEquivalent);
      const usdtVal = fmtNum(ethEq * USDT_PER_ETH);
      const tokensFmt = fmtNum(tokens);
      const txHash  = ev.transactionHash;
      const txShort = txHash.slice(0, 10) + '…';

      // Decode which lock was involved from the triggering function
      const data = txDataMap[txHash];
      let claimLabel = 'All locks';
      let positionDetail = '';

      if (data && data.length >= 10) {
        const sel = data.slice(0, 10);
        let lockIdx = null;
        let trigger = '';

        if (sel === SEL_CLAIM_LOCK) {
          try { [lockIdx] = ethers.utils.defaultAbiCoder.decode(['uint256'], '0x' + data.slice(10)); }
          catch(_) {}
          trigger = '';
        } else if (sel === SEL_REMOVE_LP) {
          try { [lockIdx] = ethers.utils.defaultAbiCoder.decode(['uint256'], '0x' + data.slice(10)); }
          catch(_) {}
          trigger = ' · settled on LP removal';
        } else if (sel === SEL_REMOVE_DIR) {
          try { [lockIdx] = ethers.utils.defaultAbiCoder.decode(['uint256'], '0x' + data.slice(10)); }
          catch(_) {}
          trigger = ' · settled on direct removal';
        }
        // SEL_CLAIM_ALL falls through with lockIdx = null → "All locks"

        if (lockIdx !== null) {
          const idx = lockIdx.toNumber();
          claimLabel = 'Lock #' + idx + trigger;
          const lock = locks[idx];
          if (lock) {
            const sym     = symCache[lock.token] || lock.token;
            const invested = fmtNum(fEth(lock.ethInvested) * USDT_PER_ETH);
            const lp      = fmtNum(fEth(lock.lpAmount));
            positionDetail = `${sym} position · $${invested} invested · ${lp} LP`;
          }
        }
      }

      return `
        <div class="ph-row">
          <div class="ph-badge reward-claim">REWARD</div>
          <div class="ph-main">
            <div class="ph-title">${tokensFmt} ${platformSym} &nbsp;·&nbsp; $${usdtVal} USDT equivalent</div>
            <div class="ph-sub">${claimLabel}${positionDetail ? ' — ' + positionDetail : ''}</div>
          </div>
          <div class="ph-meta">
            <div class="ph-date">${date}</div>
            <div class="ph-tx">${txShort}</div>
          </div>
        </div>`;
    }).join('');

  } catch(e) {
    el.innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
  }
}

function openHistRefSplitPopup(id) {
  const el = document.getElementById(id + '_pop');
  if (!el) return;
  document.body.appendChild(el);
  el.style.display = 'flex';
  document.body.style.overflow      = 'hidden';
  document.body.style.pointerEvents = 'none';
  document.body.classList.add('modal-open');
}

function closeHistRefSplitPopup(id) {
  const el = document.getElementById(id + '_pop');
  if (!el) return;
  el.style.display = 'none';
  document.body.style.overflow      = '';
  document.body.style.pointerEvents = '';
  document.body.classList.remove('modal-open');
}

window.switchHistoryTab        = switchHistoryTab;
window._refreshHistoryTab      = _refreshHistoryTab;
window.loadHistory             = loadHistory;
window.toggleHistoryDetail     = toggleHistoryDetail;
window.openHistRefSplitPopup   = openHistRefSplitPopup;
window.closeHistRefSplitPopup  = closeHistRefSplitPopup;
window.loadPoolHistory         = loadPoolHistory;
window.loadRewardHistory       = loadRewardHistory;
