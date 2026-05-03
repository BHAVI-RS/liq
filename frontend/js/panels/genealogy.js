let _geneView = 'list';
let _geneTree = null;

function switchGeneView(mode) {
  _geneView = mode;
  document.getElementById('geneListView').style.display = mode === 'list' ? '' : 'none';
  document.getElementById('geneTreeView').style.display = mode === 'tree' ? '' : 'none';
  document.getElementById('geneListBtn').style.background = mode === 'list' ? 'var(--gold)' : 'var(--surface)';
  document.getElementById('geneListBtn').style.color      = mode === 'list' ? '#000' : 'var(--muted)';
  document.getElementById('geneTreeBtn').style.background = mode === 'tree' ? 'var(--gold)' : 'var(--surface)';
  document.getElementById('geneTreeBtn').style.color      = mode === 'tree' ? '#000' : 'var(--muted)';
}

async function fetchGeneTree(addr, depth) {
  if (depth > 10) return { addr, children: [] };
  let refs = [];
  try { refs = await contract.getReferrals(addr); } catch(_) {}
  const children = [];
  for (const r of refs) children.push(await fetchGeneTree(r, depth + 1));
  return { addr, children };
}

async function loadGenealogy() {
  if (!requireConnected()) return;
  _tabLoaded.add('genealogy');
  const listEl = document.getElementById('geneListView');
  const treeEl = document.getElementById('geneTreeView');
  listEl.innerHTML = '<div class="empty-state">Loading genealogy<span class="ld"><span></span><span></span><span></span></span></div>';
  treeEl.innerHTML = '';
  try {
    const [treeData, activeCountRaw, minInvRaw] = await Promise.all([
      fetchGeneTree(walletAddress, 1),
      contract.getActiveDirectReferralCount(walletAddress).catch(() => ethers.BigNumber.from(0)),
      contract.minDirectReferralInvestment().catch(() => ethers.BigNumber.from(0))
    ]);
    _geneTree = treeData;
    const activeCount = Number(activeCountRaw);
    const minInvETH   = parseFloat(ethers.utils.formatEther(minInvRaw));

    const levels = [];
    function collectLevels(node, depth) {
      if (depth > 10) return;
      for (const child of node.children) {
        if (!levels[depth - 1]) levels[depth - 1] = [];
        levels[depth - 1].push(child.addr);
        collectLevels(child, depth + 1);
      }
    }
    collectLevels(_geneTree, 1);

    const totalReferrals = levels.reduce((s, l) => s + l.length, 0);

    // Eligibility banner: shows which levels the user can currently earn from
    const maxEligibleLevel = Math.min(activeCount, 10);
    const nextLevelNeeded  = maxEligibleLevel + 1;
    const minInvLabel      = minInvETH > 0 ? `(≥ ${fmtUSDT(minInvETH,{noEth:true})} active each)` : '(any active investment)';
    const eligBannerColor  = maxEligibleLevel > 0 ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)';
    const eligBorderColor  = maxEligibleLevel > 0 ? 'rgba(74,222,128,0.25)' : 'rgba(248,113,113,0.25)';
    const eligTextColor    = maxEligibleLevel > 0 ? '#4ade80' : '#f87171';

    let nextLevelHint = '';
    if (maxEligibleLevel < 10) {
      nextLevelHint = `<div style="margin-top:5px;font-size:10px;color:var(--muted);">Need <span style="color:var(--cream);">${nextLevelNeeded} active direct referral${nextLevelNeeded !== 1 ? 's' : ''}</span> to unlock Level ${nextLevelNeeded} commission ${minInvLabel}.</div>`;
    }

    const eligBanner = `
      <div style="background:${eligBannerColor};border:1px solid ${eligBorderColor};border-radius:6px;padding:11px 14px;margin-bottom:16px;font-size:11px;font-family:var(--font-mono);">
        <div style="color:${eligTextColor};letter-spacing:1px;font-size:10px;margin-bottom:4px;">COMMISSION ELIGIBILITY</div>
        <div style="color:var(--cream);">
          ${activeCount} active direct referral${activeCount !== 1 ? 's' : ''} → earning up to
          <span style="color:${eligTextColor};font-weight:700;">Level ${maxEligibleLevel > 0 ? maxEligibleLevel : 0} commission</span>
          ${maxEligibleLevel === 10 ? '<span style="color:var(--gold);"> · MAX</span>' : ''}
        </div>
        ${nextLevelHint}
      </div>`;

    if (totalReferrals === 0) {
      listEl.innerHTML = eligBanner + '<div class="empty-state">No referrals yet. Share your referral link to grow your network.</div>';
    } else {
      listEl.innerHTML = eligBanner;

      const allAddrs   = [...new Set(levels.flat())];
      const investedMap = new Map();
      await Promise.all(allAddrs.map(async addr => {
        try {
          const amt = await contract.userTotalInvested(addr);
          investedMap.set(addr, parseFloat(ethers.utils.formatEther(amt)));
        } catch(_) { investedMap.set(addr, 0); }
      }));

      levels.forEach((addrs, idx) => {
        if (!addrs || addrs.length === 0) return;
        const level      = idx + 1;
        const rate       = COMMISSION_RATES[idx] !== undefined ? COMMISSION_RATES[idx].toFixed(2) + '%' : '—';
        const levelTotal = addrs.reduce((s, a) => s + (investedMap.get(a) || 0), 0);
        const eligible   = activeCount >= level;
        const eligStyle  = eligible
          ? 'color:#4ade80;font-size:10px;font-family:var(--font-mono);margin-left:8px;'
          : 'color:#f87171;font-size:10px;font-family:var(--font-mono);margin-left:8px;';
        const eligLabel  = eligible ? '✓ ELIGIBLE' : `✗ NEED ${level} ACTIVE REFERRAL${level !== 1 ? 'S' : ''}`;
        const block = document.createElement('div');
        block.className = 'gene-level-block';
        block.innerHTML = `
          <div class="gene-level-header">
            <span class="gene-level-badge">LEVEL ${level}</span>
            <span class="gene-commission-rate">${rate} commission</span>
            <span style="${eligStyle}">${eligLabel}</span>
            <span class="gene-count-pill" style="margin-left:auto;">${addrs.length} member${addrs.length !== 1 ? 's' : ''}</span>
            <span style="margin-left:8px;font-size:10px;color:var(--gold);font-family:var(--font-mono);">${fmtUSDT(levelTotal,{noEth:true})} invested</span>
          </div>
          ${addrs.map(a => {
            const inv = investedMap.get(a) || 0;
            return `<div class="gene-addr-row" style="justify-content:space-between;">
              <div style="display:flex;align-items:center;gap:8px;">
                <div class="gene-addr-dot"></div>
                <a href="https://sepolia.etherscan.io/address/${a}" target="_blank" rel="noopener" title="${a}" style="color:var(--cream);text-decoration:none;font-family:var(--font-mono);font-size:12px;">${a.slice(0,10)}…${a.slice(-6)}</a>
              </div>
              <span style="font-size:11px;font-family:var(--font-mono);color:${inv > 0 ? 'var(--gold)' : 'var(--muted)'};">${inv > 0 ? fmtUSDT(inv,{noEth:true}) : '—'}</span>
            </div>`;
          }).join('')}
        `;
        listEl.appendChild(block);
      });
    }

    function buildTreeHTML(node, depth) {
      const isRoot = depth === 0;
      const label = isRoot
        ? `<span class="gene-node gene-node-self" title="${node.addr}">YOU  ${node.addr.slice(0,8)}…${node.addr.slice(-6)}</span>`
        : `<span class="gene-node" title="${node.addr}"><span class="gene-node-lvl">L${depth}</span>${node.addr.slice(0,10)}…${node.addr.slice(-6)}</span>`;
      if (node.children.length === 0) return `<li>${label}</li>`;
      return `<li>${label}<ul>${node.children.map(c => buildTreeHTML(c, depth + 1)).join('')}</ul></li>`;
    }

    treeEl.innerHTML = `
      <div class="gene-tree">
        <ul style="padding-left:0;">${buildTreeHTML(_geneTree, 0)}</ul>
      </div>`;

    const rootUl = treeEl.querySelector('.gene-tree > ul');
    if (rootUl) rootUl.style.cssText += ';padding-left:0;';

    switchGeneView(_geneView);
  } catch(e) {
    listEl.innerHTML = '<div class="empty-state">Failed to load genealogy: ' + (e.errorName || e.reason || e?.error?.message || e.message) + '</div>';
  }
}

window.switchGeneView = switchGeneView;
window.loadGenealogy  = loadGenealogy;
