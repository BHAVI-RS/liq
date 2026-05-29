// ─── Referral pagination / sort state ────────────────────────────────────────
let _rwRefAllEvents  = [];
let _rwRefBlockTsMap = new Map();
let _rwRefPage       = 1;
let _rwRefPerPage    = 10;
let _rwRefSortKey    = 'ts';
let _rwRefSortDir    = -1;

// ─── ROI active streams pagination ───────────────────────────────────────────
let _rwROIStreamPage    = 1;
let _rwROIStreamPerPage = 5;

function _rwROIStreamsHtml() {
  if (_rwROIStreamDetails.length === 0) return '';
  const total = _rwROIStreamDetails.length;
  const pages = Math.max(1, Math.ceil(total / _rwROIStreamPerPage));
  const page  = Math.min(_rwROIStreamPage, pages);
  const start = (page - 1) * _rwROIStreamPerPage;
  const slice = _rwROIStreamDetails.slice(start, start + _rwROIStreamPerPage);
  const end   = start + slice.length;

  const perPageBtns = [5, 10, 50, 100].map(n =>
    `<button onclick="setRwROIStreamPerPage(${n})"
      style="padding:4px 10px;font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;
             border:1px solid ${_rwROIStreamPerPage === n ? 'var(--gold)' : 'var(--border)'};
             background:${_rwROIStreamPerPage === n ? 'rgba(201,168,76,0.12)' : 'var(--surface)'};
             color:${_rwROIStreamPerPage === n ? 'var(--gold)' : 'var(--muted)'};
             border-radius:3px;cursor:pointer;">${n}</button>`
  ).join('');

  const navBtn = (lbl, p, dis) =>
    `<button onclick="setRwROIStreamPage(${p})" ${dis ? 'disabled' : ''}
      style="padding:5px 12px;font-family:var(--font-mono);font-size:11px;letter-spacing:.04em;
             border:1px solid var(--border);background:var(--surface);
             color:${dis ? 'rgba(255,255,255,0.18)' : 'var(--cream)'};
             border-radius:3px;cursor:${dis ? 'default' : 'pointer'};">${lbl}</button>`;

  let rows = '';
  for (let j = 0; j < slice.length; j++) {
    const d = slice[j];
    const i = start + j;   // global index — matches ticker element IDs

    const paidPct    = d.capETH > 0 ? Math.min(100, d.roiPaidETH / d.capETH * 100) : 0;
    const accruedPct = d.capETH > 0 ? Math.min(100 - paidPct, d.accruedETH / d.capETH * 100) : 0;
    const totalPct   = paidPct + accruedPct;
    const isAtCap    = totalPct >= 99.99;

    const progressBar = `
      <div class="dis-bar-track" style="width:100%;min-width:90px;">
        <div class="dis-bar-claimed" style="width:${paidPct.toFixed(2)}%"></div>
        <div id="rwROIStreamBar-${i}" class="dis-bar-active" style="left:${paidPct.toFixed(2)}%; width:${accruedPct.toFixed(2)}%"></div>
      </div>
      <div style="font-size:9px;color:var(--muted);margin-top:3px;">
        <span id="rwROIStreamPct-${i}">${totalPct >= 100 ? '100' : totalPct.toFixed(2)}% of cap</span>${isAtCap ? ' · <span style="color:var(--gold);">cap reached</span>' : ''}
      </div>`;

    rows += `<tr style="border-bottom:1px solid rgba(20,30,42,0.7);">
      <td style="padding:8px 8px;color:var(--muted);font-size:10px;">
        ${d.investor.slice(0,6)}…${d.investor.slice(-4)}
        <div style="color:var(--cream);margin-top:2px;">L${d.level + 1} <span style="color:var(--gold);font-size:10px;">${(d.commRate / 100).toFixed(2)}%</span></div>
      </td>
      <td style="padding:8px 8px;color:var(--cream);">$${fmtNum(d.ethInv * USDT_PER_ETH)}
        <div style="font-size:9px;color:var(--muted);">accrued: <span id="rwROIStreamAccrued-${i}" style="color:var(--gold);">$${(d.accruedETH * USDT_PER_ETH).toFixed(5)}</span></div>
      </td>
      <td style="padding:8px 8px;min-width:120px;">${progressBar}</td>
      <td style="padding:8px 8px;text-align:right;color:var(--muted);font-size:10px;">$${fmtNum(d.capETH * USDT_PER_ETH)}</td>
      <td style="padding:8px 8px;text-align:right;">
        <button onclick="claimROIFromStreamBtn('${d.investor}',${d.lockIndex},${d.level},this)"
          id="rwROIStreamClaimBtn-${i}"
          style="padding:5px 10px;font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;
                 border:1px solid var(--gold);background:rgba(201,168,76,0.12);color:var(--gold);
                 border-radius:3px;cursor:pointer;white-space:nowrap;">CLAIM</button>
      </td>
    </tr>`;
  }

  return `<div style="margin-top:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px;">
      <div style="font-size:9px;letter-spacing:2px;color:var(--muted);">ACTIVE STREAMS</div>
      <div style="display:flex;align-items:center;gap:5px;">
        <span style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">SHOW</span>
        ${perPageBtns}
      </div>
    </div>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:11px;">
        <thead>
          <tr style="border-bottom:1px solid var(--border);">
            <th style="text-align:left;color:var(--muted);font-weight:400;padding:5px 8px;">STREAM</th>
            <th style="text-align:left;color:var(--muted);font-weight:400;padding:5px 8px;">INVESTED / ACCRUED</th>
            <th style="text-align:left;color:var(--muted);font-weight:400;padding:5px 8px;min-width:120px;">PROGRESS</th>
            <th style="text-align:right;color:var(--muted);font-weight:400;padding:5px 8px;">CAP</th>
            <th style="text-align:right;color:var(--muted);font-weight:400;padding:5px 8px;">CLAIM</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;flex-wrap:wrap;gap:10px;">
      <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">
        ${start + 1}–${end} <span style="opacity:0.5;">of</span> ${total} entries
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        ${navBtn('‹ PREV', page - 1, page <= 1)}
        <span style="font-size:11px;font-family:var(--font-mono);color:var(--muted);">PAGE</span>
        <span style="font-size:14px;font-family:var(--font-mono);color:var(--cream);min-width:22px;text-align:center;">${page}</span>
        <span style="font-size:11px;font-family:var(--font-mono);color:var(--muted);">OF ${pages}</span>
        ${navBtn('NEXT ›', page + 1, page >= pages)}
      </div>
    </div>
  </div>`;
}

