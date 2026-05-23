// ── SHARED COUNTDOWN STATE (used by investments.js too) ──
// var (not let) so these are window-level globals visible across script tags
var _dashCountdownInterval  = null;
var _invCountdownInterval   = null;
var _dashPollInterval       = null;
var _dashTeamStatsLastFetch = 0;

function _dashStopPoll() {
  if (_dashPollInterval) { clearInterval(_dashPollInterval); _dashPollInterval = null; }
}

function _dashStartPoll() {
  _dashStopPoll();
  _dashPollInterval = setInterval(() => {
    const panel = document.getElementById('panel-dashboard');
    if (!panel || !panel.classList.contains('active')) { _dashStopPoll(); return; }
    loadDashboard(true);
  }, 10000);
}

// ── Dashboard staking live ticker ──
var _dashStakingTickInterval = null;
var _dashStakingTickLocks    = [];
var _dashStakingTickPrices   = [];
var _dashStakingTickBase     = 0;
var _dashStakingTickWall     = 0;
var _dashWealthBase          = 0;  // non-staking portion of My Wealth (LP value + ref earnings + invested)
// Sum of ethEquivalent from all StakingRewardClaimed events — stable across restakes.
// rewardClaimedETH on each lock resets to 0 at every restake, but these events never disappear.
var _dashStakingEventsBase   = 0;
// In-memory high-water mark so the staking display never decreases (e.g. token price dip).
var _dashStakingHWM          = 0;
var _dashRefNow    = 0;
var _dashWallRef   = 0;

// Cached lock data for badge popup functions (set at end of loadDashboard).
var _dashLpLocks = [];
var _dashEffNow  = 0;

// ── Team Wealth real-time ticker ──
var _dashTeamWealthTicker    = null;
var _dashTeamWealthFetcher   = null;
var _dashTeamWealthParams    = [];  // wealthParams for each downline member
var _dashTeamWealthAddrs     = [];  // downline addresses (set once per load)
var _dashTeamWealthLastFetch = 0;

function _dashStopTeamWealth() {
  if (_dashTeamWealthTicker)  { clearInterval(_dashTeamWealthTicker);  _dashTeamWealthTicker  = null; }
  if (_dashTeamWealthFetcher) { clearInterval(_dashTeamWealthFetcher); _dashTeamWealthFetcher = null; }
}

function _dashUpdateTeamWealthDisplay() {
  const el = document.getElementById('dashTeamWealth');
  if (!el) { _dashStopTeamWealth(); return; }
  let total = 0;
  for (const p of _dashTeamWealthParams) total += _computeWealthFromParams(p);
  el.innerHTML = total > 0.000001
    ? `<span style="color:#a855f7;">${fmtUSDT(total, {decimals:2})}</span>`
    : '<span style="color:var(--muted);">—</span>';
}

async function _loadDashTeamWealth() {
  const _tsNow = Date.now();
  if (_tsNow - _dashTeamWealthLastFetch < 25000) return;
  _dashTeamWealthLastFetch = _tsNow;
  _dashStopTeamWealth();
  try {
    const treeData = await fetchGeneTree(walletAddress, 1);
    const allAddrs = _geneCollectAddrs(treeData).slice(1); // exclude self
    _dashTeamWealthAddrs = allAddrs;
    if (allAddrs.length === 0) {
      _dashTeamWealthParams = [];
      _dashUpdateTeamWealthDisplay();
      return;
    }
    const paramsList = await Promise.all(
      allAddrs.map(a => contract.getWealthParams(a).catch(() => null))
    );
    _dashTeamWealthParams = paramsList.filter(p => p !== null);
    _dashUpdateTeamWealthDisplay();
    // Update display every 1s via wall-clock advancement
    _dashTeamWealthTicker = setInterval(_dashUpdateTeamWealthDisplay, 1000);
    // Re-fetch params from chain every 10s
    _dashTeamWealthFetcher = setInterval(async () => {
      const el = document.getElementById('dashTeamWealth');
      if (!el) { _dashStopTeamWealth(); return; }
      try {
        const fresh = await Promise.all(
          _dashTeamWealthAddrs.map(a => contract.getWealthParams(a).catch(() => null))
        );
        _dashTeamWealthParams = fresh.filter(p => p !== null);
      } catch(e) {}
    }, 10000);
  } catch(e) {
    console.error('_loadDashTeamWealth', e);
  }
}

// ── Referral popup wealth ticker ──
var _refPopupTickInterval    = null;
var _refPopupParamFetchTimer = null;
var _refPopupStatsFetchTimer = null;
var _refPopupCurrentAddr     = null;
var _refPopupWealthParams    = null;  // latest WealthParams from contract.getWealthParams()
// Offset between blockchain time and wall clock (can differ on Hardhat mainnet forks).
var _blockTimeOffset = 0;
// High-water mark for effective blockchain time — advances by wall-clock elapsed time
// between loadInvestments() calls so the timer never regresses even when the chain
// hasn't mined a new block (common on Hardhat forks in automine mode).
var _maxEffectiveNow  = 0;
var _lastLoadWallTime = 0;

function _dashFmtCountdown(secsLeft) {
  const s = Math.floor(secsLeft);
  if (!Number.isFinite(s) || s <= 0) return null;
  return {
    d: Math.floor(s / 86400),
    h: Math.floor((s % 86400) / 3600),
    m: Math.floor((s % 3600) / 60),
    s: s % 60
  };
}

function _dashFmtCompact(cd) {
  const p = n => String(n).padStart(2, '0');
  return `${cd.d} days ${p(cd.h)}:${p(cd.m)}:${p(cd.s)}`;
}

function _dashTickCountdowns() {
  // Advance from the effective blockchain time recorded at last load, not from wall
  // clock + offset — this stays correct even after multiple loadInvestments() calls
  // where _blockTimeOffset shifts but _dashRefNow/_dashWallRef are anchored together.
  const nowSec = _dashRefNow + Math.floor(Date.now() / 1000 - _dashWallRef);

  let anyExpired = false;

  // ── Lock countdown timers ──
  document.querySelectorAll('#investmentsContent [data-unlock-time]').forEach(el => {
    const unlockTime = Number(el.dataset.unlockTime);
    const secsLeft   = unlockTime - nowSec;
    const tv         = el.querySelector('.dis-timer-val');
    if (!tv) return;
    if (secsLeft <= 0) {
      tv.textContent = '0 days 00:00:00';
      anyExpired = true;
    } else {
      const cd = _dashFmtCountdown(secsLeft);
      if (cd) tv.textContent = _dashFmtCompact(cd);
    }
  });

  // ── Staking reward progress (linear per-second) ──
  document.querySelectorAll('#investmentsContent .dash-inv-staking').forEach(el => {
    const lockedAt         = Number(el.dataset.stakingLockedAt);
    const lockDurSecs      = Number(el.dataset.lockDurSecs || '60');
    const rewardTotalEth   = parseFloat(el.dataset.rewardTotalEth || '0');
    const rewardClaimedEth = parseFloat(el.dataset.rewardClaimedEth || '0');
    const priceEth         = parseFloat(el.dataset.priceEth || '0');
    const tokenSymbol      = el.dataset.tokenSymbol || 'HORDEX';
    const invIndex         = Number(el.dataset.invIndex || '0');
    const tokensAccumulated = parseFloat(el.dataset.tokensAccumulated || '0');
    const perSecUSDT       = parseFloat(el.dataset.perSecUsdt || '0');
    if (!lockedAt) return;

    const elapsed    = Math.min(lockDurSecs, Math.max(0, nowSec - lockedAt));
    const earnedETH  = lockDurSecs > 0 ? rewardTotalEth * elapsed / lockDurSecs : 0;
    const pendingETH = Math.max(0, earnedETH - rewardClaimedEth);

    // Progress bar: claimed portion + pending (earned but not yet claimed).
    const claimedPct = rewardTotalEth > 0 ? Math.min(100, rewardClaimedEth / rewardTotalEth * 100) : 0;
    const pendingPct = rewardTotalEth > 0 ? Math.min(100 - claimedPct, pendingETH / rewardTotalEth * 100) : 0;
    const slotsEl = el.querySelector('.dis-slots');
    if (slotsEl) {
      let track = slotsEl.querySelector('.dis-bar-track');
      if (!track) {
        slotsEl.innerHTML = `<div class="dis-bar-track"><div class="dis-bar-claimed"></div><div class="dis-bar-active"></div></div>`;
        track = slotsEl.querySelector('.dis-bar-track');
      }
      const claimedBar = track.querySelector('.dis-bar-claimed');
      const activeBar  = track.querySelector('.dis-bar-active');
      if (claimedBar) claimedBar.style.width = claimedPct.toFixed(3) + '%';
      if (activeBar)  { activeBar.style.left = claimedPct.toFixed(3) + '%'; activeBar.style.width = pendingPct.toFixed(3) + '%'; }
    }

    // Reward label.
    const accumulatedUSDT = tokensAccumulated * priceEth * USDT_PER_ETH;
    const liveUSDT = pendingETH * USDT_PER_ETH + accumulatedUSDT;
    const rewardEl = el.querySelector('.dis-sl-reward');
    if (rewardEl) {
      rewardEl.textContent = perSecUSDT > 0 || accumulatedUSDT > 0
        ? '$' + fmtNum(liveUSDT, 3) + ' USDT'
        : '— USDT';
    }

    // Claim footer.
    const claimTokens = (priceEth > 0 ? pendingETH / priceEth : 0) + tokensAccumulated;
    const canClaim    = claimTokens > 0;
    const footerEl    = el.querySelector('.dis-staking-footer');
    if (footerEl) {
      const hasBtn = !!footerEl.querySelector('.inv-btn-claim-staking');
      if (canClaim && !hasBtn) {
        footerEl.innerHTML = `<button class="inv-action-btn inv-btn-claim-staking" id="claimStakingBtn-${invIndex}" onclick="claimStakingRewardForLock(${invIndex})">CLAIM ${fmtNum(claimTokens)} ${tokenSymbol}</button>`;
      } else if (canClaim && hasBtn) {
        const btn = footerEl.querySelector('.inv-btn-claim-staking');
        if (btn && !btn.disabled) btn.textContent = 'CLAIM ' + fmtNum(claimTokens) + ' ' + tokenSymbol;
      } else if (!canClaim && hasBtn) {
        const hint = elapsed >= lockDurSecs
          ? `Staking period complete · max reward reached`
          : liveUSDT > 0
            ? `$${fmtNum(liveUSDT, 3)} USDT earned · $${fmtNum(perSecUSDT, 3)} USDT/sec`
            : `Rewards accumulating · $${fmtNum(perSecUSDT, 3)} USDT/sec`;
        footerEl.innerHTML = `<div class="dis-staking-hint">${hint}</div>`;
      }
    }
  });

  if (anyExpired) {
    clearInterval(_invCountdownInterval);
    _invCountdownInterval = null;
    loadInvestments();
  }
}

