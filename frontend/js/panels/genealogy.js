let _geneView      = 'list';
let _geneLoading   = false;
let _geneTree      = null;
let _geneRootNid   = null;
let _geneInvestedMap = new Map();
let _geneStatsMap    = new Map();  // addr.toLowerCase() → { teamCount, teamBusiness }
let _geneTtHideTimer = null;

function switchGeneView(mode) {
  _geneView = mode;
  document.getElementById('geneListView').style.display = mode === 'list' ? '' : 'none';
  document.getElementById('geneTreeView').style.display = mode === 'tree' ? '' : 'none';
  document.getElementById('geneListBtn').style.background = mode === 'list' ? 'var(--gold)' : 'var(--surface)';
  document.getElementById('geneListBtn').style.color      = mode === 'list' ? '#000' : 'var(--muted)';
  document.getElementById('geneTreeBtn').style.background = mode === 'tree' ? 'var(--gold)' : 'var(--surface)';
  document.getElementById('geneTreeBtn').style.color      = mode === 'tree' ? '#000' : 'var(--muted)';

  // On mobile tree view: always show the detail panel, defaulting to the root "YOU" node
  if (mode === 'tree' && _isTouchDevice() && _geneRootNid) {
    const rootEl = document.getElementById(_geneRootNid);
    if (rootEl) _geneShowMobileDetail(rootEl);
  }
}

