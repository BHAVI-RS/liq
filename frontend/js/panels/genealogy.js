let _geneView      = 'list';
let _geneTree      = null;
let _geneInvestedMap = new Map();
let _geneStatsMap    = new Map();  // addr.toLowerCase() → { teamCount, teamBusiness }

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

function _geneCollectAddrs(node, result = []) {
  result.push(node.addr);
  for (const child of node.children) _geneCollectAddrs(child, result);
  return result;
}

function _geneComputeStats(node) {
  let count = 0, business = 0;
  for (const child of node.children) {
    const inv = _geneInvestedMap.get(child.addr) || 0;
    if (inv > 0) count++;
    business += inv;
    const sub = _geneComputeStats(child);
    count    += sub.count;
    business += sub.business;
  }
  node._teamCount    = count;
  node._teamBusiness = business;
  return { count, business };
}

function _buildGeneStatsMap(node) {
  _geneStatsMap.set(node.addr.toLowerCase(), {
    teamCount:    node._teamCount    || 0,
    teamBusiness: node._teamBusiness || 0
  });
  for (const child of node.children) _buildGeneStatsMap(child);
}

// ─── Shared tooltip ───────────────────────────────────────────────────────────

function geneShowTooltip(e, el) {
  let tt = document.getElementById('geneTooltip');
  if (!tt) {
    tt = document.createElement('div');
    tt.id = 'geneTooltip';
    tt.style.cssText = [
      'position:fixed','z-index:9000','background:#0b1520',
      'border:1px solid rgba(201,168,76,0.35)','border-radius:8px',
      'padding:12px 16px','font-family:var(--font-mono)','font-size:11px',
      'pointer-events:none','min-width:250px','max-width:320px',
      'box-shadow:0 6px 28px rgba(0,0,0,0.65)','display:none','line-height:1.5'
    ].join(';');
    document.body.appendChild(tt);
  }

  const addr    = el.dataset.addr   || '';
  const inv     = parseFloat(el.dataset.inv           || '0');
  const teamCnt = parseInt(el.dataset.teamCount       || '0');
  const teamBiz = parseFloat(el.dataset.teamBusiness  || '0');

  const invLabel = inv > 0 ? fmtUSDT(inv, {noEth:true}) : `<span style="color:#f87171;">No active package</span>`;
  const bizLabel = fmtUSDT(teamBiz, {noEth:true});

  tt.innerHTML = `
    <div style="color:var(--gold);font-size:10px;letter-spacing:1px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(201,168,76,0.2);">USER DETAILS</div>
    <div style="display:grid;grid-template-columns:auto 1fr;gap:5px 14px;align-items:baseline;">
      <div style="color:var(--muted);font-size:9px;letter-spacing:.08em;white-space:nowrap;">ADDRESS</div>
      <div style="color:var(--gold);font-size:10px;word-break:break-all;">${addr.slice(0,12)}…${addr.slice(-8)}</div>
      <div style="color:var(--muted);font-size:9px;letter-spacing:.08em;white-space:nowrap;">ACTIVE PKG</div>
      <div style="color:var(--cream);">${invLabel}</div>
      <div style="color:var(--muted);font-size:9px;letter-spacing:.08em;white-space:nowrap;">TEAM VOLUME</div>
      <div style="color:var(--cream);">${teamCnt} active user${teamCnt !== 1 ? 's' : ''}</div>
      <div style="color:var(--muted);font-size:9px;letter-spacing:.08em;white-space:nowrap;">TEAM BUSINESS</div>
      <div style="color:#4ade80;">${bizLabel}</div>
    </div>`;

  tt.style.display = 'block';
  const margin = 14, tw = tt.offsetWidth || 270, th = tt.offsetHeight || 130;
  let left = e.clientX + margin, top = e.clientY + margin;
  if (left + tw > window.innerWidth  - 8) left = e.clientX - tw - margin;
  if (top  + th > window.innerHeight - 8) top  = e.clientY - th - margin;
  tt.style.left = left + 'px';
  tt.style.top  = top  + 'px';
}

function geneHideTooltip() {
  const tt = document.getElementById('geneTooltip');
  if (tt) tt.style.display = 'none';
}