function _dashStopStakingTicker() {
  if (_dashStakingTickInterval) { clearInterval(_dashStakingTickInterval); _dashStakingTickInterval = null; }
}

function _dashStartStakingTicker() {
  _dashStopStakingTicker();
  if (!_dashStakingTickLocks.length) return;
  // Don't start if every lock has already elapsed its full duration — nothing will accumulate.
  const hasActive = _dashStakingTickLocks.some(l => {
    if (l.removed) return false;
    const ut  = Number(l.unlockTime);
    const la  = Number(l.lockedAt) || (ut - 60);
    const dur = Math.max(ut - la, 60);
    return Math.min(dur, Math.max(0, _dashStakingTickBase - la)) < dur;
  });
  if (!hasActive) return;

  _dashStakingTickInterval = setInterval(() => {
    const el = document.getElementById('dashStakingRewards');
    if (!el) { _dashStopStakingTicker(); return; }
    const now = _dashStakingTickBase + (Math.floor(Date.now() / 1000) - _dashStakingTickWall);
    // Base = ETH from all StakingRewardClaimed events (stable, never resets on restake).
    // Per-lock we add only: pendingETH (live, ticking) + tokensAccumulated * price (carry).
    // claimedETH per lock is already captured in _dashStakingEventsBase — don't double-count.
    let totalETH = _dashStakingEventsBase;
    let anyStillActive = false;
    let activeLockCount = 0;
    for (let i = 0; i < _dashStakingTickLocks.length; i++) {
      const lock         = _dashStakingTickLocks[i];
      if (lock.removed) continue;
      const ut           = Number(lock.unlockTime);
      const la           = Number(lock.lockedAt) || (ut - 60);
      const dur          = Math.max(ut - la, 60);
      const eth          = parseFloat(ethers.utils.formatEther(lock.ethInvested));
      const elapsed      = Math.min(dur, Math.max(0, now - la));
      const ratePPM_tick = lock.rewardRatePPM ? lock.rewardRatePPM.toNumber() : 0;
      const rwEth_tick   = ratePPM_tick > 0 ? eth * ratePPM_tick / 1_000_000 : 0;
      const earnedETH    = dur > 0 ? rwEth_tick * elapsed / dur : 0;
      const claimedETH   = parseFloat(ethers.utils.formatEther(lock.rewardClaimedETH || ethers.BigNumber.from(0)));
      const tokensAcc    = parseFloat(ethers.utils.formatEther(lock.tokensAccumulated || ethers.BigNumber.from(0)));
      const priceEth     = _dashStakingTickPrices[i] || 0;
      const pendingETH   = Math.max(0, earnedETH - claimedETH);
      totalETH += pendingETH + tokensAcc * priceEth;
      if (elapsed < dur) { anyStillActive = true; activeLockCount++; }
    }

    // In-memory HWM only — prevents same-session regression from price dips
    // without freezing the display across restake periods.
    if (totalETH > _dashStakingHWM) _dashStakingHWM = totalETH;
    const displayETH = Math.max(totalETH, _dashStakingHWM);

    el.innerHTML = displayETH > 0.000001
      ? `<span style="color:var(--gold);">${fmtUSDT(displayETH, {decimals:3})}</span>`
      : '<span style="color:var(--muted);">—</span>';

    const wealthEl = document.getElementById('dashPnL');
    if (wealthEl) {
      const liveWealthETH = _dashWealthBase + displayETH;
      wealthEl.innerHTML = liveWealthETH > 0 ? fmtUSDT(liveWealthETH, {decimals:2}) : '—';
    }

    // All locks have now expired — stop ticking, the value is final.
    if (!anyStillActive) _dashStopStakingTicker();
  }, 1000);
}

async function _dashGetPoolPrice(tokenAddr) {
  try {
    const factory  = getFactory();
    const pairAddr = await factory.getPair(tokenAddr, DEX_WETH);
    if (!pairAddr || pairAddr === ethers.constants.AddressZero) return null;
    const pair = getPairContract(pairAddr);
    const [reserves, token0, totalSupply] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
      pair.totalSupply()
    ]);
    const isToken0 = token0.toLowerCase() === tokenAddr.toLowerCase();
    const rawToken = isToken0 ? reserves.reserve0 : reserves.reserve1;
    const rawETH   = isToken0 ? reserves.reserve1 : reserves.reserve0;

    let dec = 18;
    try {
      const t = new ethers.Contract(tokenAddr, ["function decimals() view returns (uint8)"], provider);
      dec = Number(await t.decimals());
    } catch(_) {}

    const resToken = parseFloat(ethers.utils.formatUnits(rawToken, dec));
    const resETH   = parseFloat(ethers.utils.formatEther(rawETH));
    const priceEth = resToken > 0 ? resETH / resToken : 0;

    return { priceEth, resETH, resToken, totalLPSupply: totalSupply, pairAddr };
  } catch(_) { return null; }
}

function _dashComputeLPValue(lpAmount, resETH, totalLPSupply) {
  if (!totalLPSupply || totalLPSupply.eq(0)) return 0;
  try {
    const lpFloat    = parseFloat(ethers.utils.formatEther(lpAmount));
    const totalFloat = parseFloat(ethers.utils.formatEther(totalLPSupply));
    return (lpFloat / totalFloat) * resETH * 2;
  } catch(_) { return 0; }
}

function copyRefLink() {
  const el = document.getElementById('dashRefLink');
  if (!el) return;
  el.select();
  navigator.clipboard.writeText(el.value)
    .then(() => toast('Referral link copied!', 'success'))
    .catch(() => { document.execCommand('copy'); toast('Referral link copied!', 'success'); });
}

// ── Featured banner ──
async function loadFeaturedBanner() {
  const banner = document.getElementById('dashFeaturedBanner');
  if (!contract) return;
  try {
    const addrs = await contract.getRegisteredTokens();
    if (!addrs.length) return;
    const latest = addrs[addrs.length - 1];
    const t    = await contract.getToken(latest);
    const meta = getMeta(latest);
    document.getElementById('featuredSymbol').textContent = t.symbol;
    document.getElementById('featuredName').textContent   = t.name;
    const logoEl = document.getElementById('featuredLogo');
    if (meta && meta.logo) {
      logoEl.innerHTML = `<img src="${meta.logo}" style="width:100%;height:100%;object-fit:contain;border-radius:5px;"/>`;
    } else {
      logoEl.textContent = '⬡';
    }
    banner.style.display = '';
  } catch(_) {}
}

function dismissFeaturedBanner() {
  document.getElementById('dashFeaturedBanner').style.display = 'none';
}

// ── STAT LINE GRAPH ──

let _graphCache        = null;
let _graphCleanup      = null;
let _graphPendingTimer = null;

const GRAPH_OPTS = {
  invested: { label: 'TOTAL INVESTED',    unit: 'USDT', color: '#c9a84c', yLabel: 'USDT Invested' },
  lpvalue:  { label: 'LP FEES',           unit: 'USDT', color: '#e2e8f0', yLabel: 'USDT (LP P/L)' },
  referral: { label: 'REFERRAL EARNINGS', unit: 'USDT', color: '#4ade80', yLabel: 'USDT Earned' },
  staking:  { label: 'STAKING REWARDS',   unit: 'USDT', color: '#a78bfa', yLabel: 'USDT value of token rewards' },
  pnl:      { label: 'My Wealth',         unit: 'USDT', color: '#60a5fa', yLabel: 'USDT Total Value' },
  locks:    { label: 'ACTIVE LOCKS',      unit: '',     color: '#c9a84c', yLabel: 'Positions' },
};

async function fetchGraphData() {
  if (!contract || !walletAddress) return null;
  try {
    const latestBlockNum = await provider.getBlockNumber();
    const fromBlock      = getFromBlock(latestBlockNum);
    const [userInfo, investEvents, refEvents] = await Promise.all([
      contract.users(walletAddress),
      queryFilterBatched(contract, contract.filters.Invested(walletAddress), fromBlock, 'latest'),
      queryFilterBatched(contract, contract.filters.CommissionPaid(walletAddress), fromBlock, 'latest'),
    ]);
    const regTime = Number(userInfo.registeredAt);

    const blockNums = [...new Set([
      ...investEvents.map(e => e.blockNumber),
      ...refEvents.map(e => e.blockNumber)
    ])];
    const blockMap = new Map();
    await Promise.all(blockNums.map(async bn => {
      try {
        const b = await provider.getBlock(bn);
        blockMap.set(bn, b.timestamp);
      } catch(_) {}
    }));

    const invPts = investEvents.map(ev => ({
      time:      blockMap.get(ev.blockNumber) || 0,
      ethAmount: parseFloat(ethers.utils.formatEther(ev.args.ethAmount)),
      lpTokens:  parseFloat(ethers.utils.formatEther(ev.args.lpTokens))
    })).filter(p => p.time > 0).sort((a, b) => a.time - b.time);

    const refPts = refEvents.map(ev => ({
      time:   blockMap.get(ev.blockNumber) || 0,
      amount: parseFloat(ethers.utils.formatEther(ev.args.amount))
    })).filter(p => p.time > 0).sort((a, b) => a.time - b.time);

    let lpPricePerToken = 0;
    if (invPts.length) {
      const tokenSet = [...new Set(investEvents.map(e => e.args.token.toLowerCase()))];
      let totalLPMinted = 0, totalCurrentETH = 0;
      for (const addr of tokenSet) {
        const pool = await _dashGetPoolPrice(addr).catch(() => null);
        if (!pool) continue;
        const myLP = invPts
          .filter(p => {
            const ev = investEvents.find(e => (blockMap.get(e.blockNumber) || 0) === p.time);
            return ev && ev.args.token.toLowerCase() === addr;
          })
          .reduce((s, p) => s + p.lpTokens, 0);
        const val = myLP > 0 ? _dashComputeLPValue(
          ethers.utils.parseEther(myLP.toFixed(18)),
          pool.resETH, pool.totalLPSupply
        ) : 0;
        totalLPMinted   += myLP;
        totalCurrentETH += val;
      }
      lpPricePerToken = totalLPMinted > 0 ? totalCurrentETH / totalLPMinted : 0;
    }

    return { regTime, invPts, refPts, lpPricePerToken };
  } catch(e) {
    console.error('fetchGraphData', e);
    return null;
  }
}

