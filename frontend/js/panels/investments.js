
var _invPollInterval = null;

var _invLPLocks = [];
var _invTokenMetaMap = new Map();
var _invPoolCacheMap = new Map();

function _invStopPoll() {
  if (_invPollInterval) { clearInterval(_invPollInterval); _invPollInterval = null; }
}

function _invStartPoll() {
  _invStopPoll();
  _invPollInterval = setInterval(() => {
    const panel = document.getElementById('panel-investments');
    if (!panel || !panel.classList.contains('active')) { _invStopPoll(); return; }
    loadInvestments();
  }, 5000);
}

function toggleInvDetails(btn) {
  const details = btn.nextElementSibling;
  if (!details) return;
  const open = details.classList.toggle('open');
  btn.classList.toggle('open', open);
  btn.querySelector('.dit-arrow').textContent = open ? '▴' : '▾';
  btn.childNodes[0].textContent = open ? 'SHOW LESS ' : 'SHOW MORE ';
}

async function loadInvestments() {
  if (!contract || !walletAddress) {
    document.getElementById('investmentsContent').innerHTML =
      '<div class="empty-state">Connect wallet to view your investments.</div>';
    return;
  }
  _tabLoaded.add('investments');

  const el = document.getElementById('investmentsContent');

  if (_invCountdownInterval) { clearInterval(_invCountdownInterval); _invCountdownInterval = null; }
  if (el.querySelectorAll('.dash-inv-card[data-lock-index]').length === 0) {
    el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  }

  try {
    const [lpLocks, latestBlock] = await Promise.all([
      contract.getUserLPLocks(walletAddress),
      provider.getBlock('latest').catch(() => null),
    ]);
    // Use blockchain timestamp as the reference "now".  On a Hardhat mainnet fork
    // block.timestamp can be far behind the wall clock, which makes every fresh lock
    // appear immediately unlocked (unlockTime < wallNow) and produces absurd staking
    // reward figures.  We anchor to block.timestamp once and advance it via wall-clock
    // delta in _dashTickCountdowns (using _blockTimeOffset) so the ticker never stalls.
    const blockNow = latestBlock ? latestBlock.timestamp : Math.floor(Date.now() / 1000);
    const wallNow  = Math.floor(Date.now() / 1000);

    // On a Hardhat mainnet fork, block.timestamp is frozen between transactions —
    // it only advances when a tx is mined.  _maxEffectiveNow is a high-water mark
    // that we advance by wall-clock elapsed time so expired locks stay expired even
    // when no new block has been mined.
    //
    // Problem: _maxEffectiveNow lives only in memory, so a page reload resets it
    // and expired locks show as 60 s "LOCKED" again on every login.
    //
    // Fix: persist {blockNow, effectiveNow, wallNow} in sessionStorage (cleared on
    // browser-tab close but survives page reloads / hot reloads).  On the FIRST load
    // of a fresh session we restore the high-water mark and advance it by wall-clock
    // elapsed time since it was saved.  If blockNow has advanced (new tx was mined),
    // the saved entry is stale and we start fresh from the real blockNow.
    if (_lastLoadWallTime === 0) {
      try {
        const _rawSaved = localStorage.getItem('hordex_eff_time') || sessionStorage.getItem('hordex_eff_time');
        const saved = JSON.parse(_rawSaved || 'null');
        if (saved && saved.blockNow === blockNow) {
          const elapsed = Math.max(0, wallNow - saved.wallNow);
          _maxEffectiveNow = Math.max(blockNow, saved.effectiveNow + elapsed);
          _lastLoadWallTime = wallNow; // mark as restored so the normal path below is a no-op
        }
      } catch(_) {}
    }

    const wallElapsed = _lastLoadWallTime > 0 ? Math.max(0, wallNow - _lastLoadWallTime) : 0;
    _maxEffectiveNow  = Math.max(blockNow, _maxEffectiveNow + wallElapsed);
    _lastLoadWallTime = wallNow;
    _blockTimeOffset  = blockNow - wallNow;
    const effectiveNow = _maxEffectiveNow;
    _dashRefNow  = effectiveNow;
    _dashWallRef = wallNow;

    // Persist for the next page load / session restore
    try {
      const _effTimeStr = JSON.stringify({ blockNow, effectiveNow, wallNow });
      sessionStorage.setItem('hordex_eff_time', _effTimeStr);
      localStorage.setItem('hordex_eff_time', _effTimeStr);
    } catch(_) {}

    if (!lpLocks.length) {
      el.innerHTML = '<div class="empty-state">No investments yet. Go to the INVEST tab to get started.</div>';
      return;
    }

    const tokenSet  = [...new Set(lpLocks.map(l => l.token.toLowerCase()))];
    const poolCache = new Map();
    const tokenMeta = new Map();
    await Promise.all([
      ...tokenSet.map(async addr => {
        const d = await _dashGetPoolPrice(addr); if (d) poolCache.set(addr, d);
      }),
      ...tokenSet.map(async addr => {
        try { const t = await contract.getToken(addr); tokenMeta.set(addr, { symbol: t.symbol, name: t.name, meta: getMeta(addr) }); } catch(_) {}
      })
    ]);

    _invLPLocks = lpLocks;
    _invTokenMetaMap = tokenMeta;
    _invPoolCacheMap = poolCache;

    const expandedIndices = new Set();
    el.querySelectorAll('.dash-inv-card[data-lock-index]').forEach(card => {
      if (card.querySelector('.dash-inv-details.open'))
        expandedIndices.add(Number(card.dataset.lockIndex));
    });

    const cards = [];

    for (let i = 0; i < lpLocks.length; i++) {
      const lock = lpLocks[i];
      const key  = lock.token.toLowerCase();
      const pool = poolCache.get(key);
      const td   = tokenMeta.get(key) || { symbol: lock.token, name: '', meta: {} };

      const ethInvested     = parseFloat(ethers.utils.formatEther(lock.ethInvested));
      const restakeCounts   = lock.restakeCounts
        ? Array.from(lock.restakeCounts).map(c => typeof c.toNumber === 'function' ? c.toNumber() : Number(c))
        : [0,0,0,0,0,0];
      const lpAmount        = lock.lpAmount;
      const unlockTime      = Number(lock.unlockTime);
      const isClaimed       = lock.claimed;
      const isRemoved       = lock.removed || false;
      const secsLeft        = Math.max(0, unlockTime - effectiveNow);
      const isUnlocked      = secsLeft === 0 && !isClaimed && !isRemoved;
      const lockedAt        = lock && lock.lockedAt ? Number(lock.lockedAt) : (unlockTime - 60);

      const currentETH  = pool ? _dashComputeLPValue(lpAmount, pool.resETH, pool.totalLPSupply) : 0;
      const growthETH   = currentETH - ethInvested;
      const growthPct   = ethInvested > 0 ? (growthETH / ethInvested) * 100 : 0;

      let myTokensInPool = 0, myETHInPool = 0;
      if (pool && pool.totalLPSupply && !pool.totalLPSupply.isZero()) {
        const lpFloat    = parseFloat(ethers.utils.formatEther(lpAmount));
        const totalFloat = parseFloat(ethers.utils.formatEther(pool.totalLPSupply));
        const shareRatio = lpFloat / totalFloat;
        myTokensInPool   = shareRatio * pool.resToken;
        myETHInPool      = shareRatio * pool.resETH;
      }
      const growthCls   = growthETH > 0.000001 ? 'dash-growth-pos' : growthETH < -0.000001 ? 'dash-growth-neg' : 'dash-growth-neu';
      const priceEth    = pool ? pool.priceEth : null;
      const lpFmt       = parseFloat(ethers.utils.formatEther(lpAmount)).toFixed(8);
      const logoSrc     = td.meta && td.meta.logo ? `<img src="${td.meta.logo}" style="width:100%;height:100%;object-fit:contain;"/>` : '⬡';
      const badgeHtml   = isRemoved ? `<span class="dash-inv-badge removed">REMOVED</span>` : isClaimed ? `<span class="dash-inv-badge claimed">CLAIMED</span>` : isUnlocked ? `<span class="dash-inv-badge unlocked">UNLOCKED</span>` : `<span class="dash-inv-badge locked">LOCKED</span>`;
      const cdId        = `inv-cd-${i}`;

      const lockDurSecs = unlockTime - lockedAt;
      function _fmtDur(s) {
        if (s < 60)    return s + 's';
        if (s < 3600)  return Math.round(s/60) + ' min';
        if (s < 86400) return Math.round(s/3600) + ' hr' + (Math.round(s/3600)!==1?'s':'');
        return Math.round(s/86400) + ' day' + (Math.round(s/86400)!==1?'s':'');
      }
      const lockDurLabel  = lockDurSecs > 0 ? _fmtDur(lockDurSecs) : '—';
      const lockedAtLabel = lockedAt > 0 ? new Date(lockedAt * 1000).toLocaleString() : '—';
      const unlockLabel   = new Date(unlockTime * 1000).toLocaleString();

      // ── Staking reward data ──
      const stakingPriceEth    = pool ? pool.priceEth : 0;
      const lockDurForStaking  = lockDurSecs > 0 ? lockDurSecs : 60;
      const rewardRatePPM      = lock.rewardRatePPM ? lock.rewardRatePPM.toNumber() : 0;
      const rewardTotalETH     = rewardRatePPM > 0 ? ethInvested * rewardRatePPM / 1_000_000 : 0;
      const rewardTotalUSDT    = rewardTotalETH * USDT_PER_ETH;
      const elapsedStaking     = Math.min(lockDurForStaking, Math.max(0, effectiveNow - lockedAt));
      const tokenSymbol        = td.symbol || 'HORDEX';
      const rewardClaimedETH   = parseFloat(ethers.utils.formatEther(lock.rewardClaimedETH || ethers.BigNumber.from(0)));
      const tokensAccumulated  = parseFloat(ethers.utils.formatEther(lock.tokensAccumulated || ethers.BigNumber.from(0)));
      const totalTokensClaimed = parseFloat(ethers.utils.formatEther(lock.totalTokensClaimed || ethers.BigNumber.from(0)));

      // Linear per-second accrual, capped at the lock period.
      const earnedETH          = lockDurForStaking > 0 ? rewardTotalETH * elapsedStaking / lockDurForStaking : 0;
      const pendingETH         = Math.max(0, earnedETH - rewardClaimedETH);
      const perSecUSDT         = (rewardTotalETH * USDT_PER_ETH) / lockDurForStaking;
      const accumulatedUSDT    = tokensAccumulated * stakingPriceEth * USDT_PER_ETH;
      const liveUSDTNow        = pendingETH * USDT_PER_ETH + accumulatedUSDT;

      const claimableTokensAtPrice = (stakingPriceEth > 0 ? pendingETH / stakingPriceEth : 0) + tokensAccumulated;
      const canClaimStaking        = claimableTokensAtPrice > 0;

      const isInActiveLock  = !isUnlocked && !isClaimed && !isRemoved;
      const showStakingRow  = rewardTotalETH > 0 && (isInActiveLock || canClaimStaking);

      // ── Per-lock referral cap ──
      const commissionsCapUsed = parseFloat(ethers.utils.formatEther(lock.commissionsCapUsed || ethers.BigNumber.from(0)));
      const lockCap            = ethInvested * 5;
      const lockCapRemaining   = Math.max(0, lockCap - commissionsCapUsed);
      const capPct             = lockCap > 0 ? Math.min(100, commissionsCapUsed / lockCap * 100) : 0;
      const capIsActive        = !isRemoved && !isClaimed && secsLeft > 0;
      const capIsFull          = lockCap > 0 && commissionsCapUsed >= lockCap;
      // Don't show PAUSED tag if cap is fully used and lock is expired
      const capTagHtml = isRemoved ? '' : capIsFull
        ? `<span style="font-size:9px;background:rgba(201,168,76,0.15);color:var(--gold);border:1px solid rgba(201,168,76,0.3);padding:1px 5px;border-radius:3px;letter-spacing:1px;margin-left:6px;">CAP FULL</span>`
        : capIsActive
          ? `<span style="font-size:9px;background:rgba(74,222,128,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.3);padding:1px 5px;border-radius:3px;letter-spacing:1px;margin-left:6px;">ACTIVE</span>`
          : `<span style="font-size:9px;background:rgba(234,179,8,0.15);color:#eab308;border:1px solid rgba(234,179,8,0.3);padding:1px 5px;border-radius:3px;letter-spacing:1px;margin-left:6px;">PAUSED</span>`;
      const tokensDeposited = priceEth > 0 ? (ethInvested / 2) / priceEth : myTokensInPool;
      const usdtDeposited   = ethInvested * USDT_PER_ETH / 2;

      // Progress bar: claimed portion + pending (earned but not yet claimed).
      const claimedPct  = rewardTotalETH > 0 ? Math.min(100, rewardClaimedETH / rewardTotalETH * 100) : 0;
      const pendingPct  = rewardTotalETH > 0 ? Math.min(100 - claimedPct, pendingETH / rewardTotalETH * 100) : 0;
      const initialSlotHtml = `<div class="dis-bar-track">
        <div class="dis-bar-claimed" style="width:${claimedPct.toFixed(3)}%"></div>
        <div class="dis-bar-active" style="left:${claimedPct.toFixed(3)}%; width:${pendingPct.toFixed(3)}%"></div>
      </div>`;
      const initialRewardStr = liveUSDTNow > 0
        ? '$' + liveUSDTNow.toFixed(6) + ' USDT'
        : '— USDT';

      let stakingFooterHtml = '';
      if (canClaimStaking) {
        stakingFooterHtml = `<button class="inv-action-btn inv-btn-claim-staking" id="claimStakingBtn-${i}" onclick="claimStakingRewardForLock(${i})">CLAIM ${claimableTokensAtPrice.toFixed(4)} ${tokenSymbol}</button>`;
      } else if (isRemoved) {
        stakingFooterHtml = `<div class="dis-staking-claimed">LP removed · staking rewards fully claimed</div>`;
      } else if (elapsedStaking >= lockDurForStaking) {
        stakingFooterHtml = `<div class="dis-staking-hint">Staking period complete · max reward reached</div>`;
      } else {
        const hint = liveUSDTNow > 0
          ? `$${liveUSDTNow.toFixed(6)} USDT earned · $${perSecUSDT.toFixed(6)} USDT/sec`
          : `Rewards accumulating · $${perSecUSDT.toFixed(6)} USDT/sec`;
        stakingFooterHtml = `<div class="dis-staking-hint">${hint}</div>`;
      }

      const stakingRowHtml = `
        <div class="dash-inv-staking"
             data-staking-locked-at="${lockedAt}"
             data-lock-dur-secs="${lockDurForStaking}"
             data-reward-total-eth="${rewardTotalETH.toFixed(12)}"
             data-reward-claimed-eth="${rewardClaimedETH.toFixed(12)}"
             data-price-eth="${stakingPriceEth.toFixed(12)}"
             data-token-symbol="${tokenSymbol}"
             data-token-addr="${lock.token}"
             data-inv-index="${i}"
             data-tokens-accumulated="${tokensAccumulated.toFixed(18)}"
             data-per-sec-usdt="${perSecUSDT.toFixed(12)}">
          <div class="dis-staking-header">
            <span class="dis-sl-label">STAKING REWARD · ${rewardTotalUSDT.toLocaleString(undefined,{maximumFractionDigits:2})} USDT · ${lockDurLabel} · CONTINUOUS</span>
            <span class="dis-sl-reward">${initialRewardStr}</span>
          </div>
          ${isInActiveLock ? `<div class="dis-slots">${initialSlotHtml}</div>` : ''}
          <div class="dis-staking-footer">${stakingFooterHtml}</div>
        </div>`;

      const lpAmountHex = lpAmount.toHexString();
      let actionColHtml = '';
      if (isRemoved) {
        actionColHtml = `<div id="${cdId}" class="dis-col dis-col-action" style="background:rgba(255,255,255,0.02);">
          <div class="dis-label" style="color:#6b7280;margin-bottom:4px;">REMOVED</div>
          <div class="dis-sub" style="text-align:center;">LP exited</div>
        </div>`;
      } else if (isClaimed) {
        actionColHtml = `<div id="${cdId}" class="dis-col dis-col-action" style="background:rgba(255,255,255,0.02);">
          <div class="dis-label" style="color:#4ade80;margin-bottom:4px;">✓ CLAIMED</div>
          <div class="dis-sub" style="text-align:center;">LP in wallet</div>
        </div>`;
      } else if (isUnlocked) {
        actionColHtml = `<div id="${cdId}" class="dis-col dis-col-action" style="gap:8px;">
          <button id="removeLPDirectBtn-${i}" onclick="removeLPDirect(${i}, '${lock.token}', '${lpAmountHex}')" class="inv-action-btn inv-btn-remove">REMOVE LP</button>
          <button onclick="openStakeModal(${i})" class="inv-action-btn inv-btn-stake">${rewardTotalETH === 0 ? 'LOCK-IN' : 'STAKE'}</button>
        </div>`;
      } else {
        const cd = _dashFmtCountdown(secsLeft);
        const timerStr = cd ? _dashFmtCompact(cd) : '0 days 00:00:00';
        actionColHtml = `<div id="${cdId}" class="dis-col dis-col-action" data-unlock-time="${unlockTime}">
          <div class="dis-label">UNLOCKS IN</div>
          <div class="dis-timer-val">${timerStr}</div>
        </div>`;
      }

      const removeLPBtn = (isClaimed && !isRemoved)
        ? `<button id="removeLPBtn-${i}" onclick="removeLP(${i}, '${lock.token}', '${lpAmountHex}')" style="background:transparent;border:1px solid #f87171;color:#f87171;border-radius:4px;font-family:var(--font-mono);font-size:11px;letter-spacing:1px;padding:9px 18px;cursor:pointer;transition:background 0.2s,color 0.2s;" onmouseover="this.style.background='rgba(248,113,113,0.15)'" onmouseout="this.style.background='transparent'">REMOVE LP</button>`
        : '';

      // Per-duration streak summary: indices 1-5 = 30s/60s/90s/180s/360s
      const _durStreakMeta = [[1,'30s'],[2,'60s'],[3,'90s'],[4,'180s'],[5,'360s']];
      const streakLabel = _durStreakMeta.map(([idx, lbl]) => {
        const cnt = restakeCounts[idx] || 0;
        const dot = cnt >= 3
          ? `<span style="color:var(--gold)">●</span>`
          : cnt > 0
            ? `<span style="color:var(--cream)">●</span>`
            : `<span style="color:var(--muted)">○</span>`;
        return `${dot}&nbsp;${lbl}:${cnt >= 3 ? '<span style="color:var(--gold)">MAX</span>' : cnt}`;
      }).join('&nbsp;&nbsp;');

      cards.push(`
        <div class="dash-inv-card${isClaimed ? ' claimed' : ''}" data-lock-index="${i}" data-eth-invested="${ethInvested.toFixed(12)}" data-eth-invested-wei="${lock.ethInvested.toHexString()}" data-restake-counts='${JSON.stringify(restakeCounts)}' data-lock-dur-secs="${lockDurSecs}">
          <div class="dash-inv-header">
            <div class="dash-inv-logo">${logoSrc}</div>
            <div class="dash-inv-title"><div class="sym">${td.symbol}</div><div class="nm">${td.name}</div></div>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">${badgeHtml}<button class="lock-hist-btn" onclick="showLockHistory(${i})">LOCK HISTORY</button></div>
          </div>
          <div class="dash-inv-summary">
            <div class="dis-col">
              <div class="dis-label">PACKAGE</div>
              <div class="dis-val dis-val-package">${fmtUSDT(ethInvested)}</div>
            </div>
            <div class="dis-col">
              <div class="dis-label">LP VALUE</div>
              <div class="dis-val">${pool && currentETH > 0 ? fmtUSDT(currentETH) : '—'}</div>
              <div class="dis-sub">position #${i+1}</div>
            </div>
            <div class="dis-col">
              <div class="dis-label">REWARDS CLAIMED</div>
              <div class="dis-val" style="color:#4ade80;">${totalTokensClaimed > 0 ? totalTokensClaimed.toFixed(4) + ' ' + tokenSymbol : '—'}</div>
            </div>
            ${actionColHtml}
          </div>
          ${showStakingRow ? stakingRowHtml : ''}
          <button class="dash-inv-toggle" onclick="toggleInvDetails(this)">
            SHOW MORE <span class="dit-arrow">▾</span>
          </button>
          <div class="dash-inv-details">
            ${!isRemoved ? `<div class="did-row">
              <span class="did-label">REF CAP${capTagHtml}</span>
              <span class="did-val">
                ${fmtUSDT(commissionsCapUsed)} / ${fmtUSDT(lockCap)}
                <span style="color:var(--muted);font-size:10px;margin-left:4px;">(${capPct.toFixed(1)}%)</span>
                <span style="color:${capIsFull ? '#f87171' : capIsActive ? '#4ade80' : '#eab308'};font-size:10px;margin-left:6px;">${fmtUSDT(lockCapRemaining)} remaining</span>
              </span>
            </div>
            <div class="did-row" style="padding-top:2px;padding-bottom:6px;">
              <span class="did-label"></span>
              <span class="did-val" style="width:100%;max-width:260px;">
                <div style="height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;">
                  <div style="height:100%;width:${capPct.toFixed(2)}%;background:${capIsFull ? '#f87171' : capIsActive ? '#4ade80' : '#eab308'};border-radius:2px;transition:width 0.3s;"></div>
                </div>
              </span>
            </div>` : ''}
            <div class="did-row"><span class="did-label">RESTAKE STREAK</span><span class="did-val" style="font-size:11px;">${streakLabel}</span></div>
            <div class="did-row">
              <span class="did-label">DEPOSITED</span>
              <span class="did-val">${tokensDeposited > 0 ? tokensDeposited.toFixed(4)+' '+td.symbol+'&nbsp;&nbsp;|&nbsp;&nbsp;'+usdtDeposited.toFixed(2)+' USDT' : '—'}</span>
            </div>
            <div class="did-row">
              <span class="did-label">LP TOKENS</span>
              <span class="did-val">${lpFmt}</span>
            </div>
            <div class="did-row">
              <span class="did-label">AVAILABLE</span>
              <span class="did-val">${myTokensInPool > 0 ? myTokensInPool.toLocaleString(undefined,{maximumFractionDigits:4})+' '+td.symbol+'&nbsp;&nbsp;|&nbsp;&nbsp;'+(myETHInPool*USDT_PER_ETH).toFixed(2)+' USDT' : '—'}</span>
            </div>
            ${pool ? `<div class="did-row"><span class="did-label">PAIR ADDRESS</span><span class="did-val" style="word-break:break-all;"><a href="https://sepolia.etherscan.io/address/${pool.pairAddr}" target="_blank" rel="noopener" style="color:var(--gold);text-decoration:none;">${pool.pairAddr} ↗</a></span></div>` : ''}
            ${removeLPBtn ? `<div class="did-actions">${removeLPBtn}</div>` : ''}
          </div>
        </div>`);
    }

    el.innerHTML = cards.slice().reverse().join('');

    expandedIndices.forEach(idx => {
      const card = el.querySelector(`.dash-inv-card[data-lock-index="${idx}"]`);
      if (!card) return;
      const toggle  = card.querySelector('.dash-inv-toggle');
      const details = card.querySelector('.dash-inv-details');
      if (toggle && details) {
        details.classList.add('open');
        toggle.classList.add('open');
        toggle.querySelector('.dit-arrow').textContent = '▴';
        toggle.childNodes[0].textContent = 'SHOW LESS ';
      }
    });

    const hasCountdowns = document.querySelectorAll('#investmentsContent [data-unlock-time]').length > 0;
    // Keep interval alive as long as any non-removed lock exists — rewards accrue continuously.
    const hasActiveStaking = document.querySelectorAll('#investmentsContent .dash-inv-staking').length > 0
      && lpLocks.some(l => !l.removed);
    if (hasCountdowns || hasActiveStaking) {
      _invCountdownInterval = setInterval(_dashTickCountdowns, 1000);
    }
  } catch(e) {
    el.innerHTML = `<div class="empty-state">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  }
}

async function claimLP(lockIndex) {
  if (!requireConnected()) return;
  const card = document.querySelector(`#investmentsContent .dash-inv-card[data-lock-index="${lockIndex}"]`);
  const btn  = card ? card.querySelector('.dash-claim-btn') : null;
  if (btn) { btn.disabled = true; btn.textContent = 'CLAIMING…'; }
  _txBegin();
  try {
    toast('Confirm transaction in MetaMask…', 'info');
    const tx = await contract.claimLP(lockIndex);
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    _txDone();
    toast('LP tokens claimed successfully!', 'success');
    invalidateTabs('dashboard', 'investments');
    loadInvestments();
  } catch(e) {
    _txDone();
    if (btn) { btn.disabled = false; btn.textContent = 'CLAIM LP TOKENS'; }
    toast('Claim failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

let _pendingRemoveLPInfo = null;

async function _computeRemoveLPPreview(tokenAddr, lpAmountHex) {
  const factoryAbi = ['function getPair(address,address) view returns (address)'];
  const pairAbi    = ['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)', 'function totalSupply() view returns (uint256)'];
  const erc20Abi   = ['function decimals() view returns (uint8)'];

  const lpAmount = ethers.BigNumber.from(lpAmountHex);
  const factory  = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, provider);
  const pairAddr = await factory.getPair(tokenAddr, WETH_ADDRESS);
  if (!pairAddr || pairAddr === ethers.constants.AddressZero) throw new Error('Pool not found');

  const pair = new ethers.Contract(pairAddr, pairAbi, provider);
  const [[r0, r1], tok0, totalSupply] = await Promise.all([pair.getReserves(), pair.token0(), pair.totalSupply()]);
  const isToken0 = tok0.toLowerCase() === tokenAddr.toLowerCase();
  const resToken = isToken0 ? r0 : r1;
  const resETH   = isToken0 ? r1 : r0;

  const erc20 = new ethers.Contract(tokenAddr, erc20Abi, provider);
  const dec   = Number(await erc20.decimals().catch(() => 18));

  const lpF      = parseFloat(ethers.utils.formatEther(lpAmount));
  const totalF   = parseFloat(ethers.utils.formatEther(totalSupply));
  const share    = totalF > 0 ? lpF / totalF : 0;
  const tokensOut = share * parseFloat(ethers.utils.formatUnits(resToken, dec));
  const usdtOut   = share * parseFloat(ethers.utils.formatEther(resETH)) * USDT_PER_ETH;

  let sym = tokenAddr;
  try { const t = await contract.getToken(tokenAddr); sym = t.symbol; } catch(_) {}

  return { tokensOut, usdtOut, sym };
}

async function removeLP(lockIndex, tokenAddr, lpAmountHex) {
  if (!requireConnected()) return;
  const lpAmount = ethers.BigNumber.from(lpAmountHex);
  if (lpAmount.isZero()) { toast('No LP tokens to remove', 'error'); return; }

  _pendingRemoveLPInfo = { lockIndex, isFromWallet: true, tokenAddr, lpAmountHex };
  document.getElementById('removeLPTokenAmt').textContent = '…';
  document.getElementById('removeLPTokenSym').textContent = '';
  document.getElementById('removeLPUsdtAmt').textContent  = '…';
  document.getElementById('removeLPModal').style.display  = 'flex';

  try {
    const { tokensOut, usdtOut, sym } = await _computeRemoveLPPreview(tokenAddr, lpAmountHex);
    document.getElementById('removeLPTokenAmt').textContent = tokensOut.toLocaleString(undefined, { maximumFractionDigits: 4 });
    document.getElementById('removeLPTokenSym').textContent = sym;
    document.getElementById('removeLPUsdtAmt').textContent  = usdtOut.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' USDT';
  } catch(_) {
    document.getElementById('removeLPTokenAmt').textContent = 'Unable to estimate';
    document.getElementById('removeLPUsdtAmt').textContent  = 'Unable to estimate';
  }
}

async function removeLPDirect(lockIndex, tokenAddr, lpAmountHex) {
  if (!requireConnected()) return;

  _pendingRemoveLPInfo = { lockIndex, isFromWallet: false, tokenAddr, lpAmountHex };
  document.getElementById('removeLPTokenAmt').textContent = '…';
  document.getElementById('removeLPTokenSym').textContent = '';
  document.getElementById('removeLPUsdtAmt').textContent  = '…';
  document.getElementById('removeLPModal').style.display  = 'flex';

  try {
    const { tokensOut, usdtOut, sym } = await _computeRemoveLPPreview(tokenAddr, lpAmountHex);
    document.getElementById('removeLPTokenAmt').textContent = tokensOut.toLocaleString(undefined, { maximumFractionDigits: 4 });
    document.getElementById('removeLPTokenSym').textContent = sym;
    document.getElementById('removeLPUsdtAmt').textContent  = usdtOut.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' USDT';
  } catch(_) {
    document.getElementById('removeLPTokenAmt').textContent = 'Unable to estimate';
    document.getElementById('removeLPUsdtAmt').textContent  = 'Unable to estimate';
  }
}

function closeRemoveLPModal() {
  document.getElementById('removeLPModal').style.display = 'none';
  _pendingRemoveLPInfo = null;
}

async function confirmRemoveLP() {
  if (!_pendingRemoveLPInfo) return;
  const { lockIndex, isFromWallet, tokenAddr, lpAmountHex } = _pendingRemoveLPInfo;
  closeRemoveLPModal();
  if (isFromWallet) {
    await _execRemoveLP(lockIndex, tokenAddr, lpAmountHex);
  } else {
    await _execRemoveLPDirect(lockIndex);
  }
}

async function _execRemoveLP(lockIndex, tokenAddr, lpAmountHex) {
  const btn      = document.getElementById('removeLPBtn-' + lockIndex);
  const lpAmount = ethers.BigNumber.from(lpAmountHex);
  if (btn) { btn.disabled = true; btn.textContent = 'REMOVING…'; }
  _txBegin();
  try {
    const factory  = new ethers.Contract(FACTORY_ADDRESS, ['function getPair(address,address) view returns (address)'], provider);
    const pairAddr = await factory.getPair(tokenAddr, WETH_ADDRESS);
    if (!pairAddr || pairAddr === ethers.constants.AddressZero) throw new Error('Pool not found');

    toast('Step 1/2 — Approve LP tokens to platform in MetaMask…', 'info');
    const pairERC20 = new ethers.Contract(pairAddr, ['function approve(address spender, uint256 amount) returns (bool)'], signer);
    const approveTx = await pairERC20.approve(CONTRACT_ADDRESS, lpAmount);
    await approveTx.wait();

    toast('Step 2/2 — Confirm Remove LP in MetaMask…', 'info');
    const tx = await contract.removeLP(lockIndex);
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    _txDone();
    toast('LP removed! ETH and tokens have been returned to your wallet.', 'success');
    invalidateTabs('dashboard', 'investments');
    loadInvestments();
    loadDashboard();
  } catch(e) {
    _txDone();
    if (btn) { btn.disabled = false; btn.textContent = 'REMOVE LP'; }
    toast('Remove LP failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function _execRemoveLPDirect(lockIndex) {
  const btn = document.getElementById('removeLPDirectBtn-' + lockIndex);
  if (btn) { btn.disabled = true; btn.textContent = 'REMOVING…'; }
  _txBegin();
  try {
    toast('Confirm Remove LP in MetaMask…', 'info');
    const tx = await contract.removeLPDirect(lockIndex);
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    _txDone();
    toast('LP removed! ETH and tokens returned to your wallet.', 'success');
    invalidateTabs('dashboard', 'investments');
    loadInvestments();
    loadDashboard();
  } catch(e) {
    _txDone();
    if (btn) { btn.disabled = false; btn.textContent = 'REMOVE LP'; }
    toast('Remove LP failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

let _stakeModalLockIndex = null;
let _stakeSelectedDays   = null;

async function openStakeModal(lockIndex) {
  _stakeModalLockIndex = lockIndex;
  _stakeSelectedDays   = null;

  const card   = document.querySelector(`#investmentsContent .dash-inv-card[data-lock-index="${lockIndex}"]`);
  const weiHex = card ? card.dataset.ethInvestedWei : null;

  // stakingDurations = [7,30,60,90,180,360] → indices 0-5
  const _durToIdx = { 7:0, 30:1, 60:2, 90:3, 180:4, 360:5 };
  // Streak PPM increment per duration index — must match _setTieredRates() in contract
  const _streakIncrPPM = [0, 5_000, 26_000, 30_000, 50_000, 100_000];

  // Per-duration restake counts and the current lock's own duration
  let restakeCounts = [0,0,0,0,0,0];
  let lockDurSecs   = 90; // default to 90s if not stored
  try { if (card && card.dataset.restakeCounts) restakeCounts = JSON.parse(card.dataset.restakeCounts); } catch(_) {}
  try { if (card && card.dataset.lockDurSecs)   lockDurSecs   = Number(card.dataset.lockDurSecs); } catch(_) {}

  // Reset buttons to loading state
  document.querySelectorAll('.stake-day-btn').forEach(b => {
    b.classList.remove('selected');
    ['sdb-reward','sdb-pct','sdb-streak'].forEach(cls => {
      const el = b.querySelector('.' + cls);
      if (el) el.textContent = cls === 'sdb-reward' ? '…' : '';
    });
  });
  document.getElementById('stakeUnlockInfo').innerHTML = '&nbsp;';
  document.getElementById('stakeConfirmBtn').disabled  = true;
  const streakInfoEl = document.getElementById('stakeStreakInfo');
  if (streakInfoEl) streakInfoEl.style.display = 'none';
  document.getElementById('stakeModal').style.display = 'flex';

  if (!weiHex) return;
  try {
    const ethInvestedBN = ethers.BigNumber.from(weiHex);
    const investedUSDT  = parseFloat(ethers.utils.formatEther(ethInvestedBN)) * USDT_PER_ETH;
    const [durSecs, ratesPPM] = await contract.getStakingRatesForAmount(ethInvestedBN);

    document.querySelectorAll('.stake-day-btn').forEach(b => {
      const secs     = Number(b.dataset.days);
      const cIdx     = Array.from(durSecs).findIndex(d => Number(d) === secs);
      const rewardEl = b.querySelector('.sdb-reward');
      const pctEl    = b.querySelector('.sdb-pct');
      const streakEl = b.querySelector('.sdb-streak');
      if (!rewardEl) return;
      if (cIdx === -1) { rewardEl.textContent = '—'; return; }

      // Streak bonus only applies when continuing the SAME duration as the current lock,
      // AND only when a base reward rate exists (packages below $100 earn no staking reward).
      const isSameDur   = secs === lockDurSecs;
      const baseRatePPM = Number(ratesPPM[cIdx]);
      let streakBonusPPM = 0;
      let streakLabel    = 'BASE';
      if (isSameDur && baseRatePPM > 0) {
        const dIdx       = _durToIdx[secs] !== undefined ? _durToIdx[secs] : -1;
        const curCount   = dIdx >= 0 ? (restakeCounts[dIdx] || 0) : 0;
        const nextStreak = Math.min(curCount + 1, 3);
        const incrPPM    = dIdx >= 0 ? _streakIncrPPM[dIdx] : 50_000;
        streakBonusPPM   = nextStreak * incrPPM;
        streakLabel      = nextStreak >= 3 ? 'STREAK MAX' : `STREAK ${nextStreak}`;
      }

      const ratePPM    = baseRatePPM + streakBonusPPM;
      const rewardUSDT = investedUSDT * ratePPM / 1_000_000;
      const pct        = rewardUSDT > 0 ? (rewardUSDT / investedUSDT * 100).toFixed(1) + '%' : '';

      rewardEl.textContent = rewardUSDT > 0 ? '$' + rewardUSDT.toLocaleString(undefined, {maximumFractionDigits: 2}) : '—';
      if (pctEl)    pctEl.textContent    = pct;
      if (streakEl) streakEl.textContent = streakLabel;
    });
  } catch(_) {
    document.querySelectorAll('.stake-day-btn .sdb-reward').forEach(el => { el.textContent = '—'; });
  }
}

function selectStakeDays(days) {
  _stakeSelectedDays = days;
  document.querySelectorAll('.stake-day-btn').forEach(b =>
    b.classList.toggle('selected', Number(b.dataset.days) === days)
  );
  const unlockDate = new Date(Date.now() + days * 1000);
  document.getElementById('stakeUnlockInfo').innerHTML =
    `Unlocks: <span>${unlockDate.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', second:'2-digit' })}</span>`;
  document.getElementById('stakeConfirmBtn').disabled = false;
}

function closeStakeModal() {
  document.getElementById('stakeModal').style.display = 'none';
  const streakInfoEl = document.getElementById('stakeStreakInfo');
  if (streakInfoEl) streakInfoEl.style.display = 'none';
  _stakeModalLockIndex = null;
  _stakeSelectedDays   = null;
}

async function confirmRestake() {
  if (_stakeModalLockIndex === null || !_stakeSelectedDays) return;
  const lockIndex = _stakeModalLockIndex;
  const days      = _stakeSelectedDays;
  closeStakeModal();

  _txBegin();
  try {
    toast(`Confirm stake for ${days} seconds in MetaMask…`, 'info');
    const tx = await contract.restakeLP(lockIndex, days);
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    _txDone();
    toast(`LP staked for ${days} seconds! Timer restarted.`, 'success');
    invalidateTabs('dashboard', 'investments');
    loadInvestments();
  } catch(e) {
    _txDone();
    toast('Stake failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function claimStakingRewardForLock(lockIndex) {
  if (!requireConnected()) return;
  const btn = document.getElementById('claimStakingBtn-' + lockIndex);
  if (btn) { btn.disabled = true; btn.textContent = 'CLAIMING…'; }
  _txBegin();
  try {
    toast('Confirm staking reward claim in MetaMask…', 'info');
    const tx = await contract.claimStakingRewardForLock(lockIndex);
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    _txDone();
    toast('Staking reward claimed!', 'success');
    invalidateTabs('dashboard', 'investments', 'rewards');
    loadInvestments();
  } catch(e) {
    _txDone();
    if (btn) { btn.disabled = false; btn.textContent = 'CLAIM REWARDS'; }
    toast('Claim failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

function revealDashboard() {
  const overlay = document.getElementById('landingOverlay');
  overlay.classList.add('hidden');
  setTimeout(() => { overlay.style.display = 'none'; }, 500);
  document.querySelector('.tabs').classList.add('visible');
  document.querySelector('main').classList.add('visible');
  setTimeout(checkMissedCommissions, 1500);
  if (window._startChainListeners) window._startChainListeners();
}

async function showLockHistory(lockIndex) {
  const lock = _invLPLocks[lockIndex];
  if (!lock) return;

  const key          = lock.token.toLowerCase();
  const td           = _invTokenMetaMap.get(key) || { symbol: lock.token, name: '' };
  const ethInvested  = parseFloat(ethers.utils.formatEther(lock.ethInvested));
  const totalClaimed = parseFloat(ethers.utils.formatEther(lock.totalTokensClaimed || ethers.BigNumber.from(0)));

  function fmtDur(s) {
    if (s <= 0)    return '—';
    if (s < 60)    return s + 's';
    if (s < 3600)  return (s / 60).toFixed(0) + ' min';
    if (s < 86400) return (s / 3600).toFixed(1) + ' hr';
    return Math.round(s / 86400) + ' day' + (Math.round(s / 86400) !== 1 ? 's' : '');
  }
  function fmtTs(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'2-digit' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }

  const existing = document.getElementById('lockHistoryModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'lockHistoryModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:600;background:rgba(4,8,15,0.88);backdrop-filter:blur(16px);display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--panel);border:1px solid rgba(201,168,76,0.2);border-radius:8px;max-width:700px;width:96%;max-height:88vh;overflow-y:auto;padding:24px 28px;" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-family:var(--font-display);font-size:18px;letter-spacing:2px;color:var(--gold);">LOCK HISTORY</div>
        <button onclick="document.getElementById('lockHistoryModal').remove()" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;line-height:1;">×</button>
      </div>
      <div style="font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:1px;margin-bottom:16px;">${td.symbol} · Position #${lockIndex+1} · ${fmtUSDT(ethInvested)} invested</div>
      <div id="lhBody" style="font-family:var(--font-mono);font-size:11px;color:var(--muted);text-align:center;padding:28px 0;">Loading lock history<span class="ld"><span></span><span></span><span></span></span></div>
    </div>`;
  modal.onclick = () => modal.remove();
  document.body.appendChild(modal);

  const body = document.getElementById('lhBody');

  try {
    const [investedEvs, restakedEvs, claimEvs] = await Promise.all([
      contract.queryFilter(contract.filters.Invested(walletAddress, lock.token)).catch(() => []),
      contract.queryFilter(contract.filters.LPRestaked(walletAddress, lock.token)).catch(() => []),
      contract.queryFilter(contract.filters.StakingRewardClaimed(walletAddress)).catch(() => []),
    ]);

    investedEvs.sort((a, b) => a.blockNumber - b.blockNumber);
    restakedEvs.sort((a, b) => a.blockNumber - b.blockNumber);
    claimEvs.sort((a, b)    => a.blockNumber - b.blockNumber);

    const allBlocks = [...new Set([
      ...investedEvs.map(e => e.blockNumber),
      ...restakedEvs.map(e => e.blockNumber),
      ...claimEvs.map(e    => e.blockNumber),
    ])];
    const btsMap = new Map();
    await Promise.all(allBlocks.map(async bn => {
      const blk = await provider.getBlock(bn).catch(() => null);
      if (blk) btsMap.set(bn, blk.timestamp);
    }));

    // Find the Invested event for this specific lock (Nth occurrence for this token).
    let nthForToken = 0;
    for (let j = 0; j < lockIndex; j++) {
      if (_invLPLocks[j] && _invLPLocks[j].token.toLowerCase() === key) nthForToken++;
    }
    const initEvent = investedEvs[nthForToken] || investedEvs[0];
    const initTs    = initEvent ? btsMap.get(initEvent.blockNumber) : null;

    // Build restake periods directly from events sorted chronologically.
    // Each LPRestaked event gives: newUnlockTime (period end) and durationDays (seconds).
    // Period start = newUnlockTime - durationDays.
    const restakePeriods = restakedEvs
      .map(ev => ({
        start:    Number(ev.args.newUnlockTime) - Number(ev.args.durationDays),
        end:      Number(ev.args.newUnlockTime),
        duration: Number(ev.args.durationDays),
      }))
      .sort((a, b) => a.start - b.start);

    // Initial period: from investment timestamp to start of first restake
    // (or to current unlockTime if no restakes).
    const initStart = initTs || Number(lock.lockedAt) || Number(lock.unlockTime);
    const initEnd   = restakePeriods.length > 0
      ? restakePeriods[0].start
      : Number(lock.unlockTime);

    const periods = [{
      label:     'Initial',
      start:     initStart,
      end:       initEnd,
      duration:  initEnd - initStart,
      isCurrent: restakePeriods.length === 0,
    }];
    restakePeriods.forEach((p, idx) => {
      periods.push({
        label:     `Restake ${idx + 1}`,
        start:     p.start,
        end:       p.end,
        duration:  p.duration,
        isCurrent: idx === restakePeriods.length - 1,
      });
    });

    // Attribute StakingRewardClaimed events to periods by block timestamp.
    // Events aggregate all user locks in one tx, so scale amounts by this lock's
    // fraction of total claimed (lock.totalTokensClaimed is per-lock accurate).
    const claims = claimEvs.map(e => ({
      ts:     btsMap.get(e.blockNumber) || 0,
      tokens: parseFloat(ethers.utils.formatEther(e.args.tokensAmount || ethers.BigNumber.from(0))),
    }));
    const eventTotal = claims.reduce((s, c) => s + c.tokens, 0);
    const scale = (eventTotal > 0 && totalClaimed > 0) ? totalClaimed / eventTotal : 1;
    for (let pidx = 0; pidx < periods.length; pidx++) {
      const p = periods[pidx];
      const isLast = pidx === periods.length - 1;
      p.claimed = claims
        .filter(c => c.ts >= p.start && (isLast ? c.ts <= p.end : c.ts < p.end))
        .reduce((s, c) => s + c.tokens * scale, 0);
    }

    // Render table rows.
    const rows = periods.map(p => {
      const clTxt = p.claimed > 0.000001
        ? `<span style="color:#4ade80;">${p.claimed.toFixed(4)} ${td.symbol}</span>`
        : `<span style="color:var(--muted);">—</span>`;
      const rowBg  = p.isCurrent ? 'background:rgba(201,168,76,0.05);' : '';
      const lbClr  = p.isCurrent ? 'var(--gold)' : 'var(--muted)';
      const dot    = p.isCurrent ? ' <span style="color:var(--gold);font-size:8px;">●</span>' : '';
      return `<tr style="border-bottom:1px solid rgba(20,30,42,0.7);${rowBg}">
        <td style="padding:7px 8px;color:${lbClr};white-space:nowrap;">${p.label}${dot}</td>
        <td style="padding:7px 8px;color:var(--cream);white-space:nowrap;">${fmtTs(p.start)}</td>
        <td style="padding:7px 8px;color:var(--cream);white-space:nowrap;">${fmtTs(p.end)}</td>
        <td style="padding:7px 8px;text-align:center;color:var(--cream);">${fmtDur(p.duration)}</td>
        <td style="padding:7px 8px;text-align:right;">${clTxt}</td>
      </tr>`;
    }).join('');

    const totalRow = `<tr style="border-top:1px solid rgba(201,168,76,0.25);background:rgba(201,168,76,0.04);">
      <td colspan="4" style="padding:7px 8px;font-size:10px;color:var(--muted);letter-spacing:1px;">TOTAL CLAIMED</td>
      <td style="padding:7px 8px;text-align:right;font-size:12px;color:#4ade80;">${totalClaimed > 0.000001 ? totalClaimed.toFixed(4)+' '+td.symbol : '—'}</td>
    </tr>`;

    body.innerHTML = `<div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:11px;">
        <thead>
          <tr style="border-bottom:1px solid var(--border);">
            <th style="text-align:left;padding:6px 8px;color:var(--muted);font-size:9px;letter-spacing:1.5px;font-weight:400;">PERIOD</th>
            <th style="text-align:left;padding:6px 8px;color:var(--muted);font-size:9px;letter-spacing:1.5px;font-weight:400;">START</th>
            <th style="text-align:left;padding:6px 8px;color:var(--muted);font-size:9px;letter-spacing:1.5px;font-weight:400;">END</th>
            <th style="text-align:center;padding:6px 8px;color:var(--muted);font-size:9px;letter-spacing:1.5px;font-weight:400;">DURATION</th>
            <th style="text-align:right;padding:6px 8px;color:var(--muted);font-size:9px;letter-spacing:1.5px;font-weight:400;">REWARDS CLAIMED</th>
          </tr>
        </thead>
        <tbody>${rows}${totalRow}</tbody>
      </table>
    </div>`;

  } catch(e) {
    if (body) body.innerHTML = `<div style="color:#f87171;padding:16px 0;">${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  }
}

window.claimStakingRewardForLock = claimStakingRewardForLock;
window.showLockHistory      = showLockHistory;
window.loadInvestments      = loadInvestments;
window._invStopPoll         = _invStopPoll;
window._invStartPoll        = _invStartPoll;
window.claimLP              = claimLP;
window.removeLP             = removeLP;
window.removeLPDirect       = removeLPDirect;
window.closeRemoveLPModal   = closeRemoveLPModal;
window.confirmRemoveLP      = confirmRemoveLP;
window.openStakeModal       = openStakeModal;
window.selectStakeDays      = selectStakeDays;
window.closeStakeModal      = closeStakeModal;
window.confirmRestake       = confirmRestake;
window.revealDashboard      = revealDashboard;
window.toggleInvDetails     = toggleInvDetails;