// ─── List view accordion toggle ───────────────────────────────────────────────

function geneListLevelToggle(id) {
  const content = document.getElementById(id);
  const arrow   = document.getElementById(id + '-arrow');
  if (!content) return;
  const opening = content.style.display === 'none';
  content.style.display = opening ? '' : 'none';
  if (arrow) arrow.textContent = opening ? '▼' : '▶';
}

// ─── Tree view node builder ───────────────────────────────────────────────────

function _geneBuildNodeHtml(node, depth) {
  const isRoot  = depth === 0;
  const addr    = node.addr;
  const hasKids = node.children.length > 0;
  const nid     = 'gnd' + addr.slice(2).toLowerCase();
  const inv     = _geneInvestedMap.get(addr) || 0;

  const expandIcon = hasKids
    ? `<span id="ei-${nid}" style="display:inline-block;width:14px;font-size:9px;color:var(--muted);vertical-align:middle;flex-shrink:0;">▶</span>`
    : `<span style="display:inline-block;width:14px;flex-shrink:0;"></span>`;

  const label = isRoot
    ? `YOU · ${addr.slice(0, 8)}…${addr.slice(-6)}`
    : `<span class="gene-node-lvl">L${depth}</span>${addr.slice(0, 10)}…${addr.slice(-6)}`;

  const nodeEl = `<span class="gene-node ${isRoot ? 'gene-node-self' : ''}"
    id="${nid}"
    data-addr="${addr}"
    data-inv="${inv}"
    data-team-count="${node._teamCount || 0}"
    data-team-business="${node._teamBusiness || 0}"
    ${hasKids ? `onclick="geneNodeClick('${nid}')"` : ''}
    onmouseenter="geneShowTooltip(event,this)"
    onmouseleave="geneHideTooltip()"
    style="display:inline-flex;align-items:center;gap:4px;${hasKids ? 'cursor:pointer;' : ''}"
  >${expandIcon}${label}</span>`;

  if (!hasKids) return `<li>${nodeEl}</li>`;
  const hidden = depth >= 1 ? 'style="display:none"' : '';
  const kids   = node.children.map(c => _geneBuildNodeHtml(c, depth + 1)).join('');
  return `<li>${nodeEl}<ul class="gene-subtree" id="sub-${nid}" ${hidden}>${kids}</ul></li>`;
}

function geneNodeClick(nid) {
  const ul = document.getElementById('sub-' + nid);
  const ei = document.getElementById('ei-'  + nid);
  if (!ul) return;
  const opening = ul.style.display === 'none';
  ul.style.display = opening ? '' : 'none';
  if (ei) {
    ei.textContent = opening ? '▼' : '▶';
    ei.style.color = opening ? 'var(--gold)' : 'var(--muted)';
  }
}

