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
      provider.getBlock('latest')
    ]);
    const blockTs = latestBlock ? latestBlock.timestamp : Math.floor(Date.now() / 1000);
    // On first load (_dashWallNow=0): anchor to blockchain time to avoid JS clock skew on Hardhat.
    // On reload (e.g., triggered by timer expiry): advance from last calibration by wall-clock elapsed
    // so locks correctly expire even when Hardhat hasn't mined a new block since the invest tx.
    const now = (_dashWallNow > 0)
      ? Math.max(blockTs, Math.floor(_dashBlockNow + (Date.now() / 1000 - _dashWallNow)))
      : blockTs;
    _dashBlockNow = now;
    _dashWallNow  = Date.now() / 1000;

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
      const td   = tokenMeta.get(key) || { symbol: lock.token.slice(0,6), name: '', meta: {} };

      const ethInvested     = parseFloat(ethers.utils.formatEther(lock.ethInvested));
      const lpAmount        = lock.lpAmount;
      const unlockTime      = Number(lock.unlockTime);
      const isClaimed       = lock.claimed;
      const isRemoved       = lock.removed || false;
      const secsLeft        = Math.max(0, unlockTime - now);
      const isUnlocked      = now >= unlockTime && !isClaimed && !isRemoved;
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

      // ── Staking slot data ──
      const SLOT_DURATION_S   = 10;
      const NUM_SLOTS         = Math.max(1, Math.floor(lockDurSecs / SLOT_DURATION_S));
      const rewardEthTotal    = ethInvested * 0.30;
      const rewardEthPerSlot  = rewardEthTotal / NUM_SLOTS;
      const stakingPriceEth   = pool ? pool.priceEth : 0;
      const elapsedStaking    = Math.max(0, now - lockedAt);
      const slotsNow          = Math.min(Math.floor(elapsedStaking / SLOT_DURATION_S), NUM_SLOTS);
      const slotProgressNow   = (elapsedStaking % SLOT_DURATION_S) / SLOT_DURATION_S;
      const tokenSymbol       = td.symbol || 'HORDEX';
      const slotsClaimed      = lock.stakingTokens ? Number(lock.stakingTokens) : 0;
      const isStakingClaimed  = lock.stakingClaimed || false;
      const newSlotsAvail     = Math.max(0, slotsNow - slotsClaimed);
      const canClaimStaking   = !isRemoved && !isStakingClaimed && newSlotsAvail > 0;

      const claimedPct = NUM_SLOTS > 0 ? (slotsClaimed / NUM_SLOTS) * 100 : 0;
      const activePct  = NUM_SLOTS > 0 ? (Math.max(0, slotsNow - slotsClaimed + slotProgressNow) / NUM_SLOTS) * 100 : 0;
      const initialSlotHtml = `<div class="dis-bar-track">
        <div class="dis-bar-claimed" style="width:${claimedPct.toFixed(3)}%"></div>
        <div class="dis-bar-active" style="left:${claimedPct.toFixed(3)}%; width:${activePct.toFixed(3)}%"></div>
      </div>`;
      const totalEarnedTokens = stakingPriceEth > 0 ? (rewardEthPerSlot * slotsNow) / stakingPriceEth : 0;
      const initialRewardStr  = stakingPriceEth > 0
        ? totalEarnedTokens.toFixed(4) + ' ' + tokenSymbol
        : '— ' + tokenSymbol;

      let stakingFooterHtml = '';
      if (isStakingClaimed) {
        stakingFooterHtml = `<div class="dis-staking-claimed">✓ All staking rewards claimed</div>`;
      } else if (canClaimStaking) {
        const claimableETH    = rewardEthPerSlot * newSlotsAvail;
        const claimableTokens = stakingPriceEth > 0 ? claimableETH / stakingPriceEth : 0;
        const btnLabel = claimableTokens > 0
          ? 'CLAIM ' + claimableTokens.toFixed(4) + ' ' + tokenSymbol
          : 'CLAIM REWARDS';
        stakingFooterHtml = `<button class="inv-action-btn inv-btn-claim-staking" id="claimStakingBtn-${i}" onclick="claimStakingRewardForLock(${i})">${btnLabel}</button>`;
      } else {
        const hint = slotsClaimed > 0
          ? `${slotsClaimed}/${NUM_SLOTS} slots claimed · ${NUM_SLOTS - slotsNow} remaining`
          : `Rewards accrue slot-by-slot · ${NUM_SLOTS - slotsNow} slots remaining`;
        stakingFooterHtml = `<div class="dis-staking-hint">${hint}</div>`;
      }

      const stakingRowHtml = `
        <div class="dash-inv-staking"
             data-staking-locked-at="${lockedAt}"
             data-num-slots="${NUM_SLOTS}"
             data-last-slots-complete="${slotsNow}"
             data-reward-eth-per-slot="${rewardEthPerSlot.toFixed(12)}"
             data-price-eth="${stakingPriceEth.toFixed(12)}"
             data-token-symbol="${tokenSymbol}"
             data-slots-claimed="${slotsClaimed}"
             data-staking-claimed="${isStakingClaimed}"
             data-inv-index="${i}">
          <div class="dis-staking-header">
            <span class="dis-sl-label">STAKING REWARD · 30% · ${NUM_SLOTS.toLocaleString()} × ${SLOT_DURATION_S}s</span>
            <span class="dis-sl-reward">${initialRewardStr}</span>
          </div>
          <div class="dis-slots">${initialSlotHtml}</div>
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
          <button id="removeLPDirectBtn-${i}" onclick="removeLPDirect(${i})" class="inv-action-btn inv-btn-remove">REMOVE LP</button>
          <button onclick="openStakeModal(${i})" class="inv-action-btn inv-btn-stake">STAKE</button>
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

      cards.push(`
        <div class="dash-inv-card${isClaimed ? ' claimed' : ''}" data-lock-index="${i}">
          <div class="dash-inv-header">
            <div class="dash-inv-logo">${logoSrc}</div>
            <div class="dash-inv-title"><div class="sym">${td.symbol}</div><div class="nm">${td.name}</div></div>
            ${badgeHtml}
          </div>
          <div class="dash-inv-summary">
            <div class="dis-col">
              <div class="dis-label">PACKAGE</div>
              <div class="dis-val">${ethInvested.toFixed(4)} ETH</div>
              <div class="dis-sub">${fmtUSDT(ethInvested, {noEth:true})}</div>
            </div>
            <div class="dis-col">
              <div class="dis-label">LP TOKENS</div>
              <div class="dis-val">${lpFmt}</div>
              <div class="dis-sub">position #${i+1}</div>
            </div>
            ${actionColHtml}
          </div>
          ${stakingRowHtml}
          <button class="dash-inv-toggle" onclick="toggleInvDetails(this)">
            SHOW MORE <span class="dit-arrow">▾</span>
          </button>
          <div class="dash-inv-details">
            <div class="did-row"><span class="did-label">CURRENT LP VALUE</span><span class="did-val">${currentETH > 0 ? fmtUSDT(currentETH,{noEth:true})+' <span style="color:var(--muted);font-size:10px;">('+currentETH.toFixed(6)+' ETH)</span>' : '—'}</span></div>
            <div class="did-row"><span class="did-label">GROWTH</span><span class="did-val ${growthCls}" data-field="growth">${currentETH>0 ? (growthETH>=0?'+':'')+growthPct.toFixed(2)+'%  '+fmtUSDT(growthETH,{noEth:true,sign:true}) : '—'}</span></div>
            <div class="did-row"><span class="did-label">TOKEN PRICE</span><span class="did-val">${priceEth ? fmtUSDT(priceEth,{noEth:true})+' <span style="color:var(--muted);font-size:10px;">('+priceEth.toFixed(8)+' ETH)</span>' : '—'}</span></div>
            <div class="did-row"><span class="did-label">POOL RESERVES</span><span class="did-val">${pool ? pool.resToken.toLocaleString(undefined,{maximumFractionDigits:2})+' '+td.symbol+' / '+pool.resETH.toFixed(4)+' ETH' : '—'}</span></div>
            <div class="did-row"><span class="did-label">YOUR TOKENS IN POOL</span><span class="did-val">${myTokensInPool > 0 ? myTokensInPool.toLocaleString(undefined,{maximumFractionDigits:4})+' '+td.symbol : '—'}</span></div>
            <div class="did-row"><span class="did-label">YOUR ETH IN POOL</span><span class="did-val">${myETHInPool > 0 ? myETHInPool.toFixed(6)+' ETH' : '—'}</span></div>
            <hr class="did-hr">
            <div class="did-row"><span class="did-label">LOCK PERIOD</span><span class="did-val">${lockDurLabel}</span></div>
            <div class="did-row"><span class="did-label">LOCKED AT</span><span class="did-val">${lockedAtLabel}</span></div>
            <div class="did-row"><span class="did-label">UNLOCKS AT</span><span class="did-val" style="color:${isUnlocked?'#4ade80':'var(--cream)'};">${unlockLabel}</span></div>
            ${pool ? `<div class="did-row"><span class="did-label">PAIR ADDRESS</span><span class="did-val"><a href="https://sepolia.etherscan.io/address/${pool.pairAddr}" target="_blank" rel="noopener" style="color:var(--gold);text-decoration:none;">${pool.pairAddr.slice(0,10)}…${pool.pairAddr.slice(-6)} ↗</a></span></div>` : ''}
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
    const hasActiveStaking = document.querySelectorAll('#investmentsContent .dash-inv-staking').length > 0
      && lpLocks.some(l => !l.stakingClaimed && !l.removed);
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

