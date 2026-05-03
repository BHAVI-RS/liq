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
    const activeCount  = Number(activeCountRaw);
    const minInvETH    = parseFloat(ethers.utils.formatEther(minInvRaw));
    const minInvLabel  = minInvETH > 0 ? `≥ ${fmtUSDT(minInvETH,{noEth:true})} each` : 'any active investment';

    const earned    = parseFloat(ethers.utils.formatEther(commStats.earned));
    const missed    = parseFloat(ethers.utils.formatEther(commStats.missed));
    const remaining = parseFloat(ethers.utils.formatEther(commStats.remainingCap));

    const blockNums  = [...new Set(commEvents.map(e => e.blockNumber))];
    const blockTsMap = new Map();
    await Promise.all(blockNums.map(async bn => {
      const blk = await provider.getBlock(bn).catch(() => null);
      if (blk) blockTsMap.set(bn, blk.timestamp);
    }));

    const sortedEvents = [...commEvents].sort((a, b) => b.blockNumber - a.blockNumber);

    let histHtml = '';
    if (sortedEvents.length === 0) {
      histHtml = '<div class="empty-state" style="margin-top:16px;">No commissions received yet.</div>';
    } else {
      let rows = '';
      for (const ev of sortedEvents) {
        const ts    = blockTsMap.get(ev.blockNumber);
        const date  = ts ? _fmtTsFull(ts) : `Block #${ev.blockNumber}`;
        const from  = ev.args.from;
        const amt   = parseFloat(ethers.utils.formatEther(ev.args.amount));
        const level = Number(ev.args.level);
        const txUrl = `https://sepolia.etherscan.io/tx/${ev.transactionHash}`;
        rows += `<tr style="border-bottom:1px solid rgba(20,30,42,0.8);">
          <td style="padding:7px 8px;color:var(--muted);white-space:nowrap;">${date}</td>
          <td style="padding:7px 8px;"><a href="https://sepolia.etherscan.io/address/${from}" target="_blank" rel="noopener" style="color:var(--gold);text-decoration:none;">${from.slice(0,6)}…${from.slice(-4)}</a></td>
          <td style="padding:7px 8px;text-align:center;color:var(--cream);">L${level}</td>
          <td style="padding:7px 8px;text-align:right;"><a href="${txUrl}" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:none;">+${amt.toFixed(6)} ETH ↗</a></td>
        </tr>`;
      }
      histHtml = `<div style="overflow-x:auto;margin-top:16px;">
        <table style="width:100%;border-collapse:collapse;font-size:11px;font-family:var(--font-mono);">
          <thead>
            <tr style="border-bottom:1px solid var(--border);">
              <th style="text-align:left;padding:6px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">DATE</th>
              <th style="text-align:left;padding:6px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">FROM</th>
              <th style="text-align:center;padding:6px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">LVL</th>
              <th style="text-align:right;padding:6px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">AMOUNT</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }

    const missedWarn = missed > 0.000001
      ? `<div style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);border-radius:6px;padding:10px 14px;margin-top:12px;font-size:11px;color:#f87171;">
           <span style="letter-spacing:1px;">⚠ MISSED COMMISSIONS: ${fmtUSDT(missed,{noEth:true})} (${missed.toFixed(6)} ETH)</span>
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
          <div style="font-size:18px;color:#4ade80;font-family:var(--font-display);">${fmtUSDT(earned,{noEth:true})}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;">${earned.toFixed(6)} ETH</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">CAP REMAINING</div>
          <div style="font-size:18px;color:var(--gold);font-family:var(--font-display);">${fmtUSDT(remaining,{noEth:true})}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;">${remaining.toFixed(6)} ETH</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">MISSED</div>
          <div style="font-size:18px;font-family:var(--font-display);${missed > 0.000001 ? 'color:#f87171' : 'color:var(--muted)'};">${missed > 0.000001 ? fmtUSDT(missed,{noEth:true}) : '—'}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;">${missed > 0.000001 ? missed.toFixed(6)+' ETH' : 'none'}</div>
        </div>
      </div>
      ${missedWarn}
      ${histHtml}`;

  } catch(e) {
    el.innerHTML = `<div class="empty-state">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  }
}

