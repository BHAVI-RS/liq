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
    if (document.hidden) return; // skip while the browser tab is backgrounded
    loadDashboard(true);
  }, 30000);
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

// ── Dashboard ROI commission live ticker ──
var _dashROITickInterval  = null;
var _dashROIBaseETH       = 0;   // lifetimeClaimed + liveETH + pendingETH at last fetch
var _dashROIRatePerSec    = 0;   // ETH per second accumulated across all active streams
var _dashROIWall          = 0;   // wall-clock seconds at last fetch
var _dashCurrentROIETH    = 0;   // live ROI total for wealth display (updated by ROI ticker)
var _dashCurrentStakingETH = 0;  // live staking total for wealth display (updated by staking ticker)
// ── Dashboard cap ticker ──
var _dashEffCapRefBase  = 0;     // effective referral cap (raw − pending − live) at last fetch
var _dashCapRawAtLoad   = 0;     // raw cap at last fetch (for the sub-note)
var _dashCapIsEligible  = false;
var _dashCapPaused      = false; // true when _capPausedAt > 0 (commission-triggered exhaustion)
var _dashCapLockExpired = false; // true when all active locks expired naturally (no _capPausedAt)
var _dashRefNow    = 0;
var _dashWallRef   = 0;

// Cached lock data for badge popup functions (set at end of loadDashboard).
var _dashLpLocks = [];
var _dashEffNow  = 0;

// ── Shared team-tree cache ──
// Both _loadDashTeamStats and _loadDashTeamWealth need the same fetchGeneTree result.
// Caching it avoids two separate full traversals on every dashboard load.
// The pending-promise dedup means simultaneous callers share a single in-flight request.
let _dashTeamTreeCache   = null;
let _dashTeamTreeCacheTs = 0;
let _dashTeamTreePending = null;

async function _fetchDashTeamTree() {
  if (_dashTeamTreeCache && Date.now() - _dashTeamTreeCacheTs < 60_000) return _dashTeamTreeCache;
  if (_dashTeamTreePending) return _dashTeamTreePending;
  _dashTeamTreePending = fetchGeneTree(walletAddress, 1)
    .then(tree => {
      _dashTeamTreeCache   = tree;
      _dashTeamTreeCacheTs = Date.now();
      _dashTeamTreePending = null;
      return tree;
    })
    .catch(e => { _dashTeamTreePending = null; throw e; });
  return _dashTeamTreePending;
}

// ── Team Wealth real-time ticker ──
// Params are fetched once per dashboard load (or after a user transaction via loadDashboard).
// The 1s ticker recomputes staking accumulation from wall clock — no periodic chain polling.
var _dashTeamWealthTicker    = null;
var _dashTeamWealthParams    = [];  // wealthParams for each downline member (cached until next load)
var _dashTeamROIAmounts      = [];  // parallel: liveETH+pendingETH snapshot per member
var _dashTeamWealthLastFetch = 0;

function _dashStopTeamWealth() {
  if (_dashTeamWealthTicker) { clearInterval(_dashTeamWealthTicker); _dashTeamWealthTicker = null; }
}

function _dashUpdateTeamWealthDisplay() {
  const el = document.getElementById('dashTeamWealth');
  if (!el) { _dashStopTeamWealth(); return; }
  let total = 0;
  for (let _i = 0; _i < _dashTeamWealthParams.length; _i++) {
    total += _computeWealthFromParams(_dashTeamWealthParams[_i]);
    total += (_dashTeamROIAmounts[_i] || 0);
  }
  el.innerHTML = total > 0.000001
    ? `<span style="color:#a855f7;">${fmtUSDT(total, {decimals:2})}</span>`
    : '0';
}

async function _loadDashTeamWealth() {
  const _tsNow = Date.now();
  if (_tsNow - _dashTeamWealthLastFetch < 60000) return;
  _dashTeamWealthLastFetch = _tsNow;
  _dashStopTeamWealth();
  try {
    const treeData = await _fetchDashTeamTree();
    const allAddrs = _geneCollectAddrs(treeData).slice(1); // exclude self
    if (allAddrs.length === 0) {
      _dashTeamWealthParams = [];
      _dashUpdateTeamWealthDisplay();
      return;
    }
    // One getWealthParamsBatch + one getROIDataBatch per chunk (each does the per-member
    // reads on-chain) instead of 2 RPC calls per member. Chunked to keep each eth_call's
    // gas bounded for large teams.
    const batchSize = 40;
    const paramsList = [];
    const roiList    = [];
    for (let _bi = 0; _bi < allAddrs.length; _bi += batchSize) {
      const _chunk = allAddrs.slice(_bi, _bi + batchSize);
      const [_wps, _roi] = await Promise.all([
        contract.getWealthParamsBatch(_chunk).catch(() => _chunk.map(() => null)),
        contract.getROIDataBatch(_chunk).catch(() => [[], []]),
      ]);
      const _live = _roi[0] || [], _pend = _roi[1] || [];
      for (let _i = 0; _i < _chunk.length; _i++) {
        paramsList.push(_wps[_i] || null);
        roiList.push(
          usdtToFloat(_live[_i] || 0) +
          usdtToFloat(_pend[_i] || 0)
        );
      }
    }
    const _combined = paramsList.map((_wp, _i) => ({ _wp, _roi: roiList[_i] || 0 })).filter(x => x._wp !== null);
    _dashTeamWealthParams = _combined.map(x => x._wp);
    _dashTeamROIAmounts   = _combined.map(x => x._roi);
    _dashUpdateTeamWealthDisplay();
    // Tick every 1s: recomputes staking accumulation from wall clock (no chain calls).
    // Params stay cached until the next loadDashboard() call (e.g. after a transaction).
    _dashTeamWealthTicker = setInterval(_dashUpdateTeamWealthDisplay, 1000);
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
    const payoutPrice      = parseFloat(el.dataset.payoutPrice || '0') || priceEth;
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

    // Claim footer. (reward label is owned exclusively by _invTickStakingRewards at 100ms resolution)
    const claimTokens = (payoutPrice > 0 ? pendingETH / payoutPrice : 0) + tokensAccumulated;
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
    // Sum earnedETH per lock — matches rewards tab ACCRUED (total earned, never drops after claiming).
    let totalETH = 0;
    let anyStillActive = false;
    let activeLockCount = 0;
    for (let i = 0; i < _dashStakingTickLocks.length; i++) {
      const lock         = _dashStakingTickLocks[i];
      if (lock.removed) continue;
      const ut           = Number(lock.unlockTime);
      const la           = Number(lock.lockedAt) || (ut - 60);
      const dur          = Math.max(ut - la, 60);
      const eth          = usdtToFloat(lock.ethInvested);
      const elapsed      = Math.min(dur, Math.max(0, now - la));
      const ratePPM_tick = lock.rewardRatePPM ? lock.rewardRatePPM.toNumber() : 0;
      const rwEth_tick   = ratePPM_tick > 0 ? eth * ratePPM_tick / 1_000_000 : 0;
      const earnedETH      = dur > 0 ? rwEth_tick * elapsed / dur : 0;
      const claimedEth_i   = lock.rewardClaimedETH    ? usdtToFloat(lock.rewardClaimedETH)    : 0;
      const pendingETH_i   = Math.max(0, earnedETH - claimedEth_i);
      const tokensAcc_i    = lock.tokensAccumulated   ? parseFloat(ethers.utils.formatEther(lock.tokensAccumulated))   : 0;
      const totalClaimed_i = lock.totalTokensClaimed  ? parseFloat(ethers.utils.formatEther(lock.totalTokensClaimed))  : 0;
      const priceEth_i     = _dashStakingTickPrices[i] || 0;
      // pendingETH_i + historical tokens: stable across claims (pendingETH drops = totalClaimed rises by same amount)
      totalETH += pendingETH_i + (tokensAcc_i + totalClaimed_i) * priceEth_i;
      if (elapsed < dur) { anyStillActive = true; activeLockCount++; }
    }

    // In-memory HWM only — prevents same-session regression from price dips
    // without freezing the display across restake periods.
    if (totalETH > _dashStakingHWM) _dashStakingHWM = totalETH;
    const displayETH = Math.max(totalETH, _dashStakingHWM);

    if (anyStillActive || displayETH > 0) {
      const usdt = displayETH * USDT_PER_ETH;
      const fmt  = usdt >= 0.00001 ? usdt.toFixed(5) : usdt.toExponential(3);
      el.innerHTML = `<span style="color:var(--gold);">${fmt} USDT</span>`;
    } else {
      el.innerHTML = '0';
    }

    _dashCurrentStakingETH = displayETH;
    _dashUpdateWealthDisplay();

    // All locks have now expired — stop ticking, the value is final.
    if (!anyStillActive) _dashStopStakingTicker();
  }, 1000);
}