// Fetches the entire downline under `addr` in a SINGLE RPC call (contract.getDownline does
// the tree traversal on-chain) instead of one getReferrals() call per node. The flattened
// nodes are rebuilt into the same { addr, children } shape the rest of the panel expects.
// Each node is annotated with `_inv` (the member's total invested, in USDT/ETH units) so
// callers no longer need a separate userTotalInvested() call per member either.
// `depth` is the 1-based level of `addr`; the genealogy historically showed up to level 10,
// so we request (11 - depth) levels of referrals below the requested node.
async function fetchGeneTree(addr, depth) {
  const maxDepth = Math.max(0, 11 - (depth || 1));
  let nodes = [];
  try { nodes = await contract.getDownline(addr, maxDepth); } catch(_) {}
  if (!nodes || nodes.length === 0) return { addr, children: [], _inv: 0 };
  const objs = nodes.map(n => ({
    addr:     n.addr,
    children: [],
    _inv:     parseFloat(ethers.utils.formatEther(n.totalInvested)),
  }));
  for (let i = 1; i < nodes.length; i++) {
    const p = Number(nodes[i].parent);
    if (objs[p]) objs[p].children.push(objs[i]);
  }
  return objs[0];
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

const _isTouchDevice = () => ('ontouchstart' in window || navigator.maxTouchPoints > 0);

function _geneBuildTooltipBody(el) {
  const addr    = el.dataset.addr          || '';
  const inv     = parseFloat(el.dataset.inv           || '0');
  const teamCnt = parseInt(el.dataset.teamCount       || '0');
  const teamBiz = parseFloat(el.dataset.teamBusiness  || '0');
  const invLabel = inv > 0 ? fmtUSDT(inv, {noEth:true}) : `<span style="color:#f87171;">No active package</span>`;
  const bizLabel = fmtUSDT(teamBiz, {noEth:true});
  const copyBtn  = `<button onclick="copyAddr('${addr}',this)" title="Copy address" style="padding:2px 4px;display:inline-flex;align-items:center;justify-content:center;border:1px solid rgba(201,168,76,0.3);border-radius:3px;background:var(--surface);color:var(--muted);cursor:pointer;flex-shrink:0;line-height:1;">${_COPY_ICON}</button>`;
  return `
    <div style="display:grid;grid-template-columns:auto 1fr;gap:5px 14px;align-items:center;">
      <div style="color:var(--muted);font-size:9px;letter-spacing:.08em;white-space:nowrap;">ADDRESS</div>
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="color:var(--gold);font-size:10px;word-break:break-all;">${addr}</span>
        ${copyBtn}
      </div>
      <div style="color:var(--muted);font-size:9px;letter-spacing:.08em;white-space:nowrap;">ACTIVE PKG</div>
      <div style="color:var(--cream);">${invLabel}</div>
      <div style="color:var(--muted);font-size:9px;letter-spacing:.08em;white-space:nowrap;">TEAM VOLUME</div>
      <div style="color:var(--cream);">${teamCnt} active user${teamCnt !== 1 ? 's' : ''}</div>
      <div style="color:var(--muted);font-size:9px;letter-spacing:.08em;white-space:nowrap;">TEAM BUSINESS</div>
      <div style="color:#4ade80;">${bizLabel}</div>
    </div>`;
}

function geneShowTooltip(e, el) {
  // On touch devices, suppress hover-triggered calls — tooltip is shown via tap in geneNodeClick instead
  if (_isTouchDevice()) return;

  if (_geneTtHideTimer) { clearTimeout(_geneTtHideTimer); _geneTtHideTimer = null; }

  let tt = document.getElementById('geneTooltip');
  if (!tt) {
    tt = document.createElement('div');
    tt.id = 'geneTooltip';
    tt.style.cssText = [
      'position:fixed','z-index:9000','background:#0b1520',
      'border:1px solid rgba(201,168,76,0.35)','border-radius:8px',
      'padding:12px 16px','font-family:var(--font-mono)','font-size:11px',
      'pointer-events:auto','min-width:250px','max-width:320px',
      'box-shadow:0 6px 28px rgba(0,0,0,0.65)','display:none','line-height:1.5'
    ].join(';');
    tt.addEventListener('mouseenter', () => {
      if (_geneTtHideTimer) { clearTimeout(_geneTtHideTimer); _geneTtHideTimer = null; }
    });
    tt.addEventListener('mouseleave', () => {
      _geneTtHideTimer = setTimeout(() => {
        const t = document.getElementById('geneTooltip');
        if (t) t.style.display = 'none';
      }, 100);
    });
    document.body.appendChild(tt);
  }

  tt.innerHTML = `<div style="color:var(--gold);font-size:10px;letter-spacing:1px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(201,168,76,0.2);">USER DETAILS</div>` + _geneBuildTooltipBody(el);
  tt.style.display = 'block';
  const tw   = tt.offsetWidth  || 280;
  const th   = tt.offsetHeight || 160;
  const rect = el.getBoundingClientRect();
  const margin = 10;
  let left = rect.right + margin;
  if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
  let top = rect.top + rect.height / 2 - th / 2;
  top = Math.max(8, Math.min(window.innerHeight - th - 8, top));
  tt.style.right = 'auto';
  tt.style.left  = left + 'px';
  tt.style.top   = top  + 'px';
}

function geneHideTooltip() {
  if (_isTouchDevice()) return;
  _geneTtHideTimer = setTimeout(() => {
    const tt = document.getElementById('geneTooltip');
    if (tt) tt.style.display = 'none';
  }, 120);
}

// Mobile-only: inline detail card at top of tree view, no overlay needed
function _geneShowMobileDetail(el) {
  const treeEl = document.getElementById('geneTreeView');
  if (!treeEl) return;

  let panel = document.getElementById('geneMobileDetail');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'geneMobileDetail';
    panel.style.cssText = [
      'background:#0b1520','border:1px solid rgba(201,168,76,0.35)',
      'border-radius:10px','padding:14px 16px','margin-bottom:14px',
      'font-family:var(--font-mono)','font-size:11px','line-height:1.6',
      'display:none'
    ].join(';');
  }
  // Re-anchor to top of tree view in case the tree was re-rendered
  if (panel.parentElement !== treeEl) {
    treeEl.insertBefore(panel, treeEl.firstChild);
  }

  panel.innerHTML = `
    <div style="color:var(--gold);font-size:10px;letter-spacing:1px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid rgba(201,168,76,0.2);">USER DETAILS</div>
    ${_geneBuildTooltipBody(el)}`;
  panel.style.display = 'block';
}