async function loadRwStaking() {
  const el = document.getElementById('rwStakingContent');
  el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  try {
    const [stakingData, lpLocks, latestBlock] = await Promise.all([
      contract.getStakingReward(walletAddress),
      contract.getUserLPLocks(walletAddress),
      provider.getBlock('latest')
    ]);

    const now              = latestBlock ? latestBlock.timestamp : Math.floor(Date.now() / 1000);
    const lifetimeClaimed  = parseFloat(ethers.utils.formatEther(stakingData.lifetimeClaimed));
    const totalAccumulated = parseFloat(ethers.utils.formatEther(stakingData.totalAccumulated));
    const previewNewTokens = parseFloat(ethers.utils.formatEther(stakingData.previewNewTokens));
    const totalClaimable   = totalAccumulated + previewNewTokens;

    // Compute USDT figures from lock data (linear per-second accrual, capped at period end).
    // Removed locks are included — rewards earned before removal remain claimable.
    let totalLiveUSDT      = 0;
    let totalClaimableUSDT = 0;
    for (const lock of lpLocks) {
      const la    = Number(lock.lockedAt);
      const ut    = Number(lock.unlockTime);
      const dur   = Math.max(ut - la, 60);
      const ethInv = parseFloat(ethers.utils.formatEther(lock.ethInvested));
      const rwETH  = ethInv * 0.30;
      const elapsed = Math.min(dur, Math.max(0, now - la));
      const earnedETH = dur > 0 ? rwETH * elapsed / dur : 0;
      const claimedETH = parseFloat(ethers.utils.formatEther(lock.rewardClaimedETH || ethers.BigNumber.from(0)));
      const pendingETH = Math.max(0, earnedETH - claimedETH);
      const carry = parseFloat(ethers.utils.formatEther(lock.tokensAccumulated || ethers.BigNumber.from(0)));
      totalLiveUSDT      += earnedETH * USDT_PER_ETH;
      totalClaimableUSDT += pendingETH * USDT_PER_ETH;
    }
    const canClaim = totalClaimable > 0;

    let tokenSymbol = 'HORDEX';
    if (lpLocks.length > 0) {
      try { const t = await contract.getToken(lpLocks[0].token); tokenSymbol = t.symbol; } catch(_) {}
    }

    let lockRows = '';
    for (let i = 0; i < lpLocks.length; i++) {
      const lock        = lpLocks[i];
      const isRemoved   = lock.removed || false;
      const lockedAt    = Number(lock.lockedAt);
      const unlockTime  = Number(lock.unlockTime);
      const lockDurSecs = unlockTime > lockedAt ? unlockTime - lockedAt : 60;
      const ethInvested = parseFloat(ethers.utils.formatEther(lock.ethInvested));
      const rewardClaimedETH  = parseFloat(ethers.utils.formatEther(lock.rewardClaimedETH || ethers.BigNumber.from(0)));
      const tokensAccumulated = parseFloat(ethers.utils.formatEther(lock.tokensAccumulated || ethers.BigNumber.from(0)));
      const totalClaimed      = parseFloat(ethers.utils.formatEther(lock.totalTokensClaimed || ethers.BigNumber.from(0)));
      const elapsed           = Math.min(lockDurSecs, Math.max(0, now - lockedAt));
      const rewardTotalETH    = ethInvested * 0.30;
      const earnedETH         = lockDurSecs > 0 ? rewardTotalETH * elapsed / lockDurSecs : 0;
      const pendingETH        = Math.max(0, earnedETH - rewardClaimedETH);
      const liveUSDT_lock     = earnedETH * USDT_PER_ETH;
      const claimUSDT_lock    = pendingETH * USDT_PER_ETH;

      // Skip locks with no rewards at all (no earned, no carry, no claimed ever).
      if (earnedETH === 0 && tokensAccumulated === 0 && totalClaimed === 0) continue;

      const claimedPct = rewardTotalETH > 0 ? Math.min(100, rewardClaimedETH / rewardTotalETH * 100) : 0;
      const pendingPct = rewardTotalETH > 0 ? Math.min(100 - claimedPct, pendingETH / rewardTotalETH * 100) : 0;
      const progressBar = isRemoved
        ? `<div style="font-size:9px;color:#f87171;letter-spacing:1px;">LP REMOVED</div>`
        : `<div class="dis-bar-track" style="width:100%;min-width:70px;">
            <div class="dis-bar-claimed" style="width:${claimedPct.toFixed(2)}%"></div>
            <div class="dis-bar-active" style="left:${claimedPct.toFixed(2)}%; width:${pendingPct.toFixed(2)}%"></div>
          </div>`;

      const progressLabel = isRemoved
        ? `full period earned`
        : `${(elapsed / lockDurSecs * 100).toFixed(1)}% of period`;
      const claimedCell   = totalClaimed > 0
        ? `<span style="color:#4ade80;">✓ ${totalClaimed.toFixed(4)} ${tokenSymbol} claimed</span>`
        : '';
      const statusCell    = claimUSDT_lock > 0
        ? `<span style="color:var(--gold);">$${claimUSDT_lock.toFixed(6)} USDT</span>`
        : `<span style="color:var(--muted);">—</span>`;

      lockRows += `
        <tr style="border-bottom:1px solid rgba(20,30,42,0.7);">
          <td style="padding:8px 8px;color:var(--muted);font-size:10px;">#${i+1}</td>
          <td style="padding:8px 8px;color:var(--cream);">${fmtUSDT(ethInvested,{noEth:true})}<div style="font-size:9px;color:var(--muted);">accrued: $${liveUSDT_lock.toFixed(6)} USDT</div></td>
          <td style="padding:8px 8px;">
            ${progressBar}
            <div style="font-size:9px;color:var(--muted);margin-top:3px;">${progressLabel} · ${claimedCell}</div>
          </td>
          <td style="padding:8px 8px;text-align:right;">${statusCell}</td>
        </tr>`;
    }

    el.innerHTML = `
      <div style="background:rgba(201,168,76,0.06);border:1px solid rgba(201,168,76,0.18);border-radius:6px;padding:12px 14px;margin-bottom:16px;font-size:11px;font-family:var(--font-mono);">
        <div style="color:var(--gold);letter-spacing:1px;font-size:10px;margin-bottom:5px;">HOW STAKING REWARDS WORK</div>
        <div style="color:var(--muted);line-height:1.75;">Rewards accrue at <span style="color:var(--cream);">30% of your invested amount per lock period</span>, every second, capped at the lock period end. Restake to start a new period. When you claim, the accrued USDT value is <span style="color:var(--gold);">converted to ${tokenSymbol} tokens at the current market price</span> and sent to your wallet. Claim any time — no minimum wait.</div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:16px;">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">ACCRUED (USDT)</div>
          <div style="font-size:16px;color:var(--gold);font-family:var(--font-display);">${totalLiveUSDT > 0 ? '$' + totalLiveUSDT.toFixed(6) : '$0.000000'}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;">30% of investment · live</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">CLAIMABLE (USDT)</div>
          <div style="font-size:16px;color:var(--cream);font-family:var(--font-display);">${totalClaimableUSDT > 0 ? '$' + totalClaimableUSDT.toFixed(6) : '$0.000000'}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;">unclaimed · converts to tokens at claim</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">LIFETIME CLAIMED</div>
          <div style="font-size:16px;color:#4ade80;font-family:var(--font-display);">${lifetimeClaimed > 0 ? lifetimeClaimed.toFixed(4) : '0'}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;">${tokenSymbol} tokens total</div>
        </div>
      </div>

      <div style="margin-bottom:16px;">
        <button id="claimStakingBtn" onclick="claimStakingReward()"
          style="background:${canClaim ? 'var(--gold)' : 'rgba(255,255,255,0.06)'};
                 border:1px solid ${canClaim ? 'var(--gold)' : 'var(--border)'};
                 color:${canClaim ? '#0a0a0a' : 'var(--muted)'};
                 border-radius:4px;padding:10px 24px;font-family:var(--font-mono);
                 font-size:11px;font-weight:700;letter-spacing:1px;cursor:${canClaim ? 'pointer' : 'not-allowed'};
                 transition:opacity 0.15s;"
          ${canClaim ? '' : 'disabled'}>
          ${canClaim ? 'CLAIM ALL · ' + totalClaimable.toFixed(4) + ' ' + tokenSymbol : 'NOTHING TO CLAIM'}
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
              <th style="text-align:right;padding:6px 8px;color:var(--muted);font-weight:400;">CLAIMABLE</th>
            </tr>
          </thead>
          <tbody>${lockRows}</tbody>
        </table>
      </div>` : '<div class="empty-state">No investments yet. Go to INVEST to get started.</div>'}`;

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
        <div style="color:var(--muted);line-height:1.75;">Every swap in a Uniswap pool charges a <span style="color:var(--cream);">0.3% fee</span> that flows directly to LP providers. In V2, fees <span style="color:var(--cream);">compound automatically</span> inside the pool — your LP tokens grow in value with every swap. <span style="color:var(--gold);">No separate fee claim is needed.</span> Pool earnings are automatically included when you claim or remove your LP tokens.</div>
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

window.loadRewards           = loadRewards;
window.loadRwReferral        = loadRwReferral;
window.loadRwStaking         = loadRwStaking;
window.loadRwLPFees          = loadRwLPFees;
window.claimStakingReward    = claimStakingReward;