function _rwROIStreamsSnapBars(container) {
  if (!container) return;
  container.querySelectorAll('.dis-bar-active, .dis-bar-claimed').forEach(b => b.style.transition = 'none');
  requestAnimationFrame(() => requestAnimationFrame(() =>
    container.querySelectorAll('.dis-bar-active, .dis-bar-claimed').forEach(b => b.style.transition = '')
  ));
}

function setRwROIStreamPage(p) {
  const pages = Math.max(1, Math.ceil(_rwROIStreamDetails.length / _rwROIStreamPerPage));
  _rwROIStreamPage = Math.max(1, Math.min(p, pages));
  const el = document.getElementById('rwROIStreamsContainer');
  if (el) { el.innerHTML = _rwROIStreamsHtml(); _rwROIStreamsSnapBars(el); }
}

function setRwROIStreamPerPage(n) {
  _rwROIStreamPerPage = n;
  _rwROIStreamPage    = 1;
  const el = document.getElementById('rwROIStreamsContainer');
  if (el) { el.innerHTML = _rwROIStreamsHtml(); _rwROIStreamsSnapBars(el); }
}


// ─── ROI Commission live ticker ───────────────────────────────────────────────
let _rwROIInterval    = null;
let _rwROIBaseETH     = 0;      // liveETH + pendingETH at fetch time
let _rwROIRatePerSec  = 0;      // ETH per second from active streams
let _rwROIFetchWall   = 0;      // wall-clock seconds at fetch
let _rwROITokenSym    = 'HORDEX';
let _rwROITokenPrice  = 0;      // ETH per token (spot)
let _rwROIActiveCount = 0;      // number of active streams
let _rwROIStreamDetails = [];   // [{investor,lockIndex,level,commRate,ethInv,capETH,accruedETH,streamRate}]
let _rwROILoading = false;      // concurrency guard

function _rwStopROITicker() {
  if (_rwROIInterval) { clearInterval(_rwROIInterval); _rwROIInterval = null; }
}

function _rwStartROITicker() {
  _rwStopROITicker();
  _rwROIInterval = setInterval(() => {
    const liveEl   = document.getElementById('rwROILive');
    if (!liveEl) { _rwStopROITicker(); return; }
    const elapsed   = Math.max(0, Math.floor(Date.now() / 1000) - _rwROIFetchWall);
    const totalETH  = _rwROIBaseETH + elapsed * _rwROIRatePerSec;
    const totalUSDT = totalETH * USDT_PER_ETH;
    liveEl.textContent = '$' + totalUSDT.toFixed(5);

    const tokEl = document.getElementById('rwROITokens');
    if (tokEl && _rwROITokenPrice > 0) {
      const tokens = totalETH / _rwROITokenPrice;
      tokEl.textContent = fmtNum(tokens) + ' ' + _rwROITokenSym;
    }

    const btn = document.getElementById('claimROIBtn');
    if (btn && btn.textContent !== 'CLAIMING…') {
      const canClaim  = totalETH > 0.000001;
      const tokens    = _rwROITokenPrice > 0 ? totalETH / _rwROITokenPrice : 0;
      btn.textContent = canClaim ? 'CLAIM ALL · ' + fmtNum(tokens) + ' ' + _rwROITokenSym : 'NOTHING TO CLAIM';
      btn.disabled    = !canClaim;
      btn.style.background  = canClaim ? 'var(--gold)' : 'rgba(255,255,255,0.06)';
      btn.style.borderColor = canClaim ? 'var(--gold)' : 'var(--border)';
      btn.style.color       = canClaim ? '#0a0a0a'     : 'var(--muted)';
      btn.style.cursor      = canClaim ? 'pointer'     : 'not-allowed';
    }

    for (let _si = 0; _si < _rwROIStreamDetails.length; _si++) {
      const _d    = _rwROIStreamDetails[_si];
      const _capL = Math.max(0, _d.capETH - _d.roiPaidETH);
      const _a    = Math.min(_capL, Math.max(0, _d.accruedETH + elapsed * _d.streamRate));

      const _accEl = document.getElementById('rwROIStreamAccrued-' + _si);
      if (_accEl) _accEl.textContent = '$' + (_a * USDT_PER_ETH).toFixed(5);

      if (_d.capETH > 0) {
        const _paidPct = Math.min(100, _d.roiPaidETH / _d.capETH * 100);
        const _accPct  = Math.min(100 - _paidPct, _a / _d.capETH * 100);
        const _barEl   = document.getElementById('rwROIStreamBar-' + _si);
        if (_barEl) _barEl.style.width = _accPct.toFixed(3) + '%';
        const _pctEl   = document.getElementById('rwROIStreamPct-' + _si);
        if (_pctEl) {
          const _tot = _paidPct + _accPct;
          _pctEl.textContent = (_tot >= 100 ? '100' : _tot.toFixed(2)) + '% of cap';
        }
      }
    }
  }, 1000);
}