async function removeLP(lockIndex, tokenAddr, lpAmountHex) {
  if (!requireConnected()) return;
  const btn      = document.getElementById('removeLPBtn-' + lockIndex);
  const lpAmount = ethers.BigNumber.from(lpAmountHex);
  if (lpAmount.isZero()) { toast('No LP tokens to remove', 'error'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'REMOVING…'; }
  _txBegin();
  try {
    const factory  = new ethers.Contract(DEX_FACTORY, FACTORY_ABI, provider);
    const pairAddr = await factory.getPair(tokenAddr, DEX_WETH);
    if (!pairAddr || pairAddr === ethers.constants.AddressZero) throw new Error('Pool not found');

    toast('Step 1/2 — Approve LP tokens to platform in MetaMask…', 'info');
    const pairERC20  = new ethers.Contract(pairAddr, ['function approve(address spender, uint256 amount) returns (bool)'], signer);
    const approveTx  = await pairERC20.approve(CONTRACT_ADDRESS, lpAmount);
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

async function removeLPDirect(lockIndex) {
  if (!requireConnected()) return;
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

function openStakeModal(lockIndex) {
  _stakeModalLockIndex = lockIndex;
  _stakeSelectedDays   = null;
  document.querySelectorAll('.stake-day-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('stakeUnlockInfo').innerHTML = '&nbsp;';
  document.getElementById('stakeConfirmBtn').disabled  = true;
  document.getElementById('stakeModal').style.display  = 'flex';
}

function selectStakeDays(days) {
  _stakeSelectedDays = days;
  document.querySelectorAll('.stake-day-btn').forEach(b =>
    b.classList.toggle('selected', Number(b.dataset.days) === days)
  );
  const unlockDate = new Date(Date.now() + days * 86400 * 1000);
  document.getElementById('stakeUnlockInfo').innerHTML =
    `Unlocks: <span>${unlockDate.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' })}</span>`;
  document.getElementById('stakeConfirmBtn').disabled = false;
}

function closeStakeModal() {
  document.getElementById('stakeModal').style.display = 'none';
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
    toast(`Confirm stake for ${days} days in MetaMask…`, 'info');
    const tx = await contract.restakeLP(lockIndex, days);
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    _txDone();
    toast(`LP staked for ${days} days! Timer restarted.`, 'success');
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
}

window.claimStakingRewardForLock = claimStakingRewardForLock;
window.loadInvestments      = loadInvestments;
window.claimLP              = claimLP;
window.removeLP             = removeLP;
window.removeLPDirect       = removeLPDirect;
window.openStakeModal       = openStakeModal;
window.selectStakeDays      = selectStakeDays;
window.closeStakeModal      = closeStakeModal;
window.confirmRestake       = confirmRestake;
window.revealDashboard      = revealDashboard;
window.toggleInvDetails     = toggleInvDetails;