function _dashStopROITicker() {
  if (_dashROITickInterval) { clearInterval(_dashROITickInterval); _dashROITickInterval = null; }
}

// Wealth = ref earnings + ROI commissions + staking rewards + LP fee earnings + invested.
// Called by both the staking and ROI tickers so the display stays in sync regardless of which fires.
function _dashUpdateWealthDisplay() {
  const el = document.getElementById('dashPnL');
  if (el) el.innerHTML = fmtUSDT(_dashWealthBase + _dashCurrentStakingETH + _dashCurrentROIETH, {decimals:2});
}

function _dashStartROITicker() {
  _dashStopROITicker();
  _dashROITickInterval = setInterval(() => {
    const el = document.getElementById('dashROICommissions');
    if (!el) { _dashStopROITicker(); return; }
    const elapsed  = Math.max(0, Math.floor(Date.now() / 1000) - _dashROIWall);
    // Prefer the rewards tab's live value (includes mid-session exhaustion capping) when available.
    const _rwAccrued = typeof window._rwROIGetAccrued === 'function' ? window._rwROIGetAccrued() : null;
    const totalETH = _rwAccrued !== null ? _rwAccrued : (_dashROIBaseETH + elapsed * _dashROIRatePerSec);
    _dashCurrentROIETH = totalETH;
    _dashUpdateWealthDisplay();
    if (totalETH > 0) {
      const totalUSDT = totalETH * USDT_PER_ETH;
      const fmt = totalUSDT >= 0.00001 ? totalUSDT.toFixed(5) : totalUSDT.toExponential(3);
      el.innerHTML = `<span style="color:#a78bfa;">${fmt} USDT</span>`;
    } else {
      el.innerHTML = '0';
    }
    // Tick effective referral cap down as ROI accrues at the same rate.
    const capNow = _dashCapIsEligible
      ? Math.max(0, _dashEffCapRefBase - elapsed * _dashROIRatePerSec)
      : 0;
    if (_dashCapIsEligible) {
      const capEl   = document.getElementById('dashCapRem');
      const badgeEl = document.getElementById('dashCapBadge');
      if (capEl) {
        capEl.textContent = '$' + (capNow * USDT_PER_ETH).toFixed(2) + ' available cap';
        if (badgeEl && capNow <= 0) {
          badgeEl.textContent = 'EXHAUSTED';
          badgeEl.style.color = '#ef4444';
          badgeEl.style.background = 'rgba(239,68,68,0.12)';
          badgeEl.style.borderColor = 'rgba(239,68,68,0.3)';
        }
      }
    }
    // Update ROI sub-label to reflect real cap state (not always "live").
    const _roiSubEl = document.getElementById('dashROICommSub');
    if (_roiSubEl) {
      if (_dashCapPaused) {
        _roiSubEl.innerHTML = '<span style="color:#ef4444;">paused</span>';
      } else if (_dashCapLockExpired) {
        _roiSubEl.innerHTML = '<span style="color:#f97316;">lock expired</span>';
      } else if (_dashCapIsEligible && capNow <= 0) {
        _roiSubEl.innerHTML = '<span style="color:#ef4444;">exhausted</span>';
      } else if (!_dashCapIsEligible) {
        _roiSubEl.innerHTML = 'no active cap';
      } else {
        _roiSubEl.innerHTML = 'live <span style="color:#a78bfa;font-size:9px;">&#9679;</span>';
      }
    }
  }, 1000);
}

const _poolPriceCache = new Map(); // tokenAddr.lower() → { data, ts }

// Pre-warm _poolPriceCache for many tokens with a single multicall (reserves +
// totalSupply per pair), reusing the pair/decimals metadata resolver from pool.js.
// After this runs, _dashGetPoolPrice(addr) is a cache hit (0 RPC) for ~60s. Best-
// effort: on any failure the per-token path in _dashGetPoolPrice still works.
async function _dashPrewarmPoolPrices(tokenAddrs) {
  try {
    if (typeof _resolvePoolMeta !== 'function' || typeof _poolMetaCache === 'undefined'
        || typeof _PAIR_IFACE === 'undefined') return; // pool.js helpers not present
    const fresh = [...new Set(tokenAddrs.map(a => a.toLowerCase()))].filter(a => {
      const c = _poolPriceCache.get(a);
      return !(c && Date.now() - c.ts < 60_000);
    });
    if (fresh.length === 0) return;
    await _resolvePoolMeta(fresh);
    const withPool = fresh.filter(a => _poolMetaCache.get(a));
    if (withPool.length === 0) return;

    const mc = getMulticall();
    const calls = [];
    withPool.forEach(a => {
      const pair = _poolMetaCache.get(a).pairAddr;
      calls.push({ target: pair, allowFailure: true, callData: _PAIR_IFACE.encodeFunctionData('getReserves', []) });
      calls.push({ target: pair, allowFailure: true, callData: _PAIR_IFACE.encodeFunctionData('totalSupply', []) });
    });
    const res = await mc.aggregate3(calls);
    withPool.forEach((a, idx) => {
      const meta = _poolMetaCache.get(a);
      const rRes = res[idx * 2], rSup = res[idx * 2 + 1];
      if (!rRes.success || !rSup.success) return;
      try {
        const [r0, r1]   = _PAIR_IFACE.decodeFunctionResult('getReserves', rRes.returnData);
        const [totalSup] = _PAIR_IFACE.decodeFunctionResult('totalSupply', rSup.returnData);
        const rawToken = meta.isToken0 ? r0 : r1;
        const rawETH   = meta.isToken0 ? r1 : r0;
        const resToken = parseFloat(ethers.utils.formatUnits(rawToken, meta.decimals));
        const resETH   = usdtToFloat(rawETH);
        const priceEth = resToken > 0 ? resETH / resToken : 0;
        _poolPriceCache.set(a, {
          data: { priceEth, resETH, resToken, totalLPSupply: totalSup, pairAddr: meta.pairAddr },
          ts: Date.now(),
        });
      } catch (_) {}
    });
  } catch (_) { /* fall back to per-token _dashGetPoolPrice */ }
}

