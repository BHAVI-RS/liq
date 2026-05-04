// ─── Referral pagination / sort state ────────────────────────────────────────
let _rwRefAllEvents  = [];
let _rwRefBlockTsMap = new Map();
let _rwRefPage       = 1;
let _rwRefPerPage    = 10;
let _rwRefSortKey    = 'ts';
let _rwRefSortDir    = -1;

// ─── Staking live ticker ──────────────────────────────────────────────────────
let _rwStakingInterval = null;
let _rwStakingLocks    = [];
let _rwStakingPrices   = [];   // parallel array: priceEth per lock
let _rwStakingTokenSyms = [];  // parallel array: token symbol per lock
let _rwStakingFirstSym  = 'HORDEX';
let _rwStakingBaseTime = 0;
let _rwStakingWallBase = 0;

function _rwStopTicker() {
  if (_rwStakingInterval) { clearInterval(_rwStakingInterval); _rwStakingInterval = null; }
}

function _rwComputeLiveUsdt(now) {
  let live = 0, pending = 0, totalClaimableTokens = 0;
  let anyActive = false;
  const perLock = [];
  for (let i = 0; i < _rwStakingLocks.length; i++) {
    const lock = _rwStakingLocks[i];
    const ut   = Number(lock.unlockTime);
    const la   = Number(lock.lockedAt) || (ut - 60);
    const dur  = Math.max(ut - la, 60);
    const eth  = parseFloat(ethers.utils.formatEther(lock.ethInvested));
    const rwEth       = eth * 0.30;
    const elapsed     = Math.min(dur, Math.max(0, now - la));
    const isActive    = elapsed < dur && !lock.removed;
    const earnedEth   = dur > 0 ? rwEth * elapsed / dur : 0;
    const claimedEth  = parseFloat(ethers.utils.formatEther(lock.rewardClaimedETH  || ethers.BigNumber.from(0)));
    const tokensAcc   = parseFloat(ethers.utils.formatEther(lock.tokensAccumulated || ethers.BigNumber.from(0)));
    const priceEth    = _rwStakingPrices[i] || 0;
    const pendingEth  = Math.max(0, earnedEth - claimedEth);
    const lockLive    = earnedEth  * USDT_PER_ETH;
    const lockPending = pendingEth * USDT_PER_ETH + tokensAcc * priceEth * USDT_PER_ETH;
    const claimableTokens = (priceEth > 0 ? pendingEth / priceEth : 0) + tokensAcc;
    const claimedPct  = rwEth > 0 ? Math.min(100, claimedEth / rwEth * 100) : 0;
    const pendingPct  = rwEth > 0 ? Math.min(100 - claimedPct, pendingEth / rwEth * 100) : 0;
    const elapsedPct  = dur  > 0 ? (elapsed / dur * 100).toFixed(1) : '0.0';
    if (isActive) anyActive = true;
    live    += lockLive;
    pending += lockPending;
    totalClaimableTokens += claimableTokens;
    perLock.push({ live: lockLive, pending: lockPending, pendingPct, elapsedPct, isActive, claimableTokens });
  }
  return { live, pending, perLock, anyActive, totalClaimableTokens };
}

function _rwStartTicker() {
  _rwStopTicker();
  if (!_rwStakingLocks.length) return;
  _rwStakingInterval = setInterval(() => {
    const accrEl  = document.getElementById('rwStakingAccrued');
    const claimEl = document.getElementById('rwStakingClaimable');
    const liveEl  = document.getElementById('rwStakingLiveLabel');
    if (!accrEl) { _rwStopTicker(); return; }
    const now = _rwStakingBaseTime + (Math.floor(Date.now() / 1000) - _rwStakingWallBase);
    const { live, pending, perLock, anyActive, totalClaimableTokens } = _rwComputeLiveUsdt(now);
    accrEl.textContent  = '$' + live.toFixed(6);
    if (claimEl) claimEl.textContent = '$' + pending.toFixed(6);
    if (liveEl) {
      liveEl.innerHTML = anyActive
        ? '30% of investment · live <span style="color:#4ade80;font-size:9px;">●</span>'
        : 'period complete · <span style="color:var(--gold);">claim to restake</span>';
    }
    const btn = document.getElementById('claimStakingBtn');
    if (btn && btn.textContent !== 'CLAIMING…') {
      const canClaim = totalClaimableTokens > 0.000001;
      btn.textContent = canClaim ? 'CLAIM ALL · ' + totalClaimableTokens.toFixed(4) + ' ' + _rwStakingFirstSym : 'NOTHING TO CLAIM';
      btn.disabled = !canClaim;
      btn.style.background  = canClaim ? 'var(--gold)' : 'rgba(255,255,255,0.06)';
      btn.style.borderColor = canClaim ? 'var(--gold)' : 'var(--border)';
      btn.style.color       = canClaim ? '#0a0a0a'     : 'var(--muted)';
      btn.style.cursor      = canClaim ? 'pointer'     : 'not-allowed';
    }
    for (let i = 0; i < perLock.length; i++) {
      const accrued   = document.getElementById('rwLockAccrued-' + i);
      const bar       = document.getElementById('rwLockBar-' + i);
      const pct       = document.getElementById('rwLockPct-' + i);
      const claimable = document.getElementById('rwLockClaimable-' + i);
      if (accrued) accrued.textContent = '$' + perLock[i].live.toFixed(6) + ' USDT';
      if (bar)     bar.style.width     = perLock[i].pendingPct.toFixed(3) + '%';
      if (pct) {
        pct.textContent = perLock[i].isActive
          ? perLock[i].elapsedPct + '% of period'
          : '100% · period complete';
      }
      if (claimable) {
        const ct  = perLock[i].claimableTokens;
        const sym = _rwStakingTokenSyms[i] || _rwStakingFirstSym;
        claimable.textContent = ct > 0.000001 ? ct.toFixed(4) + ' ' + sym : '—';
        claimable.style.color = ct > 0.000001 ? 'var(--gold)' : 'var(--muted)';
      }
    }
  }, 1000);
}

