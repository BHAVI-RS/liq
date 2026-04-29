async function loadMyInfo() {
  if (!requireConnected()) return;
  _tabLoaded.add('myinfo');
  try {
    const user      = await contract.users(walletAddress);
    const referrer  = user.referrer;
    const referrals = await contract.getReferrals(walletAddress);
    const el        = document.getElementById('myInfoContent');
    const refLink   = window.location.origin + window.location.pathname + '?ref=' + walletAddress;
    el.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:18px 20px;margin-bottom:20px;">
        <div style="font-size:10px;color:var(--muted);letter-spacing:.1em;margin-bottom:10px;">MY REFERRAL LINK</div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div style="flex:1;font-family:var(--font-mono);font-size:11px;color:var(--gold);background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:8px 12px;word-break:break-all;" id="myRefLinkText">${refLink}</div>
          <button onclick="copyRefLink()" style="padding:8px 16px;font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--cream);cursor:pointer;white-space:nowrap;flex-shrink:0;" id="copyRefBtn">COPY</button>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:8px;">Share this link. Anyone who registers through it becomes your Level 1 referral and earns you commissions on their investments.</div>
      </div>
      <div class="info-grid">
        <div class="info-cell">
          <div class="info-cell-label">STATUS</div>
          <div class="info-cell-value" style="color:${user.isRegistered ? 'var(--success)' : 'var(--danger)'}">${user.isRegistered ? '✓ REGISTERED' : '✗ NOT REGISTERED'}</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-label">MY ADDRESS</div>
          <div class="info-cell-value">${walletAddress.slice(0,12) + '...'}</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-label">MY REFERRER</div>
          <div class="info-cell-value">${referrer === ethers.constants.AddressZero ? '— (Root)' : referrer.slice(0,12) + '...'}</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-label">DIRECT REFERRALS</div>
          <div class="info-cell-value" style="color:var(--gold);font-size:20px;font-family:var(--font-display)">${referrals.length}</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-label">JOINED</div>
          <div class="info-cell-value">${user.registeredAt.toNumber() > 0 ? new Date(user.registeredAt.toNumber()*1000).toLocaleString() : '—'}</div>
        </div>
      </div>
      ${referrals.length > 0 ? `
        <div style="margin-top:20px;">
          <div class="section-header">DIRECT REFERRALS</div>
          <div class="referral-chain">
            ${referrals.map((r,i) => `
              <div class="referral-item">
                <span class="referral-level">LVL ${i+1}</span>
                <span>${r}</span>
              </div>
            `).join('')}
          </div>
        </div>` : ''}
    `;
  } catch(e) {
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

window.loadMyInfo = loadMyInfo;
