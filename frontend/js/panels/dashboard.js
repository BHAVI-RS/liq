// ── SHARED COUNTDOWN STATE (used by investments.js too) ──
// var (not let) so these are window-level globals visible across script tags
var _dashCountdownInterval = null;
var _invCountdownInterval  = null;
var _dashPollInterval      = null;

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
var _dashRefNow    = 0;
var _dashWallRef   = 0;
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
        ? '$' + liveUSDT.toFixed(6) + ' USDT'
        : '— USDT';
    }

    // Claim footer.
    const claimTokens = (priceEth > 0 ? pendingETH / priceEth : 0) + tokensAccumulated;
    const canClaim    = claimTokens > 0;
    const footerEl    = el.querySelector('.dis-staking-footer');
    if (footerEl) {
      const hasBtn = !!footerEl.querySelector('.inv-btn-claim-staking');
      if (canClaim && !hasBtn) {
        footerEl.innerHTML = `<button class="inv-action-btn inv-btn-claim-staking" id="claimStakingBtn-${invIndex}" onclick="claimStakingRewardForLock(${invIndex})">CLAIM ${claimTokens.toFixed(4)} ${tokenSymbol}</button>`;
      } else if (canClaim && hasBtn) {
        const btn = footerEl.querySelector('.inv-btn-claim-staking');
        if (btn && !btn.disabled) btn.textContent = 'CLAIM ' + claimTokens.toFixed(4) + ' ' + tokenSymbol;
      } else if (!canClaim && hasBtn) {
        const hint = elapsed >= lockDurSecs
          ? `Staking period complete · max reward reached`
          : liveUSDT > 0
            ? `$${liveUSDT.toFixed(6)} USDT earned · $${perSecUSDT.toFixed(6)} USDT/sec`
            : `Rewards accumulating · $${perSecUSDT.toFixed(6)} USDT/sec`;
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
  _dashStakingTickInterval = setInterval(() => {
    const el = document.getElementById('dashStakingRewards');
    if (!el) { _dashStopStakingTicker(); return; }
    const now = _dashStakingTickBase + (Math.floor(Date.now() / 1000) - _dashStakingTickWall);
    // Total = claimed (on-chain) + pending (live, ticking) + accumulated token value.
    let totalETH = 0;
    for (let i = 0; i < _dashStakingTickLocks.length; i++) {
      const lock         = _dashStakingTickLocks[i];
      if (lock.removed) continue;
      const ut           = Number(lock.unlockTime);
      const la           = Number(lock.lockedAt) || (ut - 60);
      const dur          = Math.max(ut - la, 60);
      const eth          = parseFloat(ethers.utils.formatEther(lock.ethInvested));
      const effectiveNow = now >= ut ? ut : now;
      const elapsed      = Math.max(0, effectiveNow - la);
      const ratePPM_tick = lock.rewardRatePPM ? lock.rewardRatePPM.toNumber() : 0;
      const rwEth_tick   = ratePPM_tick > 0 ? eth * ratePPM_tick / 1_000_000 : 0;
      const earnedETH    = dur > 0 ? rwEth_tick * elapsed / dur : 0;
      const claimedETH   = parseFloat(ethers.utils.formatEther(lock.rewardClaimedETH || ethers.BigNumber.from(0)));
      const tokensAcc    = parseFloat(ethers.utils.formatEther(lock.tokensAccumulated || ethers.BigNumber.from(0)));
      const priceEth     = _dashStakingTickPrices[i] || 0;
      const pendingETH   = Math.max(0, earnedETH - claimedETH);
      totalETH += claimedETH + pendingETH + tokensAcc * priceEth;
    }
    el.innerHTML = totalETH > 0.000001
      ? `<span style="color:var(--gold);">${fmtUSDT(totalETH)}</span>`
      : '<span style="color:var(--muted);">—</span>';
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
    const [userInfo, investEvents, refEvents] = await Promise.all([
      contract.users(walletAddress),
      contract.queryFilter(contract.filters.Invested(walletAddress)).catch(() => []),
      contract.queryFilter(contract.filters.CommissionPaid(walletAddress)).catch(() => [])
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
    const label = Math.abs(v) < 0.001 && v !== 0 ? v.toExponential(1) : v.toFixed(v >= 1 ? 3 : 6);
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
      ? best.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDT'
      : unitLabel
        ? best.value.toFixed(best.value >= 1 ? 4 : 8) + ' ' + unitLabel
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
    const label = Math.abs(v) < 0.001 && v !== 0 ? v.toExponential(1) : v.toFixed(v >= 1 ? 3 : 6);
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
  }

  try {
    const [lpLocks, commStats, stakingReward, platformToken, stakingEvents, latestBlock] = await Promise.all([
      contract.getUserLPLocks(walletAddress),
      contract.getUserCommissionStats(walletAddress).catch(() => null),
      contract.getStakingReward(walletAddress).catch(() => null),
      contract.platformToken(),
      contract.queryFilter(contract.filters.StakingRewardClaimed(walletAddress)).catch(() => []),
      provider.getBlock('latest').catch(() => null),
    ]);

    const refEarningsETH = commStats ? parseFloat(ethers.utils.formatEther(commStats.earned))       : 0;
    const missedETH      = commStats ? parseFloat(ethers.utils.formatEther(commStats.missed))       : 0;
    const capETH         = commStats ? parseFloat(ethers.utils.formatEther(commStats.totalCap))     : 0;
    const capRemETH      = commStats ? parseFloat(ethers.utils.formatEther(commStats.remainingCap)) : 0;
    const isEligible     = commStats ? (commStats.active.gt(0) && commStats.remainingCap.gt(0))     : false;

    const missedBanner = document.getElementById('dashMissedCommBanner');
    if (missedBanner) {
      const showBanner = missedETH > 0 && capRemETH <= 0;
      missedBanner.style.display = showBanner ? 'flex' : 'none';
      if (showBanner) {
        const amtEl = document.getElementById('dashMissedAmount');
        if (amtEl) amtEl.textContent = fmtUSDT(missedETH, { noEth: true });
      }
    }

    let totalInvestedETH = 0;
    let totalCurrentETH  = 0;
    let activeLocks      = 0;
    let totalLPTokens    = 0;
    let poolCache        = new Map();

    // Use blockchain time to match what the contract uses for lock expiry.
    const _nowTs = latestBlock ? latestBlock.timestamp : Math.floor(Date.now() / 1000);

    if (lpLocks.length) {
      const tokenSet  = [...new Set(lpLocks.map(l => l.token.toLowerCase()))];
      await Promise.all(tokenSet.map(async addr => {
        const d = await _dashGetPoolPrice(addr);
        if (d) poolCache.set(addr, d);
      }));

      for (const lock of lpLocks) {
        totalInvestedETH += parseFloat(ethers.utils.formatEther(lock.ethInvested));
        if (!lock.claimed && !lock.removed && Number(lock.unlockTime) > _nowTs) {
          activeLocks++;
          totalLPTokens += parseFloat(ethers.utils.formatEther(lock.lpAmount));
        }
        const pool = poolCache.get(lock.token.toLowerCase());
        if (pool && !lock.removed) totalCurrentETH += _dashComputeLPValue(lock.lpAmount, pool.resETH, pool.totalLPSupply);
      }
    }

    // ── Staking live ticker setup ──
    const _wallNow = Math.floor(Date.now() / 1000);
    const _blockTs = latestBlock ? latestBlock.timestamp : _wallNow;
    // Keep _effNow monotonically advancing: take max(fresh block time,
    // wall-clock-advanced saved time). This prevents the ticker from restarting
    // on refresh when the blockchain hasn't mined a new block (e.g. Hardhat).
    let _effNow = _blockTs;
    try {
      const _rawRef = localStorage.getItem('hordex_staking_ref') || sessionStorage.getItem('hordex_staking_ref');
      const _sv = JSON.parse(_rawRef || 'null');
      if (_sv && typeof _sv.effNow === 'number' && typeof _sv.wallNow === 'number') {
        _effNow = Math.max(_blockTs, _sv.effNow + Math.max(0, _wallNow - _sv.wallNow));
      }
    } catch(_) {}
    const _stakingRefStr = JSON.stringify({ effNow: _effNow, wallNow: _wallNow });
    sessionStorage.setItem('hordex_staking_ref', _stakingRefStr);
    localStorage.setItem('hordex_staking_ref', _stakingRefStr);

    _dashStakingTickLocks  = lpLocks;
    _dashStakingTickPrices = lpLocks.map(l => (poolCache.get(l.token.toLowerCase()) || {}).priceEth || 0);
    _dashStakingTickBase   = _effNow;
    _dashStakingTickWall   = _wallNow;

    let _initTotalETH = 0, _initAnyActive = false;
    for (let _i = 0; _i < lpLocks.length; _i++) {
      const _l          = lpLocks[_i];
      if (_l.removed) continue;
      const _ut         = Number(_l.unlockTime);
      const _la         = Number(_l.lockedAt) || (_ut - 60);
      const _dur        = Math.max(_ut - _la, 60);
      const _eth        = parseFloat(ethers.utils.formatEther(_l.ethInvested));
      const _effLockNow = _effNow >= _ut ? _ut : _effNow;
      const _el2        = Math.max(0, _effLockNow - _la);
      const _ratePPM    = _l.rewardRatePPM ? _l.rewardRatePPM.toNumber() : 0;
      const _rwEth      = _ratePPM > 0 ? _eth * _ratePPM / 1_000_000 : 0;
      const _earnedETH  = _dur > 0 ? _rwEth * _el2 / _dur : 0;
      const _claimedETH = parseFloat(ethers.utils.formatEther(_l.rewardClaimedETH || ethers.BigNumber.from(0)));
      const _tokensAcc  = parseFloat(ethers.utils.formatEther(_l.tokensAccumulated || ethers.BigNumber.from(0)));
      const _priceEth   = _dashStakingTickPrices[_i] || 0;
      _initTotalETH += _claimedETH + Math.max(0, _earnedETH - _claimedETH) + _tokensAcc * _priceEth;
      if (_effNow < _ut) _initAnyActive = true;
    }

    const totalValueETH = totalCurrentETH + refEarningsETH;
    const pnlETH  = totalValueETH - totalInvestedETH;
    const pnlPct  = totalInvestedETH > 0 ? (pnlETH / totalInvestedETH) * 100 : 0;
    const pnlCls  = pnlETH > 0.000001 ? '#4ade80' : pnlETH < -0.000001 ? '#f87171' : 'var(--muted)';

    document.getElementById('dashTotalInvested').innerHTML     = fmtUSDT(totalInvestedETH);
    document.getElementById('dashTotalInvestedUSD').innerHTML  = '';
    const lpFeesETH = Math.max(0, totalCurrentETH - totalInvestedETH);
    document.getElementById('dashTotalValue').innerHTML        = totalInvestedETH > 0 ? fmtUSDT(lpFeesETH) : '—';
    document.getElementById('dashTotalValue').style.color      = 'white';
    document.getElementById('dashTotalValueUSD').innerHTML     = '';
    const lpTokensEl = document.getElementById('dashLPTokens');
    if (lpTokensEl) lpTokensEl.textContent = totalLPTokens > 0 ? totalLPTokens.toFixed(6) + ' LP' : '';
    document.getElementById('dashRefEarnings').innerHTML       = fmtUSDT(refEarningsETH);
    document.getElementById('dashRefEarningsUSD').innerHTML    =
      capETH > 0
        ? `<span style="color:var(--muted);">Cap: ${fmtUSDT(capRemETH, {noEth:true})} remaining</span>` +
          (missedETH > 0 ? ` &nbsp;<span style="color:#f87171;cursor:pointer;" onclick="checkMissedCommissions()" title="Click to view missed commission details">⚠ ${fmtUSDT(missedETH,{noEth:true})} missed</span>` : '')
        : '';

    const eligBadge = isEligible
      ? '<span style="font-size:9px;background:rgba(74,222,128,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.3);padding:2px 6px;border-radius:3px;letter-spacing:1px;">ELIGIBLE</span>'
      : '<span style="font-size:9px;background:rgba(248,113,113,0.12);color:#f87171;border:1px solid rgba(248,113,113,0.3);padding:2px 6px;border-radius:3px;letter-spacing:1px;">INELIGIBLE</span>';
    document.getElementById('dashStakingRewards').innerHTML = _initTotalETH > 0.000001
      ? `<span style="color:var(--gold);">${fmtUSDT(_initTotalETH)}</span>` : '<span style="color:var(--muted);">—</span>';
    const stakingSubEl = document.querySelector('#dashCard-staking .dash-stat-sub');
    if (stakingSubEl) stakingSubEl.textContent = _initAnyActive
      ? 'accumulating'
      : lpLocks.length ? 'period complete · claim in rewards' : 'no active staking';
    _dashStartStakingTicker();
    const refLabelEl = document.querySelector('#dashCard-referral .dash-stat-label');
    if (refLabelEl) refLabelEl.innerHTML = `REFERRAL EARNINGS ${eligBadge} <span class="dash-stat-chart-hint">→</span>`;

    const pnlEl = document.getElementById('dashPnL');
    pnlEl.style.color = '#4ade80'; // Always green for My Wealth
    pnlEl.innerHTML = totalValueETH > 0 ? fmtUSDT(totalValueETH) : '—';
    const pnlPctEl = document.getElementById('dashPnLPct');
    pnlPctEl.style.color  = pnlCls;

    document.getElementById('dashActiveLocks').textContent = activeLocks || '0';

    _graphCache = null;
    fetchGraphData().then(data => { _graphCache = data; });

  } catch(e) {
    document.getElementById('dashLoadingState').innerHTML =
      `<div class="empty-state">Error loading dashboard: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
    console.error('loadDashboard', e);
  }
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