async function _dashGetPoolPrice(tokenAddr) {
  const cacheKey = tokenAddr.toLowerCase();
  const cached = _poolPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60_000) return cached.data;
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
    const resETH   = usdtToFloat(rawETH);
    const priceEth = resToken > 0 ? resETH / resToken : 0;

    const result = { priceEth, resETH, resToken, totalLPSupply: totalSupply, pairAddr };
    _poolPriceCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
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
    const latestBlockNum = await getCachedBlockNumber();
    const fromBlock      = getFromBlock(latestBlockNum);
    const [userInfo, investEvents, refEvents] = await Promise.all([
      contract.users(walletAddress),
      cachedQueryFilter(contract.filters.Invested(walletAddress), 'Invested', fromBlock),
      cachedQueryFilter(contract.filters.CommissionPaid(walletAddress), 'CommissionPaid', fromBlock),
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
      ethAmount: usdtToFloat(ev.args.ethAmount),
      lpTokens:  parseFloat(ethers.utils.formatEther(ev.args.lpTokens))
    })).filter(p => p.time > 0).sort((a, b) => a.time - b.time);

    const refPts = refEvents.map(ev => ({
      time:   blockMap.get(ev.blockNumber) || 0,
      amount: usdtToFloat(ev.args.amount)
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
      pts.push({ time: ev.time, value: invested + lpVal + refVal });
    }
    pts.push({ time: now, value: invested + lpVal + refVal });
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

function drawLineGraph(canvas, series, color, unitLabel, graphOpts) {
  graphOpts = graphOpts || {};
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

  const padL = 62, padR = 20, padT = 20;
  const padB = graphOpts.noXAxis ? 12 : 44;
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

  if (!graphOpts.noXAxis) {
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
  }

  if (vMin < 0 && vMax > 0) {
    const y0 = ty(0);
    ctx.strokeStyle = 'rgba(201,168,76,0.2)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(W - padR, y0); ctx.stroke();
    ctx.setLineDash([]);
  }

  if (graphOpts.smooth && series.length > 1) {
    const grad = ctx.createLinearGradient(0, padT, 0, padT + cH);
    grad.addColorStop(0, color + '44');
    grad.addColorStop(1, color + '05');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(tx(series[0].time), ty(0));
    ctx.lineTo(tx(series[0].time), ty(series[0].value));
    for (let i = 0; i < series.length - 1; i++) {
      const cpx = (tx(series[i].time) + tx(series[i+1].time)) / 2;
      ctx.bezierCurveTo(cpx, ty(series[i].value), cpx, ty(series[i+1].value), tx(series[i+1].time), ty(series[i+1].value));
    }
    ctx.lineTo(tx(series[series.length-1].time), ty(0));
    ctx.closePath(); ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(tx(series[0].time), ty(series[0].value));
    for (let i = 0; i < series.length - 1; i++) {
      const cpx = (tx(series[i].time) + tx(series[i+1].time)) / 2;
      ctx.bezierCurveTo(cpx, ty(series[i].value), cpx, ty(series[i+1].value), tx(series[i+1].time), ty(series[i+1].value));
    }
    ctx.stroke();
  } else {
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
  }

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
    drawLineGraph._redraw(ctx, series, color, tx, ty, padL, padR, padT, padB, cW, cH, W, H, vMin, vMax, vRange, tMin, tMax, graphOpts);

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
    drawLineGraph._redraw(ctx, series, color, tx, ty, padL, padR, padT, padB, cW, cH, W, H, vMin, vMax, vRange, tMin, tMax, graphOpts);
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

drawLineGraph._redraw = function(ctx, series, color, tx, ty, padL, padR, padT, padB, cW, cH, W, H, vMin, vMax, vRange, tMin, tMax, graphOpts) {
  graphOpts = graphOpts || {};
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
  if (!graphOpts.noXAxis) {
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
  }
  if (vMin < 0 && vMax > 0) {
    const y0 = ty(0);
    ctx.strokeStyle = 'rgba(201,168,76,0.2)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(W - padR, y0); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (graphOpts.smooth && series.length > 1) {
    const grad = ctx.createLinearGradient(0, padT, 0, padT + cH);
    grad.addColorStop(0, color + '44');
    grad.addColorStop(1, color + '05');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(tx(series[0].time), ty(0));
    ctx.lineTo(tx(series[0].time), ty(series[0].value));
    for (let i = 0; i < series.length - 1; i++) {
      const cpx = (tx(series[i].time) + tx(series[i+1].time)) / 2;
      ctx.bezierCurveTo(cpx, ty(series[i].value), cpx, ty(series[i+1].value), tx(series[i+1].time), ty(series[i+1].value));
    }
    ctx.lineTo(tx(series[series.length-1].time), ty(0));
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(tx(series[0].time), ty(series[0].value));
    for (let i = 0; i < series.length - 1; i++) {
      const cpx = (tx(series[i].time) + tx(series[i+1].time)) / 2;
      ctx.bezierCurveTo(cpx, ty(series[i].value), cpx, ty(series[i+1].value), tx(series[i+1].time), ty(series[i+1].value));
    }
    ctx.stroke();
  } else {
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
  }
  series.forEach(p => {
    ctx.beginPath(); ctx.arc(tx(p.time), ty(p.value), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.strokeStyle = '#04080f'; ctx.lineWidth = 1.5;
    ctx.fill(); ctx.stroke();
  });
};

function openStatGraph(type) {
  if (type === 'locks' || type === 'pnl') return;

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
  const graphOpts = type === 'pnl' ? { noXAxis: true, smooth: true } : {};
  document.getElementById('dashGraphTitle').textContent = opts.label + ' OVER TIME';
  document.getElementById('dashGraphSub').textContent   = type === 'pnl'
    ? opts.yLabel
    : opts.yLabel + '  ·  X-axis = time since registration';
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
    requestAnimationFrame(() => drawLineGraph(canvas, series, opts.color, opts.unit, graphOpts));
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
        requestAnimationFrame(() => drawLineGraph(canvas, s2, opts.color, opts.unit, graphOpts));
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
  if (_tsNow - _dashTeamStatsLastFetch < 60000) return;
  _dashTeamStatsLastFetch = _tsNow;
  try {
    const treeData  = await _fetchDashTeamTree();
    const allAddrs  = _geneCollectAddrs(treeData).slice(1); // exclude self (index 0)
    if (allAddrs.length === 0) {
      volEl.textContent = '0';
      bizEl.textContent = '—';
      return;
    }
    // Invested amounts arrived with the downline (node._inv) — no per-member RPC calls.
    let teamVolume = 0, teamBusinessETH = 0;
    (function _walk(node, isRoot) {
      if (!isRoot) {
        const eth = node._inv || 0;
        if (eth > 0) teamVolume++;
        teamBusinessETH += eth;
      }
      for (const child of node.children) _walk(child, false);
    })(treeData, true);
    volEl.textContent  = teamVolume;
    bizEl.innerHTML    = teamBusinessETH > 0 ? fmtUSDT(teamBusinessETH, {decimals:2}) : '0';
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
  _dashStopROITicker();
  _tabLoaded.add('dashboard');
  document.getElementById('dashLoadingState').innerHTML = '';

  document.getElementById('dashStatsRow').style.display = 'grid';

  // Show refreshing indicator on user-triggered loads only; skip on background polls.
  if (!silent) {
    const _ld = '<span class="ld"><span></span><span></span><span></span></span>';
    ['dashStakingRewards','dashROICommissions','dashTotalInvested','dashRefEarnings',
     'dashPnL','dashTeamWealth','dashTeamBusiness','dashTeamVolume'].forEach(id => {
      const _el = document.getElementById(id);
      if (_el) _el.innerHTML = _ld;
    });
    // Clear direct refs list so a wallet switch forces a full reload (bypasses the DOM-card guard).
    const _drefListEl = document.getElementById('dashDirectRefsList');
    if (_drefListEl) _drefListEl.innerHTML = '';
    // Reset wallet-specific label state so the new wallet's labels are fetched fresh.
    _labelCache.clear();
    _labelCryptoKey  = null;
    _labelKeyPromise = null;
    _dashTeamStatsLastFetch  = 0;
    _dashTeamWealthLastFetch = 0;
    _dashTeamTreeCache   = null;
    _dashTeamTreeCacheTs = 0;
    _dashTeamTreePending = null;
    _dashStopTeamWealth();
  }

  try {
    const _latestBlockNum = await getCachedBlockNumber();
    const _fromBlock      = getFromBlock(_latestBlockNum);
    // All seven per-user contract reads go out as ONE multicall (was 7 separate RPCs).
    // platformToken is cached after first load; getBlock isn't a contract call — both
    // stay outside the batch. `?? default` reproduces each old per-call `.catch(default)`.
    const [_mc, platformToken, latestBlock] = await Promise.all([
      multicallRead(contract, [
        ['getUserLPLocks',         [walletAddress]],
        ['getUserCommissionStats', [walletAddress]],
        ['getStakingReward',       [walletAddress]],
        ['getROIData',             [walletAddress]],
        ['getCapPausedAt',         [walletAddress]],
        ['getROIClaimRecords',     [walletAddress]],
        // Authoritative live available cap (active locks) — matches the contract's accrual gate.
        // Used instead of reconstructing from getROIData, whose liveETH reads 0 at exhaustion.
        ['getAvailableCap',        [walletAddress]],
      ]).catch(() => []),
      cachedConstant('platformToken', () => contract.platformToken()).catch(() => null),
      provider.getBlock('latest').catch(() => null),
    ]);
    const lpLocks         = _mc[0] ?? [];
    const commStats       = _mc[1] ?? null;
    const stakingReward   = _mc[2] ?? null;
    const roiData         = _mc[3] ?? null;
    const capPausedAtRaw  = _mc[4] ?? 0;
    const roiClaimRecords = _mc[5] ?? [];
    const availCapRaw     = _mc[6] ?? null;
    // Silent poll: if every critical call failed the RPC is down — keep existing display
    if (silent && lpLocks.length === 0 && platformToken === null) return;
    // Fetch staking-claim events in the background — they are only needed to add
    // historical claimed ETH from past restake periods. The display renders immediately
    // from lock struct data (fast path); the events-base correction arrives shortly after.
    _dashStakingEventsBase = 0;
    cachedQueryFilter(contract.filters.StakingRewardClaimed(walletAddress), 'StakingRewardClaimed', _fromBlock)
      .then(evs => {
        _dashStakingEventsBase = evs.reduce((s, ev) => {
          try { return s + usdtToFloat(ev.args.ethEquivalent); } catch(_) { return s; }
        }, 0);
      })
      .catch(() => {});

    const refEarningsETH = commStats ? usdtToFloat(commStats.earned) : 0;
    // Cap state assigned after _effNow is established below.
    let capETH = 0, capRemETH = 0, pausedCapETH = 0, adminPausedCapETH = 0, isEligible = false, isPaused = false, hasAdminPausedCap = false;

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
      let _lActiveCap      = ethers.BigNumber.from(0);
      let _lPausedCap      = ethers.BigNumber.from(0);
      let _lAdminPausedCap = ethers.BigNumber.from(0);
      for (const _lk of lpLocks) {
        if (_lk.removed) continue;
        const _capMax  = _lk.ethInvested.mul(5);
        const _capUsed = _lk.commissionsCapUsed || ethers.BigNumber.from(0);
        const _capLeft = _capMax.gt(_capUsed) ? _capMax.sub(_capUsed) : ethers.BigNumber.from(0);
        if (_capLeft.isZero()) continue;
        if (_lk.capPaused) {
          // Admin-paused: track separately so we can show PAUSED badge when active cap is gone
          if (_effNow < Number(_lk.unlockTime)) _lAdminPausedCap = _lAdminPausedCap.add(_capLeft);
          continue;
        }
        if (_effNow < Number(_lk.unlockTime)) {
          _lActiveCap = _lActiveCap.add(_capLeft);
        } else {
          _lPausedCap = _lPausedCap.add(_capLeft);
        }
      }
      capETH           = usdtToFloat(_lActiveCap.add(_lPausedCap));
      capRemETH        = usdtToFloat(_lActiveCap);
      pausedCapETH     = usdtToFloat(_lPausedCap);
      adminPausedCapETH = usdtToFloat(_lAdminPausedCap);
      isEligible       = _lActiveCap.gt(0);
      isPaused         = !isEligible && _lPausedCap.gt(0);
      hasAdminPausedCap = _lAdminPausedCap.gt(0);
    }

    if (lpLocks.length) {
      const tokenSet  = [...new Set(lpLocks.map(l => l.token.toLowerCase()))];
      // Pre-warm every token's pool data in one multicall; the per-token reads below
      // then hit the cache instead of doing 5 RPCs each.
      await _dashPrewarmPoolPrices(tokenSet);
      await Promise.all(tokenSet.map(async addr => {
        const d = await _dashGetPoolPrice(addr);
        if (d) poolCache.set(addr, d);
      }));

      for (const lock of lpLocks) {
        totalInvestedETH += usdtToFloat(lock.ethInvested);
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

    // Reset HWM to zero each load so the display starts from the live computed value
    // and visibly accumulates. The in-memory HWM still prevents same-session regressions
    // from token price dips, but a stale localStorage HWM from a previous restake period
    // would freeze the display until the new period surpassed the old peak.
    _dashStakingHWM = 0;

    // Compute initial total as sum of earnedETH per lock — matches rewards tab ACCRUED.
    let _initTotalETH = 0, _initAnyActive = false;
    for (let _i = 0; _i < lpLocks.length; _i++) {
      const _l          = lpLocks[_i];
      if (_l.removed) continue;
      const _ut         = Number(_l.unlockTime);
      const _la         = Number(_l.lockedAt) || (_ut - 60);
      const _dur        = Math.max(_ut - _la, 60);
      const _eth        = usdtToFloat(_l.ethInvested);
      const _el2        = Math.min(_dur, Math.max(0, _effNow - _la));
      const _ratePPM    = _l.rewardRatePPM ? _l.rewardRatePPM.toNumber() : 0;
      const _rwEth      = _ratePPM > 0 ? _eth * _ratePPM / 1_000_000 : 0;
      const _earnedETH  = _dur > 0 ? _rwEth * _el2 / _dur : 0;
      const _claimedETH = _l.rewardClaimedETH  ? usdtToFloat(_l.rewardClaimedETH)  : 0;
      const _pendingETH = Math.max(0, _earnedETH - _claimedETH);
      const _tokAcc     = _l.tokensAccumulated  ? parseFloat(ethers.utils.formatEther(_l.tokensAccumulated))  : 0;
      const _totClaimed = _l.totalTokensClaimed ? parseFloat(ethers.utils.formatEther(_l.totalTokensClaimed)) : 0;
      const _pEth       = (poolCache.get(_l.token.toLowerCase()) || {}).priceEth || 0;
      _initTotalETH += _pendingETH + (_tokAcc + _totClaimed) * _pEth;
      if (_effNow < _ut && _ratePPM > 0) _initAnyActive = true;
    }

    _dashStakingHWM = _initTotalETH;
    const _initDisplayETH = _initTotalETH;

    const totalValueETH = totalCurrentETH + refEarningsETH;
    const pnlETH  = totalValueETH - totalInvestedETH;
    const pnlCls  = pnlETH > 0.000001 ? '#4ade80' : pnlETH < -0.000001 ? '#f87171' : 'var(--muted)';

    document.getElementById('dashTotalInvested').innerHTML     = fmtUSDT(totalInvestedETH, {decimals:2});
    document.getElementById('dashTotalInvestedUSD').innerHTML  = '';
    // ── ROI commissions ── compute first so totalROIAccruedETH is available for wealth calc
    const roiLiveETH    = roiData ? usdtToFloat(roiData.liveETH)    : 0;
    const roiPendingETH = roiData ? usdtToFloat(roiData.pendingETH) : 0;
    const roiBaseETH    = roiLiveETH + roiPendingETH;
    const roiLifetimeClaimedETH = (roiClaimRecords || []).reduce(
      (sum, r) => sum + usdtToFloat(r.ethEquivalent), 0
    );
    const totalROIAccruedETH = roiLifetimeClaimedETH + roiBaseETH;
    _dashROIBaseETH    = totalROIAccruedETH;
    _dashROIWall       = _wallNow;
    _dashROIRatePerSec = 0;

    // ── My Wealth = ref + ROI + staking + LP fees + invested ──
    const lpFeesETH        = Math.max(0, totalCurrentETH - totalInvestedETH);
    _dashWealthBase        = refEarningsETH + lpFeesETH + totalInvestedETH;
    _dashCurrentStakingETH = _initDisplayETH;
    _dashCurrentROIETH     = totalROIAccruedETH;
    const myWealthETH      = _dashWealthBase + _dashCurrentStakingETH + _dashCurrentROIETH;

    // ── ROI commissions element display (ticker takes over after async rate is computed) ──
    {
      const roiEl = document.getElementById('dashROICommissions');
      if (roiEl) {
        if (totalROIAccruedETH > 0) {
          const roiUSDT = totalROIAccruedETH * USDT_PER_ETH;
          const roiFmt  = roiUSDT >= 0.00001 ? roiUSDT.toFixed(5) : roiUSDT.toExponential(3);
          roiEl.innerHTML = `<span style="color:#a78bfa;">${roiFmt} USDT</span>`;
        } else {
          roiEl.innerHTML = '0';
        }
      }
    }
    // Compute per-second ROI rate in background, then start ticker
    const _effNowCapture = _effNow;
    (async () => {
      try {
        const ROI_RATES = [25000, 5000, 2500, 1000, 300, 250, 225, 200, 200, 175];
        const activeStreams = await contract.getActiveROIStreams(walletAddress).catch(() => []);
        if (!activeStreams.length) { _dashStartROITicker(); return; }
        const investorMap = new Map();
        for (const ref of activeStreams) {
          const key = ref.investor.toLowerCase();
          if (!investorMap.has(key)) investorMap.set(key, []);
          investorMap.get(key).push(ref);
        }
        let ratePerSec = 0;
        // Fetch every distinct investor's LP locks in ONE batch call instead of one
        // getUserLPLocks() per investor.
        const _invEntries = [...investorMap.entries()];
        const _invAddrs   = _invEntries.map(([, refs]) => refs[0].investor);
        let _locksArr = [];
        try { _locksArr = await contract.getUserLPLocksBatch(_invAddrs); } catch(_) { _locksArr = []; }
        _invEntries.forEach(([, refs], _ei) => {
          const locks = _locksArr[_ei];
          if (!locks) return;
          for (const ref of refs) {
            const lock = locks[Number(ref.lockIndex)];
            if (!lock || lock.removed) continue;
            const unlockTime = Number(lock.unlockTime);
            const lockedAt   = Number(lock.lockedAt);
            if (_effNowCapture >= unlockTime) continue;
            const lockDur = unlockTime - lockedAt;
            if (lockDur <= 0) continue;
            const ethInv  = usdtToFloat(lock.ethInvested);
            const ratePPM = lock.rewardRatePPM ? lock.rewardRatePPM.toNumber() : 0;
            if (ratePPM === 0) continue;
            const commRate = ROI_RATES[Number(ref.level)] || 0;
            ratePerSec += ethInv * ratePPM * commRate / (50_000_000_000 * lockDur);
          }
        });
        // Don't show a growing rate when the contract already reports no live accrual
        // (liveETH=0 means cap is exhausted or paused — matches getROIData's cap gates).
        // Also zero rate when the effective cap reference is 0: the new investment's cap
        // is already fully consumed by outstanding ROI from an earlier package, so the
        // ticker should not grow the display past actual accrual.
        if (roiLiveETH === 0 || _dashEffCapRefBase <= 0) ratePerSec = 0;
        _dashROIRatePerSec = ratePerSec;
        _dashStartROITicker();
      } catch(_) {}
    })();
    document.getElementById('dashRefEarnings').innerHTML       = fmtUSDT(refEarningsETH, {decimals: 3});
    document.getElementById('dashRefEarningsUSD').innerHTML    = '';

    const eligBadge = isEligible
      ? '<span style="cursor:pointer;font-size:9px;background:rgba(74,222,128,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.3);padding:2px 6px;border-radius:3px;letter-spacing:1px;" onclick="event.stopPropagation();navToRewards(\'referral\')">ELIGIBLE</span>'
      : isPaused
        ? '<span style="cursor:pointer;font-size:9px;background:rgba(234,179,8,0.15);color:#eab308;border:1px solid rgba(234,179,8,0.3);padding:2px 6px;border-radius:3px;letter-spacing:1px;" onclick="showPausedLocksPopup(event)">PAUSED</span>'
        : '<span style="cursor:pointer;font-size:9px;background:rgba(248,113,113,0.12);color:#f87171;border:1px solid rgba(248,113,113,0.3);padding:2px 6px;border-radius:3px;letter-spacing:1px;" onclick="showIneligiblePopup(event)">INELIGIBLE</span>';
    {
      const _sEl = document.getElementById('dashStakingRewards');
      if (_initAnyActive || _initDisplayETH > 0) {
        const _usdt = _initDisplayETH * USDT_PER_ETH;
        const _fmt  = _usdt >= 0.00001 ? _usdt.toFixed(5) : _usdt.toExponential(3);
        _sEl.innerHTML = `<span style="color:var(--gold);">${_fmt} USDT</span>`;
      } else {
        _sEl.innerHTML = '0';
      }
    }
    const stakingSubEl = document.querySelector('#dashCard-staking .dash-stat-sub');
    if (stakingSubEl) {
      const _isPeriodComplete = !_initAnyActive && lpLocks.length > 0;
      stakingSubEl.classList.toggle('is-period-complete', _isPeriodComplete);
      stakingSubEl.textContent = _initAnyActive
        ? 'accumulating'
        : lpLocks.length ? 'period complete · claim in rewards' : 'no active staking';
    }
    _dashStartStakingTicker();
    const refLabelEl = document.querySelector('#dashCard-referral .dash-stat-label');
    if (refLabelEl) refLabelEl.innerHTML = `REFERRAL EARNINGS ${eligBadge} <span class="dash-stat-chart-hint">→</span>`;

    const pnlEl = document.getElementById('dashPnL');
    pnlEl.style.color = '#4ade80'; // Always green for My Wealth
    pnlEl.innerHTML = myWealthETH > 0 ? fmtUSDT(myWealthETH, {decimals:2}) : '0';
    _dashStartROITicker(); // start ROI ticker immediately so wealth updates as ROI ticks
    const pnlPctEl = document.getElementById('dashPnLPct');
    pnlPctEl.style.color  = pnlCls;
    {
      // Prefer the contract's authoritative live available cap (rawActive − pending − REAL live
      // accrual). Falls back to the local reconstruction only if the getter is unavailable —
      // note the reconstruction under-counts ROI at exhaustion (liveETH=0), which this fixes.
      const _effCapRef = (availCapRaw != null)
        ? usdtToFloat(availCapRaw)
        : Math.max(0, capRemETH - roiLiveETH - roiPendingETH);
      _dashEffCapRefBase  = _effCapRef;
      _dashCapRawAtLoad   = capRemETH;
      _dashCapIsEligible  = isEligible;
      _dashCapPaused      = Number(capPausedAtRaw) > 0;
      _dashCapLockExpired = !isEligible && isPaused && !_dashCapPaused;

      let _badgeTxt, _badgeColor, _badgeBg, _badgeBorder;
      if (isEligible && _effCapRef > 0.0001) {
        // Active lock with cap headroom available.
        _badgeTxt    = 'ACTIVE';
        _badgeColor  = '#4ade80';
        _badgeBg     = 'rgba(74,222,128,0.12)';
        _badgeBorder = 'rgba(74,222,128,0.3)';
      } else if (isEligible) {
        // Active lock exists but outstanding ROI has already consumed the available cap
        // (e.g. previous package exhausted its portion — new investment doesn't restore
        // headroom until pending ROI is claimed). Show EXHAUSTED immediately so the
        // badge never flashes ACTIVE→EXHAUSTED via the ticker.
        _badgeTxt    = 'EXHAUSTED';
        _badgeColor  = '#ef4444';
        _badgeBg     = 'rgba(239,68,68,0.12)';
        _badgeBorder = 'rgba(239,68,68,0.3)';
      } else if (hasAdminPausedCap) {
        // No active cap left, but at least one investment has its cap admin-paused with remaining headroom.
        _badgeTxt    = 'PAUSED';
        _badgeColor  = '#eab308';
        _badgeBg     = 'rgba(234,179,8,0.12)';
        _badgeBorder = 'rgba(234,179,8,0.3)';
      } else if (_dashCapPaused) {
        _badgeTxt    = 'CAP PAUSED';
        _badgeColor  = '#ef4444';
        _badgeBg     = 'rgba(239,68,68,0.12)';
        _badgeBorder = 'rgba(239,68,68,0.3)';
      } else if (_dashCapLockExpired) {
        _badgeTxt    = 'LOCK EXPIRED';
        _badgeColor  = '#f97316';
        _badgeBg     = 'rgba(249,115,22,0.12)';
        _badgeBorder = 'rgba(249,115,22,0.3)';
      } else {
        _badgeTxt    = 'NO CAP';
        _badgeColor  = '#ef4444';
        _badgeBg     = 'rgba(239,68,68,0.12)';
        _badgeBorder = 'rgba(239,68,68,0.3)';
      }
      // Always show the live available cap (active cap − pending ROI − live ROI),
      // mirroring the contract's _getAvailableCap. The colored badge above conveys the
      // state (ACTIVE / EXHAUSTED / PAUSED / …); the figure is the available cap in USDT.
      const _capLine =
        `<span id="dashCapRem" style="font-size:10px;color:var(--muted);">$${(_effCapRef * USDT_PER_ETH).toFixed(2)} available cap</span>`;
      pnlPctEl.innerHTML =
        `<div style="display:flex;align-items:center;gap:6px;margin-top:3px;flex-wrap:wrap;">
           <span id="dashCapBadge" style="font-size:9px;font-family:var(--font-mono);letter-spacing:1px;
                 padding:2px 6px;border-radius:3px;
                 background:${_badgeBg};color:${_badgeColor};border:1px solid ${_badgeBorder};"
           >${_badgeTxt}</span>
           ${_capLine}
         </div>`;
    }


    if (!silent || !_graphCache) {
      _graphCache = null;
      fetchGraphData().then(data => { _graphCache = data; });
    }

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
    const tx = await contract.connect(signer).setRefLabel(addr, encBytes);
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

function _computeCapStateFromStats(commStats) {
  // null means the RPC call failed — don't apply a glow color in that case
  if (!commStats) return 'unknown';
  // remainingCap = activeCap only (locks still within unlock window)
  // totalCap     = activeCap + pausedCap
  const rc = commStats.remainingCap ?? commStats[3];
  const tc = commStats.totalCap     ?? commStats[2];
  if (rc && rc.gt(0)) return 'eligible';
  if (tc && tc.gt(0)) return 'paused';
  return 'ineligible';
}

async function _refreshDashDirectRefStats() {
  const listEl = document.getElementById('dashDirectRefsList');
  if (!listEl) return;
  const cards = [...listEl.querySelectorAll('.dash-dref-card[id^="drefCard_"]')];
  if (!cards.length) return;
  try {
    // Single batch call replaces N×3 individual calls
    const batch = await contract.getDirectRefsInfo(walletAddress).catch(() => null);
    if (!batch) return;
    // Build a lookup by lowercase address for O(1) card updates
    const byAddr = new Map(batch.map(r => [r.addr.toLowerCase(), r]));
    for (const card of cards) {
      const addr = card.id.slice('drefCard_'.length);
      const r    = byAddr.get(addr);
      if (!r) continue;
      const invested  = usdtToFloat(r.totalInvested);
      const dirCount  = Number(r.directRefCount);
      const capState  = r.remainingCap.gt(0) ? 'eligible'
                      : r.totalCap.gt(0)     ? 'paused'
                      :                        'ineligible';
      const invEl = card.querySelector('.dash-dref-invested');
      if (invEl) invEl.innerHTML = `${invested > 0 ? fmtUSDT(invested, {decimals:2}) + ' invested' : 'No active investment'} &nbsp;·&nbsp; ${dirCount} direct ref${dirCount !== 1 ? 's' : ''}`;
      card.classList.remove('cap-paused', 'cap-ineligible', 'dref-no-invest');
      if (invested > 0) {
        if (capState === 'paused')          card.classList.add('cap-paused');
        else if (capState === 'ineligible') card.classList.add('cap-ineligible');
      }
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
    // Single batch call: returns addr + totalInvested + directRefCount + remainingCap + totalCap
    const batch = await contract.getDirectRefsInfo(walletAddress).catch(() => null);
    if (!batch || batch.length === 0) { section.style.display = 'none'; return; }

    section.style.display = '';
    listEl.innerHTML = '<div style="color:var(--muted);font-family:var(--font-mono);font-size:11px;padding:8px 0;">Loading…</div>';

    // Fetch labels in parallel (only extra call needed)
    const refs = batch.map(r => r.addr);
    await _batchGetRefLabels(refs).catch(() => {});

    listEl.innerHTML = batch.map(r => {
      const addr      = r.addr;
      const invested  = usdtToFloat(r.totalInvested);
      const dirCount  = Number(r.directRefCount);
      const label     = _labelCache.get(addr.toLowerCase()) || '';
      const display   = label || addr;
      const initial   = addr.slice(2, 4).toUpperCase();
      const capState  = r.remainingCap.gt(0) ? 'eligible'
                      : r.totalCap.gt(0)     ? 'paused'
                      :                        'ineligible';
      const capClass  = invested > 0 && capState === 'paused'     ? ' cap-paused'
                      : invested > 0 && capState === 'ineligible' ? ' cap-ineligible'
                      : '';
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
    const missed = await contract.totalMissedCommissions(addr);
    return usdtToFloat(missed);
  } catch (_) { return 0; }
}

async function _refreshRefPopupStats(addr) {
  try {
    const investedRaw = await contract.userTotalInvested(addr).catch(() => ethers.BigNumber.from(0));
    const totalInv = usdtToFloat(investedRaw);
    const invEl = document.getElementById('refPopInvestedVal');
    if (invEl) invEl.innerHTML = totalInv > 0 ? fmtUSDT(totalInv, {decimals:2}) : '0';

    const treeData  = await fetchGeneTree(addr, 1);
    let teamVol = 0, teamBizETH = 0, teamWealthETH = 0;
    const teamAddrs = await _refPopTeamAgg(treeData, v => {
      teamVol = v.vol; teamBizETH = v.biz; teamWealthETH = v.wealth;
    });
    const twEl = document.getElementById('refPopTeamWealthVal');
    if (twEl) twEl.innerHTML = teamWealthETH > 0 ? fmtUSDT(teamWealthETH, {decimals:2}) : '0';
    const tbEl = document.getElementById('refPopTeamBizVal');
    if (tbEl) tbEl.innerHTML = teamBizETH > 0 ? fmtUSDT(teamBizETH, {decimals:2}) : '0';
    const tvEl = document.getElementById('refPopTeamVolVal');
    if (tvEl) tvEl.textContent = teamVol;

    const missedETH = await _computeMissedETHForAddr(addr);
    const missEl = document.getElementById('refPopMissedVal');
    if (missEl) missEl.innerHTML = missedETH > 0 ? fmtUSDT(missedETH, {decimals:2}) : '0';
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
  const refEarningsETH = usdtToFloat(params.refEarnings);
  const tokenPriceEth  = usdtToFloat(params.platformTokenPriceEth);
  const defaultLockDur = params.lpLockDuration ? Number(params.lpLockDuration) : 90;

  let totalInvestedETH = 0, totalCurrentLP = 0, stakingETH = 0;

  for (const lock of params.locks) {
    const ethInv = usdtToFloat(lock.ethInvested);
    totalInvestedETH += ethInv;

    if (!lock.removed) {
      // LP value using on-chain reserves fetched by getWealthParams
      const lpAmt      = parseFloat(ethers.utils.formatEther(lock.lpAmount));
      const totalLPSup = parseFloat(ethers.utils.formatEther(lock.totalLPSupply));
      const resETH     = usdtToFloat(lock.reserveETH);
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

// Aggregates a referral's downline team stats (volume, business, wealth) with batched reads:
// invested comes from the downline nodes (_inv, already fetched by fetchGeneTree), and wealth
// from one getWealthParamsBatch per chunk — instead of one userTotalInvested()+getWealthParams()
// pair per team member. Returns the flat team address list and reports {vol,biz,wealth} via cb.
async function _refPopTeamAgg(treeData, cb) {
  const teamAddrs = _geneCollectAddrs(treeData).slice(1);
  let vol = 0, biz = 0, wealth = 0;
  const invMap = new Map();
  (function _w(node) { invMap.set(node.addr.toLowerCase(), node._inv || 0); node.children.forEach(_w); })(treeData);
  for (const a of teamAddrs) { const e = invMap.get(a.toLowerCase()) || 0; if (e > 0) vol++; biz += e; }
  if (teamAddrs.length > 0) {
    const CH = 40;
    for (let i = 0; i < teamAddrs.length; i += CH) {
      const chunk = teamAddrs.slice(i, i + CH);
      let wps = [];
      try { wps = await contract.getWealthParamsBatch(chunk); } catch(_) { wps = chunk.map(() => null); }
      for (const wp of wps) wealth += _computeWealthFromParams(wp);
    }
  }
  cb({ vol, biz, wealth });
  return teamAddrs;
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
    valEl.innerHTML = wealthETH > 0 ? fmtUSDT(wealthETH, {decimals:2}) : '0';
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
    const totalInv  = usdtToFloat(investedRaw);

    _refPopupCurrentAddr = addr;

    const missedETH = await _computeMissedETHForAddr(addr);

    const treeData  = await fetchGeneTree(addr, 1);
    let teamVol = 0, teamBizETH = 0, teamWealthETH = 0;
    await _refPopTeamAgg(treeData, v => {
      teamVol = v.vol; teamBizETH = v.biz; teamWealthETH = v.wealth;
    });

    const stats = [
      { label: 'WEALTH',             val: wealthETH     > 0 ? fmtUSDT(wealthETH,     {decimals:2}) : '0', color: '#4ade80',     id: 'refPopWealthVal' },
      { label: 'TOTAL INVESTED',     val: totalInv      > 0 ? fmtUSDT(totalInv,      {decimals:2}) : '0', color: 'var(--gold)', id: 'refPopInvestedVal' },
      { label: 'TEAM WEALTH',        val: teamWealthETH > 0 ? fmtUSDT(teamWealthETH, {decimals:2}) : '0', color: '#a78bfa',     id: 'refPopTeamWealthVal' },
      { label: 'TEAM BUSINESS',      val: teamBizETH    > 0 ? fmtUSDT(teamBizETH,    {decimals:2}) : '0', color: '#4ade80',     id: 'refPopTeamBizVal' },
      { label: 'TEAM VOLUME',        val: teamVol,                                                          color: 'var(--cream)', id: 'refPopTeamVolVal' },
      { label: 'MISSED COMMISSIONS', val: missedETH     > 0 ? fmtUSDT(missedETH,     {decimals:2}) : '0', color: '#f87171',     id: 'refPopMissedVal' },
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
    const ethInv   = usdtToFloat(l.ethInvested);
    const capMax   = l.ethInvested.mul(5);
    const capUsed  = l.commissionsCapUsed || ethers.BigNumber.from(0);
    const capLeft  = capMax.gt(capUsed) ? capMax.sub(capUsed) : ethers.BigNumber.from(0);
    const capLeftE = usdtToFloat(capLeft);
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
    <div style="font-size:11px;color:#94a3b8;margin-bottom:10px;">${detail}</div>
    <div style="font-size:10px;color:#64748b;margin-bottom:16px;">This is your overall cap status. Referral commissions unlock all 10 levels at $25 active self-stake; ROI <em>levels</em> unlock by active self-stake per level — see the <strong>Network</strong> tab.</div>
    <div>
      <button onclick="closeDashEligPopup()" style="width:100%;background:transparent;border:1px solid rgba(255,255,255,0.15);color:#94a3b8;border-radius:3px;font-family:var(--font-mono);font-size:10px;letter-spacing:1px;padding:7px 0;cursor:pointer;">CLOSE</button>
    </div>
  </div>`);
}

// ── Dashboard ROI-by-level popup ───────────────────────────────────────────────
// Clicking the dashboard ROI COMMISSIONS card opens this instead of jumping to the
// rewards tab. Shows live-accruing ROI grouped by downline level, ticking each second.
let _dashROILevelTicker = null;
let _dashROILevelData   = [];   // [{level, ratePct, count, baseETH, ratePerSec}]
let _dashROILevelWall   = 0;

function _dashStopROILevelTicker() {
  if (_dashROILevelTicker) { clearInterval(_dashROILevelTicker); _dashROILevelTicker = null; }
}

async function showDashROILevelPopup() {
  const existing = document.getElementById('dashROILevelOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dashROILevelOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:20px;max-width:460px;width:100%;box-sizing:border-box;font-family:var(--font-mono);position:relative;max-height:85vh;overflow-y:auto;">
      <button onclick="var o=document.getElementById('dashROILevelOverlay');if(o)o.remove();"
        style="position:absolute;top:12px;right:12px;width:26px;height:26px;border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:4px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;">✕</button>
      <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:4px;">ROI COMMISSIONS · BY LEVEL</div>
      <div style="font-size:11px;color:var(--cream);margin-bottom:14px;">Live accrual across your active downline streams</div>
      <div id="dashROILevelBody"><div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div></div>
      <div style="margin-top:14px;text-align:right;">
        <span onclick="var o=document.getElementById('dashROILevelOverlay');if(o)o.remove();navToRewards('roicomm');" style="font-size:10px;color:var(--gold);cursor:pointer;text-decoration:underline;">View full ROI details →</span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  try {
    const ROI_RATES_CONTRACT = [25000, 5000, 2500, 1000, 300, 250, 225, 200, 200, 175];
    const ROI_RATES_PCT      = [50, 10, 5, 2, 0.6, 0.5, 0.45, 0.4, 0.4, 0.35];
    const [streams, roiData, blk] = await Promise.all([
      contract.getActiveROIStreams(walletAddress).catch(() => []),
      contract.getROIData(walletAddress).catch(() => null),
      contract.provider.getBlock('latest').catch(() => null),
    ]);
    if (!document.getElementById('dashROILevelOverlay')) return; // closed while loading
    const liveETH = roiData ? usdtToFloat(roiData.liveETH) : 0;
    const wallNow = Math.floor(Date.now() / 1000);
    const effNow  = Math.max(blk ? blk.timestamp : wallNow, wallNow);

    const byLevel = new Map(); // level -> {count, baseETH, ratePerSec}
    if (streams && streams.length) {
      const uniq    = [...new Set(streams.map(r => r.investor.toLowerCase()))];
      const lockMap = new Map();
      const infoMap = new Map();
      // Every distinct investor's locks in ONE batch call instead of one getUserLPLocks() each.
      const _uniqAddrs = uniq.map(key => streams.find(r => r.investor.toLowerCase() === key).investor);
      await Promise.all([
        (async () => {
          let _locksArr = [];
          try { _locksArr = await contract.getUserLPLocksBatch(_uniqAddrs); } catch(_) {}
          uniq.forEach((key, _ui) => { if (_locksArr[_ui]) lockMap.set(key, _locksArr[_ui]); });
        })(),
        ...streams.map(async ref => {
          const k = `${ref.investor.toLowerCase()}:${Number(ref.lockIndex)}:${Number(ref.level)}`;
          try { infoMap.set(k, await contract.getROIStreamInfo(ref.investor, ref.lockIndex, ref.level)); } catch(_) {}
        }),
      ]);
      for (const ref of streams) {
        const lvl  = Number(ref.level);
        const lock = (lockMap.get(ref.investor.toLowerCase()) || [])[Number(ref.lockIndex)];
        if (!lock || lock.removed) continue;
        const unlockTime = Number(lock.unlockTime);
        const lockedAt   = Number(lock.lockedAt);
        const lockDur    = unlockTime - lockedAt;
        if (lockDur <= 0) continue;
        const ethInv  = usdtToFloat(lock.ethInvested);
        const ratePPM = lock.rewardRatePPM ? lock.rewardRatePPM.toNumber() : 0;
        const roiRate = ROI_RATES_CONTRACT[lvl] || 0;
        const info    = infoMap.get(`${ref.investor.toLowerCase()}:${Number(ref.lockIndex)}:${lvl}`);
        const roiPaid = info ? usdtToFloat(info.roiPaidETH) : 0;
        const histPaid= info && info.historicalPaidETH ? usdtToFloat(info.historicalPaidETH) : 0;
        const recSince= info ? Number(info.recipientSince) : lockedAt;
        const recTs   = Math.max(lockedAt, recSince);
        const streamRate = (liveETH > 0 && effNow < unlockTime && ratePPM > 0 && roiRate > 0)
          ? ethInv * ratePPM * roiRate / (50_000_000_000 * lockDur) : 0;
        const elapsed2 = Math.max(0, Math.min(unlockTime, effNow) - recTs);
        const accrued  = (liveETH > 0 && ratePPM > 0 && roiRate > 0)
          ? ethInv * ratePPM * elapsed2 * roiRate / (50_000_000_000 * lockDur) : 0;
        const e = byLevel.get(lvl) || { count: 0, baseETH: 0, ratePerSec: 0 };
        e.count      += 1;
        e.baseETH    += histPaid + roiPaid + Math.max(0, accrued);
        e.ratePerSec += streamRate;
        byLevel.set(lvl, e);
      }
    }

    _dashROILevelData = [...byLevel.entries()]
      .map(([level, e]) => ({ level, ratePct: ROI_RATES_PCT[level] !== undefined ? ROI_RATES_PCT[level] : 0, ...e }))
      .sort((a, b) => a.level - b.level);
    _dashROILevelWall = wallNow;

    _dashRenderROILevelBody();
    _dashStopROILevelTicker();
    _dashROILevelTicker = setInterval(_dashTickROILevel, 1000);
  } catch (_) {
    const body = document.getElementById('dashROILevelBody');
    if (body) body.innerHTML = '<div class="empty-state">Failed to load ROI data.</div>';
  }
}

function _dashRenderROILevelBody() {
  const body = document.getElementById('dashROILevelBody');
  if (!body) { _dashStopROILevelTicker(); return; }
  if (!_dashROILevelData.length) {
    body.innerHTML = '<div class="empty-state">No active ROI streams. Refer active investors to start earning.</div>';
    return;
  }
  let totalETH = 0, totalRate = 0;
  for (const d of _dashROILevelData) { totalETH += d.baseETH; totalRate += d.ratePerSec; }
  let rows = '';
  for (const d of _dashROILevelData) {
    rows += `<tr style="border-bottom:1px solid rgba(20,30,42,0.7);">
      <td style="padding:8px 8px;"><span style="color:var(--cream);">L${d.level + 1}</span> <span style="color:var(--gold);font-size:10px;">${d.ratePct}%</span></td>
      <td style="padding:8px 8px;color:var(--muted);text-align:center;">${d.count}</td>
      <td style="padding:8px 8px;text-align:right;"><span id="dashROILvlVal-${d.level}" style="color:#a78bfa;">$${(d.baseETH * USDT_PER_ETH).toFixed(5)}</span></td>
    </tr>`;
  }
  body.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:11px;">
      <thead><tr style="border-bottom:1px solid var(--border);">
        <th style="text-align:left;color:var(--muted);font-weight:400;padding:5px 8px;">LEVEL</th>
        <th style="text-align:center;color:var(--muted);font-weight:400;padding:5px 8px;">STREAMS</th>
        <th style="text-align:right;color:var(--muted);font-weight:400;padding:5px 8px;">ACCRUED (USDT)</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr style="border-top:1px solid var(--border);">
        <td style="padding:8px 8px;color:var(--muted);">TOTAL</td>
        <td></td>
        <td style="padding:8px 8px;text-align:right;"><span id="dashROILvlTotal" style="color:#a78bfa;font-family:var(--font-display);">$${(totalETH * USDT_PER_ETH).toFixed(5)}</span></td>
      </tr></tfoot>
    </table>
    ${totalRate > 0 ? '<div style="margin-top:8px;font-size:9px;color:var(--muted);text-align:right;">accruing live <span style="color:#4ade80;">●</span></div>' : ''}`;
}

function _dashTickROILevel() {
  if (!document.getElementById('dashROILevelOverlay')) { _dashStopROILevelTicker(); return; }
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - _dashROILevelWall);
  let totalETH = 0;
  for (const d of _dashROILevelData) {
    const v = d.baseETH + elapsed * d.ratePerSec;
    totalETH += v;
    const el = document.getElementById('dashROILvlVal-' + d.level);
    if (el) el.textContent = '$' + (v * USDT_PER_ETH).toFixed(5);
  }
  const totEl = document.getElementById('dashROILvlTotal');
  if (totEl) totEl.textContent = '$' + (totalETH * USDT_PER_ETH).toFixed(5);
}

function navToRewards(section) {
  const cardId = section === 'staking' ? 'rwStakingCard'
               : section === 'lpfees'  ? 'rwLPFeesCard'
               : section === 'roicomm' ? 'rwROICard'
               :                         'rwRefCard';
  switchTabByName('rewards');
  if (section === 'referral') {
    // Referral card is at the top — no layout shift from content above it
    setTimeout(() => {
      const el = document.getElementById(cardId);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  } else {
    // Staking / ROI / LP fees sit below the referral card whose async render
    // causes a large layout shift. Store target and scroll after ref renders.
    window._rwPendingScrollId = cardId;
  }
}

function navToGeneView(mode) {
  switchTabByName('genealogy');
  setTimeout(() => {
    if (typeof switchGeneView === 'function') switchGeneView(mode);
  }, 150);
}

window.loadDashboard        = loadDashboard;
window.showDashROILevelPopup = showDashROILevelPopup;
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
window._dashStopROITicker   = _dashStopROITicker;
window._dashStartROITicker  = _dashStartROITicker;
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