// ─── loadGenealogy ────────────────────────────────────────────────────────────

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

    // Fetch investment amounts for every node (shared by list + tree)
    const allAddrs = _geneCollectAddrs(treeData);
    _geneInvestedMap = new Map();
    await Promise.all(allAddrs.map(async a => {
      try {
        const amt = await contract.userTotalInvested(a);
        _geneInvestedMap.set(a, parseFloat(ethers.utils.formatEther(amt)));
      } catch(_) { _geneInvestedMap.set(a, 0); }
    }));

    // Annotate tree nodes with team stats, then build flat lookup map
    _geneComputeStats(treeData);
    _geneStatsMap = new Map();
    _buildGeneStatsMap(treeData);

    // Collect level arrays for list view
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

    // ── Eligibility banner ──────────────────────────────────────────────────
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

    // ── List view ───────────────────────────────────────────────────────────
    if (totalReferrals === 0) {
      listEl.innerHTML = eligBanner + '<div class="empty-state">No referrals yet. Share your referral link to grow your network.</div>';
    } else {
      listEl.innerHTML = eligBanner;
      listEl.insertAdjacentHTML('beforeend',
        '<div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);letter-spacing:.05em;margin-bottom:12px;">Click a level header to expand · Hover a member for details</div>'
      );

      levels.forEach((addrs, idx) => {
        if (!addrs || addrs.length === 0) return;
        const level    = idx + 1;
        const isFirst  = level === 1;
        const blockId  = `glvl${level}`;
        const rate     = COMMISSION_RATES[idx] !== undefined ? COMMISSION_RATES[idx].toFixed(2) + '%' : '—';
        const levelTotal = addrs.reduce((s, a) => s + (_geneInvestedMap.get(a) || 0), 0);
        const eligible = activeCount >= level;
        const eligStyle = eligible
          ? 'color:#4ade80;font-size:10px;font-family:var(--font-mono);margin-left:8px;'
          : 'color:#f87171;font-size:10px;font-family:var(--font-mono);margin-left:8px;';
        const eligLabel = eligible ? '✓ ELIGIBLE' : `✗ NEED ${level} ACTIVE REFERRAL${level !== 1 ? 'S' : ''}`;

        const memberRows = addrs.map(a => {
          const inv   = _geneInvestedMap.get(a) || 0;
          const stats = _geneStatsMap.get(a.toLowerCase()) || { teamCount: 0, teamBusiness: 0 };
          return `<div class="gene-addr-row"
            data-addr="${a}"
            data-inv="${inv}"
            data-team-count="${stats.teamCount}"
            data-team-business="${stats.teamBusiness}"
            onmouseenter="geneShowTooltip(event,this)"
            onmouseleave="geneHideTooltip()"
            style="justify-content:space-between;cursor:default;">
            <div style="display:flex;align-items:center;gap:8px;">
              <div class="gene-addr-dot"></div>
              <a href="https://sepolia.etherscan.io/address/${a}" target="_blank" rel="noopener" title="${a}"
                 style="color:var(--cream);text-decoration:none;font-family:var(--font-mono);font-size:12px;"
                 onclick="event.stopPropagation()">${a.slice(0,10)}…${a.slice(-6)}</a>
            </div>
            <span style="font-size:11px;font-family:var(--font-mono);color:${inv > 0 ? 'var(--gold)' : 'var(--muted)'};">${inv > 0 ? fmtUSDT(inv,{noEth:true}) : '—'}</span>
          </div>`;
        }).join('');

        const block = document.createElement('div');
        block.className = 'gene-level-block';
        block.innerHTML = `
          <div class="gene-level-header"
            onclick="geneListLevelToggle('${blockId}')"
            style="cursor:pointer;user-select:none;">
            <span class="gene-level-badge">LEVEL ${level}</span>
            <span class="gene-commission-rate">${rate} commission</span>
            <span style="${eligStyle}">${eligLabel}</span>
            <span class="gene-count-pill" style="margin-left:auto;">${addrs.length} member${addrs.length !== 1 ? 's' : ''}</span>
            <span style="margin-left:8px;font-size:10px;color:var(--gold);font-family:var(--font-mono);">${fmtUSDT(levelTotal,{noEth:true})} invested</span>
            <span id="${blockId}-arrow" style="margin-left:10px;font-size:11px;color:var(--muted);">${isFirst ? '▼' : '▶'}</span>
          </div>
          <div id="${blockId}" style="${isFirst ? '' : 'display:none;'}">
            ${memberRows}
          </div>`;
        listEl.appendChild(block);
      });
    }

    // ── Tree view ───────────────────────────────────────────────────────────
    treeEl.innerHTML = `
      <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);letter-spacing:.05em;margin-bottom:12px;">
        Click any node to expand · Hover for details
      </div>
      <div class="gene-tree">
        <ul style="padding-left:0;">${_geneBuildNodeHtml(_geneTree, 0)}</ul>
      </div>`;

    switchGeneView(_geneView);
  } catch(e) {
    listEl.innerHTML = '<div class="empty-state">Failed to load genealogy: ' + (e.errorName || e.reason || e?.error?.message || e.message) + '</div>';
  }
}

window.switchGeneView       = switchGeneView;
window.loadGenealogy        = loadGenealogy;
window.geneNodeClick        = geneNodeClick;
window.geneShowTooltip      = geneShowTooltip;
window.geneHideTooltip      = geneHideTooltip;
window.geneListLevelToggle  = geneListLevelToggle;