function buildSeries(type, data) {
  const now = Math.floor(Date.now() / 1000);
  if (!data) return [{ time: now, value: 0 }];
  const { regTime, invPts, refPts, lpPricePerToken } = data;
  const start = { time: regTime || now - 86400, value: 0 };

  if (type === 'invested') {
    const pts = [start]; let cum = 0;
    for (const p of invPts) { cum += p.ethAmount; pts.push({ time: p.time, value: cum }); }
    pts.push({ time: now, value: cum }); return pts;
  }
  if (type === 'lpvalue') {
    const pts = [start]; let cum = 0;
    for (const p of invPts) { cum += p.lpTokens * lpPricePerToken; pts.push({ time: p.time, value: cum }); }
    pts.push({ time: now, value: cum }); return pts;
  }
  if (type === 'referral') {
    const pts = [start]; let cum = 0;
    for (const p of refPts) { cum += p.amount; pts.push({ time: p.time, value: cum }); }
    pts.push({ time: now, value: cum }); return pts;
  }
  if (type === 'staking') {
    return [start, { time: now, value: 0 }];
  }
  if (type === 'pnl') {
    const events = [
      ...invPts.map(p => ({ time: p.time, type: 'invest', eth: p.ethAmount, lp: p.lpTokens })),
      ...refPts.map(p => ({ time: p.time, type: 'ref',    eth: p.amount }))
    ].sort((a, b) => a.time - b.time);
    const pts = [start];
    let invested = 0, lpVal = 0, refVal = 0;
    for (const ev of events) {
      if (ev.type === 'invest') { invested += ev.eth; lpVal += ev.lp * lpPricePerToken; }
      else                      { refVal   += ev.eth; }
      pts.push({ time: ev.time, value: (lpVal + refVal) - invested });
    }
    pts.push({ time: now, value: (lpVal + refVal) - invested });
    return pts;
  }
  if (type === 'locks') {
    const pts = [start]; let locks = 0;
    for (const p of invPts) { locks++; pts.push({ time: p.time, value: locks }); }
    pts.push({ time: now, value: locks }); return pts;
  }
  return [start, { time: now, value: 0 }];
}

// Scale a series from ETH to USDT — applied after buildSeries for all non-locks types
function _scaleSeriesToUSDT(type, pts) {
  if (type === 'locks') return pts;
  return pts.map(p => ({ time: p.time, value: p.value * USDT_PER_ETH }));
}