// ─── Referral history helpers ─────────────────────────────────────────────────

function _rwRefSorted() {
  return [..._rwRefAllEvents].sort((a, b) => {
    let va, vb;
    if (_rwRefSortKey === 'amount') {
      va = parseFloat(ethers.utils.formatEther(a.args.amount));
      vb = parseFloat(ethers.utils.formatEther(b.args.amount));
    } else if (_rwRefSortKey === 'level') {
      va = Number(a.args.level);
      vb = Number(b.args.level);
    } else {
      va = a.blockNumber;
      vb = b.blockNumber;
    }
    return _rwRefSortDir * (vb - va);
  });
}

function _rwRefSI(key) {
  if (_rwRefSortKey !== key) return `<span style="opacity:0.35;font-size:8px;margin-left:2px;">↕</span>`;
  return `<span style="color:var(--gold);font-size:8px;margin-left:2px;">${_rwRefSortDir < 0 ? '↓' : '↑'}</span>`;
}

function _rwRefHistHtml() {
  if (_rwRefAllEvents.length === 0) {
    return '<div class="empty-state" style="margin-top:16px;">No commissions received yet.</div>';
  }

  const sorted = _rwRefSorted();
  const total  = sorted.length;
  const pages  = Math.max(1, Math.ceil(total / _rwRefPerPage));
  const page   = Math.min(_rwRefPage, pages);
  const start  = (page - 1) * _rwRefPerPage;
  const end    = Math.min(start + _rwRefPerPage, total);
  const slice  = sorted.slice(start, end);

  let rows = '';
  for (const ev of slice) {
    const ts      = _rwRefBlockTsMap.get(ev.blockNumber);
    const date    = ts ? _fmtTsFull(ts) : `Block #${ev.blockNumber}`;
    const from    = ev.args.from;
    const amt     = parseFloat(ethers.utils.formatEther(ev.args.amount));
    const level   = Number(ev.args.level);
    const ratePct = ([5000,2500,1000,300,250,225,200,200,175,150][level-1] || 0) / 500;
    const txUrl   = `https://sepolia.etherscan.io/tx/${ev.transactionHash}`;
    rows += `<tr style="border-bottom:1px solid rgba(20,30,42,0.8);">
      <td style="padding:7px 8px;color:var(--muted);white-space:nowrap;">${date}</td>
      <td style="padding:7px 8px;"><a href="https://sepolia.etherscan.io/address/${from}" target="_blank" rel="noopener" style="color:var(--gold);text-decoration:none;">${from.slice(0,6)}…${from.slice(-4)}</a></td>
      <td style="padding:7px 8px;text-align:center;color:var(--cream);">L${level}</td>
      <td style="padding:7px 8px;text-align:center;color:var(--muted);font-size:10px;">${ratePct.toFixed(ratePct % 1 === 0 ? 0 : 2)}%</td>
      <td style="padding:7px 8px;text-align:right;"><a href="${txUrl}" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:none;">+${ethToUSDT(amt).toFixed(2)} USDT ↗</a></td>
    </tr>`;
  }

  const perPageBtns = [10, 50, 100].map(n =>
    `<button onclick="setRwRefPerPage(${n})"
      style="padding:4px 10px;font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;
             border:1px solid ${_rwRefPerPage === n ? 'var(--gold)' : 'var(--border)'};
             background:${_rwRefPerPage === n ? 'rgba(201,168,76,0.12)' : 'var(--surface)'};
             color:${_rwRefPerPage === n ? 'var(--gold)' : 'var(--muted)'};
             border-radius:3px;cursor:pointer;">${n}</button>`
  ).join('');

  const navBtn = (lbl, p, dis) =>
    `<button onclick="setRwRefPage(${p})" ${dis ? 'disabled' : ''}
      style="padding:5px 12px;font-family:var(--font-mono);font-size:11px;letter-spacing:.04em;
             border:1px solid var(--border);background:var(--surface);
             color:${dis ? 'rgba(255,255,255,0.18)' : 'var(--cream)'};
             border-radius:3px;cursor:${dis ? 'default' : 'pointer'};">${lbl}</button>`;

  const pagination = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      ${navBtn('‹ PREV', page - 1, page <= 1)}
      <span style="font-size:11px;font-family:var(--font-mono);color:var(--muted);">PAGE</span>
      <span style="font-size:14px;font-family:var(--font-mono);color:var(--cream);min-width:22px;text-align:center;">${page}</span>
      <span style="font-size:11px;font-family:var(--font-mono);color:var(--muted);">OF ${pages}</span>
      ${navBtn('NEXT ›', page + 1, page >= pages)}
    </div>`;

  return `<div style="margin-top:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
      <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">
        ${start + 1}–${end} <span style="opacity:0.5;">of</span> ${total} entries
      </div>
      <div style="display:flex;align-items:center;gap:5px;">
        <span style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">SHOW</span>
        ${perPageBtns}
      </div>
    </div>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:11px;font-family:var(--font-mono);">
        <thead>
          <tr style="border-bottom:1px solid var(--border);">
            <th onclick="sortRwRef('ts')"     style="text-align:left;padding:7px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;cursor:pointer;user-select:none;white-space:nowrap;">DATE${_rwRefSI('ts')}</th>
            <th                               style="text-align:left;padding:7px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">FROM</th>
            <th onclick="sortRwRef('level')"  style="text-align:center;padding:7px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;cursor:pointer;user-select:none;">LVL${_rwRefSI('level')}</th>
            <th                               style="text-align:center;padding:7px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">RATE</th>
            <th onclick="sortRwRef('amount')" style="text-align:right;padding:7px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;cursor:pointer;user-select:none;">AMOUNT${_rwRefSI('amount')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;flex-wrap:wrap;gap:10px;">
      <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">
        ${total} total · sorted by ${_rwRefSortKey === 'ts' ? 'DATE' : _rwRefSortKey.toUpperCase()} ${_rwRefSortDir < 0 ? '↓' : '↑'}
      </div>
      ${pagination}
    </div>
  </div>`;
}

function setRwRefPerPage(n) {
  _rwRefPerPage = n;
  _rwRefPage = 1;
  const el = document.getElementById('rwRefHistContainer');
  if (el) el.innerHTML = _rwRefHistHtml();
}

function setRwRefPage(p) {
  const pages = Math.max(1, Math.ceil(_rwRefAllEvents.length / _rwRefPerPage));
  _rwRefPage = Math.max(1, Math.min(p, pages));
  const el = document.getElementById('rwRefHistContainer');
  if (el) el.innerHTML = _rwRefHistHtml();
}

function sortRwRef(key) {
  if (_rwRefSortKey === key) {
    _rwRefSortDir = -_rwRefSortDir;
  } else {
    _rwRefSortKey = key;
    _rwRefSortDir = -1;
  }
  _rwRefPage = 1;
  const el = document.getElementById('rwRefHistContainer');
  if (el) el.innerHTML = _rwRefHistHtml();
}

// ─── loadRewards ──────────────────────────────────────────────────────────────

async function loadRewards() {
  if (!contract || !walletAddress) {
    ['rwRefContent','rwStakingContent','rwLPFeesContent'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="empty-state">Connect wallet to view your rewards.</div>';
    });
    return;
  }
  _tabLoaded.add('rewards');
  loadRwReferral();
  loadRwStaking();
  loadRwLPFees();
}

// ─── loadRwReferral ───────────────────────────────────────────────────────────

async function loadRwReferral() {
  const el = document.getElementById('rwRefContent');
  el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  try {
    const [commStats, commEvents, activeCountRaw, minInvRaw] = await Promise.all([
      contract.getUserCommissionStats(walletAddress),
      contract.queryFilter(contract.filters.CommissionPaid(walletAddress)).catch(() => []),
      contract.getActiveDirectReferralCount(walletAddress).catch(() => ethers.BigNumber.from(0)),
      contract.minDirectReferralInvestment().catch(() => ethers.BigNumber.from(0))
    ]);
    const activeCount = Number(activeCountRaw);
    const minInvETH   = parseFloat(ethers.utils.formatEther(minInvRaw));
    const minInvLabel = minInvETH > 0 ? `≥ ${fmtUSDT(minInvETH,{noEth:true})} each` : 'any active investment';

    const earned    = parseFloat(ethers.utils.formatEther(commStats.earned));
    const missed    = parseFloat(ethers.utils.formatEther(commStats.missed));
    const remaining = parseFloat(ethers.utils.formatEther(commStats.remainingCap));

    const blockNums = [...new Set(commEvents.map(e => e.blockNumber))];
    _rwRefBlockTsMap = new Map();
    await Promise.all(blockNums.map(async bn => {
      const blk = await provider.getBlock(bn).catch(() => null);
      if (blk) _rwRefBlockTsMap.set(bn, blk.timestamp);
    }));

    _rwRefAllEvents = [...commEvents].sort((a, b) => b.blockNumber - a.blockNumber);
    _rwRefPage = 1;

    const missedWarn = missed > 0.000001
      ? `<div style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);border-radius:6px;padding:10px 14px;margin-top:12px;font-size:11px;color:#f87171;">
           <span style="letter-spacing:1px;">⚠ MISSED COMMISSIONS: ${fmtUSDT(missed)}</span>
           <div style="margin-top:4px;color:rgba(248,113,113,0.7);font-size:10px;">You were ineligible when these commissions passed through your position. Invest to earn future commissions.</div>
         </div>` : '';

    const maxEligibleLevel = Math.min(activeCount, 10);
    const eligColor  = maxEligibleLevel > 0 ? '#4ade80' : '#f87171';
    const eligBg     = maxEligibleLevel > 0 ? 'rgba(74,222,128,0.07)' : 'rgba(248,113,113,0.07)';
    const eligBorder = maxEligibleLevel > 0 ? 'rgba(74,222,128,0.22)' : 'rgba(248,113,113,0.22)';
    const nextLevel  = maxEligibleLevel + 1;
    const nextHint   = maxEligibleLevel < 10
      ? `<div style="margin-top:4px;font-size:10px;color:var(--muted);">Invite <span style="color:var(--cream);">${nextLevel} active referral${nextLevel !== 1 ? 's' : ''} (${minInvLabel})</span> to unlock Level ${nextLevel}.</div>`
      : `<div style="margin-top:4px;font-size:10px;color:var(--gold);">All 10 levels unlocked — maximum commission reach.</div>`;

    const eligBanner = `
      <div style="background:${eligBg};border:1px solid ${eligBorder};border-radius:6px;padding:11px 14px;margin-bottom:14px;font-size:11px;font-family:var(--font-mono);">
        <div style="color:${eligColor};letter-spacing:1px;font-size:10px;margin-bottom:4px;">REFERRAL ELIGIBILITY</div>
        <div style="color:var(--cream);">
          <span style="color:${eligColor};font-weight:700;">${activeCount}</span> active direct referral${activeCount !== 1 ? 's' : ''} → commissions up to
          <span style="color:${eligColor};font-weight:700;">Level ${maxEligibleLevel}</span>
          ${maxEligibleLevel === 10 ? '<span style="color:var(--gold);"> · MAX</span>' : ''}
        </div>
        ${nextHint}
      </div>`;

    el.innerHTML = `
      ${eligBanner}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:4px;">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">TOTAL EARNED</div>
          <div style="font-size:18px;color:#4ade80;font-family:var(--font-display);">${fmtUSDT(earned)}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">CAP REMAINING</div>
          <div style="font-size:18px;color:var(--gold);font-family:var(--font-display);">${fmtUSDT(remaining)}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">MISSED</div>
          <div style="font-size:18px;font-family:var(--font-display);${missed > 0.000001 ? 'color:#f87171' : 'color:var(--muted)'};">${missed > 0.000001 ? fmtUSDT(missed) : '—'}</div>
        </div>
      </div>
      ${missedWarn}
      <div id="rwRefHistContainer">${_rwRefHistHtml()}</div>`;

  } catch(e) {
    el.innerHTML = `<div class="empty-state">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  }
}