// ─── Staking live ticker ──────────────────────────────────────────────────────
let _rwPollInterval    = null;
let _rwStakingInterval = null;
let _rwStakingLocks    = [];
let _rwStakingPrices   = [];   // parallel array: priceEth per lock
let _rwStakingTokenSyms = [];  // parallel array: token symbol per lock
let _rwStakingFirstSym  = 'HORDEX';
let _rwStakingBaseTime = 0;
let _rwStakingWallBase = 0;

function _rwStopPoll() {
  if (_rwPollInterval) { clearInterval(_rwPollInterval); _rwPollInterval = null; }
}

function _rwStartPoll() {
  _rwStopPoll();
  _rwPollInterval = setInterval(() => {
    const panel = document.getElementById('panel-rewards');
    if (!panel || !panel.classList.contains('active')) { _rwStopPoll(); return; }
    loadRwROI(true);
  }, 30000);
}

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
    const ratePPM = lock.rewardRatePPM ? lock.rewardRatePPM.toNumber() : 0;
    const rwEth   = ratePPM > 0 ? eth * ratePPM / 1_000_000 : 0;
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
    const _ePctNum    = dur  > 0 ? elapsed / dur * 100 : 0;
    const elapsedPct  = _ePctNum >= 100 ? '100' : _ePctNum.toFixed(5);
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
    accrEl.textContent  = '$' + fmtNum(live);
    if (claimEl) claimEl.textContent = '$' + fmtNum(pending);
    if (liveEl) {
      liveEl.innerHTML = anyActive
        ? '30% of investment · live <span style="color:#4ade80;font-size:9px;">●</span>'
        : 'period complete · <span style="color:var(--gold);">claim to restake</span>';
    }
    const btn = document.getElementById('claimStakingBtn');
    if (btn && btn.textContent !== 'CLAIMING…') {
      const canClaim = totalClaimableTokens > 0.000001;
      btn.textContent = canClaim ? 'CLAIM ALL · ' + fmtNum(totalClaimableTokens) + ' ' + _rwStakingFirstSym : 'NOTHING TO CLAIM';
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
      if (accrued) accrued.textContent = '$' + fmtNum(perLock[i].live) + ' USDT';
      if (bar)     bar.style.width     = perLock[i].pendingPct.toFixed(3) + '%';
      if (pct) {
        pct.textContent = perLock[i].isActive
          ? perLock[i].elapsedPct + '% of period'
          : '100% · period complete';
      }
      if (claimable) {
        const ct  = perLock[i].claimableTokens;
        const sym = _rwStakingTokenSyms[i] || _rwStakingFirstSym;
        claimable.textContent = ct > 0.000001 ? fmtNum(ct) + ' ' + sym : '—';
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
      va = parseFloat(ethers.utils.formatEther(a.args.amount)) * (a._missed ? -1 : 1);
      vb = parseFloat(ethers.utils.formatEther(b.args.amount)) * (b._missed ? -1 : 1);
    } else if (_rwRefSortKey === 'level') {
      va = Number(a.args.level);
      vb = Number(b.args.level);
    } else {
      // Use _ts (on-chain timestamp) preferentially; fall back to blockNumber for live-appended events
      va = a._ts || a.blockNumber || 0;
      vb = b._ts || b.blockNumber || 0;
    }
    return _rwRefSortDir * (va - vb);
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

  const RATES = [5000,2500,1000,300,250,225,200,200,175,150];

  let rows = '';
  for (const ev of slice) {
    // _ts is set for on-chain records; blockNumber fallback for live-appended events
    const tsVal       = ev._ts || _rwRefBlockTsMap.get(ev.blockNumber);
    const date        = tsVal ? _fmtTsFull(tsVal) : (ev.blockNumber ? `Block #${ev.blockNumber}` : '—');
    const from        = ev.args.from;
    const fromDisplay = (typeof _labelCache !== 'undefined' && _labelCache.get(from.toLowerCase())) || from;
    const amt     = parseFloat(ethers.utils.formatEther(ev.args.amount));
    const level   = Number(ev.args.level);
    const ratePct = (RATES[level - 1] || 0) / 500;
    const txUrl   = ev.transactionHash ? `https://amoy.polygonscan.com/tx/${ev.transactionHash}` : null;

    if (ev._missed) {
      const tipText = ev._missedReason === 'cap'        ? 'Referral cap exceeded — excess spilled to next upline'
                   : ev._missedReason === 'ineligible' ? 'Not enough active referrals to qualify for this level'
                   :                                     'No active investment lock or lock expired';
      rows += `<tr style="border-bottom:1px solid rgba(20,30,42,0.8);background:rgba(248,113,113,0.04);">
        <td style="padding:7px 8px;color:rgba(248,113,113,0.6);white-space:nowrap;">${date}</td>
        <td style="padding:7px 8px;">
          <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
            <a href="https://amoy.polygonscan.com/address/${from}" target="_blank" rel="noopener" title="${from}" style="color:rgba(248,113,113,0.7);text-decoration:none;word-break:break-all;">${fromDisplay}</a>
            <button onclick="copyAddr('${from}',this)" title="Copy address" style="padding:2px 4px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--muted);cursor:pointer;flex-shrink:0;line-height:1;">${_COPY_ICON}</button>
          </div>
        </td>
        <td style="padding:7px 8px;text-align:center;color:#f87171;">L${level}</td>
        <td style="padding:7px 8px;text-align:center;color:rgba(248,113,113,0.6);font-size:10px;">${ratePct.toFixed(ratePct % 1 === 0 ? 0 : 2)}%</td>
        <td style="padding:7px 8px;text-align:right;">
          <div class="rw-missed-tip">
            ${txUrl ? `<a href="${txUrl}" target="_blank" rel="noopener" style="color:#f87171;text-decoration:none;">⚠ −${fmtNum(ethToUSDT(amt))} USDT ↗</a>` : `<span style="color:#f87171;">⚠ −${fmtNum(ethToUSDT(amt))} USDT</span>`}
            <div class="rw-missed-tip-box">${tipText}</div>
          </div>
        </td>
      </tr>`;
    } else {
      rows += `<tr style="border-bottom:1px solid rgba(20,30,42,0.8);">
        <td style="padding:7px 8px;color:var(--muted);white-space:nowrap;">${date}</td>
        <td style="padding:7px 8px;">
          <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
            <a href="https://amoy.polygonscan.com/address/${from}" target="_blank" rel="noopener" title="${from}" style="color:var(--gold);text-decoration:none;word-break:break-all;">${fromDisplay}</a>
            <button onclick="copyAddr('${from}',this)" title="Copy address" style="padding:2px 4px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--muted);cursor:pointer;flex-shrink:0;line-height:1;">${_COPY_ICON}</button>
          </div>
        </td>
        <td style="padding:7px 8px;text-align:center;color:var(--cream);">L${level}</td>
        <td style="padding:7px 8px;text-align:center;color:var(--muted);font-size:10px;">${ratePct.toFixed(ratePct % 1 === 0 ? 0 : 2)}%</td>
        <td style="padding:7px 8px;text-align:right;">${txUrl ? `<a href="${txUrl}" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:none;">+${fmtNum(ethToUSDT(amt))} USDT ↗</a>` : `<span style="color:#4ade80;">+${fmtNum(ethToUSDT(amt))} USDT</span>`}</td>
      </tr>`;
    }
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

// ─── Live commission append (avoids full reload on CommissionPaid event) ──────
// Called from app.js _startChainListeners when a CommissionPaid fires.
// Only runs if the rewards tab has already been loaded (i.e. _rwRefAllEvents is populated).
// Pushes the new event into the existing list and re-renders just the table row section.

async function _rwAppendCommission(ev, from, amount, level) {
  // If the tab hasn't been loaded yet, the full loadRwReferral() will handle it
  if (!_rwRefAllEvents.length && !document.getElementById('rwRefHistContainer')) return;

  try {
    // Fetch block timestamp (needed for date column)
    const blk = await provider.getBlock(ev.blockNumber).catch(() => null);
    if (blk) _rwRefBlockTsMap.set(ev.blockNumber, blk.timestamp);

    // Build synthetic event in the same shape loadRwReferral() produces
    const syntheticEv = {
      _missed: false,
      args: { from, amount, level },
      blockNumber:     ev.blockNumber,
      transactionHash: ev.transactionHash,
    };

    // Prepend (newest first)
    _rwRefAllEvents = [syntheticEv, ..._rwRefAllEvents];
    _rwRefPage = 1;

    if (typeof _batchGetRefLabels === 'function') {
      await _batchGetRefLabels([from]).catch(() => {});
    }

    // Re-render table
    const container = document.getElementById('rwRefHistContainer');
    if (container) container.innerHTML = _rwRefHistHtml();

    // Update earned / cap stats from a single contract call (no event scan)
    const stats = await contract.getUserCommissionStats(walletAddress).catch(() => null);
    if (stats) {
      const earnedEl     = document.querySelector('#rwRefContent [data-field="earned"]');
      const remainingEl  = document.querySelector('#rwRefContent [data-field="remaining"]');
      if (earnedEl)    earnedEl.textContent    = fmtUSDT(parseFloat(ethers.utils.formatEther(stats.earned)), {decimals: 3});
      if (remainingEl) remainingEl.textContent = fmtUSDT(parseFloat(ethers.utils.formatEther(stats.remainingCap)));
    }
  } catch(_) {}
}

// ─── loadRewards ──────────────────────────────────────────────────────────────

let _rwLoadTime = 0;

async function loadRewards() {
  if (!contract || !walletAddress) {
    ['rwRefContent','rwStakingContent','rwROIContent','rwLPFeesContent'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="empty-state">Connect wallet to view your rewards.</div>';
    });
    return;
  }
  const _now = Date.now();
  if (_now - _rwLoadTime < 3000) return;
  _rwLoadTime = _now;
  _tabLoaded.add('rewards');
  loadRwReferral();
  loadRwStaking();
  loadRwROI();
  loadRwLPFees();
}

// ─── loadRwReferral ───────────────────────────────────────────────────────────

async function loadRwReferral() {
  const el = document.getElementById('rwRefContent');
  el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  try {
    const _zeroStats = { earned: ethers.BigNumber.from(0), totalCap: ethers.BigNumber.from(0), remainingCap: ethers.BigNumber.from(0) };
    // Fast on-chain calls only — _computeMissedWei runs in the background after render
    const [commStats, commRecords, activeCountRaw, minInvRaw] = await Promise.all([
      contract.getUserCommissionStats(walletAddress).catch(() => _zeroStats),
      contract.getCommissionRecords(walletAddress).catch(() => []),
      contract.getActiveDirectReferralCount(walletAddress).catch(() => ethers.BigNumber.from(0)),
      contract.minDirectReferralInvestment().catch(() => ethers.BigNumber.from(0)),
    ]);
    const activeCount = Number(activeCountRaw);
    const minInvETH   = parseFloat(ethers.utils.formatEther(minInvRaw));
    const minInvLabel = minInvETH > 0 ? `≥ ${fmtUSDT(minInvETH,{noEth:true})} each` : 'any active investment';

    const earned    = parseFloat(ethers.utils.formatEther(commStats.earned));
    const remaining = parseFloat(ethers.utils.formatEther(commStats.remainingCap));

    // Normalise on-chain CommissionRecord — no block fetches needed (ts is stored on-chain)
    const receivedEvs = commRecords.map(r => ({
      _missed: false,
      _ts:     r.ts.toNumber ? r.ts.toNumber() : Number(r.ts),
      args:    { from: r.from, amount: r.amount, level: ethers.BigNumber.from(r.level) },
      blockNumber:     null,
      transactionHash: null,
    }));

    _rwRefBlockTsMap = new Map();
    _rwRefAllEvents  = receivedEvs.sort((a, b) => (b._ts || 0) - (a._ts || 0));
    _rwRefPage = 1;

    const maxEligibleLevel = Math.min(activeCount, 10);

    // Render immediately — missed card shows loading dots
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:4px;">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">TOTAL EARNED</div>
          <div data-field="earned" style="font-size:18px;color:#4ade80;font-family:var(--font-display);">${fmtUSDT(earned, {decimals: 3})}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">CAP REMAINING</div>
          <div data-field="remaining" style="font-size:18px;color:var(--gold);font-family:var(--font-display);">${fmtUSDT(remaining)}</div>
        </div>
        <div id="rwRefMissedCard" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div id="rwRefMissedLabel" style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">MISSED</div>
          <div id="rwRefMissedVal" style="font-size:18px;font-family:var(--font-display);color:var(--muted);"><span class="ld"><span></span><span></span><span></span></span></div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">ELIGIBLE UP TO</div>
          <div style="font-size:18px;font-family:var(--font-display);color:${maxEligibleLevel === 10 ? '#4ade80' : maxEligibleLevel > 0 ? 'var(--cream)' : 'var(--muted)'};">${maxEligibleLevel > 0 ? 'Level ' + maxEligibleLevel : '—'}${maxEligibleLevel === 10 ? ' · MAX' : ''}</div>
        </div>
      </div>
      <div id="rwRefMissedWarn"></div>
      <div id="rwRefHistContainer">${_rwRefHistHtml()}</div>`;

    // Labels in background — re-renders table when ready, doesn't block initial display
    if (typeof _batchGetRefLabels === 'function') {
      const fromAddrs = [...new Set(_rwRefAllEvents.map(e => e.args.from))];
      _batchGetRefLabels(fromAddrs).catch(() => {}).then(() => {
        const c = document.getElementById('rwRefHistContainer');
        if (c) c.innerHTML = _rwRefHistHtml();
      });
    }

    // Missed commissions — computed in background, updates card + table when done
    (async () => {
      try {
        const lb = await provider.getBlockNumber().catch(() => 0);
        const missedResult = await _computeMissedWei(getFromBlock(lb))
          .catch(() => ({ total: ethers.BigNumber.from(0), entries: [] }));
        const missed = parseFloat(ethers.utils.formatEther(missedResult.total));

        // Update missed stat card
        const missedCard  = document.getElementById('rwRefMissedCard');
        const missedLabel = document.getElementById('rwRefMissedLabel');
        const missedVal   = document.getElementById('rwRefMissedVal');
        if (missedCard) {
          missedCard.style.background   = missed > 0.000001 ? 'rgba(248,113,113,0.07)' : 'var(--bg)';
          missedCard.style.borderColor  = missed > 0.000001 ? 'rgba(248,113,113,0.35)' : 'var(--border)';
        }
        if (missedLabel) missedLabel.style.color = missed > 0.000001 ? '#f87171' : 'var(--muted)';
        if (missedVal) {
          missedVal.style.color = missed > 0.000001 ? '#f87171' : 'var(--muted)';
          missedVal.innerHTML   = missed > 0.000001 ? fmtUSDT(missed) : '0';
        }

        // Update warning banner
        const warnEl = document.getElementById('rwRefMissedWarn');
        if (warnEl && missed > 0.000001) {
          warnEl.innerHTML = `<div style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);border-radius:6px;padding:10px 14px;margin-top:12px;font-size:11px;color:#f87171;">
            <span style="letter-spacing:1px;">⚠ MISSED COMMISSIONS: ${fmtUSDT(missed)}</span>
            <div style="margin-top:4px;color:rgba(248,113,113,0.7);font-size:10px;">Includes commissions that bypassed you entirely (ineligible) and excess that spilled past your 5× cap. Invest to earn future commissions in full.</div>
          </div>`;
        }

        // Merge missed entries into the event list and re-render table
        if (missedResult.entries.length > 0) {
          const missedEvs = missedResult.entries.map(e => ({
            _missed: true,
            _missedReason: e.reason === 2 ? 'cap' : e.reason === 0 ? 'ineligible' : 'no-lock',
            _ts: e._ts || null,
            args: { from: e.from, level: e.level, amount: e.amount },
            blockNumber: null,
            transactionHash: null,
          }));
          _rwRefAllEvents = [..._rwRefAllEvents, ...missedEvs].sort((a, b) => {
            const ta = a._ts || _rwRefBlockTsMap.get(a.blockNumber) || 0;
            const tb = b._ts || _rwRefBlockTsMap.get(b.blockNumber) || 0;
            return tb - ta;
          });
          const c = document.getElementById('rwRefHistContainer');
          if (c) c.innerHTML = _rwRefHistHtml();
        }
      } catch(_) {}
    })();

  } catch(e) {
    el.innerHTML = `<div class="empty-state">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  }
}

// ─── loadRwStaking ────────────────────────────────────────────────────────────

async function loadRwStaking(silent = false) {
  _rwStopTicker();
  const el = document.getElementById('rwStakingContent');
  if (!silent) {
    el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  }
  try {
    const _zeroStaking = { totalAccumulated: ethers.BigNumber.from(0), previewNewTokens: ethers.BigNumber.from(0), lifetimeClaimed: ethers.BigNumber.from(0) };
    const [stakingData, lpLocks, latestBlock] = await Promise.all([
      contract.getStakingReward(walletAddress).catch(() => _zeroStaking),
      contract.getUserLPLocks(walletAddress).catch(() => []),
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
    for (let i = lpLocks.length - 1; i >= 0; i--) {
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
      const ratePPM_lock   = lock.rewardRatePPM ? lock.rewardRatePPM.toNumber() : 0;
      const rewardTotalETH = ratePPM_lock > 0 ? ethInvested * ratePPM_lock / 1_000_000 : 0;
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
          : `<span id="rwLockPct-${i}">${((_p => _p >= 100 ? '100' : _p.toFixed(5))(elapsed / lockDurSecs * 100))}% of period</span>`;
      const claimedCell   = totalClaimed > 0 ? `<span style="color:#4ade80;">✓ ${fmtNum(totalClaimed)} ${tokenSym} claimed</span>` : '';
      const statusCell    = isRemoved
        ? `<span style="color:var(--muted);">LP REMOVED</span>`
        : `<span id="rwLockClaimable-${i}" style="color:${claimableTokens > 0.000001 ? 'var(--gold)' : 'var(--muted)'};">${claimableTokens > 0.000001 ? fmtNum(claimableTokens) + ' ' + tokenSym : '—'}</span>`;

      lockRows += `
        <tr style="border-bottom:1px solid rgba(20,30,42,0.7);">
          <td style="padding:8px 8px;color:var(--muted);font-size:10px;">#${i+1}</td>
          <td style="padding:8px 8px;color:var(--cream);">${fmtUSDT(ethInvested,{noEth:true})}<div style="font-size:9px;color:var(--muted);">accrued: <span id="rwLockAccrued-${i}" style="color:var(--gold);">$${fmtNum(liveUSDT_lock)} USDT</span></div></td>
          <td style="padding:8px 8px;">
            ${progressBar}
            <div style="font-size:9px;color:var(--muted);margin-top:3px;">${progressLabel} · ${claimedCell}</div>
          </td>
          <td style="padding:8px 8px;text-align:right;">${statusCell}</td>
        </tr>`;
    }

    const canClaim = totalClaimableTokens > 0.000001;

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">ACCRUED (USDT)</div>
          <div id="rwStakingAccrued" style="font-size:16px;color:var(--gold);font-family:var(--font-display);">${totalLiveUSDT > 0 ? '$' + fmtNum(totalLiveUSDT) : '$0'}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">CLAIMABLE (USDT)</div>
          <div id="rwStakingClaimable" style="font-size:16px;color:var(--cream);font-family:var(--font-display);">${totalClaimableUSDT > 0 ? '$' + fmtNum(totalClaimableUSDT) : '$0'}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">LIFETIME CLAIMED</div>
          <div style="font-size:16px;color:#4ade80;font-family:var(--font-display);">${lifetimeClaimed > 0 ? fmtNum(lifetimeClaimed) : '0'}</div>
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
          ${canClaim ? 'CLAIM ALL · ' + fmtNum(totalClaimableTokens) + ' ' + firstTokenSym : 'NOTHING TO CLAIM'}
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

    // Snap bars to their rendered positions without CSS transition.
    // loadRwStaking re-creates DOM elements each call (including silent polls every 5s),
    // so without this the 0.9s transition animates bars from 0 each time, making them
    // appear to reset and re-accumulate even after the lock period ends.
    el.querySelectorAll('.dis-bar-active, .dis-bar-claimed').forEach(b => b.style.transition = 'none');
    requestAnimationFrame(() => requestAnimationFrame(() =>
      el.querySelectorAll('.dis-bar-active, .dis-bar-claimed').forEach(b => b.style.transition = '')
    ));

    _rwStartTicker();

  } catch(e) {
    document.getElementById('rwStakingContent').innerHTML =
      `<div class="empty-state">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  }
}

async function claimStakingReward() {
  // Warn if the claimable value is less than $1 — gas cost likely exceeds the reward.
  if (_rwStakingLocks.length) {
    const _now = _rwStakingBaseTime + (Math.floor(Date.now() / 1000) - _rwStakingWallBase);
    const { pending: _claimableUSDT } = _rwComputeLiveUsdt(_now);
    if (_claimableUSDT < 1) {
      const ok = window.confirm(
        `Your claimable staking reward is $${_claimableUSDT.toFixed(6)} USDT — less than $1.\n` +
        `Gas fees may exceed this amount.\n\nClaim anyway?`
      );
      if (!ok) return;
    }
  }
  const btn = document.getElementById('claimStakingBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'CLAIMING…'; }
  try {
    toast('Confirm staking claim in MetaMask…', 'info');
    const tx = await contract.connect(signer).claimStakingReward(_GAS);
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    toast('Staking rewards claimed!', 'success');
    loadRwStaking();
  } catch(e) {
    if (btn) { btn.disabled = false; }
    toast('Claim failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

// ─── loadRwROI ────────────────────────────────────────────────────────────────

async function loadRwROI(silent = false) {
  if (_rwROILoading) return;
  _rwROILoading = true;
  const el = document.getElementById('rwROIContent');
  if (!el) { _rwROILoading = false; return; }
  if (!silent) {
    _rwStopROITicker();
    el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  }
  try {
    const COMM_RATES = [5000, 2500, 1000, 300, 250, 225, 200, 200, 175, 150];

    const [roiData, activeStreams, platformToken, latestBlock] = await Promise.all([
      contract.getROIData(walletAddress).catch(() => null),
      contract.getActiveROIStreams(walletAddress).catch(() => null),
      contract.platformToken().catch(() => null),
      provider.getBlock('latest').catch(() => null),
    ]);

    // In silent (poll) mode: if core data failed, keep the existing ticker running
    if (silent && roiData === null) { _rwROILoading = false; return; }
    if (silent && activeStreams === null) { _rwROILoading = false; return; }

    // Reset stream page to 1 only on full (non-silent) loads to preserve user's position
    if (!silent) { _rwROIStreamPage = 1; }

    const streams = activeStreams || [];

    const liveETH    = roiData ? parseFloat(ethers.utils.formatEther(roiData.liveETH))    : 0;
    const pendingETH = roiData ? parseFloat(ethers.utils.formatEther(roiData.pendingETH)) : 0;
    const baseETH    = liveETH + pendingETH;

    // Fetch token price and symbol
    let tokenSym = 'HORDEX', tokenPrice = 0;
    if (platformToken) {
      try {
        const pool = await _dashGetPoolPrice(platformToken);
        if (pool) tokenPrice = pool.priceEth;
      } catch(_) {}
      try { const t = await contract.getToken(platformToken); if (t.symbol) tokenSym = t.symbol; } catch(_) {}
    }

    // Compute per-second accrual rate + per-stream details — all from lock data, no extra RPC calls.
    // capETH = ethInv * commRate / 10_000  (mirrors contract's initROIStreamsExt formula)
    // accruedETH = same linear formula as _calcAccrued (recipientSince ≈ lockedAt for new streams)
    let ratePerSec = 0;
    const wallNow  = Math.floor(Date.now() / 1000);
    const blockTs  = latestBlock ? latestBlock.timestamp : wallNow;
    const effNow   = Math.max(blockTs, wallNow);
    _rwROIStreamDetails = [];

    if (streams.length > 0) {
      const lockDataMap   = new Map();
      const streamInfoMap = new Map();
      const uniqueInvKeys = [...new Set(streams.map(r => r.investor.toLowerCase()))];
      await Promise.all([
        ...uniqueInvKeys.map(async (key) => {
          const addr = streams.find(r => r.investor.toLowerCase() === key).investor;
          try { lockDataMap.set(key, await contract.getUserLPLocks(addr)); } catch(_) {}
        }),
        ...streams.map(async (ref) => {
          const key = `${ref.investor.toLowerCase()}:${Number(ref.lockIndex)}:${Number(ref.level)}`;
          try {
            const info = await contract.getROIStreamInfo(ref.investor, ref.lockIndex, ref.level);
            streamInfoMap.set(key, info);
          } catch(_) {}
        })
      ]);

      for (const ref of streams) {
        const lock = (lockDataMap.get(ref.investor.toLowerCase()) || [])[Number(ref.lockIndex)];
        if (!lock || lock.removed) continue;
        const unlockTime = Number(lock.unlockTime);
        const lockedAt   = Number(lock.lockedAt);
        const lockDur    = unlockTime - lockedAt;
        if (lockDur <= 0) continue;
        const ethInv   = parseFloat(ethers.utils.formatEther(lock.ethInvested));
        const ratePPM  = lock.rewardRatePPM ? lock.rewardRatePPM.toNumber() : 0;
        const commRate = COMM_RATES[Number(ref.level)] || 0;
        const capETH   = ethInv * commRate / 10_000;
        const streamRate = (effNow < unlockTime && ratePPM > 0)
          ? ethInv * ratePPM * commRate / (50_000_000_000 * lockDur)
          : 0;

        const streamKey    = `${ref.investor.toLowerCase()}:${Number(ref.lockIndex)}:${Number(ref.level)}`;
        const streamInfo   = streamInfoMap.get(streamKey);
        const roiPaidETH   = streamInfo ? parseFloat(ethers.utils.formatEther(streamInfo.roiPaidETH)) : 0;
        const recSince     = streamInfo ? Number(streamInfo.recipientSince) : lockedAt;

        // Accrue from recipientSince (more accurate than from lockedAt), capped by remaining cap
        const startTs    = Math.max(lockedAt, recSince);
        const elapsed2   = Math.max(0, Math.min(unlockTime, effNow) - startTs);
        const capLeft    = Math.max(0, capETH - roiPaidETH);
        const accruedETH = lockDur > 0 && ratePPM > 0
          ? Math.min(capLeft, ethInv * ratePPM * elapsed2 * commRate / (50_000_000_000 * lockDur))
          : 0;

        ratePerSec += streamRate;
        _rwROIStreamDetails.push({
          investor: ref.investor, lockIndex: Number(ref.lockIndex), level: Number(ref.level),
          commRate, ethInv, capETH, accruedETH, streamRate, roiPaidETH
        });
      }
    }

    _rwROIBaseETH     = baseETH;
    _rwROIRatePerSec  = ratePerSec;
    _rwROIFetchWall   = wallNow;
    _rwROITokenSym    = tokenSym;
    _rwROITokenPrice  = tokenPrice;
    _rwROIActiveCount = streams.length;

    const claimTokens = tokenPrice > 0 && baseETH > 0.000001 ? baseETH / tokenPrice : 0;
    const canClaim    = baseETH > 0.000001;

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">LIVE ACCRUING (USDT) <span style="color:#a78bfa;font-size:9px;">●</span></div>
          <div id="rwROILive" style="font-size:16px;color:#a78bfa;font-family:var(--font-display);">$${(liveETH * USDT_PER_ETH).toFixed(5)}</div>
          <div style="font-size:9px;color:var(--muted);margin-top:3px;font-family:var(--font-mono);">${streams.length} active stream${streams.length !== 1 ? 's' : ''}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">SETTLED PENDING (USDT)</div>
          <div style="font-size:16px;color:var(--cream);font-family:var(--font-display);">$${fmtNum(pendingETH * USDT_PER_ETH)}</div>
          <div style="font-size:9px;color:var(--muted);margin-top:3px;font-family:var(--font-mono);">from redirected streams</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">CLAIMABLE (TOKENS)</div>
          <div id="rwROITokens" style="font-size:16px;color:var(--gold);font-family:var(--font-display);">${claimTokens > 0.000001 ? fmtNum(claimTokens) + ' ' + tokenSym : '—'}</div>
        </div>
      </div>

      <div style="margin-bottom:12px;">
        <button id="claimROIBtn" onclick="claimAllROI()"
          style="background:${canClaim ? 'var(--gold)' : 'rgba(255,255,255,0.06)'};
                 border:1px solid ${canClaim ? 'var(--gold)' : 'var(--border)'};
                 color:${canClaim ? '#0a0a0a' : 'var(--muted)'};
                 border-radius:4px;padding:10px 24px;font-family:var(--font-mono);
                 font-size:11px;font-weight:700;letter-spacing:1px;
                 cursor:${canClaim ? 'pointer' : 'not-allowed'};transition:opacity 0.15s;"
          ${canClaim ? '' : 'disabled'}>
          ${canClaim ? 'CLAIM ALL · ' + fmtNum(claimTokens) + ' ' + tokenSym : 'NOTHING TO CLAIM'}
        </button>
        <div style="font-size:10px;color:var(--muted);margin-top:6px;font-family:var(--font-mono);">Accumulates from your downline's staking rewards · No cooldown</div>
      </div>

      ${streams.length === 0 && pendingETH < 0.000001 ? '<div class="empty-state">No active ROI streams. Refer active investors to start earning.</div>' : ''}

      <div id="rwROIStreamsContainer">${_rwROIStreamsHtml()}</div>`;

    // Snap bars to rendered positions without CSS transition (same as staking)
    el.querySelectorAll('.dis-bar-active, .dis-bar-claimed').forEach(b => b.style.transition = 'none');
    requestAnimationFrame(() => requestAnimationFrame(() =>
      el.querySelectorAll('.dis-bar-active, .dis-bar-claimed').forEach(b => b.style.transition = '')
    ));

    _rwStopROITicker();
    _rwStartROITicker();
  } catch(e) {
    if (!silent) el.innerHTML = `<div class="empty-state">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  } finally {
    _rwROILoading = false;
  }
}

async function claimROIFromStreamBtn(investor, lockIndex, level, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'CLAIMING…'; }
  try {
    toast('Confirm ROI claim in MetaMask…', 'info');
    const tx = await contract.connect(signer).claimROIFromStream(investor, lockIndex, level, _GAS);
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    toast('ROI commission claimed!', 'success');
    loadRwROI();
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'CLAIM'; }
    toast('Claim failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function claimAllROI() {
  const btn = document.getElementById('claimROIBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'CLAIMING…'; }
  try {
    toast('Confirm ROI commission claim in MetaMask…', 'info');
    const tx = await contract.connect(signer).claimAllROI(_GAS);
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    toast('ROI commissions claimed!', 'success');
    loadRwROI();
  } catch(e) {
    if (btn) { btn.disabled = false; }
    toast('Claim failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

// ─── loadRwLPFees ─────────────────────────────────────────────────────────────

async function loadRwLPFees(silent = false) {
  const el = document.getElementById('rwLPFeesContent');
  if (!silent) {
    el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  }
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

    for (let i = lpLocks.length - 1; i >= 0; i--) {
      const lock        = lpLocks[i];
      const key         = lock.token.toLowerCase();
      const pool        = poolCache.get(key);
      const td          = tokenMeta.get(key) || { symbol: lock.token, meta: {} };
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
          ${currentETH > 0 ? `<div style="font-size:9px;color:${gainClr};opacity:0.75;">${(gainETH >= 0 ? '+' : '') + fmtNum(gainPct, 2)}%</div>` : ''}
        </td>
        <td style="padding:9px 8px;text-align:right;font-size:10px;color:${statusClr};">${statusTxt}</td>
      </tr>`;
    }

    const totalClr = totalGainETH > 0.000001 ? '#4ade80' : totalGainETH < -0.000001 ? '#f87171' : 'var(--muted)';

    el.innerHTML = `
      <div style="background:rgba(201,168,76,0.06);border:1px solid rgba(201,168,76,0.18);border-radius:6px;padding:12px 14px;margin-bottom:16px;font-size:11px;font-family:var(--font-mono);">
        <div style="color:var(--gold);letter-spacing:1px;font-size:10px;margin-bottom:5px;">HOW UNISWAP V2 POOL FEES WORK</div>
        <div style="color:var(--muted);line-height:1.75;">Every swap charges a <span style="color:var(--cream);">0.3% fee</span> that flows to LP providers. Fees <span style="color:var(--cream);">compound automatically</span> — your LP tokens grow in value with every swap. <span style="color:var(--cream);">No separate fee claim needed.</span> Earnings are included when you claim or remove LP tokens.</div>
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

window._rwAppendCommission = _rwAppendCommission;
window.loadRewards        = loadRewards;
window.loadRwReferral     = loadRwReferral;
window.loadRwStaking      = loadRwStaking;
window.loadRwROI          = loadRwROI;
window.loadRwLPFees       = loadRwLPFees;
window._rwStopPoll        = _rwStopPoll;
window._rwStartPoll       = _rwStartPoll;
window.claimStakingReward      = claimStakingReward;
window.claimAllROI             = claimAllROI;
window.claimROIFromStreamBtn   = claimROIFromStreamBtn;
window.setRwRefPerPage       = setRwRefPerPage;
window.setRwRefPage          = setRwRefPage;
window.sortRwRef             = sortRwRef;
window.setRwROIStreamPage    = setRwROIStreamPage;
window.setRwROIStreamPerPage = setRwROIStreamPerPage;