function _geneCloseMobileDetail() {
  const panel = document.getElementById('geneMobileDetail');
  if (panel) panel.style.display = 'none';
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
    ? `<span id="ei-${nid}" style="display:inline-block;width:14px;font-size:9px;color:var(--muted);vertical-align:middle;flex-shrink:0;">${depth === 0 ? '▾' : '▶'}</span>`
    : `<span style="display:inline-block;width:14px;flex-shrink:0;"></span>`;

  const nodeLabel = (typeof _labelCache !== 'undefined' && _labelCache.get(addr.toLowerCase())) || addr;
  const label = isRoot
    ? (_isTouchDevice() ? 'YOU' : `YOU · ${addr}`)
    : `<span class="gene-node-lvl">L${depth}</span>${nodeLabel}`;

  const nodeEl = `<span class="gene-node ${isRoot ? 'gene-node-self' : ''}"
    id="${nid}"
    data-addr="${addr}"
    data-inv="${inv}"
    data-team-count="${node._teamCount || 0}"
    data-team-business="${node._teamBusiness || 0}"
    onclick="geneNodeTap('${nid}')"
    onmouseenter="geneShowTooltip(event,this)"
    onmouseleave="geneHideTooltip()"
    style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"
  >${expandIcon}${label}</span>`;

  if (!hasKids) return `<li>${nodeEl}</li>`;
  const hidden = depth >= 1 ? 'style="display:none"' : '';
  const kids   = node.children.map(c => _geneBuildNodeHtml(c, depth + 1)).join('');
  return `<li>${nodeEl}<ul class="gene-subtree" id="sub-${nid}" ${hidden}>${kids}</ul></li>`;
}

function geneNodeTap(nid) {
  const ul = document.getElementById('sub-' + nid);
  const ei = document.getElementById('ei-'  + nid);
  const el = document.getElementById(nid);
  // Expand / collapse children if present
  if (ul) {
    const opening = ul.style.display === 'none';
    ul.style.display = opening ? '' : 'none';
    if (ei) {
      ei.textContent = opening ? '▼' : '▶';
      ei.style.color = opening ? 'var(--gold)' : 'var(--muted)';
    }
  }
  // On mobile show details panel for every node (expandable or leaf)
  if (_isTouchDevice() && el) _geneShowMobileDetail(el);
}

// ─── loadGenealogy ────────────────────────────────────────────────────────────