// ─── loadRwStaking ────────────────────────────────────────────────────────────

async function loadRwStaking() {
  _rwStopTicker();
  const el = document.getElementById('rwStakingContent');
  el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  try {
    const [stakingData, lpLocks, latestBlock] = await Promise.all([
      contract.getStakingReward(walletAddress),
      contract.getUserLPLocks(walletAddress),
      provider.getBlock('latest')
    ]);

    // Use same effectiveNow as investments tab (restored from sessionStorage so
    // Hardhat's frozen block.timestamp doesn't cause mismatches).
    const blockTs  = latestBlock ? latestBlock.timestamp : Math.floor(Date.now() / 1000);
    const wallNow  = Math.floor(Date.now() / 1000);
    let effectiveNow = blockTs;
    try {
      const saved = JSON.parse(sessionStorage.getItem('hordex_eff_time') || 'null');
      if (saved && saved.blockNow <= blockTs) {
        const wallElapsed = Math.max(0, wallNow - saved.wallNow);
        effectiveNow = Math.max(blockTs, saved.effectiveNow + wallElapsed);
      }
    } catch(_) {}

    // Fetch pool prices and token symbols for all unique tokens (same as investments tab).
    const tokenSet  = [...new Set(lpLocks.map(l => l.token.toLowerCase()))];
    const poolCache = new Map();
    const tokenMeta = new Map();
    await Promise.all([
      ...tokenSet.map(async addr => { try { const d = await _dashGetPoolPrice(addr); if (d) poolCache.set(addr, d); } catch(_) {} }),
      ...tokenSet.map(async addr => { try { const t = await contract.getToken(addr); tokenMeta.set(addr, t.symbol); } catch(_) {} })
    ]);

    _rwStakingBaseTime  = effectiveNow;
    _rwStakingWallBase  = wallNow;
    _rwStakingLocks     = lpLocks;
    _rwStakingPrices    = lpLocks.map(l => (poolCache.get(l.token.toLowerCase()) || {}).priceEth || 0);
    _rwStakingTokenSyms = lpLocks.map(l => tokenMeta.get(l.token.toLowerCase()) || 'HORDEX');
    _rwStakingFirstSym  = _rwStakingTokenSyms[0] || 'HORDEX';

    const firstTokenSym    = lpLocks.length > 0 ? (tokenMeta.get(lpLocks[0].token.toLowerCase()) || 'HORDEX') : 'HORDEX';
    const now              = effectiveNow;
    const lifetimeClaimed  = parseFloat(ethers.utils.formatEther(stakingData.lifetimeClaimed));

    const { live: totalLiveUSDT, pending: totalClaimableUSDT, anyActive: initAnyActive } = _rwComputeLiveUsdt(now);

    let lockRows = '';
    let totalClaimableTokens = 0;
    for (let i = 0; i < lpLocks.length; i++) {
      const lock        = lpLocks[i];
      const isRemoved   = lock.removed || false;
      const unlockTime  = Number(lock.unlockTime);
      const lockedAt    = Number(lock.lockedAt) || (unlockTime - 60);
      const lockDurSecs = unlockTime > lockedAt ? unlockTime - lockedAt : 60;
      const tokenSym    = tokenMeta.get(lock.token.toLowerCase()) || 'HORDEX';
      const priceEth    = _rwStakingPrices[i] || 0;
      const ethInvested = parseFloat(ethers.utils.formatEther(lock.ethInvested));
      const rewardClaimedETH  = parseFloat(ethers.utils.formatEther(lock.rewardClaimedETH  || ethers.BigNumber.from(0)));
      const tokensAccumulated = parseFloat(ethers.utils.formatEther(lock.tokensAccumulated || ethers.BigNumber.from(0)));
      const totalClaimed      = parseFloat(ethers.utils.formatEther(lock.totalTokensClaimed || ethers.BigNumber.from(0)));
      const elapsed           = Math.min(lockDurSecs, Math.max(0, now - lockedAt));
      const rewardTotalETH    = ethInvested * 0.30;
      const earnedETH         = lockDurSecs > 0 ? rewardTotalETH * elapsed / lockDurSecs : 0;
      const pendingETH        = Math.max(0, earnedETH - rewardClaimedETH);
      // Same formula as investments tab
      const liveUSDT_lock    = earnedETH * USDT_PER_ETH;
      const claimableTokens  = (priceEth > 0 ? pendingETH / priceEth : 0) + tokensAccumulated;
      totalClaimableTokens  += claimableTokens;

      const claimedPct  = rewardTotalETH > 0 ? Math.min(100, rewardClaimedETH / rewardTotalETH * 100) : 0;
      const pendingPct  = rewardTotalETH > 0 ? Math.min(100 - claimedPct, pendingETH / rewardTotalETH * 100) : 0;
      const progressBar = isRemoved
        ? `<div style="font-size:9px;color:#f87171;letter-spacing:1px;">LP REMOVED</div>`
        : `<div class="dis-bar-track" style="width:100%;min-width:70px;">
            <div class="dis-bar-claimed" style="width:${claimedPct.toFixed(2)}%"></div>
            <div id="rwLockBar-${i}" class="dis-bar-active" style="left:${claimedPct.toFixed(2)}%; width:${pendingPct.toFixed(2)}%"></div>
          </div>`;
      const isPeriodComplete = !isRemoved && elapsed >= lockDurSecs;
      const progressLabel = isRemoved
        ? `full period earned`
        : isPeriodComplete
          ? `<span id="rwLockPct-${i}" style="color:var(--gold);">100% · period complete</span>`
          : `<span id="rwLockPct-${i}">${(elapsed / lockDurSecs * 100).toFixed(1)}% of period</span>`;
      const claimedCell   = totalClaimed > 0 ? `<span style="color:#4ade80;">✓ ${totalClaimed.toFixed(4)} ${tokenSym} claimed</span>` : '';
      const statusCell    = isRemoved
        ? `<span style="color:var(--muted);">LP REMOVED</span>`
        : `<span id="rwLockClaimable-${i}" style="color:${claimableTokens > 0.000001 ? 'var(--gold)' : 'var(--muted)'};">${claimableTokens > 0.000001 ? claimableTokens.toFixed(4) + ' ' + tokenSym : '—'}</span>`;

      lockRows += `
        <tr style="border-bottom:1px solid rgba(20,30,42,0.7);">
          <td style="padding:8px 8px;color:var(--muted);font-size:10px;">#${i+1}</td>
          <td style="padding:8px 8px;color:var(--cream);">${fmtUSDT(ethInvested,{noEth:true})}<div style="font-size:9px;color:var(--muted);">accrued: <span id="rwLockAccrued-${i}" style="color:var(--gold);">$${liveUSDT_lock.toFixed(6)} USDT</span></div></td>
          <td style="padding:8px 8px;">
            ${progressBar}
            <div style="font-size:9px;color:var(--muted);margin-top:3px;">${progressLabel} · ${claimedCell}</div>
          </td>
          <td style="padding:8px 8px;text-align:right;">${statusCell}</td>
        </tr>`;
    }

    const canClaim = totalClaimableTokens > 0.000001;

    el.innerHTML = `
      <div style="background:rgba(201,168,76,0.06);border:1px solid rgba(201,168,76,0.18);border-radius:6px;padding:12px 14px;margin-bottom:16px;font-size:11px;font-family:var(--font-mono);">
        <div style="color:var(--gold);letter-spacing:1px;font-size:10px;margin-bottom:5px;">HOW STAKING REWARDS WORK</div>
        <div style="color:var(--muted);line-height:1.75;">Rewards accrue at <span style="color:var(--cream);">30% of your invested amount per lock period</span>, every second, capped at the lock period end. Restake to start a new period. When you claim, the accrued USDT value is <span style="color:var(--gold);">converted to ${firstTokenSym} tokens at the current market price</span> and sent to your wallet.</div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:16px;">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">ACCRUED (USDT)</div>
          <div id="rwStakingAccrued" style="font-size:16px;color:var(--gold);font-family:var(--font-display);">${totalLiveUSDT > 0 ? '$' + totalLiveUSDT.toFixed(6) : '$0.000000'}</div>
          <div id="rwStakingLiveLabel" style="font-size:10px;color:var(--muted);margin-top:2px;">${initAnyActive ? '30% of investment · live <span style="color:#4ade80;font-size:9px;">●</span>' : 'period complete · <span style="color:var(--gold);">claim to restake</span>'}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">CLAIMABLE (USDT)</div>
          <div id="rwStakingClaimable" style="font-size:16px;color:var(--cream);font-family:var(--font-display);">${totalClaimableUSDT > 0 ? '$' + totalClaimableUSDT.toFixed(6) : '$0.000000'}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;">unclaimed · converts to tokens at claim</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">LIFETIME CLAIMED</div>
          <div style="font-size:16px;color:#4ade80;font-family:var(--font-display);">${lifetimeClaimed > 0 ? lifetimeClaimed.toFixed(4) : '0'}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;">${firstTokenSym} tokens total</div>
        </div>
      </div>

      <div style="margin-bottom:16px;">
        <button id="claimStakingBtn" onclick="claimStakingReward()"
          style="background:${canClaim ? 'var(--gold)' : 'rgba(255,255,255,0.06)'};
                 border:1px solid ${canClaim ? 'var(--gold)' : 'var(--border)'};
                 color:${canClaim ? '#0a0a0a' : 'var(--muted)'};
                 border-radius:4px;padding:10px 24px;font-family:var(--font-mono);
                 font-size:11px;font-weight:700;letter-spacing:1px;
                 cursor:${canClaim ? 'pointer' : 'not-allowed'};transition:opacity 0.15s;"
          ${canClaim ? '' : 'disabled'}>
          ${canClaim ? 'CLAIM ALL · ' + totalClaimableTokens.toFixed(4) + ' ' + firstTokenSym : 'NOTHING TO CLAIM'}
        </button>
        <div style="font-size:10px;color:var(--muted);margin-top:6px;font-family:var(--font-mono);">No cooldown · tokens sent at current market price</div>
      </div>

      ${lockRows ? `
      <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:8px;">PER-INVESTMENT BREAKDOWN</div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:11px;font-family:var(--font-mono);">
          <thead>
            <tr style="border-bottom:1px solid var(--border);">
              <th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:400;">#</th>
              <th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:400;">INVESTED</th>
              <th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:400;">PROGRESS / CLAIMED</th>
              <th style="text-align:right;padding:6px 8px;color:var(--muted);font-weight:400;">CLAIMABLE (TOKENS)</th>
            </tr>
          </thead>
          <tbody>${lockRows}</tbody>
        </table>
      </div>` : '<div class="empty-state">No investments yet. Go to INVEST to get started.</div>'}`;

    _rwStartTicker();

  } catch(e) {
    document.getElementById('rwStakingContent').innerHTML =
      `<div class="empty-state">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  }
}

async function claimStakingReward() {
  const btn = document.getElementById('claimStakingBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'CLAIMING…'; }
  try {
    toast('Confirm staking claim in MetaMask…', 'info');
    const tx = await contract.claimStakingReward();
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    toast('Staking rewards claimed!', 'success');
    loadRwStaking();
  } catch(e) {
    if (btn) { btn.disabled = false; }
    toast('Claim failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

// ─── loadRwLPFees ─────────────────────────────────────────────────────────────

async function loadRwLPFees() {
  const el = document.getElementById('rwLPFeesContent');
  el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  try {
    const lpLocks = await contract.getUserLPLocks(walletAddress);
    if (!lpLocks.length) {
      el.innerHTML = `<div style="background:rgba(201,168,76,0.06);border:1px solid rgba(201,168,76,0.18);border-radius:6px;padding:12px 14px;margin-bottom:12px;font-size:11px;font-family:var(--font-mono);color:var(--muted);line-height:1.7;">Every swap in a Uniswap pool charges a <span style="color:var(--cream);">0.3% fee</span> that flows to LP providers. Fees <span style="color:var(--cream);">compound automatically</span> in the pool — no separate claim needed. They are included automatically when you claim or remove LP tokens.</div><div class="empty-state">No LP positions found. Go to INVEST to get started.</div>`;
      return;
    }

    const tokenSet  = [...new Set(lpLocks.map(l => l.token.toLowerCase()))];
    const poolCache = new Map();
    const tokenMeta = new Map();
    await Promise.all([
      ...tokenSet.map(async addr => { const d = await _dashGetPoolPrice(addr); if (d) poolCache.set(addr, d); }),
      ...tokenSet.map(async addr => { try { const t = await contract.getToken(addr); tokenMeta.set(addr, { symbol: t.symbol, meta: getMeta(addr) }); } catch(_) {} })
    ]);

    const now = Math.floor(Date.now() / 1000);
    let totalGainETH = 0;
    let activeCnt    = 0;
    let rows         = '';

    for (let i = 0; i < lpLocks.length; i++) {
      const lock        = lpLocks[i];
      const key         = lock.token.toLowerCase();
      const pool        = poolCache.get(key);
      const td          = tokenMeta.get(key) || { symbol: lock.token.slice(0,6), meta: {} };
      const logoSrc     = td.meta && td.meta.logo ? `<img src="${td.meta.logo}" style="width:100%;height:100%;object-fit:contain;"/>` : '⬡';
      const ethInvested = parseFloat(ethers.utils.formatEther(lock.ethInvested || ethers.BigNumber.from(0)));
      const isClaimed   = lock.claimed;
      const isRemoved   = lock.removed;
      const currentETH  = pool && !isRemoved ? _dashComputeLPValue(lock.lpAmount, pool.resETH, pool.totalLPSupply) : 0;
      const gainETH     = currentETH - ethInvested;
      const gainPct     = ethInvested > 0 ? (gainETH / ethInvested) * 100 : 0;
      const isUnlocked  = now >= Number(lock.unlockTime);

      if (!isClaimed && !isRemoved && currentETH > 0) { totalGainETH += gainETH; activeCnt++; }

      const gainClr   = gainETH > 0.000001 ? '#4ade80' : gainETH < -0.000001 ? '#f87171' : 'var(--muted)';
      const statusTxt = isClaimed ? 'LP CLAIMED' : isRemoved ? 'REMOVED' : isUnlocked ? 'READY TO CLAIM' : 'LOCKED';
      const statusClr = (isClaimed || isRemoved) ? 'var(--muted)' : isUnlocked ? '#4ade80' : 'var(--muted)';

      rows += `<tr style="border-bottom:1px solid rgba(20,30,42,0.7);">
        <td style="padding:9px 8px;">
          <div style="display:flex;align-items:center;gap:7px;">
            <div style="width:22px;height:22px;border-radius:5px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;">${logoSrc}</div>
            <div><div style="color:var(--cream);font-size:12px;">${td.symbol}</div><div style="color:var(--muted);font-size:9px;">#${i+1}</div></div>
          </div>
        </td>
        <td style="padding:9px 8px;text-align:right;color:var(--cream);">${fmtUSDT(ethInvested,{noEth:true})}</td>
        <td style="padding:9px 8px;text-align:right;color:var(--cream);">${currentETH > 0 ? fmtUSDT(currentETH,{noEth:true}) : '—'}</td>
        <td style="padding:9px 8px;text-align:right;">
          <span style="color:${gainClr};">${currentETH > 0 ? (gainETH >= 0 ? '+' : '') + fmtUSDT(gainETH,{noEth:true}) : '—'}</span>
          ${currentETH > 0 ? `<div style="font-size:9px;color:${gainClr};opacity:0.75;">${(gainETH >= 0 ? '+' : '') + gainPct.toFixed(2)}%</div>` : ''}
        </td>
        <td style="padding:9px 8px;text-align:right;font-size:10px;color:${statusClr};">${statusTxt}</td>
      </tr>`;
    }

    const totalClr = totalGainETH > 0.000001 ? '#4ade80' : totalGainETH < -0.000001 ? '#f87171' : 'var(--muted)';

    el.innerHTML = `
      <div style="background:rgba(201,168,76,0.06);border:1px solid rgba(201,168,76,0.18);border-radius:6px;padding:12px 14px;margin-bottom:16px;font-size:11px;font-family:var(--font-mono);">
        <div style="color:var(--gold);letter-spacing:1px;font-size:10px;margin-bottom:5px;">HOW UNISWAP V2 POOL FEES WORK</div>
        <div style="color:var(--muted);line-height:1.75;">Every swap charges a <span style="color:var(--cream);">0.3% fee</span> that flows to LP providers. In V2, fees <span style="color:var(--cream);">compound automatically</span> — your LP tokens grow in value with every swap. <span style="color:var(--gold);">No separate fee claim needed.</span> Earnings are included when you claim or remove LP tokens.</div>
      </div>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:16px;display:inline-block;min-width:200px;">
        <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:5px;">ESTIMATED POOL EARNINGS</div>
        <div style="font-size:22px;font-family:var(--font-display);color:${totalClr};">${totalGainETH !== 0 ? (totalGainETH >= 0 ? '+' : '') + fmtUSDT(totalGainETH,{noEth:true}) : '—'}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px;">${activeCnt} active position${activeCnt !== 1 ? 's' : ''} · fees + price change combined</div>
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:11px;font-family:var(--font-mono);">
          <thead>
            <tr style="border-bottom:1px solid var(--border);">
              <th style="text-align:left;padding:6px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">TOKEN</th>
              <th style="text-align:right;padding:6px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">INVESTED</th>
              <th style="text-align:right;padding:6px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">CURRENT VALUE</th>
              <th style="text-align:right;padding:6px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">GAIN (FEES + PRICE)</th>
              <th style="text-align:right;padding:6px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">STATUS</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:12px;font-size:10px;color:var(--muted);font-family:var(--font-mono);">
        To collect pool earnings, go to the <span style="color:var(--gold);cursor:pointer;text-decoration:underline;" onclick="switchTabByName('investments')">INVESTMENTS</span> tab and claim or remove your LP position.
      </div>`;

  } catch(e) {
    el.innerHTML = `<div class="empty-state">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  }
}

window.loadRewards        = loadRewards;
window.loadRwReferral     = loadRwReferral;
window.loadRwStaking      = loadRwStaking;
window.loadRwLPFees       = loadRwLPFees;
window.claimStakingReward = claimStakingReward;
window.setRwRefPerPage    = setRwRefPerPage;
window.setRwRefPage       = setRwRefPage;
window.sortRwRef          = sortRwRef;