function drawLineGraph(canvas, series, color, unitLabel) {
  if (_graphCleanup) { _graphCleanup(); _graphCleanup = null; }

  const dpr  = window.devicePixelRatio || 1;
  const W    = canvas.parentElement.clientWidth || 600;
  const H    = 240;
  canvas.width        = W * dpr;
  canvas.height       = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const padL = 62, padR = 20, padT = 20, padB = 44;
  const cW = W - padL - padR;
  const cH = H - padT - padB;

  const times  = series.map(p => p.time);
  const vals   = series.map(p => p.value);
  const tMin   = times[0], tMax = times[times.length - 1] || tMin + 1;
  const vMin   = Math.min(0, ...vals);
  const vMax   = Math.max(...vals, 0.000001);
  const vRange = vMax - vMin || 1;

  const tx = (t) => padL + ((t - tMin) / (tMax - tMin || 1)) * cW;
  const ty = (v) => padT + cH - ((v - vMin) / vRange) * cH;

  ctx.clearRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(201,168,76,0.08)';
  ctx.fillStyle   = 'rgba(148,163,184,0.55)';
  ctx.font        = '10px monospace';
  ctx.textAlign   = 'right';
  ctx.lineWidth   = 1;
  const GRID_ROWS = 5;
  for (let i = 0; i <= GRID_ROWS; i++) {
    const v = vMin + (i / GRID_ROWS) * vRange;
    const y = ty(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    const label = Math.abs(v) < 0.001 && v !== 0 ? v.toExponential(1) : fmtNum(v);
    ctx.fillText(label, padL - 6, y + 3.5);
  }

  ctx.textAlign = 'center';
  const xTicks = Math.min(series.length, 5);
  for (let i = 0; i < xTicks; i++) {
    const idx = Math.round(i * (series.length - 1) / Math.max(xTicks - 1, 1));
    const x   = tx(series[idx].time);
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    ctx.fillText(_fmtTs(series[idx].time), x, H - padB + 16);
    ctx.strokeStyle = 'rgba(201,168,76,0.06)';
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + cH); ctx.stroke();
  }

  if (vMin < 0 && vMax > 0) {
    const y0 = ty(0);
    ctx.strokeStyle = 'rgba(201,168,76,0.2)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(W - padR, y0); ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = color + '22';
  ctx.beginPath();
  ctx.moveTo(tx(series[0].time), ty(0));
  for (let i = 0; i < series.length - 1; i++) {
    ctx.lineTo(tx(series[i].time), ty(series[i].value));
    ctx.lineTo(tx(series[i+1].time), ty(series[i].value));
  }
  ctx.lineTo(tx(series[series.length-1].time), ty(series[series.length-1].value));
  ctx.lineTo(tx(series[series.length-1].time), ty(0));
  ctx.closePath(); ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth   = 2.5;
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  ctx.moveTo(tx(series[0].time), ty(series[0].value));
  for (let i = 0; i < series.length - 1; i++) {
    ctx.lineTo(tx(series[i+1].time), ty(series[i].value));
    ctx.lineTo(tx(series[i+1].time), ty(series[i+1].value));
  }
  ctx.stroke();

  series.forEach(p => {
    ctx.beginPath();
    ctx.arc(tx(p.time), ty(p.value), 3.5, 0, Math.PI * 2);
    ctx.fillStyle   = color;
    ctx.strokeStyle = 'var(--bg)';
    ctx.lineWidth   = 1.5;
    ctx.fill(); ctx.stroke();
  });

  const tooltip   = document.getElementById('dashGraphTooltip');
  const canvasRect = () => canvas.getBoundingClientRect();

  function getHoverPoint(clientX) {
    const rect = canvasRect();
    const mouseX = clientX - rect.left;
    let best = null, bestDist = Infinity;
    series.forEach(p => {
      const px = tx(p.time);
      const d  = Math.abs(px - mouseX);
      if (d < bestDist) { bestDist = d; best = p; }
    });
    return { best, mouseX };
  }

  function showTooltip(clientX, clientY) {
    const rect = canvasRect();
    const { best, mouseX } = getHoverPoint(clientX);
    if (!best || mouseX < padL || mouseX > W - padR) { tooltip.style.display = 'none'; return; }
    const px = tx(best.time);
    const py = ty(best.value);

    ctx.clearRect(0, 0, W, H);
    drawLineGraph._redraw(ctx, series, color, tx, ty, padL, padR, padT, padB, cW, cH, W, H, vMin, vMax, vRange, tMin, tMax);

    ctx.strokeStyle = 'rgba(201,168,76,0.35)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + cH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(W - padR, py); ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle   = color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 2;
    ctx.fill(); ctx.stroke();

    const valLabel = unitLabel === 'USDT'
      ? fmtNum(best.value) + ' USDT'
      : unitLabel
        ? fmtNum(best.value) + ' ' + unitLabel
        : Math.round(best.value).toString();
    tooltip.innerHTML =
      `<div style="color:var(--muted);margin-bottom:3px;">${_fmtTsFull(best.time)}</div>` +
      `<div style="color:${color};font-size:13px;font-weight:bold;">${valLabel}</div>`;
    tooltip.style.display = 'block';
    let tx2 = px + 12, ty2 = py - 44;
    if (tx2 + 180 > W) tx2 = px - 180;
    if (ty2 < 0) ty2 = py + 10;
    tooltip.style.left = tx2 + 'px';
    tooltip.style.top  = ty2 + 'px';
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
    ctx.clearRect(0, 0, W, H);
    drawLineGraph._redraw(ctx, series, color, tx, ty, padL, padR, padT, padB, cW, cH, W, H, vMin, vMax, vRange, tMin, tMax);
  }

  const onMove  = (e) => { const cx = e.touches ? e.touches[0].clientX : e.clientX; const cy = e.touches ? e.touches[0].clientY : e.clientY; showTooltip(cx, cy); };
  const onLeave = () => hideTooltip();

  canvas.addEventListener('mousemove',  onMove);
  canvas.addEventListener('touchmove',  onMove, { passive: true });
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('touchend',   onLeave);

  _graphCleanup = () => {
    canvas.removeEventListener('mousemove',  onMove);
    canvas.removeEventListener('touchmove',  onMove);
    canvas.removeEventListener('mouseleave', onLeave);
    canvas.removeEventListener('touchend',   onLeave);
    if (tooltip) tooltip.style.display = 'none';
  };
}

drawLineGraph._redraw = function(ctx, series, color, tx, ty, padL, padR, padT, padB, cW, cH, W, H, vMin, vMax, vRange, tMin, tMax) {
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = 1;
  const GRID_ROWS = 5;
  for (let i = 0; i <= GRID_ROWS; i++) {
    const v = vMin + (i / GRID_ROWS) * vRange;
    const y = ty(v);
    ctx.strokeStyle = 'rgba(201,168,76,0.08)';
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    ctx.font = '10px monospace'; ctx.textAlign = 'right';
    const label = Math.abs(v) < 0.001 && v !== 0 ? v.toExponential(1) : fmtNum(v);
    ctx.fillText(label, padL - 6, y + 3.5);
  }
  const xTicks = Math.min(series.length, 5);
  for (let i = 0; i < xTicks; i++) {
    const idx = Math.round(i * (series.length - 1) / Math.max(xTicks - 1, 1));
    const x   = tx(series[idx].time);
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText(_fmtTs(series[idx].time), x, H - padB + 16);
    ctx.strokeStyle = 'rgba(201,168,76,0.06)';
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + cH); ctx.stroke();
  }
  if (vMin < 0 && vMax > 0) {
    const y0 = ty(0);
    ctx.strokeStyle = 'rgba(201,168,76,0.2)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(W - padR, y0); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = color + '22';
  ctx.beginPath();
  ctx.moveTo(tx(series[0].time), ty(0));
  for (let i = 0; i < series.length - 1; i++) {
    ctx.lineTo(tx(series[i].time), ty(series[i].value));
    ctx.lineTo(tx(series[i+1].time), ty(series[i].value));
  }
  ctx.lineTo(tx(series[series.length-1].time), ty(series[series.length-1].value));
  ctx.lineTo(tx(series[series.length-1].time), ty(0));
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(tx(series[0].time), ty(series[0].value));
  for (let i = 0; i < series.length - 1; i++) {
    ctx.lineTo(tx(series[i+1].time), ty(series[i].value));
    ctx.lineTo(tx(series[i+1].time), ty(series[i+1].value));
  }
  ctx.stroke();
  series.forEach(p => {
    ctx.beginPath(); ctx.arc(tx(p.time), ty(p.value), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.strokeStyle = '#04080f'; ctx.lineWidth = 1.5;
    ctx.fill(); ctx.stroke();
  });
};

function openStatGraph(type) {
  if (type === 'locks') return;

  const panel = document.getElementById('dashGraphPanel');

  if (panel.dataset.type === type && panel.style.display !== 'none') {
    closeStatGraph(); return;
  }

  document.querySelectorAll('.dash-stat-card').forEach(c => c.classList.remove('active-graph'));
  const clickedCard = document.getElementById('dashCard-' + type);
  if (clickedCard) {
    clickedCard.classList.add('active-graph');
    clickedCard.insertAdjacentElement('afterend', panel);
  }

  const opts = GRAPH_OPTS[type];
  document.getElementById('dashGraphTitle').textContent = opts.label + ' OVER TIME';
  document.getElementById('dashGraphSub').textContent   = opts.yLabel + '  ·  X-axis = time since registration';
  panel.dataset.type     = type;
  panel.style.transition = 'none';
  panel.style.opacity    = '0';
  panel.style.display    = '';

  const series  = _scaleSeriesToUSDT(type, buildSeries(type, _graphCache));
  const canvas  = document.getElementById('dashGraphCanvas');
  const emptyEl = document.getElementById('dashGraphEmpty');
  const hasData = series.some(p => p.value > 0);

  if (!hasData && _graphCache) {
    canvas.style.display  = 'none';
    emptyEl.style.display = '';
  } else {
    canvas.style.display  = '';
    emptyEl.style.display = 'none';
    requestAnimationFrame(() => drawLineGraph(canvas, series, opts.color, opts.unit));
  }

  if (!_graphCache && contract && walletAddress) {
    fetchGraphData().then(data => {
      _graphCache = data;
      const s2   = _scaleSeriesToUSDT(type, buildSeries(type, data));
      const has2 = s2.some(p => p.value > 0);
      if (!has2) {
        canvas.style.display  = 'none';
        emptyEl.style.display = '';
      } else {
        canvas.style.display  = '';
        emptyEl.style.display = 'none';
        requestAnimationFrame(() => drawLineGraph(canvas, s2, opts.color, opts.unit));
      }
    });
  }

  // Trigger visible 0.5s fade-in after browser paints the opacity:0 state
  requestAnimationFrame(() => requestAnimationFrame(() => {
    panel.style.transition = 'opacity 0.5s ease';
    panel.style.opacity    = '1';
  }));
}

function closeStatGraph() {
  const panel = document.getElementById('dashGraphPanel');
  panel.style.transition = '';
  panel.style.opacity    = '';
  panel.style.display    = 'none';
  panel.dataset.type     = '';
  document.querySelectorAll('.dash-stat-card').forEach(c => c.classList.remove('active-graph'));
  if (_graphCleanup) { _graphCleanup(); _graphCleanup = null; }
}

async function _loadDashTeamStats() {
  const volEl = document.getElementById('dashTeamVolume');
  const bizEl = document.getElementById('dashTeamBusiness');
  if (!volEl || !bizEl) return;
  const _tsNow = Date.now();
  if (_tsNow - _dashTeamStatsLastFetch < 25000) return;
  _dashTeamStatsLastFetch = _tsNow;
  try {
    const treeData  = await fetchGeneTree(walletAddress, 1);
    const allAddrs  = _geneCollectAddrs(treeData).slice(1); // exclude self (index 0)
    if (allAddrs.length === 0) {
      volEl.textContent = '0';
      bizEl.textContent = '—';
      return;
    }
    const amounts = await Promise.all(
      allAddrs.map(a => contract.userTotalInvested(a).catch(() => ethers.BigNumber.from(0)))
    );
    let teamVolume = 0, teamBusinessETH = 0;
    for (const amt of amounts) {
      const eth = parseFloat(ethers.utils.formatEther(amt));
      if (eth > 0) teamVolume++;
      teamBusinessETH += eth;
    }
    volEl.textContent  = teamVolume;
    bizEl.innerHTML    = teamBusinessETH > 0 ? fmtUSDT(teamBusinessETH, {decimals:2}) : '—';
  } catch(e) {
    console.error('_loadDashTeamStats', e);
  }
}

async function loadDashboard(silent = false) {
  if (!contract || !walletAddress) {
    document.getElementById('dashLoadingState').innerHTML =
      '<div class="empty-state" style="margin-top:20px;">Connect wallet to load your dashboard.</div>';
    return;
  }
  _dashStopStakingTicker();
  _tabLoaded.add('dashboard');
  document.getElementById('dashLoadingState').innerHTML = '';

  document.getElementById('dashStatsRow').style.display = 'grid';

  // Show refreshing indicator on user-triggered loads only; skip on background polls.
  if (!silent) {
    const _stakingElRef = document.getElementById('dashStakingRewards');
    if (_stakingElRef) _stakingElRef.innerHTML = '<span style="color:var(--muted);font-size:12px;">···</span>';
    // Clear direct refs list so a wallet switch forces a full reload (bypasses the DOM-card guard).
    const _drefListEl = document.getElementById('dashDirectRefsList');
    if (_drefListEl) _drefListEl.innerHTML = '';
    // Reset wallet-specific label state so the new wallet's labels are fetched fresh.
    _labelCache.clear();
    _labelCryptoKey  = null;
    _labelKeyPromise = null;
    _dashTeamStatsLastFetch  = 0;
    _dashTeamWealthLastFetch = 0;
    _dashStopTeamWealth();
  }

  try {
    const _latestBlockNum = await provider.getBlockNumber();
    const _fromBlock      = getFromBlock(_latestBlockNum);
    const [lpLocks, commStats, stakingReward, platformToken, stakingEvents, latestBlock] = await Promise.all([
      contract.getUserLPLocks(walletAddress),
      contract.getUserCommissionStats(walletAddress).catch(() => null),
      contract.getStakingReward(walletAddress).catch(() => null),
      contract.platformToken(),
      queryFilterBatched(contract, contract.filters.StakingRewardClaimed(walletAddress), _fromBlock, 'latest'),
      provider.getBlock('latest').catch(() => null),
    ]);

    const refEarningsETH = commStats ? parseFloat(ethers.utils.formatEther(commStats.earned)) : 0;
    // Cap state assigned after _effNow is established below.
    let capETH = 0, capRemETH = 0, pausedCapETH = 0, isEligible = false, isPaused = false;

    let totalInvestedETH = 0;
    let totalCurrentETH  = 0;
    let activeLocks      = 0;
    let totalLPTokens    = 0;
    let poolCache        = new Map();

    // Compute effective blockchain time first — advances with wall clock on Hardhat
    // forks where block.timestamp is frozen. Used for both activeLocks count and
    // the staking ticker so the dashboard stays in sync with the countdown timers.
    const _wallNow = Math.floor(Date.now() / 1000);
    const _blockTs = latestBlock ? latestBlock.timestamp : _wallNow;
    let _effNow = Math.max(_blockTs, _wallNow);
    try {
      const _rawRef = localStorage.getItem('hordex_eff_time') || sessionStorage.getItem('hordex_eff_time');
      const _sv = JSON.parse(_rawRef || 'null');
      if (_sv && typeof _sv.effectiveNow === 'number' && typeof _sv.wallNow === 'number'
          && _sv.blockNow <= _blockTs) {
        _effNow = Math.max(_blockTs, _sv.effectiveNow + Math.max(0, _wallNow - _sv.wallNow));
      }
    } catch(_) {}

    _dashLpLocks = lpLocks;
    _dashEffNow  = _effNow;

    // Compute referral cap state using _effNow (same clock as investments tab)
    // so PAUSED/ELIGIBLE badges stay in sync regardless of Hardhat block.timestamp lag.
    {
      let _lActiveCap = ethers.BigNumber.from(0);
      let _lPausedCap = ethers.BigNumber.from(0);
      for (const _lk of lpLocks) {
        if (_lk.removed) continue;
        const _capMax  = _lk.ethInvested.mul(5);
        const _capUsed = _lk.commissionsCapUsed || ethers.BigNumber.from(0);
        const _capLeft = _capMax.gt(_capUsed) ? _capMax.sub(_capUsed) : ethers.BigNumber.from(0);
        if (_capLeft.isZero()) continue;
        if (_effNow < Number(_lk.unlockTime)) {
          _lActiveCap = _lActiveCap.add(_capLeft);
        } else {
          _lPausedCap = _lPausedCap.add(_capLeft);
        }
      }
      capETH      = parseFloat(ethers.utils.formatEther(_lActiveCap.add(_lPausedCap)));
      capRemETH   = parseFloat(ethers.utils.formatEther(_lActiveCap));
      pausedCapETH = parseFloat(ethers.utils.formatEther(_lPausedCap));
      isEligible  = _lActiveCap.gt(0);
      isPaused    = !isEligible && _lPausedCap.gt(0);
    }

    if (lpLocks.length) {
      const tokenSet  = [...new Set(lpLocks.map(l => l.token.toLowerCase()))];
      await Promise.all(tokenSet.map(async addr => {
        const d = await _dashGetPoolPrice(addr);
        if (d) poolCache.set(addr, d);
      }));

      for (const lock of lpLocks) {
        totalInvestedETH += parseFloat(ethers.utils.formatEther(lock.ethInvested));
        if (!lock.claimed && !lock.removed && Number(lock.unlockTime) > _effNow) {
          activeLocks++;
          totalLPTokens += parseFloat(ethers.utils.formatEther(lock.lpAmount));
        }
        const pool = poolCache.get(lock.token.toLowerCase());
        if (pool && !lock.removed) totalCurrentETH += _dashComputeLPValue(lock.lpAmount, pool.resETH, pool.totalLPSupply);
      }
    }

    // ── Staking live ticker setup ──
    // Mirror the rewards tab: read hordex_eff_time written by the investments tab
    // (monotonically-advancing high-water mark that accounts for Hardhat's frozen
    // block.timestamp). Fall back to max(blockTs, wallNow) so expired locks are
    // never shown as still-accumulating when the chain clock lags wall clock.

    _dashStakingTickLocks  = lpLocks;
    _dashStakingTickPrices = lpLocks.map(l => (poolCache.get(l.token.toLowerCase()) || {}).priceEth || 0);
    _dashStakingTickBase   = _effNow;
    _dashStakingTickWall   = _wallNow;

    // Sum ethEquivalent from every StakingRewardClaimed event — this persists across
    // restakes even though rewardClaimedETH on each lock resets to 0 at restake time.
    _dashStakingEventsBase = stakingEvents.reduce((s, ev) => {
      try { return s + parseFloat(ethers.utils.formatEther(ev.args.ethEquivalent)); } catch(_) { return s; }
    }, 0);

    // Reset HWM to zero each load so the display starts from the live computed value
    // and visibly accumulates. The in-memory HWM still prevents same-session regressions
    // from token price dips, but a stale localStorage HWM from a previous restake period
    // would freeze the display until the new period surpassed the old peak.
    _dashStakingHWM = 0;

    // Compute initial total: events base + per-lock pending + carry.
    // Do NOT add rewardClaimedETH here — it is already counted in _dashStakingEventsBase.
    let _initTotalETH = _dashStakingEventsBase, _initAnyActive = false;
    for (let _i = 0; _i < lpLocks.length; _i++) {
      const _l          = lpLocks[_i];
      if (_l.removed) continue;
      const _ut         = Number(_l.unlockTime);
      const _la         = Number(_l.lockedAt) || (_ut - 60);
      const _dur        = Math.max(_ut - _la, 60);
      const _eth        = parseFloat(ethers.utils.formatEther(_l.ethInvested));
      const _el2        = Math.min(_dur, Math.max(0, _effNow - _la));
      const _ratePPM    = _l.rewardRatePPM ? _l.rewardRatePPM.toNumber() : 0;
      const _rwEth      = _ratePPM > 0 ? _eth * _ratePPM / 1_000_000 : 0;
      const _earnedETH  = _dur > 0 ? _rwEth * _el2 / _dur : 0;
      const _claimedETH = parseFloat(ethers.utils.formatEther(_l.rewardClaimedETH || ethers.BigNumber.from(0)));
      const _tokensAcc  = parseFloat(ethers.utils.formatEther(_l.tokensAccumulated || ethers.BigNumber.from(0)));
      const _priceEth   = _dashStakingTickPrices[_i] || 0;
      _initTotalETH += Math.max(0, _earnedETH - _claimedETH) + _tokensAcc * _priceEth;
      if (_effNow < _ut && _ratePPM > 0) _initAnyActive = true;
    }

    _dashStakingHWM = _initTotalETH;
    const _initDisplayETH = _initTotalETH;

    const totalValueETH = totalCurrentETH + refEarningsETH;
    const pnlETH  = totalValueETH - totalInvestedETH;
    const pnlCls  = pnlETH > 0.000001 ? '#4ade80' : pnlETH < -0.000001 ? '#f87171' : 'var(--muted)';

    document.getElementById('dashTotalInvested').innerHTML     = fmtUSDT(totalInvestedETH, {decimals:2});
    document.getElementById('dashTotalInvestedUSD').innerHTML  = '';
    const lpFeesETH   = Math.max(0, totalCurrentETH - totalInvestedETH);
    const myWealthETH = refEarningsETH + _initDisplayETH + lpFeesETH + totalInvestedETH;
    _dashWealthBase   = myWealthETH - _initDisplayETH;
    document.getElementById('dashTotalValue').innerHTML        = totalInvestedETH > 0 ? fmtUSDT(lpFeesETH, {decimals:2}) : '—';
    document.getElementById('dashTotalValue').style.color      = 'white';
    document.getElementById('dashTotalValueUSD').innerHTML     = '';
    const lpTokensEl = document.getElementById('dashLPTokens');
    if (lpTokensEl) lpTokensEl.textContent = totalLPTokens > 0 ? fmtNum(totalLPTokens) + ' LP' : '';
    document.getElementById('dashRefEarnings').innerHTML       = fmtUSDT(refEarningsETH, {decimals: 3});
    document.getElementById('dashRefEarningsUSD').innerHTML    =
      isEligible
        ? `<span style="color:var(--muted);">Cap: ${fmtUSDT(capRemETH, {decimals:2})} remaining</span>`
        : isPaused
          ? `<span style="color:rgba(234,179,8,0.7);">Cap: ${fmtUSDT(pausedCapETH, {decimals:2})} paused</span>`
          : '';

    const eligBadge = isEligible
      ? '<span style="cursor:pointer;font-size:9px;background:rgba(74,222,128,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.3);padding:2px 6px;border-radius:3px;letter-spacing:1px;" onclick="event.stopPropagation();navToRewards(\'referral\')">ELIGIBLE</span>'
      : isPaused
        ? '<span style="cursor:pointer;font-size:9px;background:rgba(234,179,8,0.15);color:#eab308;border:1px solid rgba(234,179,8,0.3);padding:2px 6px;border-radius:3px;letter-spacing:1px;" onclick="showPausedLocksPopup(event)">PAUSED</span>'
        : '<span style="cursor:pointer;font-size:9px;background:rgba(248,113,113,0.12);color:#f87171;border:1px solid rgba(248,113,113,0.3);padding:2px 6px;border-radius:3px;letter-spacing:1px;" onclick="showIneligiblePopup(event)">INELIGIBLE</span>';
    document.getElementById('dashStakingRewards').innerHTML = _initDisplayETH > 0.000001
      ? `<span style="color:var(--gold);">${fmtUSDT(_initDisplayETH, {decimals:3})}</span>` : '<span style="color:var(--muted);">—</span>';
    const stakingSubEl = document.querySelector('#dashCard-staking .dash-stat-sub');
    if (stakingSubEl) stakingSubEl.textContent = _initAnyActive
      ? 'accumulating'
      : lpLocks.length ? 'period complete · claim in rewards' : 'no active staking';
    _dashStartStakingTicker();
    const refLabelEl = document.querySelector('#dashCard-referral .dash-stat-label');
    if (refLabelEl) refLabelEl.innerHTML = `REFERRAL EARNINGS ${eligBadge} <span class="dash-stat-chart-hint">→</span>`;

    const pnlEl = document.getElementById('dashPnL');
    pnlEl.style.color = '#4ade80'; // Always green for My Wealth
    pnlEl.innerHTML = myWealthETH > 0 ? fmtUSDT(myWealthETH, {decimals:2}) : '—';
    const pnlPctEl = document.getElementById('dashPnLPct');
    pnlPctEl.style.color  = pnlCls;


    _graphCache = null;
    fetchGraphData().then(data => { _graphCache = data; });

    // Load team stats, team wealth, and direct referrals asynchronously
    _loadDashTeamStats();
    _loadDashTeamWealth();
    _loadDashDirectRefs();

  } catch(e) {
    document.getElementById('dashLoadingState').innerHTML =
      `<div class="empty-state">Error loading dashboard: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
    console.error('loadDashboard', e);
  }
}

// ── Label encryption (AES-GCM on HTTPS, plaintext fallback on HTTP) ─────────────
// On HTTPS: AES-GCM-256, key derived via HKDF from a one-time wallet signature.
// On HTTP (local-IP dev): raw UTF-8, no signature needed.  Labels saved in one
// mode are unreadable in the other; re-save after switching to HTTPS.
const _cryptoSecure  = !!crypto?.subtle && location.protocol === 'https:';
let _labelCryptoKey  = null;
let _labelKeyPromise = null; // singleton — prevents multiple concurrent sign requests
// In-memory cache so decryption never re-prompts within a session
const _labelCache    = new Map(); // refAddr.toLowerCase() → plaintext

async function _initLabelKey() {
  if (_labelCryptoKey) return _labelCryptoKey;

  // HTTP / non-secure context: skip wallet signature, use plaintext mode
  if (!_cryptoSecure) {
    _labelCryptoKey = 'PLAINTEXT';
    return _labelCryptoKey;
  }

  // If a sign request is already in-flight, return the same promise so mobile
  // wallets only see one pending request at a time.
  if (!_labelKeyPromise) {
    _labelKeyPromise = (async () => {
      // Reuse signature cached in sessionStorage so page-refresh doesn't re-prompt
      let sigHex = sessionStorage.getItem('hordex_lksig');
      if (!sigHex) {
        sigHex = await signer.signMessage(
          'HORDEX: Enable private label encryption for referral nicknames.\n' +
          'This is a free off-chain signature. No transaction will be sent.'
        );
        sessionStorage.setItem('hordex_lksig', sigHex);
      }
      const sigBytes = ethers.utils.arrayify(sigHex); // 65 bytes
      const raw = await crypto.subtle.importKey('raw', sigBytes, { name: 'HKDF' }, false, ['deriveKey']);
      _labelCryptoKey = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info: new TextEncoder().encode('HORDEX_REF_LABEL_V1') },
        raw,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      return _labelCryptoKey;
    })().catch(err => {
      _labelKeyPromise = null; // reset so the next call can retry
      throw err;
    });
  }
  return _labelKeyPromise;
}

async function _encryptLabel(plaintext) {
  const key = await _initLabelKey();
  if (key === 'PLAINTEXT') return new TextEncoder().encode(plaintext);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const out = new Uint8Array(12 + enc.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(enc), 12);
  return out;
}

async function _decryptLabel(bytes) {
  try {
    if (!bytes || bytes.length < 1) return '';
    const key = await _initLabelKey();
    if (key === 'PLAINTEXT') return new TextDecoder().decode(bytes);
    if (bytes.length < 13) return ''; // too short for IV + ciphertext
    const iv   = bytes.slice(0, 12);
    const data = bytes.slice(12);
    const dec  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(dec);
  } catch { return ''; }
}

// Fetch + decrypt a single label from chain (result cached in memory)
async function _getRefLabel(refAddr) {
  const key = refAddr.toLowerCase();
  if (_labelCache.has(key)) return _labelCache.get(key);
  try {
    const raw   = await contract.getRefLabel(walletAddress, refAddr);
    const bytes = ethers.utils.arrayify(raw);
    if (!bytes.length) {
      _labelCache.set(key, ''); // no label on-chain — cache permanently
      return '';
    }
    const label = await _decryptLabel(bytes);
    // Only cache on successful decryption; a failed decrypt (empty string) stays
    // un-cached so the next call (after signing) can retry automatically.
    if (label) _labelCache.set(key, label);
    return label;
  } catch { return ''; }
}

// Fetch + decrypt labels for many addresses in parallel
async function _batchGetRefLabels(addrs) {
  await Promise.all(addrs.map(a => _getRefLabel(a)));
}

function showRefLabelEdit() {
  document.getElementById('refLabelViewRow').style.display  = 'none';
  document.getElementById('refLabelEditForm').style.display = '';
  const inp = document.getElementById('refLabelInput');
  if (inp) { inp.focus(); inp.select(); }
}
function hideRefLabelEdit() {
  document.getElementById('refLabelViewRow').style.display  = '';
  document.getElementById('refLabelEditForm').style.display = 'none';
}
async function saveRefLabel(addr) {
  const inp     = document.getElementById('refLabelInput');
  const saveBtn = document.getElementById('refLabelSaveBtn');
  if (!inp) return;
  const val = inp.value.trim();

  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'SAVING…'; }
  try {
    const encBytes = val ? await _encryptLabel(val) : new Uint8Array(0);
    const tx = await contract.setRefLabel(addr, encBytes);
    if (saveBtn) saveBtn.textContent = 'CONFIRMING…';
    await tx.wait();

    // Update in-memory cache
    _labelCache.set(addr.toLowerCase(), val);

    // Update popup display
    const dispEl  = document.getElementById('refLabelDisplay');
    const viewBtn = document.getElementById('refLabelViewBtn');
    if (dispEl)  dispEl.textContent  = val || addr;
    if (viewBtn) viewBtn.textContent = val ? 'RENAME' : 'FIX LABEL';
    // Show / hide the address subtext depending on whether a label is now set
    const innerWrap = dispEl?.parentElement;
    if (innerWrap) {
      let subEl = innerWrap.querySelector('.ref-addr-sub');
      if (val && !subEl) {
        subEl = document.createElement('div');
        subEl.className = 'ref-addr-sub';
        subEl.style.cssText = 'font-family:var(--font-mono);font-size:10px;color:var(--muted);margin-top:3px;word-break:break-all;';
        subEl.textContent = addr;
        innerWrap.appendChild(subEl);
      } else if (!val && subEl) {
        subEl.remove();
      }
    }
    hideRefLabelEdit();

    // Update the matching card in the direct-refs list
    const card = document.getElementById('drefCard_' + addr.toLowerCase());
    if (card) {
      const nameEl = card.querySelector('.dash-dref-name');
      if (nameEl) nameEl.textContent = val || addr;
    }
    toast('Label saved on-chain.', 'success');
  } catch(e) {
    toast('Failed to save label: ' + (e.reason || e.message), 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'SAVE'; }
  }
}

function _computeCapState(locks) {
  let activeCap = ethers.BigNumber.from(0);
  let pausedCap = ethers.BigNumber.from(0);
  for (const l of locks) {
    if (l.removed) continue;
    const capMax  = l.ethInvested.mul(5);
    const capUsed = l.commissionsCapUsed || ethers.BigNumber.from(0);
    const capLeft = capMax.gt(capUsed) ? capMax.sub(capUsed) : ethers.BigNumber.from(0);
    if (capLeft.isZero()) continue;
    if (_dashEffNow < Number(l.unlockTime)) {
      activeCap = activeCap.add(capLeft);
    } else {
      pausedCap = pausedCap.add(capLeft);
    }
  }
  if (activeCap.gt(0)) return 'eligible';
  if (pausedCap.gt(0)) return 'paused';
  return 'ineligible';
}

async function _refreshDashDirectRefStats() {
  const listEl = document.getElementById('dashDirectRefsList');
  if (!listEl) return;
  const cards = [...listEl.querySelectorAll('.dash-dref-card[id^="drefCard_"]')];
  if (!cards.length) return;
  const addrs = cards.map(c => c.id.slice('drefCard_'.length));
  try {
    const [investedAmts, refCounts, refLocks] = await Promise.all([
      Promise.all(addrs.map(a => contract.userTotalInvested(a).catch(() => ethers.BigNumber.from(0)))),
      Promise.all(addrs.map(a => contract.getReferrals(a).catch(() => []).then(r => r.length))),
      Promise.all(addrs.map(a => contract.getUserLPLocks(a).catch(() => []))),
    ]);
    for (let i = 0; i < cards.length; i++) {
      const card     = cards[i];
      const addr     = addrs[i];
      const invested = parseFloat(ethers.utils.formatEther(investedAmts[i]));
      const dirCount = refCounts[i];
      const capState = _computeCapState(refLocks[i]);
      const invEl    = card.querySelector('.dash-dref-invested');
      if (invEl) invEl.innerHTML = `${invested > 0 ? fmtUSDT(invested, {decimals:2}) + ' invested' : 'No active investment'} &nbsp;·&nbsp; ${dirCount} direct ref${dirCount !== 1 ? 's' : ''}`;
      card.classList.remove('cap-paused', 'cap-ineligible', 'dref-no-invest');
      if (capState === 'paused')      card.classList.add('cap-paused');
      else if (capState === 'ineligible') card.classList.add('cap-ineligible');
      if (invested === 0) {
        card.classList.add('dref-no-invest');
        card.removeAttribute('onclick');
      } else if (!card.getAttribute('onclick')) {
        card.setAttribute('onclick', `openRefPopup('${addr}')`);
      }
    }
  } catch(e) { console.warn('_refreshDashDirectRefStats', e); }
}

async function _loadDashDirectRefs(force = false) {
  const section = document.getElementById('dashDirectRefsSection');
  const listEl  = document.getElementById('dashDirectRefsList');
  if (!section || !listEl) return;
  // On background polls, refresh existing cards in-place instead of rebuilding
  if (!force && listEl.querySelector('.dash-dref-card')) {
    _refreshDashDirectRefStats();
    return;
  }
  try {
    const refs = await contract.getReferrals(walletAddress).catch(() => []);
    if (!refs || refs.length === 0) { section.style.display = 'none'; return; }

    section.style.display = '';
    listEl.innerHTML = '<div style="color:var(--muted);font-family:var(--font-mono);font-size:11px;padding:8px 0;">Loading…</div>';

    const [investedAmts, refCounts, refLocks] = await Promise.all([
      Promise.all(refs.map(a => contract.userTotalInvested(a).catch(() => ethers.BigNumber.from(0)))),
      Promise.all(refs.map(a => contract.getReferrals(a).catch(() => []).then(r => r.length))),
      Promise.all(refs.map(a => contract.getUserLPLocks(a).catch(() => []))),
    ]);

    // Fetch labels from chain and decrypt (errors caught inside _getRefLabel)
    await _batchGetRefLabels(refs);

    listEl.innerHTML = refs.map((addr, i) => {
      const invested  = parseFloat(ethers.utils.formatEther(investedAmts[i]));
      const dirCount  = refCounts[i];
      const label     = _labelCache.get(addr.toLowerCase()) || '';
      const display   = label || addr;
      const initial   = addr.slice(2, 4).toUpperCase();
      const capState  = _computeCapState(refLocks[i]);
      const capClass  = capState === 'paused' ? ' cap-paused' : capState === 'ineligible' ? ' cap-ineligible' : '';
      const noInvest  = invested === 0;
      return `
        <div class="dash-dref-card${capClass}${noInvest ? ' dref-no-invest' : ''}" id="drefCard_${addr.toLowerCase()}"${noInvest ? '' : ` onclick="openRefPopup('${addr}')"`}>
          <div class="dash-dref-avatar">${initial}</div>
          <div style="flex:1;min-width:0;">
            <div class="dash-dref-addr dash-dref-name">${display}</div>
            <div class="dash-dref-invested">${invested > 0 ? fmtUSDT(invested, {decimals:2}) + ' invested' : 'No active investment'} &nbsp;·&nbsp; ${dirCount} direct ref${dirCount !== 1 ? 's' : ''}</div>
          </div>
          <div class="dash-dref-arrow">›</div>
        </div>`;
    }).join('');

    const existing = document.getElementById('dashUnlockLabelsHint');
    if (existing) existing.remove();
  } catch(e) {
    console.error('_loadDashDirectRefs', e);
  }
}

async function _unlockLabels() {
  try {
    await _initLabelKey();
    _labelCache.clear(); // clear any empty entries from the failed-decrypt pass
    await _loadDashDirectRefs(true);
  } catch(e) {
    const msg = e?.message || e?.reason || String(e);
    console.error('[HORDEX] _unlockLabels failed:', e);
    toast('Label unlock failed: ' + msg.slice(0, 100), 'error');
  }
}

async function _computeMissedETHForAddr(addr) {
  try {
    const PAID_TOPIC = ethers.utils.id('CommissionPaid(address,address,uint256,uint256)');
    const addrPadded = ethers.utils.hexZeroPad(addr.toLowerCase(), 32).toLowerCase();
    const ownerAddr  = (await contract.owner()).toLowerCase();
    const zero       = ethers.BigNumber.from(0);
    if (addr.toLowerCase() === ownerAddr) return 0;

    const visited   = new Set([addr.toLowerCase()]);
    let frontier    = [addr.toLowerCase()];
    let totalMissed = zero;

    for (let depth = 1; depth <= 10; depth++) {
      const nextFrontier = [], membersAtDepth = [];
      await Promise.all(frontier.map(async (a) => {
        const refs = await contract.getReferrals(a).catch(() => []);
        for (const ref of refs) {
          const r = ref.toLowerCase();
          if (!visited.has(r)) { visited.add(r); nextFrontier.push(r); membersAtDepth.push(r); }
        }
      }));
      if (membersAtDepth.length === 0) break;
      await Promise.all(membersAtDepth.map(async (member) => {
        const fromBlock = (typeof DEPLOY_BLOCK !== 'undefined' && DEPLOY_BLOCK > 0) ? DEPLOY_BLOCK : 0;
        const logs = await getLogsBatched({
          address: contract.address,
          topics: [PAID_TOPIC, null, ethers.utils.hexZeroPad(member, 32)],
        }, fromBlock, 'latest');
        const byTx = new Map();
        for (const log of logs) {
          const [amount, level] = ethers.utils.defaultAbiCoder.decode(['uint256','uint256'], log.data);
          if (Number(level) !== depth) continue;
          const key = log.transactionHash;
          if (!byTx.has(key)) byTx.set(key, { total: zero, received: zero });
          const entry = byTx.get(key);
          entry.total = entry.total.add(amount);
          if (log.topics[1].toLowerCase() === addrPadded) entry.received = entry.received.add(amount);
        }
        for (const entry of byTx.values()) {
          if (entry.total.gt(entry.received)) totalMissed = totalMissed.add(entry.total.sub(entry.received));
        }
      }));
      frontier = nextFrontier;
    }
    return parseFloat(ethers.utils.formatEther(totalMissed));
  } catch (_) { return 0; }
}

async function _refreshRefPopupStats(addr) {
  try {
    const investedRaw = await contract.userTotalInvested(addr).catch(() => ethers.BigNumber.from(0));
    const totalInv = parseFloat(ethers.utils.formatEther(investedRaw));
    const invEl = document.getElementById('refPopInvestedVal');
    if (invEl) invEl.innerHTML = totalInv > 0 ? fmtUSDT(totalInv, {decimals:2}) : '—';

    const treeData  = await fetchGeneTree(addr, 1);
    const teamAddrs = _geneCollectAddrs(treeData).slice(1);
    let teamVol = 0, teamBizETH = 0, teamWealthETH = 0;
    if (teamAddrs.length > 0) {
      const [amts, wps] = await Promise.all([
        Promise.all(teamAddrs.map(a => contract.userTotalInvested(a).catch(() => ethers.BigNumber.from(0)))),
        Promise.all(teamAddrs.map(a => contract.getWealthParams(a).catch(() => null))),
      ]);
      for (let i = 0; i < amts.length; i++) {
        const e = parseFloat(ethers.utils.formatEther(amts[i]));
        if (e > 0) teamVol++;
        teamBizETH   += e;
        teamWealthETH += _computeWealthFromParams(wps[i]);
      }
    }
    const twEl = document.getElementById('refPopTeamWealthVal');
    if (twEl) twEl.innerHTML = teamWealthETH > 0 ? fmtUSDT(teamWealthETH, {decimals:2}) : '—';
    const tbEl = document.getElementById('refPopTeamBizVal');
    if (tbEl) tbEl.innerHTML = teamBizETH > 0 ? fmtUSDT(teamBizETH, {decimals:2}) : '—';
    const tvEl = document.getElementById('refPopTeamVolVal');
    if (tvEl) tvEl.textContent = teamVol;

    const missedETH = await _computeMissedETHForAddr(addr);
    const missEl = document.getElementById('refPopMissedVal');
    if (missEl) missEl.innerHTML = missedETH > 0 ? fmtUSDT(missedETH, {decimals:2}) : '—';
  } catch(e) {
    console.error('_refreshRefPopupStats', e);
  }
}

function _stopRefPopupTicker() {
  if (_refPopupTickInterval)    { clearInterval(_refPopupTickInterval);    _refPopupTickInterval    = null; }
  if (_refPopupParamFetchTimer) { clearInterval(_refPopupParamFetchTimer); _refPopupParamFetchTimer = null; }
  if (_refPopupStatsFetchTimer) { clearInterval(_refPopupStatsFetchTimer); _refPopupStatsFetchTimer = null; }
}

// Compute wealth from contract params using the same effectiveNow as the dashboard staking ticker.
// _dashStakingTickBase = block.timestamp advanced by wall clock (set when loadDashboard runs).
// Using it here instead of raw Date.now() ensures the popup matches the referral's own dashboard.
function _computeWealthFromParams(params) {
  if (!params || !params.locks) return 0;
  const _w = Math.floor(Date.now() / 1000);
  const now = _dashStakingTickBase > 0
    ? _dashStakingTickBase + Math.max(0, _w - _dashStakingTickWall)
    : _w;
  const refEarningsETH = parseFloat(ethers.utils.formatEther(params.refEarnings));
  const tokenPriceEth  = parseFloat(ethers.utils.formatEther(params.platformTokenPriceEth));
  const defaultLockDur = params.lpLockDuration ? Number(params.lpLockDuration) : 90;

  let totalInvestedETH = 0, totalCurrentLP = 0, stakingETH = 0;

  for (const lock of params.locks) {
    const ethInv = parseFloat(ethers.utils.formatEther(lock.ethInvested));
    totalInvestedETH += ethInv;

    if (!lock.removed) {
      // LP value using on-chain reserves fetched by getWealthParams
      const lpAmt      = parseFloat(ethers.utils.formatEther(lock.lpAmount));
      const totalLPSup = parseFloat(ethers.utils.formatEther(lock.totalLPSupply));
      const resETH     = parseFloat(ethers.utils.formatEther(lock.reserveETH));
      if (totalLPSup > 0 && lpAmt > 0) totalCurrentLP += (lpAmt / totalLPSup) * resETH * 2;

      // Staking with wall-clock elapsed from contract's lockedAt (doesn't freeze on Hardhat)
      const lockedAt   = Number(lock.lockedAt);
      const unlockTime = Number(lock.unlockTime);
      const lockDur    = unlockTime > lockedAt ? unlockTime - lockedAt : defaultLockDur;
      const elapsed    = Math.min(lockDur, Math.max(0, now - lockedAt));
      const ratePPM    = Number(lock.rewardRatePPM);
      if (ratePPM > 0 && lockDur > 0) stakingETH += ethInv * ratePPM * elapsed / (1_000_000 * lockDur);

      // Previous-period accumulated platform tokens, valued in ETH
      const tokAcc = parseFloat(ethers.utils.formatEther(lock.tokensAccumulated));
      if (tokAcc > 0 && tokenPriceEth > 0) stakingETH += tokAcc * tokenPriceEth;
    }
  }

  const lpFees = Math.max(0, totalCurrentLP - totalInvestedETH);
  return refEarningsETH + lpFees + totalInvestedETH + stakingETH;
}

function _startRefPopupTicker() {
  _stopRefPopupTicker();
  if (!_refPopupCurrentAddr) return;
  const addr = _refPopupCurrentAddr;

  // Re-fetch params from chain every 10s to catch restakes, claims, LP reserve changes
  _refPopupParamFetchTimer = setInterval(async () => {
    try { _refPopupWealthParams = await contract.getWealthParams(addr); } catch(e) {}
  }, 10000);

  // Recompute display every 1s using wall-clock elapsed — smooth accumulation
  _refPopupTickInterval = setInterval(() => {
    const valEl = document.getElementById('refPopWealthVal');
    if (!valEl) { _stopRefPopupTicker(); return; }
    const wealthETH = _computeWealthFromParams(_refPopupWealthParams);
    valEl.innerHTML = wealthETH > 0 ? fmtUSDT(wealthETH, {decimals:2}) : '—';
  }, 1000);

  // Re-fetch the 5 non-wealth stats every 30s
  _refPopupStatsFetchTimer = setInterval(() => _refreshRefPopupStats(addr), 30000);
}

async function openRefPopup(addr) {
  const overlay = document.getElementById('dashRefPopupOverlay');
  const content = document.getElementById('dashRefPopupContent');
  if (!overlay || !content) return;

  // Use in-memory cache first; fall back to chain fetch if not yet loaded
  const existingLabel = _labelCache.has(addr.toLowerCase())
    ? _labelCache.get(addr.toLowerCase())
    : await _getRefLabel(addr);
  const addrSubtext = existingLabel
    ? `<div style="font-family:var(--font-mono);font-size:10px;color:var(--muted);margin-top:3px;word-break:break-all;">${addr}</div>`
    : '';
  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <div class="dash-refpop-title">REFERRAL DETAILS</div>
      <button onclick="closeRefPopup()" style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:4px;width:28px;height:28px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;">✕</button>
    </div>
    <div id="refLabelViewRow" style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:20px;">
      <div style="flex:1;min-width:0;">
        <div id="refLabelDisplay" style="font-family:var(--font-mono);font-size:13px;color:var(--cream);word-break:break-all;">${existingLabel || addr}</div>
        ${addrSubtext}
      </div>
      <button onclick="copyAddr('${addr}',this)" title="Copy address" style="padding:4px 6px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--muted);cursor:pointer;flex-shrink:0;margin-top:2px;line-height:1;">${_COPY_ICON}</button>
      <button id="refLabelViewBtn" onclick="showRefLabelEdit()" class="dash-refpop-label-btn" style="flex-shrink:0;margin-top:2px;">${existingLabel ? 'RENAME' : 'FIX LABEL'}</button>
    </div>
    <div id="refLabelEditForm" style="display:none;margin-bottom:20px;">
      <input id="refLabelInput" type="text" value="${existingLabel}" placeholder="Enter name for this referral…" class="dash-refpop-label-input">
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button id="refLabelSaveBtn" onclick="saveRefLabel('${addr}')" class="dash-refpop-label-save">SAVE</button>
        <button onclick="hideRefLabelEdit()" class="dash-refpop-label-cancel">CANCEL</button>
      </div>
    </div>
    <div style="text-align:center;padding:32px 0;color:var(--muted);font-family:var(--font-mono);font-size:11px;letter-spacing:1px;">
      Loading<span class="ld"><span></span><span></span><span></span></span>
    </div>
    <button class="dash-refpop-close" onclick="closeRefPopup()">CLOSE</button>`;
  overlay.style.display = 'flex';

  try {
    const [investedRaw, wealthParams] = await Promise.all([
      contract.userTotalInvested(addr).catch(() => ethers.BigNumber.from(0)),
      contract.getWealthParams(addr).catch(() => null),
    ]);

    _refPopupWealthParams = wealthParams;
    const wealthETH = _computeWealthFromParams(wealthParams);
    const totalInv  = parseFloat(ethers.utils.formatEther(investedRaw));

    _refPopupCurrentAddr = addr;

    const missedETH = await _computeMissedETHForAddr(addr);

    const treeData  = await fetchGeneTree(addr, 1);
    const teamAddrs = _geneCollectAddrs(treeData).slice(1);
    let teamVol = 0, teamBizETH = 0, teamWealthETH = 0;
    if (teamAddrs.length > 0) {
      const [amts, wps] = await Promise.all([
        Promise.all(teamAddrs.map(a => contract.userTotalInvested(a).catch(() => ethers.BigNumber.from(0)))),
        Promise.all(teamAddrs.map(a => contract.getWealthParams(a).catch(() => null))),
      ]);
      for (let i = 0; i < amts.length; i++) {
        const e = parseFloat(ethers.utils.formatEther(amts[i]));
        if (e > 0) teamVol++;
        teamBizETH   += e;
        teamWealthETH += _computeWealthFromParams(wps[i]);
      }
    }

    const stats = [
      { label: 'WEALTH',             val: wealthETH > 0     ? fmtUSDT(wealthETH,     {decimals:2}) : '—', color: '#4ade80',    id: 'refPopWealthVal' },
      { label: 'TOTAL INVESTED',     val: totalInv > 0      ? fmtUSDT(totalInv,      {decimals:2}) : '—', color: 'var(--gold)', id: 'refPopInvestedVal' },
      { label: 'TEAM WEALTH',        val: teamWealthETH > 0 ? fmtUSDT(teamWealthETH, {decimals:2}) : '—', color: '#a78bfa',    id: 'refPopTeamWealthVal' },
      { label: 'TEAM BUSINESS',      val: teamBizETH > 0    ? fmtUSDT(teamBizETH,    {decimals:2}) : '—', color: '#4ade80',    id: 'refPopTeamBizVal' },
      { label: 'TEAM VOLUME',        val: teamVol,                                                          color: 'var(--cream)', id: 'refPopTeamVolVal' },
      { label: 'MISSED COMMISSIONS', val: missedETH > 0     ? fmtUSDT(missedETH,     {decimals:2}) : '—', color: '#f87171',    id: 'refPopMissedVal' },
    ];

    // Replace only the loading section, keep the header/label area intact
    const loadingDiv = content.querySelector('div[style*="padding:32px"]');
    if (loadingDiv) loadingDiv.outerHTML = `
      <div class="dash-refpop-grid">
        ${stats.map(s => `
          <div class="dash-refpop-stat">
            <div class="dash-refpop-stat-label">${s.label}</div>
            <div class="dash-refpop-stat-val"${s.id ? ` id="${s.id}"` : ''} style="color:${s.color};">${s.val}</div>
          </div>`).join('')}
      </div>`;
    _startRefPopupTicker();
  } catch(e) {
    const loadingDiv = content.querySelector('div[style*="padding:32px"]');
    if (loadingDiv) loadingDiv.outerHTML = `<div style="color:#f87171;font-family:var(--font-mono);font-size:11px;margin-bottom:16px;">Error loading details.</div>`;
    console.error('openRefPopup', e);
  }
}

function closeRefPopup() {
  _stopRefPopupTicker();
  const overlay = document.getElementById('dashRefPopupOverlay');
  if (overlay) overlay.style.display = 'none';
}

function _showDashEligPopup(html) {
  const overlay = document.getElementById('dashEligPopupOverlay');
  const content = document.getElementById('dashEligPopupContent');
  if (!overlay || !content) return;
  content.innerHTML = html;
  overlay.style.display = 'flex';
}

function closeDashEligPopup() {
  const overlay = document.getElementById('dashEligPopupOverlay');
  if (overlay) overlay.style.display = 'none';
}

function showPausedLocksPopup(event) {
  event.stopPropagation();

  const pausedLocks = _dashLpLocks.filter(l => {
    if (l.removed) return false;
    const capMax  = l.ethInvested.mul(5);
    const capUsed = l.commissionsCapUsed || ethers.BigNumber.from(0);
    const capLeft = capMax.gt(capUsed) ? capMax.sub(capUsed) : ethers.BigNumber.from(0);
    if (capLeft.isZero()) return false;
    return Number(l.unlockTime) <= _dashEffNow;
  });

  if (!pausedLocks.length) return;

  const rows = pausedLocks.map(l => {
    const addr     = l.token;
    const short    = addr.slice(0, 6) + '…' + addr.slice(-4);
    const ethInv   = parseFloat(ethers.utils.formatEther(l.ethInvested));
    const capMax   = l.ethInvested.mul(5);
    const capUsed  = l.commissionsCapUsed || ethers.BigNumber.from(0);
    const capLeft  = capMax.gt(capUsed) ? capMax.sub(capUsed) : ethers.BigNumber.from(0);
    const capLeftE = parseFloat(ethers.utils.formatEther(capLeft));
    return `<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
      <div style="font-size:10px;color:#94a3b8;">Pair <span style="color:#e2e8f0;">${short}</span></div>
      <div style="font-size:10px;color:#94a3b8;margin-top:3px;">Invested <span style="color:#fde68a;">$${fmtNum(ethInv * USDT_PER_ETH)}</span> &nbsp;&middot;&nbsp; Cap left <span style="color:#4ade80;">$${fmtNum(capLeftE * USDT_PER_ETH)}</span></div>
    </div>`;
  }).join('');

  _showDashEligPopup(`<div style="padding:20px 24px;font-family:var(--font-mono);">
    <div style="font-size:13px;color:#eab308;letter-spacing:1px;margin-bottom:6px;">REFERRAL EARNINGS PAUSED</div>
    <div style="font-size:11px;color:#94a3b8;margin-bottom:14px;">Your lock period has ended for the investments below. Restake to resume earning commissions.</div>
    ${rows}
    <div style="margin-top:16px;">
      <button onclick="closeDashEligPopup()" style="width:100%;background:transparent;border:1px solid rgba(255,255,255,0.15);color:#94a3b8;border-radius:3px;font-family:var(--font-mono);font-size:10px;letter-spacing:1px;padding:7px 0;cursor:pointer;">CLOSE</button>
    </div>
  </div>`);
}

function showIneligiblePopup(event) {
  event.stopPropagation();

  const active = _dashLpLocks.filter(l => !l.removed);
  let reason, detail;

  if (active.length === 0) {
    reason = 'No active investments';
    detail = 'You have no active LP investments. Add liquidity to start earning referral commissions.';
  } else {
    const allExhausted = active.every(l => {
      const capMax  = l.ethInvested.mul(5);
      const capUsed = l.commissionsCapUsed || ethers.BigNumber.from(0);
      return capUsed.gte(capMax);
    });
    if (allExhausted) {
      reason = 'Commission cap exhausted';
      detail = 'Your referral commission cap is fully used up across all investments. Add a new investment to continue earning.';
    } else {
      reason = 'No remaining cap';
      detail = 'You have no remaining referral commission capacity at this time.';
    }
  }

  _showDashEligPopup(`<div style="padding:20px 24px;font-family:var(--font-mono);">
    <div style="font-size:13px;color:#f87171;letter-spacing:1px;margin-bottom:6px;">NOT ELIGIBLE</div>
    <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Reason: <span style="color:#f87171;">${reason}</span></div>
    <div style="font-size:11px;color:#94a3b8;margin-bottom:16px;">${detail}</div>
    <div>
      <button onclick="closeDashEligPopup()" style="width:100%;background:transparent;border:1px solid rgba(255,255,255,0.15);color:#94a3b8;border-radius:3px;font-family:var(--font-mono);font-size:10px;letter-spacing:1px;padding:7px 0;cursor:pointer;">CLOSE</button>
    </div>
  </div>`);
}

function navToRewards(section) {
  switchTabByName('rewards');
  setTimeout(() => {
    const cardId = section === 'staking' ? 'rwStakingCard'
                 : section === 'lpfees'  ? 'rwLPFeesCard'
                 :                         'rwRefCard';
    const el = document.getElementById(cardId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 150);
}

function navToGeneView(mode) {
  switchTabByName('genealogy');
  setTimeout(() => {
    if (typeof switchGeneView === 'function') switchGeneView(mode);
  }, 150);
}

window.loadDashboard        = loadDashboard;
window._dashStopPoll        = _dashStopPoll;
window._dashStartPoll       = _dashStartPoll;
window.copyRefLink          = copyRefLink;
window.loadFeaturedBanner   = loadFeaturedBanner;
window.dismissFeaturedBanner = dismissFeaturedBanner;
window.openStatGraph        = openStatGraph;
window.closeStatGraph       = closeStatGraph;
window._dashGetPoolPrice    = _dashGetPoolPrice;
window._dashComputeLPValue  = _dashComputeLPValue;
window._dashFmtCountdown    = _dashFmtCountdown;
window._dashFmtCompact      = _dashFmtCompact;
window._dashTickCountdowns  = _dashTickCountdowns;
window.navToRewards         = navToRewards;
window.showPausedLocksPopup = showPausedLocksPopup;
window.showIneligiblePopup  = showIneligiblePopup;
window.closeDashEligPopup   = closeDashEligPopup;
window.navToGeneView        = navToGeneView;
window.openRefPopup         = openRefPopup;
window.closeRefPopup        = closeRefPopup;
window._startRefPopupTicker = _startRefPopupTicker;
window._stopRefPopupTicker  = _stopRefPopupTicker;
window.showRefLabelEdit     = showRefLabelEdit;
window.hideRefLabelEdit     = hideRefLabelEdit;
window.saveRefLabel         = saveRefLabel;
window._initLabelKey              = _initLabelKey;
window._unlockLabels              = _unlockLabels;
window._refreshDashDirectRefStats = _refreshDashDirectRefStats;