async function loadGenealogy() {
  if (!requireConnected()) return;
  if (_geneLoading) return;
  _geneLoading = true;
  const listEl = document.getElementById('geneListView');
  const treeEl = document.getElementById('geneTreeView');
  listEl.innerHTML = '<div class="empty-state">Loading genealogy<span class="ld"><span></span><span></span><span></span></span></div>';
  treeEl.innerHTML = '';
  try {
    const [treeData, eligRaw, gatesRaw, minInvRaw] = await Promise.all([
      fetchGeneTree(walletAddress, 1),
      contract.getUserEligibility(walletAddress).catch(() => null),
      contract.getEligibilityGates().catch(() => null),
      contract.minDirectReferralInvestment().catch(() => ethers.BigNumber.from(0))
    ]);
    _geneTree = treeData;
    // New eligibility model: to earn level N you need active self-stake >= selfGate[N-1] AND
    // cumulative team business >= bizGate[N-1] (both USDT). Self-stake is ACTIVE (drops when locks
    // expire); team business is sticky/lifetime. unlockedLevels = highest contiguous level qualified.
    const selfStakeUSDT  = eligRaw ? Number(eligRaw.selfStakeUSDT    ?? eligRaw[0]) : 0;
    const teamBizUSDT    = eligRaw ? Number(eligRaw.teamBusinessUSDT ?? eligRaw[1]) : 0;
    const unlockedLevels = eligRaw ? Number(eligRaw.unlockedLevels   ?? eligRaw[2]) : 0;
    const selfGates = gatesRaw ? Array.from(gatesRaw.selfGates ?? gatesRaw[0]).map(Number) : [];
    const bizGates  = gatesRaw ? Array.from(gatesRaw.bizGates  ?? gatesRaw[1]).map(Number) : [];
    const _gateReq = (lvl) => ({ self: selfGates[lvl - 1] ?? 0, biz: bizGates[lvl - 1] ?? 0 });
    const _isElig  = (lvl) => { const g = _gateReq(lvl); return selfStakeUSDT >= g.self && teamBizUSDT >= g.biz; };
    const minInvETH   = parseFloat(ethers.utils.formatEther(minInvRaw));

    // Investment amounts now arrive with the downline (node._inv) — no per-node RPC calls.
    const allAddrs = _geneCollectAddrs(treeData);
    _geneInvestedMap = new Map();
    (function _fillInv(node) {
      _geneInvestedMap.set(node.addr, node._inv || 0);
      for (const child of node.children) _fillInv(child);
    })(treeData);

    // Annotate tree nodes with team stats, then build flat lookup map
    _geneComputeStats(treeData);
    _geneStatsMap = new Map();
    _buildGeneStatsMap(treeData);

    // Pre-fetch labels for every visible address so renders below are synchronous
    if (typeof _batchGetRefLabels === 'function') {
      await _batchGetRefLabels(allAddrs).catch(() => {});
    }

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

    // ── List view ───────────────────────────────────────────────────────────
    listEl.innerHTML = '';

    // Eligibility summary card (always shown) — your self-stake, team business, levels unlocked,
    // and what's still needed to unlock the next level.
    {
      let nextHtml;
      if (unlockedLevels >= 10) {
        nextHtml = '<span style="color:#4ade80;">All 10 levels unlocked ✓</span>';
      } else {
        const g = _gateReq(unlockedLevels + 1);
        const sNeed = Math.max(0, g.self - selfStakeUSDT);
        const bNeed = Math.max(0, g.biz - teamBizUSDT);
        const bits = [];
        if (sNeed > 0) bits.push(`+$${fmtNum(sNeed)} self-stake`);
        if (bNeed > 0) bits.push(`+$${fmtNum(bNeed)} team business`);
        nextHtml = `To unlock <strong style="color:var(--gold);">Level ${unlockedLevels + 1}</strong>: ${bits.length ? bits.join(' &nbsp;+&nbsp; ') : 'requirements met — invest to apply'}`;
      }
      const summary = document.createElement('div');
      summary.className = 'gene-level-block';
      summary.style.cssText = 'padding:14px 16px;margin-bottom:10px;';
      summary.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:18px;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-size:9px;color:var(--muted);letter-spacing:.08em;margin-bottom:2px;">COMMISSION &amp; ROI LEVELS UNLOCKED</div>
            <div style="font-family:var(--font-display);font-size:20px;color:var(--gold);">${unlockedLevels} <span style="font-size:12px;color:var(--muted);">/ 10</span></div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:9px;color:var(--muted);letter-spacing:.08em;margin-bottom:2px;">ACTIVE SELF-STAKE</div>
            <div style="font-family:var(--font-mono);font-size:13px;color:var(--cream);">$${fmtNum(selfStakeUSDT)}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:9px;color:var(--muted);letter-spacing:.08em;margin-bottom:2px;">TEAM BUSINESS</div>
            <div style="font-family:var(--font-mono);font-size:13px;color:#4ade80;">$${fmtNum(teamBizUSDT)}</div>
          </div>
        </div>
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:11px;color:var(--muted);font-family:var(--font-mono);">${nextHtml}</div>`;
      listEl.appendChild(summary);
    }

    if (totalReferrals === 0) {
      const _empty = document.createElement('div');
      _empty.className = 'empty-state';
      _empty.textContent = 'No referrals yet. Share your referral link to grow your network.';
      listEl.appendChild(_empty);
    } else {
      levels.forEach((addrs, idx) => {
        if (!addrs || addrs.length === 0) return;
        const level    = idx + 1;
        const isFirst  = level === 1;
        const blockId  = `glvl${level}`;
        const rate     = COMMISSION_RATES[idx] !== undefined ? fmtNum(COMMISSION_RATES[idx], 2) + '%' : '—';
        const levelTotal = addrs.reduce((s, a) => s + (_geneInvestedMap.get(a) || 0), 0);
        const eligible = _isElig(level);
        const eligStyle = eligible
          ? 'color:#4ade80;font-size:10px;font-family:var(--font-mono);margin-left:8px;'
          : 'color:#f87171;font-size:10px;font-family:var(--font-mono);margin-left:8px;';
        let eligLabel;
        if (eligible) {
          eligLabel = '✓ ELIGIBLE';
        } else {
          const g = _gateReq(level);
          const parts = [];
          if (selfStakeUSDT < g.self) parts.push(`$${fmtNum(g.self)} self`);
          if (teamBizUSDT   < g.biz)  parts.push(`$${fmtNum(g.biz)} biz`);
          eligLabel = '✗ NEED ' + parts.join(' + ');
        }

        const memberRows = addrs.map(a => {
          const inv      = _geneInvestedMap.get(a) || 0;
          const stats    = _geneStatsMap.get(a.toLowerCase()) || { teamCount: 0, teamBusiness: 0 };
          const rowLabel = (typeof _labelCache !== 'undefined' && _labelCache.get(a.toLowerCase())) || a;
          return `<div class="gene-addr-row" data-addr="${a}" style="justify-content:space-between;gap:12px;cursor:default;flex-wrap:nowrap;">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;">
              <div class="gene-addr-dot"></div>
              <a href="${NET.explorer}/address/${a}" target="_blank" rel="noopener"
                 style="color:var(--cream);text-decoration:none;font-family:var(--font-mono);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                 onclick="event.stopPropagation()">${rowLabel}</a>
              <button onclick="event.stopPropagation();copyAddr('${a}',this)" title="Copy address"
                style="padding:2px 4px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--muted);cursor:pointer;flex-shrink:0;line-height:1;">${_COPY_ICON}</button>
            </div>
            <div style="display:flex;align-items:center;flex-shrink:0;">
              <div class="gene-col-invested" style="width:120px;text-align:right;padding-right:20px;">
                <div style="font-size:9px;color:var(--muted);letter-spacing:.07em;margin-bottom:2px;">INVESTED</div>
                <div style="font-size:11px;font-family:var(--font-mono);color:${inv > 0 ? 'var(--gold)' : 'var(--muted)'};">${inv > 0 ? fmtUSDT(inv,{noEth:true}) : '—'}</div>
              </div>
              <div class="gene-col-teamvol" style="width:90px;text-align:right;padding-right:20px;">
                <div style="font-size:9px;color:var(--muted);letter-spacing:.07em;margin-bottom:2px;">TEAM VOL</div>
                <div style="font-size:11px;font-family:var(--font-mono);color:var(--cream);">${stats.teamCount} user${stats.teamCount !== 1 ? 's' : ''}</div>
              </div>
              <div style="width:120px;text-align:right;">
                <div style="font-size:9px;color:var(--muted);letter-spacing:.07em;margin-bottom:2px;">TEAM BIZ</div>
                <div style="font-size:11px;font-family:var(--font-mono);color:${stats.teamBusiness > 0 ? '#4ade80' : 'var(--muted)'};">${stats.teamBusiness > 0 ? fmtUSDT(stats.teamBusiness,{noEth:true}) : '—'}</div>
              </div>
            </div>
          </div>`;
        }).join('');

        const block = document.createElement('div');
        block.className = 'gene-level-block';
        block.innerHTML = `
          <div class="gene-level-header"
            onclick="geneListLevelToggle('${blockId}')"
            style="cursor:pointer;user-select:none;">
            <span class="gene-level-badge">LEVEL ${level}</span>
            <span class="gene-count-pill">${addrs.length} member${addrs.length !== 1 ? 's' : ''}</span>
            <span class="gene-commission-rate">${rate} commission</span>
            <span class="gene-elig-label" style="${eligStyle}">${eligLabel}</span>
            <span style="display:flex;align-items:center;gap:8px;margin-left:auto;flex-shrink:0;">
              <span style="font-size:10px;color:var(--gold);font-family:var(--font-mono);white-space:nowrap;">${fmtUSDT(levelTotal,{noEth:true})} invested</span>
              <span id="${blockId}-arrow" style="font-size:11px;color:var(--muted);">▶</span>
            </span>
          </div>
          <div id="${blockId}" style="display:none;">
            ${memberRows}
          </div>`;
        listEl.appendChild(block);
      });
    }

    // ── Tree view ───────────────────────────────────────────────────────────
    _geneRootNid = 'gnd' + _geneTree.addr.slice(2).toLowerCase();
    treeEl.innerHTML = `
      <div class="gene-tree">
        <ul style="padding-left:0;">${_geneBuildNodeHtml(_geneTree, 0)}</ul>
      </div>`;

    switchGeneView(_geneView);
  } catch(e) {
    listEl.innerHTML = '<div class="empty-state">Failed to load genealogy: ' + (e.errorName || e.reason || e?.error?.message || e.message) + '</div>';
  } finally {
    _geneLoading = false;
  }
}

window.switchGeneView          = switchGeneView;
window.loadGenealogy           = loadGenealogy;
window.geneNodeTap             = geneNodeTap;
window.geneShowTooltip         = geneShowTooltip;
window.geneHideTooltip         = geneHideTooltip;
window.geneListLevelToggle     = geneListLevelToggle;
window._geneCloseMobileDetail  = _geneCloseMobileDetail;
