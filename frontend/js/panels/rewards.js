// ─── Referral-commission reserve (held over-0.5× commission) ─────────────────
let _rwReserveTotalETH     = 0;   // all tranches (locked + matured), USDT
let _rwReserveClaimableETH = 0;   // tranches past their unlock time
let _rwReserveTranches     = [];  // [{ amount, unlockTime }]

// ─── Referral pagination / sort state ────────────────────────────────────────
let _rwRefAllEvents  = [];
let _rwRefBlockTsMap = new Map();
let _rwRefPage       = 1;
let _rwRefPerPage    = 5;
let _rwRefSortKey    = 'ts';
let _rwRefSortDir    = -1;

// ─── ROI active streams pagination + sort ─────────────────────────────────────
let _rwROIStreamPage    = 1;
let _rwROIStreamPerPage = 5;
// Sort key: 'invested' (package size) | 'progress' (period completion) |
// 'potential' (max earning potential) | 'accrued' (default). Dir: 1 asc, -1 desc.
let _rwROIStreamSortKey = 'accrued';
let _rwROIStreamSortDir = -1;

function _rwStreamSortVal(d, key) {
  if (key === 'invested')  return d.ethInv || 0;
  if (key === 'progress')  return (d.periodMax > 0) ? ((d.roiPaidETH || 0) + (d.accruedETH || 0)) / d.periodMax : 0;
  if (key === 'potential') return d.periodMax || 0; // full-period ROI ceiling = max earning potential
  return d.accruedETH || 0;
}

function _rwSortROIStreams() {
  _rwROIStreamDetails.sort((a, b) =>
    _rwROIStreamSortDir * (_rwStreamSortVal(a, _rwROIStreamSortKey) - _rwStreamSortVal(b, _rwROIStreamSortKey)));
}

// Sort indicator for a clickable ROI-stream column header.
function _rwROISI(key) {
  if (_rwROIStreamSortKey !== key) return `<span style="opacity:0.35;font-size:8px;margin-left:2px;">↕</span>`;
  return `<span style="color:var(--gold);font-size:8px;margin-left:2px;">${_rwROIStreamSortDir < 0 ? '↓' : '↑'}</span>`;
}

function setRwROIStreamSort(key) {
  if (_rwROIStreamSortKey === key) _rwROIStreamSortDir = -_rwROIStreamSortDir;
  else { _rwROIStreamSortKey = key; _rwROIStreamSortDir = -1; }
  _rwROIStreamPage = 1;
  _rwSortROIStreams();
  const el = document.getElementById('rwROIStreamsContainer');
  if (el) { el.innerHTML = _rwROIStreamsHtml(); _rwROIStreamsSnapBars(el); }
}

function _rwROIStreamsHtml() {
  if (_rwROIStreamDetails.length === 0) return '';
  const total = _rwROIStreamDetails.length;
  const pages = Math.max(1, Math.ceil(total / _rwROIStreamPerPage));
  const page  = Math.min(_rwROIStreamPage, pages);
  const start = (page - 1) * _rwROIStreamPerPage;
  const slice = _rwROIStreamDetails.slice(start, start + _rwROIStreamPerPage);
  const end   = start + slice.length;

  const perPageBtns = [5, 10, 50, 100].map(n =>
    `<button onclick="setRwROIStreamPerPage(${n})"
      style="padding:4px 10px;font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;
             border:1px solid ${_rwROIStreamPerPage === n ? 'var(--gold)' : 'var(--border)'};
             background:${_rwROIStreamPerPage === n ? 'rgba(201,168,76,0.12)' : 'var(--surface)'};
             color:${_rwROIStreamPerPage === n ? 'var(--gold)' : 'var(--muted)'};
             border-radius:3px;cursor:pointer;">${n}</button>`
  ).join('');

  const navBtn = (lbl, p, dis) =>
    `<button onclick="setRwROIStreamPage(${p})" ${dis ? 'disabled' : ''}
      style="padding:5px 12px;font-family:var(--font-mono);font-size:11px;letter-spacing:.04em;
             border:1px solid var(--border);background:var(--surface);
             color:${dis ? 'rgba(255,255,255,0.18)' : 'var(--cream)'};
             border-radius:3px;cursor:${dis ? 'default' : 'pointer'};">${lbl}</button>`;

  const ROI_LEVEL_RATES = [50, 10, 5, 2, 0.6, 0.5, 0.45, 0.4, 0.4, 0.35];
  let rows = '';
  for (let j = 0; j < slice.length; j++) {
    const d = slice[j];
    const i = start + j;   // global index — matches ticker element IDs

    const histPaid   = d.histPaidETH || 0;
    const _curRef    = (d.periodMax > 0 ? d.periodMax : (d.ethInv || 0));
    // Bar shows current period only — histPaid is NOT in the denominator.
    const _barRef    = _curRef;
    // Overall per-stream pending (all periods) — kept for CLAIMABLE stat below bar.
    const _streamPending   = d.streamPendingETH || 0;
    const _streamSettled   = histPaid + (d.roiPaidETH || 0);
    // Overall claimed across all periods (for CLAIMED stat below bar).
    const _trulyClaimedETH = Math.max(0, _streamSettled - _streamPending);
    // Current-period portion of pending (proportional share of global pending from this period's settlements).
    const _curPeriodPending = _streamSettled > 0 ? _streamPending * (d.roiPaidETH || 0) / _streamSettled : 0;
    const _curPeriodClaimed = Math.max(0, (d.roiPaidETH || 0) - _curPeriodPending);
    const paidPct          = _barRef > 0 ? Math.min(100, _curPeriodClaimed / _barRef * 100) : 0;
    const pendingPct       = _barRef > 0 ? Math.min(100 - paidPct, _curPeriodPending / _barRef * 100) : 0;
    // Bar segments (current period, % of periodMax), ordered claimed → pending → accruing → held → missed:
    //   PURPLE = normal accumulation (claimed + pending + claimable accruing)
    //   YELLOW = HELD (earned ROI awaiting cap → claimable once you invest for cap)
    //   RED    = MISSED (no-cap / over-cap while staked + post-expiry gap → forfeited forever)
    const _liveClaimable   = Math.min(d.accruedETH, _rwROIAvailableCapETH);
    const claimableETH     = _streamPending + _liveClaimable;
    const accruedPct       = _barRef > 0 ? Math.min(100 - paidPct - pendingPct, _liveClaimable / _barRef * 100) : 0;
    const heldPct          = _barRef > 0 ? Math.min(100 - paidPct - pendingPct - accruedPct, ((d.heldCarryETH || 0) + (d.projectedHeldETH || 0)) / _barRef * 100) : 0;
    const missedPct        = _barRef > 0 ? Math.min(100 - paidPct - pendingPct - accruedPct - heldPct, ((d.liveWindowGapETH || 0) + (d.postExpiryMissedETH || 0)) / _barRef * 100) : 0;
    const totalPct     = paidPct + pendingPct + accruedPct + heldPct + missedPct;
    const levelRate  = ROI_LEVEL_RATES[d.level] !== undefined ? ROI_LEVEL_RATES[d.level] : '—';
    const totalClaimed   = _trulyClaimedETH;

    // HELD (earned ROI awaiting cap → claimable by investing for cap, yellow) and MISSED (no-cap /
    // over-cap while staked + post-expiry gap + on-chain forfeit → red, forfeited forever).
    const _rowHeldETH   = (d.heldCarryETH || 0) + (d.projectedHeldETH || 0);
    const _rowMissedETH = (d.histMissedETH || 0) + (d.postExpiryMissedETH || 0) + (d.liveWindowGapETH || 0);
    rows += `<tr style="border-bottom:1px solid rgba(20,30,42,0.7);">
      <td style="padding:8px 8px;cursor:pointer;outline:none;user-select:none;-webkit-tap-highlight-color:transparent;" onclick="showROIStreamPopup(${i})">
        <span style="font-family:var(--font-display);font-size:20px;line-height:1.1;color:var(--gold);">$${fmtNum(d.ethInv * USDT_PER_ETH)}</span>
        <div style="color:var(--cream);margin-top:2px;">L${d.level + 1} <span style="color:var(--gold);font-size:10px;">${levelRate}%</span></div>
      </td>
      <td style="padding:8px 8px;min-width:160px;cursor:pointer;outline:none;user-select:none;-webkit-tap-highlight-color:transparent;" onclick="showROIStreamPopup(${i})">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <span id="rwROIStreamPct-${i}" class="rw-roi-stream-pct" style="font-size:9px;color:var(--muted);">${totalPct >= 100 ? '100' : totalPct.toFixed(2)}%</span>
        </div>
        <div class="dis-bar-track">
          <div class="dis-bar-claimed" style="width:${paidPct.toFixed(2)}%"></div>
          <div id="rwROIStreamPreSettledBar-${i}" class="dis-bar-active" style="left:${paidPct.toFixed(2)}%; width:${pendingPct.toFixed(2)}%;background:#a78bfa;opacity:0.55;"></div>
          <div id="rwROIStreamBar-${i}" class="dis-bar-active" style="left:${(paidPct + pendingPct).toFixed(2)}%; width:${accruedPct.toFixed(2)}%;background:#a78bfa;"></div>
          <div id="rwROIStreamHeldBar-${i}" class="dis-bar-overcap" style="left:${(paidPct + pendingPct + accruedPct).toFixed(2)}%; width:${heldPct.toFixed(2)}%"></div>
          <div id="rwROIStreamMissedBar-${i}" class="dis-bar-paused" style="left:${(paidPct + pendingPct + accruedPct + heldPct).toFixed(2)}%; width:${missedPct.toFixed(2)}%"></div>
        </div>
        <div style="margin-top:5px;font-size:9px;white-space:nowrap;">
          <span style="color:var(--muted);">CLAIMABLE </span>
          <span id="rwROIStreamClaimable-${i}" style="color:#a78bfa;">$${(claimableETH * USDT_PER_ETH).toFixed(5)}</span>
        </div>
        <div id="rwROIStreamHeldWrap-${i}" style="margin-top:3px;font-size:9px;white-space:nowrap;display:${_rowHeldETH > 1e-15 ? '' : 'none'};">
          <span style="color:var(--muted);">HELD </span>
          <span id="rwROIStreamHeld-${i}" style="color:#fbbf24;">$${(_rowHeldETH * USDT_PER_ETH).toFixed(5)}</span>
        </div>
        <div id="rwROIStreamMissedWrap-${i}" style="margin-top:3px;font-size:9px;white-space:nowrap;display:${_rowMissedETH > 1e-15 ? '' : 'none'};">
          <span style="color:var(--muted);">MISSED </span>
          <span id="rwROIStreamMissed-${i}" style="color:#ef4444;">$${(_rowMissedETH * USDT_PER_ETH).toFixed(5)}</span>
        </div>
      </td>
      <td style="padding:8px 8px;text-align:right;">
        ${(() => {
          // Enable whenever claimableETH > 0 (pending or live).
          // When _streamPending > 0, claimROIFromStream would revert (no new accrual to settle),
          // so the button routes to claimAllROI which always pays out the full pending + live.
          const _liveOnly  = Math.min(d.accruedETH, Math.max(0, _rwROIAvailableCapETH));
          const _claimable = _streamPending + _liveOnly;
          const _t       = _rwROITokenPrice > 0 && _claimable > 0 ? _claimable / _rwROITokenPrice : 0;
          const _canClaim = _claimable > 0;
          const _label   = _t > 0 ? 'CLAIM · ' + _t.toFixed(5) + ' ' + _rwROITokenSym : 'CLAIM';
          return `<button onclick="claimROIFromStreamBtn('${d.investor}',${d.lockIndex},${d.level},this)"
            id="rwROIStreamClaimBtn-${i}"
            style="padding:5px 10px;font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;
                   border:1px solid ${_canClaim ? 'var(--gold)' : 'var(--border)'};
                   background:${_canClaim ? 'rgba(201,168,76,0.12)' : 'rgba(255,255,255,0.04)'};
                   color:${_canClaim ? 'var(--gold)' : 'var(--muted)'};
                   border-radius:3px;cursor:${_canClaim ? 'pointer' : 'not-allowed'};white-space:nowrap;"
            ${_canClaim ? '' : 'disabled'}>${_label}</button>`;
        })()}
      </td>
    </tr>`;
  }

  return `<div style="margin-top:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px;">
      <div style="font-size:9px;letter-spacing:2px;color:var(--muted);"><span class="rw-streams-title-desk">${total} ACTIVE STREAM${total !== 1 ? 'S' : ''}</span><span class="rw-streams-title-mob">Active Streams</span></div>
      <div style="display:flex;align-items:center;gap:5px;">
        <span style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">SHOW</span>
        ${perPageBtns}
      </div>
    </div>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:11px;">
        <thead>
          <tr style="border-bottom:1px solid var(--border);">
            <th onclick="setRwROIStreamSort('invested')" title="Sort by invested amount" style="text-align:left;color:var(--muted);font-weight:400;padding:5px 8px;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;">INVESTED${_rwROISI('invested')}</th>
            <th onclick="setRwROIStreamSort('progress')" title="Sort by progress" style="text-align:left;color:var(--muted);font-weight:400;padding:5px 8px;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;">PROGRESS${_rwROISI('progress')}</th>
            <th onclick="setRwROIStreamSort('potential')" title="Sort by maximum earning potential" style="text-align:right;color:var(--muted);font-weight:400;padding:5px 8px;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;">CLAIM${_rwROISI('potential')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;flex-wrap:wrap;gap:10px;">
      <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">
        ${start + 1}–${end} <span style="opacity:0.5;">of</span> ${total} entries
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        ${navBtn('‹ PREV', page - 1, page <= 1)}
        <span style="font-size:11px;font-family:var(--font-mono);color:var(--muted);">PAGE</span>
        <span style="font-size:14px;font-family:var(--font-mono);color:var(--cream);min-width:22px;text-align:center;">${page}</span>
        <span style="font-size:11px;font-family:var(--font-mono);color:var(--muted);">OF ${pages}</span>
        ${navBtn('NEXT ›', page + 1, page >= pages)}
      </div>
    </div>
  </div>`;
}

function _rwROIStreamsSnapBars(container) {
  if (!container) return;
  container.querySelectorAll('.dis-bar-active, .dis-bar-claimed, .dis-bar-paused').forEach(b => b.style.transition = 'none');
  requestAnimationFrame(() => requestAnimationFrame(() =>
    container.querySelectorAll('.dis-bar-active, .dis-bar-claimed, .dis-bar-paused').forEach(b => b.style.transition = '')
  ));
}

function setRwROIStreamPage(p) {
  const pages = Math.max(1, Math.ceil(_rwROIStreamDetails.length / _rwROIStreamPerPage));
  _rwROIStreamPage = Math.max(1, Math.min(p, pages));
  const el = document.getElementById('rwROIStreamsContainer');
  if (el) { el.innerHTML = _rwROIStreamsHtml(); _rwROIStreamsSnapBars(el); }
}

function setRwROIStreamPerPage(n) {
  _rwROIStreamPerPage = n;
  _rwROIStreamPage    = 1;
  const el = document.getElementById('rwROIStreamsContainer');
  if (el) { el.innerHTML = _rwROIStreamsHtml(); _rwROIStreamsSnapBars(el); }
}

function showROIStreamPopup(i) {
  const d = _rwROIStreamDetails[i];
  if (!d) return;

  const ROI_LEVEL_RATES  = [50, 10, 5, 2, 0.6, 0.5, 0.45, 0.4, 0.4, 0.35];
  const levelRate        = ROI_LEVEL_RATES[d.level] !== undefined ? ROI_LEVEL_RATES[d.level] : '—';
  const histPaid         = d.histPaidETH || 0;
  const _streamPending   = d.streamPendingETH || 0;
  const _streamSettled   = histPaid + (d.roiPaidETH || 0);
  const _trulyClaimedETH = Math.max(0, _streamSettled - _streamPending);
  const _liveClaimable   = Math.min(d.accruedETH, _rwROIAvailableCapETH);
  const claimableETH     = _streamPending + _liveClaimable;
  // Max earning potential = full-period ROI ceiling for this stream (current lock period).
  const maxPotentialUSDT = (d.periodMax || 0) * USDT_PER_ETH;
  const _elapsed         = Math.max(0, Math.floor(Date.now() / 1000) - _rwROIFetchWall);
  // HELD = ROI EARNED before claimable accrual stopped (on-chain heldCarryETH carry + projectedHeldETH,
  // the pre-cap-exhaustion / pre-expiry earned portion) → claimable once you regain cap. MISSED =
  // accrual AFTER the boundary: on-chain forfeit (histMissedETH) + post-boundary gap (liveWindowGapETH)
  // + post-expiry gap + ongoing blocked accrual. Both shown side by side.
  const _growth          = _elapsed * (d.perStreamMissRate || 0);
  const _heldETH         = (d.heldCarryETH || 0) + (d.projectedHeldETH || 0) + (_rwROIBlockedIsMissed ? 0 : _growth);
  const _missedETH       = (d.histMissedETH || 0) + (d.postExpiryMissedETH || 0) + (d.liveWindowGapETH || 0) + (_rwROIBlockedIsMissed ? _growth : 0);
  const _showHeld        = _heldETH > 1e-15;
  const _hasMissed       = _missedETH > 1e-15;
  // HELD can be a tiny fraction; toFixed(5) would round it to 0. Show enough
  // decimals (≈2 significant digits, capped at 12) so any nonzero held is visible.
  const _heldUsd         = _heldETH * USDT_PER_ETH;
  const _heldStr         = _heldUsd <= 0       ? '0.00000'
                         : _heldUsd >= 0.00001 ? _heldUsd.toFixed(5)
                         : _heldUsd.toFixed(Math.min(12, 2 - Math.floor(Math.log10(_heldUsd))));
  const accruedTotalETH  = histPaid + d.roiPaidETH + d.accruedETH;
  const _ratePerSec      = (d.streamRate || 0) * USDT_PER_ETH;
  const _ratePerDay      = _ratePerSec * 86400;
  const _rateHtml        = _ratePerSec > 0
    ? `<span style="color:#4ade80;">+$${_ratePerSec.toFixed(8)}<span style="font-size:9px;color:var(--muted);">/sec</span></span><span style="color:var(--muted);font-size:9px;margin-left:6px;">· $${_ratePerDay.toFixed(5)}/day</span>`
    : `<span style="color:${(d.perStreamMissRate || 0) > 0 ? '#ef4444' : 'var(--muted)'};">${(d.perStreamMissRate || 0) > 0 ? 'PAUSED' : '—'}</span>`;

  const existing = document.getElementById('roiStreamPopupOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'roiStreamPopupOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  overlay.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:20px;max-width:420px;width:100%;box-sizing:border-box;font-family:var(--font-mono);position:relative;">
      <button onclick="document.getElementById('roiStreamPopupOverlay').remove()"
        style="position:absolute;top:12px;right:12px;width:26px;height:26px;border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:4px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;">✕</button>
      <div style="margin-bottom:14px;">
        <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">ROI STREAM</div>
        <div style="font-size:11px;color:var(--cream);word-break:break-all;margin-bottom:8px;">${d.investor}</div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <span style="font-size:11px;color:var(--cream);">Level ${d.level + 1}</span>
          <span style="font-size:12px;color:var(--gold);font-weight:700;">${levelRate}%</span>
          <span style="font-size:10px;color:var(--muted);">· $${fmtNum(d.ethInv * USDT_PER_ETH)} invested</span>
        </div>
        ${_showHeld ? `
        <div style="font-size:10px;padding:7px 10px;background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.45);border-radius:5px;">
          <span style="font-size:9px;letter-spacing:1px;color:var(--muted);">HELD </span><span style="color:#fbbf24;font-weight:700;">$${_heldStr}</span>
          <span style="font-size:8px;color:var(--muted);margin-left:6px;">earned ROI awaiting cap · invest more to claim</span>
        </div>` : ''}
        <div style="font-size:10px;padding:9px 12px;margin-top:8px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.3);border-radius:5px;display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:9px;letter-spacing:1px;color:var(--muted);">MAX POTENTIAL <span style="opacity:0.65;">· this period</span></span>
          <span style="color:#a78bfa;font-weight:700;font-size:14px;font-family:var(--font-display);">$${maxPotentialUSDT.toFixed(5)}</span>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="background:rgba(167,139,250,0.07);border:1px solid rgba(167,139,250,0.22);border-radius:8px;padding:12px;">
          <div style="font-size:9px;letter-spacing:1.5px;color:var(--muted);margin-bottom:5px;">ACCRUED</div>
          <div style="font-size:14px;color:#a78bfa;font-family:var(--font-display);">$${(accruedTotalETH * USDT_PER_ETH).toFixed(5)}</div>
        </div>
        <div style="background:rgba(201,168,76,0.07);border:1px solid rgba(201,168,76,0.22);border-radius:8px;padding:12px;">
          <div style="font-size:9px;letter-spacing:1.5px;color:var(--muted);margin-bottom:5px;">CLAIMABLE</div>
          <div style="font-size:14px;color:var(--gold);font-family:var(--font-display);">$${(claimableETH * USDT_PER_ETH).toFixed(5)}</div>
        </div>
        <div style="background:rgba(74,222,128,0.07);border:1px solid rgba(74,222,128,0.22);border-radius:8px;padding:12px;">
          <div style="font-size:9px;letter-spacing:1.5px;color:var(--muted);margin-bottom:5px;">CLAIMED</div>
          <div style="font-size:14px;color:#4ade80;font-family:var(--font-display);">$${(_trulyClaimedETH * USDT_PER_ETH).toFixed(5)}</div>
        </div>
        <div style="background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.22);border-radius:8px;padding:12px;">
          <div style="font-size:9px;letter-spacing:1.5px;color:var(--muted);margin-bottom:5px;">MISSED</div>
          <div style="font-size:14px;color:#ef4444;font-family:var(--font-display);">$${(_missedETH * USDT_PER_ETH).toFixed(5)}</div>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
}


// ─── Reserve modal (held over-0.5× referral commission) ───────────────────────
// A reserve tranche unlocks at its triggering downline package's 90-day mark. LP_DAY_SCALE
// (utils.js) mirrors the contract's SECONDS_PER_DAY so the countdown matches on-chain timing.
function _rwReserveUnlockLabel(unlockTime) {
  const now = Math.floor(Date.now() / 1000);
  if (unlockTime <= now) return { text: 'UNLOCKED', claimable: true, color: '#4ade80' };
  const secs     = unlockTime - now;
  const dayScale = (typeof LP_DAY_SCALE !== 'undefined' && LP_DAY_SCALE > 0) ? LP_DAY_SCALE : 86400;
  const days     = secs / dayScale;
  const text     = days >= 1
    ? `unlocks in ${days < 10 ? days.toFixed(1) : Math.round(days)}d`
    : `unlocks in ${(secs / (dayScale / 24)).toFixed(1)}h`;
  return { text, claimable: false, color: '#f59e0b', abs: `unix ${unlockTime}` };
}

function openReserveModal() {
  const existing = document.getElementById('rwReserveOverlay');
  if (existing) existing.remove();

  const tranches = (_rwReserveTranches || []).slice().sort((a, b) => a.unlockTime - b.unlockTime);
  const totalUSDT  = (_rwReserveTotalETH || 0) * USDT_PER_ETH;
  const claimUSDT  = (_rwReserveClaimableETH || 0) * USDT_PER_ETH;
  const lockedUSDT = Math.max(0, totalUSDT - claimUSDT);

  const rows = tranches.length ? tranches.map((t, i) => {
    const lbl = _rwReserveUnlockLabel(t.unlockTime);
    const amt = t.amount * USDT_PER_ETH;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--surface);">
        <div>
          <div style="font-size:9px;letter-spacing:1.5px;color:var(--muted);">PACKAGE ${i + 1}</div>
          <div style="font-size:15px;color:var(--cream);font-family:var(--font-display);">$${amt.toFixed(2)}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:11px;color:${lbl.color};font-family:var(--font-mono);">${lbl.text}</div>
          ${lbl.abs ? `<div style="font-size:9px;color:var(--muted);">${lbl.abs}</div>` : `<div style="font-size:9px;color:#4ade80;">claim now</div>`}
        </div>
      </div>`;
  }).join('') : `<div style="padding:16px;text-align:center;color:var(--muted);font-size:12px;">No reserve held.</div>`;

  const PKG = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000];
  const affordable = PKG.filter(p => p <= totalUSDT + 1e-9);
  const pkgBtns = affordable.length
    ? affordable.map(p => `<button onclick="buyPackageFromReserve(${p})"
          style="padding:6px 12px;font-family:var(--font-mono);font-size:11px;border:1px solid var(--border);
                 background:var(--surface);color:var(--cream);border-radius:4px;cursor:pointer;">$${p}</button>`).join('')
    : `<span style="font-size:11px;color:var(--muted);">Reserve below the $25 minimum package — claim it once it unlocks.</span>`;

  const overlay = document.createElement('div');
  overlay.id = 'rwReserveOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:20px;max-width:460px;width:100%;box-sizing:border-box;font-family:var(--font-mono);position:relative;max-height:88vh;overflow-y:auto;">
      <button onclick="document.getElementById('rwReserveOverlay').remove()"
        style="position:absolute;top:12px;right:12px;width:26px;height:26px;border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:4px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;">✕</button>
      <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:4px;">COMMISSION RESERVE</div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:14px;line-height:1.5;">
        Referral commission above your package size, held per downline package. Each chunk unlocks at
        its package's 90-day mark — then claim it as USDT, or use it to buy a package any time.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
        <div style="background:rgba(96,165,250,0.07);border:1px solid rgba(96,165,250,0.22);border-radius:8px;padding:12px;">
          <div style="font-size:9px;letter-spacing:1.5px;color:var(--muted);margin-bottom:5px;">CLAIMABLE NOW</div>
          <div style="font-size:16px;color:#4ade80;font-family:var(--font-display);">$${claimUSDT.toFixed(2)}</div>
        </div>
        <div style="background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.22);border-radius:8px;padding:12px;">
          <div style="font-size:9px;letter-spacing:1.5px;color:var(--muted);margin-bottom:5px;">STILL LOCKED</div>
          <div style="font-size:16px;color:#f59e0b;font-family:var(--font-display);">$${lockedUSDT.toFixed(2)}</div>
        </div>
      </div>
      <button id="rwReserveClaimBtn" onclick="claimReserveAction()" ${claimUSDT > 0.000001 ? '' : 'disabled'}
        style="width:100%;padding:11px;margin-bottom:16px;font-family:var(--font-mono);font-size:12px;letter-spacing:1px;
               border:1px solid ${claimUSDT > 0.000001 ? 'rgba(74,222,128,0.5)' : 'var(--border)'};border-radius:5px;
               background:${claimUSDT > 0.000001 ? 'rgba(74,222,128,0.12)' : 'var(--surface)'};
               color:${claimUSDT > 0.000001 ? '#4ade80' : 'var(--muted)'};cursor:${claimUSDT > 0.000001 ? 'pointer' : 'not-allowed'};">
        CLAIM $${claimUSDT.toFixed(2)} MATURED
      </button>
      <div style="font-size:9px;letter-spacing:1.5px;color:var(--muted);margin-bottom:8px;">BUY A PACKAGE WITH RESERVE</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;">${pkgBtns}</div>
      <div style="font-size:9px;letter-spacing:1.5px;color:var(--muted);margin-bottom:8px;">RESERVE BY PACKAGE</div>
      ${rows}
    </div>`;
  document.body.appendChild(overlay);
}

async function claimReserveAction() {
  if (!requireConnected()) return;
  _txBegin();
  try {
    const _c = contract.connect(signer);
    const gasLimit = await gasLimitWithBuffer(_c, 'claimReserve', [], 30);
    toast('Confirm reserve claim in your wallet…', 'info');
    const tx = await _c.claimReserve({ ..._GAS, gasLimit });
    await tx.wait();
    _txDone();
    toast('Reserve claimed to your wallet.', 'success');
    const ov = document.getElementById('rwReserveOverlay'); if (ov) ov.remove();
    invalidateTabs('rewards');
    loadRwROI(true);
  } catch (e) {
    _txDone();
    console.error('[claimReserve] failed:', e);
    toast('Claim failed: ' + decodeContractError(e, contract && contract.interface), 'error');
  }
}

async function buyPackageFromReserve(usdtAmount) {
  if (!requireConnected()) return;
  // Token: prefer the featured token, fall back to the invest panel's current selection.
  let tokenAddr = '';
  try { tokenAddr = await contract.featuredToken(); } catch (_) {}
  if (!tokenAddr || /^0x0+$/.test(tokenAddr)) {
    const sel = document.getElementById('investTokenSelect');
    tokenAddr = sel && sel.value ? sel.value : '';
  }
  if (!tokenAddr) { toast('No token available to buy into — pick one on the Invest tab first.', 'warn'); return; }

  _txBegin();
  try {
    const wei = ethers.utils.parseEther(String(usdtAmount));
    const _c  = contract.connect(signer);
    toast(`Buying a $${usdtAmount} package from reserve…`, 'info');
    const gasLimit = await gasLimitWithBuffer(_c, 'investFromReserve', [tokenAddr, wei], 30);
    const tx = await _c.investFromReserve(tokenAddr, wei, { ..._GAS, gasLimit });
    await tx.wait();
    _txDone();
    toast(`$${usdtAmount} package purchased from reserve.`, 'success');
    const ov = document.getElementById('rwReserveOverlay'); if (ov) ov.remove();
    invalidateTabs('rewards', 'dashboard', 'investments');
    loadRwROI(true);
  } catch (e) {
    _txDone();
    console.error('[investFromReserve] failed:', e);
    toast('Purchase failed: ' + decodeContractError(e, contract && contract.interface), 'error');
  }
}


// ─── ROI Commission live ticker ───────────────────────────────────────────────
let _rwROIInterval    = null;
let _rwROIBaseETH     = 0;      // liveETH + pendingETH at fetch time
let _rwROIRatePerSec  = 0;      // ETH per second from active streams
let _rwROIFetchWall   = 0;      // wall-clock seconds at fetch
let _rwROITokenSym    = 'HORDEX';
let _rwROITokenPrice  = 0;      // ETH per token — TWAP payout price (contract pays at TWAP, not spot)
let _rwROIActiveCount = 0;      // number of active streams
let _rwROIStreamDetails = [];   // per-stream detail objects
let _rwROICapPaused    = false;  // true when user's overall cap is currently exhausted
let _rwROICapPausedAt  = 0;      // timestamp when cap was exhausted (0 = not paused)
let _rwROICapExhausted = false;  // true when liveETH=0 from contract but _capPausedAt=0 (ROI consumed raw cap)
let _rwROIAvailableCapETH = Infinity; // remaining unified cap for wallet (Infinity = uncapped / unknown)
let _rwROIActiveCapETH    = Infinity; // commStats[3]: active-only raw cap — mirrors _getRawAvailableCap
let _rwROIPendingETH       = 0; // pre-settled pending at last fetch (claimable even when rawCap = 0)
let _rwROIMissedBaseETH    = 0; // genuinely lost (natural-expiry no-stake gap), static
let _rwROIHeldBaseETH      = 0; // natural-expiry carry HELD (recoverable by investing more)
let _rwROIMissedRatePerSec = 0; // rate the over-cap (now MISSED) amount grows while cap is exhausted (ETH/s)
let _rwROILockExpired           = false; // true when active locks all expired naturally (no _capPausedAt)
let _rwROIBlockedIsMissed       = true;  // over-cap ROI while staked is FORFEITED (missed), so blocked
                                         // accrual always reads MISSED (red). Only natural-expiry carry is HELD.
let _rwROIMidExhaustedDetected = false; // set by ticker on first mid-session exhaustion tick; reset by loadRwROI
let _rwROIRetained             = false; // true when all LP removed but earned ROI is retained on-chain (claimable)
// Session-only cache: exact tokens received per stream from the ROIClaimed event.
// Keyed "investor_lc:lockIndex:level". Cleared only on page reload.
const _rwROIStreamClaimedTokens = new Map();
let _rwROILoading = false;      // concurrency guard
let _rwROILifetimeClaimedETH = 0; // ETH-equiv across all ROI claim records (never drops)

function _rwStopROITicker() {
  if (_rwROIInterval) { clearInterval(_rwROIInterval); _rwROIInterval = null; }
}

function _rwStartROITicker() {
  _rwStopROITicker();
  _rwROIInterval = setInterval(() => {
    const liveEl   = document.getElementById('rwROILive');
    if (!liveEl) { _rwStopROITicker(); return; }
    const elapsed    = Math.max(0, Math.floor(Date.now() / 1000) - _rwROIFetchWall);
    const totalETH   = _rwROIBaseETH + elapsed * _rwROIRatePerSec;
    const totalUSDT  = totalETH * USDT_PER_ETH;

    // Real-time cap-exhaustion detection: contract gates _calcAccrued via _getAvailableCap
    // which deducts BOTH pendingETH and liveETH from the raw active cap.
    // Exhaustion fires when totalETH (= pendingETH + liveETH + elapsed accrual) >= activeCap.
    // Guard: _rwROIActiveCapETH > 0 so natural lock expiry (activeCap = 0) doesn't falsely trigger.
    const _midSessionExhausted = (
      !_rwROICapPaused && !_rwROIRetained &&
      (_rwROICapExhausted ||
       (_rwROIActiveCapETH > 0 && _rwROIActiveCapETH < Infinity && totalETH >= _rwROIActiveCapETH))
    );
    const _effPaused = _rwROICapPaused || _midSessionExhausted;

    // On the first ticker tick where mid-session exhaustion is detected, freeze each stream's
    // accruedETH at the exact moment cap ran out (not the stale load-time estimate). Zeroing
    // streamRate and anchoring the global base keeps totalETH flat from here on, so the
    // claimable (yellow) slice on the bar is precise and the cap badge stays EXHAUSTED.
    if (_midSessionExhausted && !_rwROICapPaused && !_rwROICapExhausted && !_rwROIMidExhaustedDetected) {
      _rwROIMidExhaustedDetected = true;
      for (const _sd of _rwROIStreamDetails) {
        _sd.accruedETH = Math.max(0, _sd.accruedETH + elapsed * _sd.streamRate);
        _sd.streamRate  = 0;
        if (_sd.lockDur > 0 && _sd.periodMax > 0 && _rwROIFetchWall < _sd.unlockTime)
          _sd.perStreamMissRate = _sd.periodMax / _sd.lockDur;
      }
      _rwROIBaseETH    = _rwROIActiveCapETH; // anchor at cap ceiling (includes pendingETH)
      _rwROIRatePerSec = 0;
      _rwROIFetchWall  = Math.floor(Date.now() / 1000);
      // From this point every second that passes is ROI that can't be earned — start MISSED ticker.
      // Gap is 0 at the exact moment of exhaustion; grows at the full unblocked rate going forward.
      _rwROIMissedBaseETH    = 0;
      _rwROIMissedRatePerSec = _rwROIStreamDetails.reduce((s, d) => {
        if (d.lockDur > 0 && d.periodMax > 0 && _rwROIFetchWall < d.unlockTime)
          return s + d.periodMax / d.lockDur;
        return s;
      }, 0);
    }

    // Live cap widget update
    {
      const _capAmtEl   = document.getElementById('rwROICapAmt');
      const _capBadgeEl = document.getElementById('rwROICapBadge');
      if (_capAmtEl || _capBadgeEl) {
        if (_rwROICapPaused) {
          if (_capBadgeEl) { _capBadgeEl.textContent = 'CAP PAUSED'; _capBadgeEl.style.color = '#ef4444'; }
        } else if (_rwROILockExpired) {
          if (_capBadgeEl) { _capBadgeEl.textContent = 'LOCK EXPIRED'; _capBadgeEl.style.color = '#f97316'; }
        } else if (_midSessionExhausted) {
          if (_capBadgeEl) { _capBadgeEl.textContent = 'EXHAUSTED'; _capBadgeEl.style.color = '#ef4444'; _capBadgeEl.style.background = 'rgba(239,68,68,0.10)'; _capBadgeEl.style.borderColor = 'rgba(239,68,68,0.3)'; }
          if (_capAmtEl) { _capAmtEl.textContent = '$0.00'; _capAmtEl.style.color = '#ef4444'; }
        } else if (_rwROIActiveCapETH === 0) {
          // no active investment — badge already rendered as NO CAP; leave it unchanged
        } else {
          const _liveCap = Math.max(0, _rwROIActiveCapETH - totalETH);
          if (_capBadgeEl) { _capBadgeEl.textContent = 'ACTIVE'; _capBadgeEl.style.color = '#4ade80'; }
          if (_capAmtEl) { _capAmtEl.textContent = '$' + (_liveCap * USDT_PER_ETH).toFixed(2); }
        }
      }
    }

    // ACCRUED display: lifetime total (claimed + pending + live).
    // Color and dot go red/gray when cap is frozen, purple when actively accumulating.
    liveEl.style.color = _effPaused ? '#ef4444' : '#a78bfa';
    {
      const _dotEl = document.getElementById('rwROIAccrDot');
      if (_dotEl) _dotEl.style.color = _effPaused ? '#ef4444' : '#a78bfa';
    }
    {
      const _outstandingETH = _rwROICapPaused
        ? _rwROIBaseETH
        : (_midSessionExhausted && _rwROIAvailableCapETH > 0 && _rwROIAvailableCapETH < Infinity)
          ? Math.min(totalETH, _rwROIAvailableCapETH)
          : totalETH;
      liveEl.textContent = '$' + ((_rwROILifetimeClaimedETH + _outstandingETH) * USDT_PER_ETH).toFixed(5);
    }

    // Claimable = min(live+pending, rawCap) when rawCap > 0; or pre-settled pending when rawCap = 0.
    const _tickEffETH = _rwROIAvailableCapETH > 0
      ? Math.min(totalETH, _rwROIAvailableCapETH)
      : _rwROIPendingETH;
    const claimableEl = document.getElementById('rwROIClaimable');
    if (claimableEl) {
      const _claimableUsdt = _tickEffETH * USDT_PER_ETH;
      claimableEl.textContent = _claimableUsdt > 0.001 ? '$' + _claimableUsdt.toFixed(2) : '—';
      claimableEl.style.color = _claimableUsdt > 0.001 ? 'var(--gold)' : 'var(--muted)';
    }
    {
      // HELD (yellow) and MISSED (red) shown side by side. The ongoing blocked rate now grows MISSED
      // (over-cap while staked is forfeited). Only the natural-expiry carry base stays HELD.
      const _growthNow = elapsed * _rwROIMissedRatePerSec;
      const _heldNow   = (_rwROIHeldBaseETH   + (_rwROIBlockedIsMissed ? 0 : _growthNow)) * USDT_PER_ETH;
      const _missedNow = (_rwROIMissedBaseETH + (_rwROIBlockedIsMissed ? _growthNow : 0)) * USDT_PER_ETH;
      const _heldEl     = document.getElementById('rwROIHeld');
      const _heldWrap   = document.getElementById('rwROIHeldWrap');
      const _missedEl2  = document.getElementById('rwROIMissed');
      const _missedWrap = document.getElementById('rwROIMissedWrap');
      const _dashEl     = document.getElementById('rwROIHeldMissedDash');
      if (_heldWrap)   { _heldWrap.style.display   = _heldNow   > 0.0000001 ? '' : 'none'; if (_heldEl && _heldNow > 0.0000001) _heldEl.textContent = '$' + _heldNow.toFixed(2); }
      if (_missedWrap) { _missedWrap.style.display = _missedNow > 0.0000001 ? '' : 'none'; if (_missedEl2 && _missedNow > 0.0000001) _missedEl2.textContent = '$' + _missedNow.toFixed(2); }
      if (_dashEl)     { _dashEl.style.display = (_heldNow > 0.0000001 || _missedNow > 0.0000001) ? 'none' : ''; }
    }

    const btn = document.getElementById('claimROIBtn');
    if (btn && btn.textContent !== 'CLAIMING…') {
      const canClaim = totalUSDT > 0.00001 && (_rwROIAvailableCapETH > 0 || _rwROIPendingETH > 0);
      const tokens   = _rwROITokenPrice > 0 && _tickEffETH > 0 ? _tickEffETH / _rwROITokenPrice : 0;
      btn.textContent = canClaim ? 'CLAIM ALL · ' + fmtNum(tokens) + ' ' + _rwROITokenSym : 'NOTHING TO CLAIM';
      btn.disabled    = !canClaim;
      btn.style.background  = canClaim ? 'var(--gold)' : 'rgba(255,255,255,0.06)';
      btn.style.borderColor = canClaim ? 'var(--gold)' : 'var(--border)';
      btn.style.color       = canClaim ? '#0a0a0a'     : 'var(--muted)';
      btn.style.cursor      = canClaim ? 'pointer'     : 'not-allowed';
    }


    for (let _si = 0; _si < _rwROIStreamDetails.length; _si++) {
      const _d    = _rwROIStreamDetails[_si];
      // Accrual is 0 while cap is paused or exhausted; streamRate is 0 when paused/exhausted at load.
      const _a    = _effPaused ? 0 : Math.max(0, _d.accruedETH + elapsed * _d.streamRate);
      // When exhausted at load, _d.accruedETH holds the capped share (yellow/claimable portion);
      // liveWindowGapETH holds the excess (red/missed). For mid-session exhaustion accruedETH
      // is anchored at the moment cap ran out.
      const _effectiveA = (_effPaused && !_rwROICapPaused) ? _d.accruedETH : _a;

      const _histP = _d.histPaidETH || 0;
      // Use precomputed streamPendingETH (histPaid+roiPaid weighted) so after restake
      // histPaid still anchors the stream's share of global pending.
      const _streamPending2 = _d.streamPendingETH || 0;
      const _accEl = document.getElementById('rwROIStreamAccrued-' + _si);
      if (_accEl) {
        const _dispA = _effPaused ? (_rwROICapPaused ? 0 : _d.accruedETH) : _a;
        _accEl.textContent = '$' + ((_d.histPaidETH + _d.roiPaidETH + _dispA) * USDT_PER_ETH).toFixed(5);
      }
      const _claimableEl = document.getElementById('rwROIStreamClaimable-' + _si);
      if (_claimableEl) {
        const _claimableDisp = _streamPending2 + Math.min(_effectiveA, _rwROIAvailableCapETH);
        _claimableEl.textContent = '$' + (_claimableDisp * USDT_PER_ETH).toFixed(5);
      }

      const _claimBtn = document.getElementById('rwROIStreamClaimBtn-' + _si);
      if (_claimBtn && _claimBtn.textContent !== 'CLAIMING…') {
        const _liveOnlyA  = Math.min(_effectiveA, _rwROIAvailableCapETH);
        const _claimableA = _streamPending2 + _liveOnlyA;
        const _canClaim = _claimableA > 0;
        const _bt       = _rwROITokenPrice > 0 && _canClaim ? _claimableA / _rwROITokenPrice : 0;
        _claimBtn.textContent        = _bt > 0 ? 'CLAIM · ' + _bt.toFixed(5) + ' ' + _rwROITokenSym : 'CLAIM';
        _claimBtn.disabled           = !_canClaim;
        _claimBtn.style.borderColor  = _canClaim ? 'var(--gold)'           : 'var(--border)';
        _claimBtn.style.background   = _canClaim ? 'rgba(201,168,76,0.12)' : 'rgba(255,255,255,0.04)';
        _claimBtn.style.color        = _canClaim ? 'var(--gold)'           : 'var(--muted)';
        _claimBtn.style.cursor       = _canClaim ? 'pointer'               : 'not-allowed';
      }

      const _curRef2 = _d.periodMax > 0 ? _d.periodMax : (_d.ethInv || 0);
      // Bar shows current period only — no _histP in denominator.
      const _barRef2 = _curRef2;
      if (_barRef2 > 0) {
        const _streamSettled2      = _histP + (_d.roiPaidETH || 0);
        const _curPeriodPending2   = _streamSettled2 > 0 ? _streamPending2 * (_d.roiPaidETH || 0) / _streamSettled2 : 0;
        const _curPeriodClaimed2   = Math.max(0, (_d.roiPaidETH || 0) - _curPeriodPending2);
        const _paidPct    = Math.min(100, _curPeriodClaimed2 / _barRef2 * 100);
        const _pendingPct2 = Math.min(100 - _paidPct, _curPeriodPending2 / _barRef2 * 100);

        // PURPLE accruing = claimable slice of live accrual (capped by remaining cap).
        const _claimableA2 = Math.min(_effectiveA, _rwROIAvailableCapETH);
        const _accPct      = Math.min(100 - _paidPct - _pendingPct2, _claimableA2 / _barRef2 * 100);

        // YELLOW = HELD (heldCarryETH carry + projectedHeldETH pre-boundary earned, recoverable);
        // RED = MISSED (post-boundary gap + post-expiry gap + ongoing blocked accrual → forfeited).
        // Must mirror the initial render (incl. projectedHeldETH) or the yellow bar vanishes on first tick.
        const _growthB    = elapsed * (_d.perStreamMissRate || 0);
        const _heldB      = (_d.heldCarryETH || 0) + (_d.projectedHeldETH || 0) + (_rwROIBlockedIsMissed ? 0 : _growthB);
        const _missedB    = (_d.liveWindowGapETH || 0) + (_d.postExpiryMissedETH || 0) + (_rwROIBlockedIsMissed ? _growthB : 0);
        const _heldPctB   = Math.min(100 - _paidPct - _pendingPct2 - _accPct, _heldB / _barRef2 * 100);
        const _missedPctB = Math.min(100 - _paidPct - _pendingPct2 - _accPct - _heldPctB, _missedB / _barRef2 * 100);

        const _barEl = document.getElementById('rwROIStreamBar-' + _si);
        if (_barEl) { _barEl.style.left = (_paidPct + _pendingPct2).toFixed(3) + '%'; _barEl.style.width = _accPct.toFixed(3) + '%'; }

        const _heldBarEl = document.getElementById('rwROIStreamHeldBar-' + _si);
        if (_heldBarEl) {
          _heldBarEl.style.left  = (_paidPct + _pendingPct2 + _accPct).toFixed(3) + '%';
          _heldBarEl.style.width = _heldPctB.toFixed(3) + '%';
        }

        const _missedBarEl = document.getElementById('rwROIStreamMissedBar-' + _si);
        if (_missedBarEl) {
          _missedBarEl.style.left  = (_paidPct + _pendingPct2 + _accPct + _heldPctB).toFixed(3) + '%';
          _missedBarEl.style.width = _missedPctB.toFixed(3) + '%';
        }

        const _pctEl = document.getElementById('rwROIStreamPct-' + _si);
        if (_pctEl) {
          const _tot = _paidPct + _pendingPct2 + _accPct + _heldPctB + _missedPctB;
          _pctEl.textContent = (_tot >= 100 ? '100' : _tot.toFixed(2)) + '%';
        }

        // Per-stream HELD + MISSED, shown as SEPARATE indicators. Over-cap-while-staked
        // (liveWindowGapETH) and the ongoing blocked accrual are now MISSED (forfeited); only the
        // natural-expiry carry (heldCarryETH) stays HELD. histMissedETH + post-expiry gap are missed.
        const _perMissRate = _d.perStreamMissRate || 0;
        const _growth      = elapsed * _perMissRate;
        const _heldPS      = (_d.heldCarryETH || 0) + (_d.projectedHeldETH || 0) + (_rwROIBlockedIsMissed ? 0 : _growth);
        const _missedPS    = (_d.histMissedETH || 0) + (_d.postExpiryMissedETH || 0) + (_d.liveWindowGapETH || 0)
                           + (_rwROIBlockedIsMissed ? _growth : 0);
        const _heldEl     = document.getElementById('rwROIStreamHeld-' + _si);
        const _heldWrapEl = document.getElementById('rwROIStreamHeldWrap-' + _si);
        if (_heldWrapEl) {
          if (_heldPS > 0.0000001) {
            _heldWrapEl.style.display = '';
            if (_heldEl) _heldEl.textContent = '$' + (_heldPS * USDT_PER_ETH).toFixed(5);
          } else {
            _heldWrapEl.style.display = 'none';
          }
        }
        const _missedEl     = document.getElementById('rwROIStreamMissed-' + _si);
        const _missedWrapEl = document.getElementById('rwROIStreamMissedWrap-' + _si);
        if (_missedWrapEl) {
          if (_missedPS > 0.0000001) {
            _missedWrapEl.style.display = '';
            if (_missedEl) _missedEl.textContent = '$' + (_missedPS * USDT_PER_ETH).toFixed(5);
          } else {
            _missedWrapEl.style.display = 'none';
          }
        }
      }
    }
  }, 1000);
}

// ─── Staking live ticker ──────────────────────────────────────────────────────
let _rwPollInterval    = null;
let _rwCapFastPollInterval = null;
let _rwStakingInterval = null;
let _rwStakingLocks    = [];
let _rwStakingPrices   = [];   // parallel array: priceEth (spot) per lock — used for USDT valuation
let _rwStakingPayoutPrice = 0; // platformToken TWAP (ETH/token) — the price the contract pays at
let _rwStakingTokenSyms = [];  // parallel array: token symbol per lock
let _rwStakingFirstSym  = 'HORDEX';
let _rwStakingBaseTime = 0;
let _rwStakingWallBase = 0;

function _rwStopCapFastPoll() {
  if (_rwCapFastPollInterval) { clearInterval(_rwCapFastPollInterval); _rwCapFastPollInterval = null; }
}

function _rwStartCapFastPoll() {
  _rwStopCapFastPoll();
  _rwCapFastPollInterval = setInterval(async () => {
    const panel = document.getElementById('panel-rewards');
    if (!panel || !panel.classList.contains('active')) { _rwStopCapFastPoll(); return; }
    if (!contract || !walletAddress) return;
    try {
      // For states where getCapPausedAt alone can't detect recovery, also fetch commStats:
      //   • LOCK EXPIRED  : restake restores activeCapETH from 0 → >0
      //   • EXHAUSTED     : new invest raises activeCapETH above the value we last loaded
      const _needsCapCheck = _rwROILockExpired || _rwROICapExhausted || _rwROIMidExhaustedDetected || _rwROIRetained;
      const [capPausedAtRaw, freshCommStats] = await Promise.all([
        contract.getCapPausedAt(walletAddress),
        _needsCapCheck
          ? contract.getUserCommissionStats(walletAddress).catch(() => null)
          : Promise.resolve(null),
      ]);
      const isPaused = Number(capPausedAtRaw) > 0;
      if (isPaused && !_rwROICapPaused) {
        // Cap just became paused between 30s polls — freeze accrual immediately.
        const _nowSec = Math.floor(Date.now() / 1000);
        _rwROIBaseETH         = _rwROIBaseETH + Math.max(0, _nowSec - _rwROIFetchWall) * _rwROIRatePerSec;
        _rwROIFetchWall       = _nowSec;
        _rwROICapPaused       = true;
        _rwROICapPausedAt     = Number(capPausedAtRaw);
        _rwROIRatePerSec      = 0;
        _rwROIAvailableCapETH = 0;
        _rwROIActiveCapETH    = 0;
        loadRwROI(true);
      } else if (!isPaused && _rwROICapPaused) {
        // Cap was restored (new invest / restake) — reload to resume accrual.
        loadRwROI(true);
      } else if (freshCommStats && !isPaused) {
        // Cap not paused on-chain. Check if a previously exhausted or lock-expired state resolved.
        const freshActiveCap = parseFloat(ethers.utils.formatEther(freshCommStats[3]));
        if (_rwROIRetained && freshActiveCap > 0) {
          // Re-invested while retained: a new active lock created cap → retention cleared on-chain.
          loadRwROI(true);
        } else if (_rwROILockExpired && freshActiveCap > 0) {
          // Lock-expired → restaked: activeCapETH went from 0 to positive.
          loadRwROI(true);
        } else if ((_rwROICapExhausted || _rwROIMidExhaustedDetected) && !_rwROILockExpired) {
          // ROI-exhausted → new investment added cap: activeCapETH increased above our last known value.
          if (freshActiveCap > _rwROIActiveCapETH) loadRwROI(true);
        }
      }
    } catch(_) {}
  }, 5000);
}

function _rwStopPoll() {
  if (_rwPollInterval) { clearInterval(_rwPollInterval); _rwPollInterval = null; }
  _rwStopCapFastPoll();
}

function _rwStartPoll() {
  _rwStopPoll();
  _rwPollInterval = setInterval(() => {
    const panel = document.getElementById('panel-rewards');
    if (!panel || !panel.classList.contains('active')) { _rwStopPoll(); return; }
    loadRwROI(true);
  }, 30000);
  _rwStartCapFastPoll();
}

function _rwStopTicker() {
  if (_rwStakingInterval) { clearInterval(_rwStakingInterval); _rwStakingInterval = null; }
}

function _rwComputeLiveUsdt(now) {
  let live = 0, pending = 0, totalClaimableTokens = 0;
  let anyActive = false;
  const perLock = [];
  for (let i = 0; i < _rwStakingLocks.length; i++) {
    const lock = _rwStakingLocks[i];
    const ut   = Number(lock.unlockTime);
    const la   = Number(lock.lockedAt) || (ut - 60);
    const dur  = Math.max(ut - la, 60);
    const eth  = parseFloat(ethers.utils.formatEther(lock.ethInvested));
    const ratePPM = lock.rewardRatePPM ? lock.rewardRatePPM.toNumber() : 0;
    const rwEth   = ratePPM > 0 ? eth * ratePPM / 1_000_000 : 0;
    const elapsed     = Math.min(dur, Math.max(0, now - la));
    const isActive    = elapsed < dur && !lock.removed;
    const earnedEth   = dur > 0 ? rwEth * elapsed / dur : 0;
    const claimedEth   = parseFloat(ethers.utils.formatEther(lock.rewardClaimedETH   || ethers.BigNumber.from(0)));
    const tokensAcc    = parseFloat(ethers.utils.formatEther(lock.tokensAccumulated  || ethers.BigNumber.from(0)));
    const totalClaimed = parseFloat(ethers.utils.formatEther(lock.totalTokensClaimed || ethers.BigNumber.from(0)));
    const priceEth     = _rwStakingPrices[i] || 0;
    const pendingEth   = Math.max(0, earnedEth - claimedEth);
    // Overall accrued = current-period PENDING + all historical tokens (carry-over + ever-claimed) at current price.
    // Using pendingEth (not earnedEth) prevents double-count: when claimed, pendingEth drops and totalClaimed rises equally.
    const lockLive    = (pendingEth + (tokensAcc + totalClaimed) * priceEth) * USDT_PER_ETH;
    const lockPending = pendingEth * USDT_PER_ETH + tokensAcc * priceEth * USDT_PER_ETH;
    // Pending ETH converts to claim tokens at the TWAP payout price (fallback: spot), matching payout.
    const _payoutPriceTick = _rwStakingPayoutPrice > 0 ? _rwStakingPayoutPrice : priceEth;
    const claimableTokens = (_payoutPriceTick > 0 ? pendingEth / _payoutPriceTick : 0) + tokensAcc;
    const claimedPct  = rwEth > 0 ? Math.min(100, claimedEth / rwEth * 100) : 0;
    const pendingPct  = rwEth > 0 ? Math.min(100 - claimedPct, pendingEth / rwEth * 100) : 0;
    const _ePctNum    = dur  > 0 ? elapsed / dur * 100 : 0;
    const elapsedPct  = _ePctNum >= 100 ? '100' : _ePctNum.toFixed(5);
    if (isActive) anyActive = true;
    live    += lockLive;
    pending += lockPending;
    totalClaimableTokens += claimableTokens;
    perLock.push({ live: lockLive, pending: lockPending, pendingPct, elapsedPct, isActive, claimableTokens });
  }
  return { live, pending, perLock, anyActive, totalClaimableTokens };
}

function _rwStartTicker() {
  _rwStopTicker();
  if (!_rwStakingLocks.length) return;
  _rwStakingInterval = setInterval(() => {
    const accrEl  = document.getElementById('rwStakingAccrued');
    const claimEl = document.getElementById('rwStakingClaimable');
    const liveEl  = document.getElementById('rwStakingLiveLabel');
    if (!accrEl) { _rwStopTicker(); return; }
    const now = _rwStakingBaseTime + (Math.floor(Date.now() / 1000) - _rwStakingWallBase);
    const { live, pending, perLock, anyActive, totalClaimableTokens } = _rwComputeLiveUsdt(now);
    accrEl.textContent  = '$' + fmtNum(live);
    if (claimEl) claimEl.textContent = '$' + fmtNum(pending);
    if (liveEl) {
      liveEl.innerHTML = anyActive
        ? '30% of investment · live <span style="color:#4ade80;font-size:9px;">●</span>'
        : 'period complete · <span style="color:var(--gold);">claim to restake</span>';
    }
    const btn = document.getElementById('claimStakingBtn');
    if (btn && btn.textContent !== 'CLAIMING…') {
      const canClaim = totalClaimableTokens > 0.000001;
      btn.textContent = canClaim ? 'CLAIM ALL · ' + fmtNum(totalClaimableTokens) + ' ' + _rwStakingFirstSym : 'NOTHING TO CLAIM';
      btn.disabled = !canClaim;
      btn.style.background  = canClaim ? 'var(--gold)' : 'rgba(255,255,255,0.06)';
      btn.style.borderColor = canClaim ? 'var(--gold)' : 'var(--border)';
      btn.style.color       = canClaim ? '#0a0a0a'     : 'var(--muted)';
      btn.style.cursor      = canClaim ? 'pointer'     : 'not-allowed';
    }
    for (let i = 0; i < perLock.length; i++) {
      const accrued   = document.getElementById('rwLockAccrued-' + i);
      const bar       = document.getElementById('rwLockBar-' + i);
      const pct       = document.getElementById('rwLockPct-' + i);
      const claimable = document.getElementById('rwLockClaimable-' + i);
      if (accrued) accrued.textContent = '$' + fmtNum(perLock[i].live) + ' USDT';
      if (bar)     bar.style.width     = perLock[i].pendingPct.toFixed(3) + '%';
      if (pct) {
        pct.textContent = perLock[i].isActive
          ? perLock[i].elapsedPct + '% of period'
          : '100% · period complete';
      }
      if (claimable) {
        const ct  = perLock[i].claimableTokens;
        const sym = _rwStakingTokenSyms[i] || _rwStakingFirstSym;
        claimable.textContent = ct > 0.000001 ? fmtNum(ct) + ' ' + sym : '—';
        claimable.style.color = ct > 0.000001 ? 'var(--gold)' : 'var(--muted)';
      }
    }
  }, 1000);
}

// ─── Referral history helpers ─────────────────────────────────────────────────

function _rwRefSorted() {
  return [..._rwRefAllEvents].sort((a, b) => {
    let va, vb;
    if (_rwRefSortKey === 'amount') {
      va = parseFloat(ethers.utils.formatEther(a.args.amount)) * (a._missed ? -1 : 1);
      vb = parseFloat(ethers.utils.formatEther(b.args.amount)) * (b._missed ? -1 : 1);
    } else if (_rwRefSortKey === 'level') {
      va = Number(a.args.level);
      vb = Number(b.args.level);
    } else {
      // Use _ts (on-chain timestamp) preferentially; fall back to blockNumber for live-appended events
      va = a._ts || a.blockNumber || 0;
      vb = b._ts || b.blockNumber || 0;
    }
    return _rwRefSortDir * (va - vb);
  });
}

function _rwRefSI(key) {
  if (_rwRefSortKey !== key) return `<span style="opacity:0.35;font-size:8px;margin-left:2px;">↕</span>`;
  return `<span style="color:var(--gold);font-size:8px;margin-left:2px;">${_rwRefSortDir < 0 ? '↓' : '↑'}</span>`;
}

function _rwRefHistHtml() {
  if (_rwRefAllEvents.length === 0) {
    return '<div class="empty-state" style="margin-top:16px;">No commissions received yet.</div>';
  }

  const sorted = _rwRefSorted();
  const total  = sorted.length;
  const pages  = Math.max(1, Math.ceil(total / _rwRefPerPage));
  const page   = Math.min(_rwRefPage, pages);
  const start  = (page - 1) * _rwRefPerPage;
  const end    = Math.min(start + _rwRefPerPage, total);
  const slice  = sorted.slice(start, end);

  const RATES = [5000,2500,1000,300,250,225,200,200,175,150];

  let rows = '';
  for (const ev of slice) {
    // _ts is set for on-chain records; blockNumber fallback for live-appended events
    const tsVal       = ev._ts || _rwRefBlockTsMap.get(ev.blockNumber);
    const date        = tsVal ? _fmtTsFull(tsVal) : (ev.blockNumber ? `Block #${ev.blockNumber}` : '—');
    const from        = ev.args.from;
    const fromDisplay = (typeof _labelCache !== 'undefined' && _labelCache.get(from.toLowerCase())) || from;
    const fromShort   = fromDisplay.length > 12 ? fromDisplay.slice(0, 12) + '…' : fromDisplay;
    const amt     = parseFloat(ethers.utils.formatEther(ev.args.amount));
    const level   = Number(ev.args.level);
    const ratePct = (RATES[level - 1] || 0) / 500;
    const txUrl   = ev.transactionHash ? `${NET.explorer}/tx/${ev.transactionHash}` : null;

    if (ev._missed) {
      const tipText = ev._missedReason === 'cap'        ? 'Referral cap exceeded — excess spilled to next upline'
                   : ev._missedReason === 'ineligible' ? 'Active self-stake below the $25 referral threshold (see Network tab)'
                   :                                     'No active investment lock or lock expired';
      rows += `<tr style="border-bottom:1px solid rgba(20,30,42,0.8);background:rgba(248,113,113,0.04);">
        <td class="rw-ref-col-date" style="padding:7px 8px;color:rgba(248,113,113,0.6);white-space:nowrap;">${date}</td>
        <td class="rw-ref-from-cell" style="padding:7px 8px;">
          <div class="rw-ref-from-inner" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
            <a href="${NET.explorer}/address/${from}" target="_blank" rel="noopener" title="${from}" style="color:rgba(248,113,113,0.7);text-decoration:none;word-break:break-all;min-width:0;"><span class="rw-addr-full">${fromDisplay}</span><span class="rw-addr-short">${fromShort}</span></a>
            <button onclick="copyAddr('${from}',this)" title="Copy address" style="padding:2px 4px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--muted);cursor:pointer;flex-shrink:0;line-height:1;">${_COPY_ICON}</button>
          </div>
        </td>
        <td style="padding:7px 8px;text-align:center;color:#f87171;">L${level}</td>
        <td class="rw-ref-col-rate" style="padding:7px 8px;text-align:center;color:rgba(248,113,113,0.6);font-size:10px;">${ratePct.toFixed(ratePct % 1 === 0 ? 0 : 2)}%</td>
        <td class="rw-ref-amt-cell" style="padding:7px 8px;text-align:right;">
          <div class="rw-missed-tip">
            ${txUrl ? `<a href="${txUrl}" target="_blank" rel="noopener" style="color:#f87171;text-decoration:none;">⚠ −${fmtNum(ethToUSDT(amt))} USDT ↗</a>` : `<span style="color:#f87171;">⚠ −${fmtNum(ethToUSDT(amt))} USDT</span>`}
            <div class="rw-missed-tip-box">${tipText}</div>
          </div>
        </td>
      </tr>`;
    } else {
      rows += `<tr style="border-bottom:1px solid rgba(20,30,42,0.8);">
        <td class="rw-ref-col-date" style="padding:7px 8px;color:var(--muted);white-space:nowrap;">${date}</td>
        <td class="rw-ref-from-cell" style="padding:7px 8px;">
          <div class="rw-ref-from-inner" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
            <a href="${NET.explorer}/address/${from}" target="_blank" rel="noopener" title="${from}" style="color:var(--gold);text-decoration:none;word-break:break-all;min-width:0;"><span class="rw-addr-full">${fromDisplay}</span><span class="rw-addr-short">${fromShort}</span></a>
            <button onclick="copyAddr('${from}',this)" title="Copy address" style="padding:2px 4px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--muted);cursor:pointer;flex-shrink:0;line-height:1;">${_COPY_ICON}</button>
          </div>
        </td>
        <td style="padding:7px 8px;text-align:center;color:var(--cream);">L${level}</td>
        <td class="rw-ref-col-rate" style="padding:7px 8px;text-align:center;color:var(--muted);font-size:10px;">${ratePct.toFixed(ratePct % 1 === 0 ? 0 : 2)}%</td>
        <td class="rw-ref-amt-cell" style="padding:7px 8px;text-align:right;">${txUrl ? `<a href="${txUrl}" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:none;">+${fmtNum(ethToUSDT(amt))} USDT ↗</a>` : `<span style="color:#4ade80;">+${fmtNum(ethToUSDT(amt))} USDT</span>`}</td>
      </tr>`;
    }
  }

  const perPageBtns = [5, 10, 50, 100].map(n =>
    `<button onclick="setRwRefPerPage(${n})"
      style="padding:4px 10px;font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;
             border:1px solid ${_rwRefPerPage === n ? 'var(--gold)' : 'var(--border)'};
             background:${_rwRefPerPage === n ? 'rgba(201,168,76,0.12)' : 'var(--surface)'};
             color:${_rwRefPerPage === n ? 'var(--gold)' : 'var(--muted)'};
             border-radius:3px;cursor:pointer;">${n}</button>`
  ).join('');

  const navBtn = (lbl, p, dis) =>
    `<button onclick="setRwRefPage(${p})" ${dis ? 'disabled' : ''}
      style="padding:5px 12px;font-family:var(--font-mono);font-size:11px;letter-spacing:.04em;
             border:1px solid var(--border);background:var(--surface);
             color:${dis ? 'rgba(255,255,255,0.18)' : 'var(--cream)'};
             border-radius:3px;cursor:${dis ? 'default' : 'pointer'};">${lbl}</button>`;

  const pagination = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      ${navBtn('‹ PREV', page - 1, page <= 1)}
      <span style="font-size:11px;font-family:var(--font-mono);color:var(--muted);">PAGE</span>
      <span style="font-size:14px;font-family:var(--font-mono);color:var(--cream);min-width:22px;text-align:center;">${page}</span>
      <span style="font-size:11px;font-family:var(--font-mono);color:var(--muted);">OF ${pages}</span>
      ${navBtn('NEXT ›', page + 1, page >= pages)}
    </div>`;

  return `<div style="margin-top:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
      <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">
        ${start + 1}–${end} <span style="opacity:0.5;">of</span> ${total} entries
      </div>
      <div style="display:flex;align-items:center;gap:5px;">
        <span style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">SHOW</span>
        ${perPageBtns}
      </div>
    </div>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:11px;font-family:var(--font-mono);">
        <thead>
          <tr style="border-bottom:1px solid var(--border);">
            <th onclick="sortRwRef('ts')"     class="rw-ref-col-date" style="text-align:left;padding:7px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;cursor:pointer;user-select:none;white-space:nowrap;">DATE${_rwRefSI('ts')}</th>
            <th                               style="text-align:left;padding:7px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">FROM</th>
            <th onclick="sortRwRef('level')"  style="text-align:center;padding:7px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;cursor:pointer;user-select:none;">LVL${_rwRefSI('level')}</th>
            <th                               class="rw-ref-col-rate" style="text-align:center;padding:7px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">RATE</th>
            <th onclick="sortRwRef('amount')" style="text-align:right;padding:7px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;cursor:pointer;user-select:none;">AMOUNT${_rwRefSI('amount')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;flex-wrap:wrap;gap:10px;">
      <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">
        ${total} total · sorted by ${_rwRefSortKey === 'ts' ? 'DATE' : _rwRefSortKey.toUpperCase()} ${_rwRefSortDir < 0 ? '↓' : '↑'}
      </div>
      ${pagination}
    </div>
  </div>`;
}

function setRwRefPerPage(n) {
  _rwRefPerPage = n;
  _rwRefPage = 1;
  const el = document.getElementById('rwRefHistContainer');
  if (el) el.innerHTML = _rwRefHistHtml();
}

function setRwRefPage(p) {
  const pages = Math.max(1, Math.ceil(_rwRefAllEvents.length / _rwRefPerPage));
  _rwRefPage = Math.max(1, Math.min(p, pages));
  const el = document.getElementById('rwRefHistContainer');
  if (el) el.innerHTML = _rwRefHistHtml();
}

function sortRwRef(key) {
  if (_rwRefSortKey === key) {
    _rwRefSortDir = -_rwRefSortDir;
  } else {
    _rwRefSortKey = key;
    _rwRefSortDir = -1;
  }
  _rwRefPage = 1;
  const el = document.getElementById('rwRefHistContainer');
  if (el) el.innerHTML = _rwRefHistHtml();
}

// ─── Live commission append (avoids full reload on CommissionPaid event) ──────
// Called from app.js _startChainListeners when a CommissionPaid fires.
// Only runs if the rewards tab has already been loaded (i.e. _rwRefAllEvents is populated).
// Pushes the new event into the existing list and re-renders just the table row section.

async function _rwAppendCommission(ev, from, amount, level) {
  // If the tab hasn't been loaded yet, the full loadRwReferral() will handle it
  if (!_rwRefAllEvents.length && !document.getElementById('rwRefHistContainer')) return;

  try {
    // Fetch block timestamp (needed for date column)
    const blk = await provider.getBlock(ev.blockNumber).catch(() => null);
    if (blk) _rwRefBlockTsMap.set(ev.blockNumber, blk.timestamp);

    // Build synthetic event in the same shape loadRwReferral() produces
    const syntheticEv = {
      _missed: false,
      args: { from, amount, level },
      blockNumber:     ev.blockNumber,
      transactionHash: ev.transactionHash,
    };

    // Prepend (newest first)
    _rwRefAllEvents = [syntheticEv, ..._rwRefAllEvents];
    _rwRefPage = 1;

    if (typeof _batchGetRefLabels === 'function') {
      await _batchGetRefLabels([from]).catch(() => {});
    }

    // Re-render table
    const container = document.getElementById('rwRefHistContainer');
    if (container) container.innerHTML = _rwRefHistHtml();

    // Update earned / cap stats — fetch roi live data alongside to show referral-adjusted cap
    const [stats, roiDataRefresh] = await Promise.all([
      contract.getUserCommissionStats(walletAddress).catch(() => null),
      contract.getROIData(walletAddress).catch(() => null),
    ]);
    if (stats) {
      const freshRaw      = parseFloat(ethers.utils.formatEther(stats.remainingCap));  // commStats[3] = activeCap
      const freshLive     = roiDataRefresh ? parseFloat(ethers.utils.formatEther(roiDataRefresh.liveETH))    : 0;
      const freshPending  = roiDataRefresh ? parseFloat(ethers.utils.formatEther(roiDataRefresh.pendingETH)) : 0;
      const freshEffective = Math.max(0, freshRaw - freshLive - freshPending);

      // Update ROI ticker's cap so AVAILABLE CAP display shrinks immediately when a
      // referral commission is received (instead of waiting for the 30s poll).
      // Only update when not in a paused/known-exhausted state to avoid clobbering freeze logic.
      if (!_rwROICapPaused && _rwROIActiveCapETH < Infinity) {
        _rwROIActiveCapETH    = freshRaw;  // activeCap (non-expired locks)
        // commStats[2] = totalCap = activeCap + pausedCap
        _rwROIAvailableCapETH = parseFloat(ethers.utils.formatEther(stats.totalCap));
      }
      if (roiDataRefresh) {
        _rwROIPendingETH = freshPending;
      }

      const earnedEl     = document.querySelector('#rwRefContent [data-field="earned"]');
      const remainingEl  = document.querySelector('#rwRefContent [data-field="remaining"]');
      const noteEl       = document.querySelector('#rwRefContent [data-field="remaining-note"]');
      if (earnedEl)    earnedEl.textContent = fmtUSDT(parseFloat(ethers.utils.formatEther(stats.earned)), {decimals: 3});
      if (remainingEl) remainingEl.textContent = fmtUSDT(freshEffective);
      if (noteEl) {
        if (freshLive > 0.000001) {
          noteEl.style.display = '';
          noteEl.textContent   = `raw ${fmtUSDT(freshRaw)} · −${fmtUSDT(freshLive)} live ROI`;
        } else {
          noteEl.style.display = 'none';
        }
      }
    }
  } catch(_) {}
}

// ─── loadRewards ──────────────────────────────────────────────────────────────

let _rwLoadTime = 0;

async function loadRewards() {
  if (!contract || !walletAddress) {
    ['rwRefContent','rwStakingContent','rwROIContent','rwLPFeesContent'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="empty-state">Connect wallet to view your rewards.</div>';
    });
    const _capTop = document.getElementById('rwAvailableCapTop');
    if (_capTop) _capTop.innerHTML = '';
    return;
  }
  const _now = Date.now();
  if (_now - _rwLoadTime < 3000) return;
  _rwLoadTime = _now;
  _tabLoaded.add('rewards');
  loadRwReferral();
  loadRwStaking();
  loadRwROI();
  loadRwLPFees();
}

// ─── loadRwReferral ───────────────────────────────────────────────────────────

async function loadRwReferral() {
  const el = document.getElementById('rwRefContent');
  el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  try {
    const _zeroStats = { earned: ethers.BigNumber.from(0), totalCap: ethers.BigNumber.from(0), remainingCap: ethers.BigNumber.from(0) };
    // Fast on-chain calls only — _computeMissedWei runs in the background after render
    const [commStats, commRecords, eligRaw, minInvRaw, roiDataRef] = await Promise.all([
      contract.getUserCommissionStats(walletAddress).catch(() => _zeroStats),
      contract.getCommissionRecords(walletAddress).catch(() => []),
      contract.getUserEligibility(walletAddress).catch(() => null),
      contract.minDirectReferralInvestment().catch(() => ethers.BigNumber.from(0)),
      contract.getROIData(walletAddress).catch(() => null),
    ]);
    // Referral eligibility (new model): a flat $25 active self-stake unlocks ALL 10 referral levels.
    const refSelfStakeUSDT = eligRaw ? Number(eligRaw.selfStakeUSDT ?? eligRaw[0]) : 0;
    const minInvETH   = parseFloat(ethers.utils.formatEther(minInvRaw));
    const minInvLabel = minInvETH > 0 ? `≥ ${fmtUSDT(minInvETH,{noEth:true})} each` : 'any active investment';

    const earned    = parseFloat(ethers.utils.formatEther(commStats.earned));
    const remaining = parseFloat(ethers.utils.formatEther(commStats.remainingCap));
    // Effective cap for new referral commissions = raw remaining − live ROI already accruing.
    // Mirrors _getAvailableCap in HordexStorage (raw − pending − live): ROI is counted as
    // earned the moment it accrues, reducing the cap available to referrals immediately.
    const liveROIRef      = roiDataRef ? parseFloat(ethers.utils.formatEther(roiDataRef.liveETH)) : 0;
    const pendingROIRef   = roiDataRef ? parseFloat(ethers.utils.formatEther(roiDataRef.pendingETH)) : 0;
    const effectiveCapRef = Math.max(0, remaining - liveROIRef - pendingROIRef);

    // Normalise on-chain CommissionRecord — no block fetches needed (ts is stored on-chain)
    const receivedEvs = commRecords.map(r => ({
      _missed: false,
      _ts:     r.ts.toNumber ? r.ts.toNumber() : Number(r.ts),
      args:    { from: r.from, amount: r.amount, level: ethers.BigNumber.from(r.level) },
      blockNumber:     null,
      transactionHash: null,
    }));

    _rwRefBlockTsMap = new Map();
    _rwRefAllEvents  = receivedEvs.sort((a, b) => (b._ts || 0) - (a._ts || 0));
    _rwRefPage = 1;

    const maxEligibleLevel = refSelfStakeUSDT >= 25 ? 10 : 0;

    // Render immediately — missed card shows loading dots
    el.innerHTML = `
      <div class="rw-stat-grid-3">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">TOTAL EARNED</div>
          <div data-field="earned" style="font-size:18px;color:#4ade80;font-family:var(--font-display);">${fmtUSDT(earned, {decimals: 3})}</div>
        </div>
        <div id="rwRefMissedCard" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div id="rwRefMissedLabel" style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">MISSED</div>
          <div id="rwRefMissedVal" style="font-size:18px;font-family:var(--font-display);color:var(--muted);"><span class="ld"><span></span><span></span><span></span></span></div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;">ELIGIBLE UP TO</div>
          <div style="font-size:18px;font-family:var(--font-display);color:${maxEligibleLevel === 10 ? '#4ade80' : maxEligibleLevel > 0 ? 'var(--cream)' : 'var(--muted)'};">${maxEligibleLevel > 0 ? 'Level ' + maxEligibleLevel : '—'}${maxEligibleLevel === 10 ? ' · MAX' : ''}</div>
        </div>
      </div>
      <div id="rwRefMissedWarn"></div>
      <div id="rwRefHistContainer">${_rwRefHistHtml()}</div>`;

    // If the target is rwStakingCard, scroll now — referral is the only card above it.
    // For rwROICard / rwLPFeesCard, keep the flag so loadRwStaking consumes it after
    // staking content renders (staking also sits above those cards).
    if (window._rwPendingScrollId === 'rwStakingCard') {
      window._rwPendingScrollId = null;
      requestAnimationFrame(() => {
        const el = document.getElementById('rwStakingCard');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    // Labels in background — re-renders table when ready, doesn't block initial display
    if (typeof _batchGetRefLabels === 'function') {
      const fromAddrs = [...new Set(_rwRefAllEvents.map(e => e.args.from))];
      _batchGetRefLabels(fromAddrs).catch(() => {}).then(() => {
        const c = document.getElementById('rwRefHistContainer');
        if (c) c.innerHTML = _rwRefHistHtml();
      });
    }

    // Missed commissions — computed in background, updates card + table when done
    (async () => {
      try {
        const lb = await provider.getBlockNumber().catch(() => 0);
        const missedResult = await _computeMissedWei(getFromBlock(lb))
          .catch(() => ({ total: ethers.BigNumber.from(0), entries: [] }));
        const missed = parseFloat(ethers.utils.formatEther(missedResult.total));

        // Update missed stat card
        const missedCard  = document.getElementById('rwRefMissedCard');
        const missedLabel = document.getElementById('rwRefMissedLabel');
        const missedVal   = document.getElementById('rwRefMissedVal');
        if (missedCard) {
          missedCard.style.background   = missed > 0.000001 ? 'rgba(248,113,113,0.07)' : 'var(--bg)';
          missedCard.style.borderColor  = missed > 0.000001 ? 'rgba(248,113,113,0.35)' : 'var(--border)';
        }
        if (missedLabel) missedLabel.style.color = missed > 0.000001 ? '#f87171' : 'var(--muted)';
        if (missedVal) {
          missedVal.style.color = missed > 0.000001 ? '#f87171' : 'var(--muted)';
          missedVal.innerHTML   = missed > 0.000001 ? fmtUSDT(missed) : '0';
        }


        // Merge missed entries into the event list and re-render table
        if (missedResult.entries.length > 0) {
          const missedEvs = missedResult.entries.map(e => ({
            _missed: true,
            _missedReason: e.reason === 2 ? 'cap' : e.reason === 0 ? 'ineligible' : 'no-lock',
            _ts: e._ts || null,
            args: { from: e.from, level: e.level, amount: e.amount },
            blockNumber: null,
            transactionHash: null,
          }));
          _rwRefAllEvents = [..._rwRefAllEvents, ...missedEvs].sort((a, b) => {
            const ta = a._ts || _rwRefBlockTsMap.get(a.blockNumber) || 0;
            const tb = b._ts || _rwRefBlockTsMap.get(b.blockNumber) || 0;
            return tb - ta;
          });
          const c = document.getElementById('rwRefHistContainer');
          if (c) c.innerHTML = _rwRefHistHtml();
        }
      } catch(_) {}
    })();

  } catch(e) {
    el.innerHTML = `<div class="empty-state">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  }
}

// ─── loadRwStaking ────────────────────────────────────────────────────────────

async function loadRwStaking(silent = false) {
  _rwStopTicker();
  const el = document.getElementById('rwStakingContent');
  if (!silent) {
    el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  }
  try {
    const _zeroStaking = { totalAccumulated: ethers.BigNumber.from(0), previewNewTokens: ethers.BigNumber.from(0), lifetimeClaimed: ethers.BigNumber.from(0) };
    const [stakingData, lpLocks, latestBlock] = await Promise.all([
      contract.getStakingReward(walletAddress).catch(() => _zeroStaking),
      contract.getUserLPLocks(walletAddress).catch(() => []),
      provider.getBlock('latest')
    ]);

    // Use same effectiveNow as investments tab (restored from sessionStorage so
    // Hardhat's frozen block.timestamp doesn't cause mismatches).
    const blockTs  = latestBlock ? latestBlock.timestamp : Math.floor(Date.now() / 1000);
    const wallNow  = Math.floor(Date.now() / 1000);
    let effectiveNow = blockTs;
    try {
      const saved = JSON.parse(sessionStorage.getItem('hordex_eff_time') || 'null');
      if (saved && saved.blockNow <= blockTs) {
        const wallElapsed = Math.max(0, wallNow - saved.wallNow);
        effectiveNow = Math.max(blockTs, saved.effectiveNow + wallElapsed);
      }
    } catch(_) {}

    // Fetch pool prices and token symbols for all unique tokens (same as investments tab).
    const tokenSet  = [...new Set(lpLocks.map(l => l.token.toLowerCase()))];
    const poolCache = new Map();
    const tokenMeta = new Map();
    await Promise.all([
      ...tokenSet.map(async addr => { try { const d = await _dashGetPoolPrice(addr); if (d) poolCache.set(addr, d); } catch(_) {} }),
      ...tokenSet.map(async addr => { try { const t = await contract.getToken(addr); tokenMeta.set(addr, t.symbol); } catch(_) {} })
    ]);

    _rwStakingBaseTime  = effectiveNow;
    _rwStakingWallBase  = wallNow;
    _rwStakingLocks     = lpLocks;
    _rwStakingPrices    = lpLocks.map(l => (poolCache.get(l.token.toLowerCase()) || {}).priceEth || 0);
    // Staking rewards are paid in platformToken valued at the on-chain TWAP (not spot), so the
    // claimable token count must convert pending ETH at the TWAP to match what's received.
    _rwStakingPayoutPrice = 0;
    try { _rwStakingPayoutPrice = parseFloat(ethers.utils.formatEther(await contract.getTWAPPrice())); } catch(_) {}
    _rwStakingTokenSyms = lpLocks.map(l => tokenMeta.get(l.token.toLowerCase()) || 'HORDEX');
    _rwStakingFirstSym  = _rwStakingTokenSyms[0] || 'HORDEX';

    const firstTokenSym    = lpLocks.length > 0 ? (tokenMeta.get(lpLocks[0].token.toLowerCase()) || 'HORDEX') : 'HORDEX';
    const now              = effectiveNow;
    const lifetimeClaimed  = parseFloat(ethers.utils.formatEther(stakingData.lifetimeClaimed));

    const { live: totalLiveUSDT, pending: totalClaimableUSDT, anyActive: initAnyActive } = _rwComputeLiveUsdt(now);

    let lockRows = '';
    let totalClaimableTokens = 0;
    for (let i = lpLocks.length - 1; i >= 0; i--) {
      const lock        = lpLocks[i];
      const isRemoved   = lock.removed || false;
      const unlockTime  = Number(lock.unlockTime);
      const lockedAt    = Number(lock.lockedAt) || (unlockTime - 60);
      const lockDurSecs = unlockTime > lockedAt ? unlockTime - lockedAt : 60;
      const tokenSym    = tokenMeta.get(lock.token.toLowerCase()) || 'HORDEX';
      const priceEth    = _rwStakingPrices[i] || 0;
      const ethInvested = parseFloat(ethers.utils.formatEther(lock.ethInvested));
      const rewardClaimedETH  = parseFloat(ethers.utils.formatEther(lock.rewardClaimedETH  || ethers.BigNumber.from(0)));
      const tokensAccumulated = parseFloat(ethers.utils.formatEther(lock.tokensAccumulated || ethers.BigNumber.from(0)));
      const totalClaimed      = parseFloat(ethers.utils.formatEther(lock.totalTokensClaimed || ethers.BigNumber.from(0)));
      const elapsed           = Math.min(lockDurSecs, Math.max(0, now - lockedAt));
      const ratePPM_lock   = lock.rewardRatePPM ? lock.rewardRatePPM.toNumber() : 0;
      const rewardTotalETH = ratePPM_lock > 0 ? ethInvested * ratePPM_lock / 1_000_000 : 0;
      const earnedETH         = lockDurSecs > 0 ? rewardTotalETH * elapsed / lockDurSecs : 0;
      const pendingETH        = Math.max(0, earnedETH - rewardClaimedETH);
      // Overall accrued: same formula as ticker — pending current-period + all historical tokens at current price
      const liveUSDT_lock    = (pendingETH + (tokensAccumulated + totalClaimed) * priceEth) * USDT_PER_ETH;
      // Convert pending ETH → tokens at the TWAP payout price (fallback: spot) so the displayed
      // claimable matches the on-chain payout; tokensAccumulated is already in token units.
      const _payoutPrice     = _rwStakingPayoutPrice > 0 ? _rwStakingPayoutPrice : priceEth;
      const claimableTokens  = (_payoutPrice > 0 ? pendingETH / _payoutPrice : 0) + tokensAccumulated;
      totalClaimableTokens  += claimableTokens;

      const claimedPct  = rewardTotalETH > 0 ? Math.min(100, rewardClaimedETH / rewardTotalETH * 100) : 0;
      const pendingPct  = rewardTotalETH > 0 ? Math.min(100 - claimedPct, pendingETH / rewardTotalETH * 100) : 0;
      const progressBar = isRemoved
        ? `<div style="font-size:9px;color:#f87171;letter-spacing:1px;">LP REMOVED</div>`
        : `<div class="dis-bar-track" style="width:100%;min-width:70px;">
            <div class="dis-bar-claimed" style="width:${claimedPct.toFixed(2)}%"></div>
            <div id="rwLockBar-${i}" class="dis-bar-active" style="left:${claimedPct.toFixed(2)}%; width:${pendingPct.toFixed(2)}%"></div>
          </div>`;
      const isPeriodComplete = !isRemoved && elapsed >= lockDurSecs;
      const progressLabel = isRemoved
        ? `full period earned`
        : isPeriodComplete
          ? `<span id="rwLockPct-${i}" style="color:var(--gold);">100% · period complete</span>`
          : `<span id="rwLockPct-${i}">${((_p => _p >= 100 ? '100' : _p.toFixed(5))(elapsed / lockDurSecs * 100))}% of period</span>`;
      const claimedCell   = totalClaimed > 0 ? `<span style="color:#4ade80;">${fmtNum(totalClaimed)} ${tokenSym} claimed</span>` : '';
      const statusCell    = isRemoved
        ? `<span style="color:var(--muted);">LP REMOVED</span>`
        : `<span id="rwLockClaimable-${i}" style="color:${claimableTokens > 0.000001 ? 'var(--gold)' : 'var(--muted)'};">${claimableTokens > 0.000001 ? fmtNum(claimableTokens) + ' ' + tokenSym : '—'}</span>`;

      lockRows += `
        <tr style="border-bottom:1px solid rgba(20,30,42,0.7);">
          <td class="rw-s-td-num" style="padding:8px 8px;color:var(--muted);font-size:10px;">#${i+1}</td>
          <td class="rw-s-td-inv" style="padding:8px 8px;">
            <span style="font-family:var(--font-display);font-size:20px;line-height:1.1;color:var(--gold);white-space:nowrap;">${fmtUSDT(ethInvested,{noEth:true})}</span>
          </td>
          <td class="rw-s-td-prog" style="padding:8px 8px;">
            <div class="rw-s-prog-header" style="display:flex;align-items:baseline;gap:6px;margin-bottom:5px;">
              <span id="rwLockAccrued-${i}" style="color:var(--gold);">$${fmtNum(liveUSDT_lock)} USDT</span>
              <span style="font-size:9px;color:var(--muted);">${progressLabel}</span>
            </div>
            ${progressBar}
            ${claimedCell ? `<div class="rw-s-prog-claimed" style="font-size:9px;color:var(--muted);margin-top:3px;">${claimedCell}</div>` : ''}
          </td>
          <td class="rw-s-td-claim" style="padding:8px 8px;text-align:right;">${statusCell}</td>
        </tr>`;
    }

    const canClaim = totalClaimableTokens > 0.000001;

    el.innerHTML = `
      <div class="rw-stat-grid-3 rw-staking-stat-grid">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;"><span class="rw-stat-label-desk">ACCRUED (USDT)</span><span class="rw-stat-label-mob">Accrued</span></div>
          <div id="rwStakingAccrued" style="font-size:16px;color:var(--gold);font-family:var(--font-display);">${totalLiveUSDT > 0 ? '$' + fmtNum(totalLiveUSDT) : '$0'}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;"><span class="rw-stat-label-desk">CLAIMABLE (USDT)</span><span class="rw-stat-label-mob">Claimable</span></div>
          <div id="rwStakingClaimable" style="font-size:16px;color:var(--cream);font-family:var(--font-display);">${totalClaimableUSDT > 0 ? '$' + fmtNum(totalClaimableUSDT) : '$0'}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;"><span class="rw-stat-label-desk">LIFETIME CLAIMED</span><span class="rw-stat-label-mob">Claimed</span></div>
          <div style="font-size:16px;color:#4ade80;font-family:var(--font-display);">${lifetimeClaimed > 0 ? fmtNum(lifetimeClaimed) + ' ' + firstTokenSym : '0'}</div>
        </div>
      </div>

      <div style="margin-bottom:16px;">
        <button id="claimStakingBtn" onclick="claimStakingReward()"
          style="background:${canClaim ? 'var(--gold)' : 'rgba(255,255,255,0.06)'};
                 border:1px solid ${canClaim ? 'var(--gold)' : 'var(--border)'};
                 color:${canClaim ? '#0a0a0a' : 'var(--muted)'};
                 border-radius:4px;padding:10px 24px;font-family:var(--font-mono);
                 font-size:11px;font-weight:700;letter-spacing:1px;
                 cursor:${canClaim ? 'pointer' : 'not-allowed'};transition:opacity 0.15s;"
          ${canClaim ? '' : 'disabled'}>
          ${canClaim ? 'CLAIM ALL · ' + fmtNum(totalClaimableTokens) + ' ' + firstTokenSym : 'NOTHING TO CLAIM'}
        </button>
      </div>

      ${lockRows ? `
      <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:8px;">PER-INVESTMENT BREAKDOWN</div>
      <div style="overflow-x:auto;">
        <table class="rw-staking-table" style="width:100%;border-collapse:collapse;font-size:11px;font-family:var(--font-mono);">
          <thead>
            <tr style="border-bottom:1px solid var(--border);">
              <th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:400;">#</th>
              <th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:400;">INVESTED</th>
              <th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:400;">PROGRESS / CLAIMED</th>
              <th style="text-align:right;padding:6px 8px;color:var(--muted);font-weight:400;">CLAIMABLE (TOKENS)</th>
            </tr>
          </thead>
          <tbody>${lockRows}</tbody>
        </table>
      </div>` : '<div class="empty-state">No investments yet. Go to INVEST to get started.</div>'}`;

    // Snap bars to their rendered positions without CSS transition.
    // loadRwStaking re-creates DOM elements each call (including silent polls every 5s),
    // so without this the 0.9s transition animates bars from 0 each time, making them
    // appear to reset and re-accumulate even after the lock period ends.
    el.querySelectorAll('.dis-bar-active, .dis-bar-claimed').forEach(b => b.style.transition = 'none');
    requestAnimationFrame(() => requestAnimationFrame(() =>
      el.querySelectorAll('.dis-bar-active, .dis-bar-claimed').forEach(b => b.style.transition = '')
    ));

    _rwStartTicker();

    // If navigated here from a dashboard card below the staking section (e.g. ROI),
    // scroll now that staking content has rendered.
    if (window._rwPendingScrollId) {
      const _scrollTarget = window._rwPendingScrollId;
      window._rwPendingScrollId = null;
      requestAnimationFrame(() => {
        const el2 = document.getElementById(_scrollTarget);
        if (el2) el2.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

  } catch(e) {
    document.getElementById('rwStakingContent').innerHTML =
      `<div class="empty-state">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  }
}

async function claimStakingReward() {
  // Warn if the claimable value is less than $1 — gas cost likely exceeds the reward.
  if (_rwStakingLocks.length) {
    const _now = _rwStakingBaseTime + (Math.floor(Date.now() / 1000) - _rwStakingWallBase);
    const { pending: _claimableUSDT } = _rwComputeLiveUsdt(_now);
    if (_claimableUSDT < 1) {
      const ok = window.confirm(
        `Your claimable staking reward is $${_claimableUSDT.toFixed(6)} USDT — less than $1.\n` +
        `Gas fees may exceed this amount.\n\nClaim anyway?`
      );
      if (!ok) return;
    }
  }
  const btn = document.getElementById('claimStakingBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'CLAIMING…'; }
  try {
    toast('Confirm staking claim in MetaMask…', 'info');
    const tx = await contract.connect(signer).claimStakingReward(_GAS);
    toast('Transaction sent — waiting for confirmation…', 'info');
    await tx.wait();
    toast('Staking rewards claimed!', 'success');
    loadRwStaking();
  } catch(e) {
    if (btn) { btn.disabled = false; }
    toast('Claim failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

// ─── loadRwROI ────────────────────────────────────────────────────────────────

async function loadRwROI(silent = false) {
  if (_rwROILoading) return;
  _rwROILoading = true;
  const el = document.getElementById('rwROIContent');
  if (!el) { _rwROILoading = false; return; }
  if (!silent) {
    _rwStopROITicker();
    el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  }
  try {
    // ROI commission rates stored in the contract (roiCommissionRates[level]).
    // These must match the on-chain values set in the constructor / setROICommissionRates().
    const ROI_CONTRACT_RATES = [25000, 5000, 2500, 1000, 300, 250, 225, 200, 200, 175];

    const [roiData, activeStreams, platformToken, latestBlock, roiClaimRecords, capPausedAtRaw, commStats, ownLocks, reserveStats, reserveTranches] = await Promise.all([
      contract.getROIData(walletAddress).catch(() => null),
      contract.getActiveROIStreams(walletAddress).catch(() => null),
      cachedConstant('platformToken', () => contract.platformToken()).catch(() => null),
      provider.getBlock('latest').catch(() => null),
      contract.getROIClaimRecords(walletAddress).catch(() => []),
      Promise.resolve().then(() => contract.getCapPausedAt(walletAddress)).catch(() => 0),
      Promise.resolve().then(() => contract.getUserCommissionStats(walletAddress)).catch(() => null),
      contract.getUserLPLocks(walletAddress).catch(() => []),
      Promise.resolve().then(() => contract.getReserveStats(walletAddress)).catch(() => null),
      Promise.resolve().then(() => contract.getReserveTranches(walletAddress)).catch(() => []),
    ]);

    // Referral-commission RESERVE (held over-0.5× commission). Cached so the modal + cap chip read it.
    _rwReserveTotalETH     = reserveStats ? parseFloat(ethers.utils.formatEther(reserveStats.total ?? reserveStats[0])) : 0;
    _rwReserveClaimableETH = reserveStats ? parseFloat(ethers.utils.formatEther(reserveStats.claimable ?? reserveStats[1])) : 0;
    _rwReserveTranches     = (reserveTranches || []).map(t => ({
      amount:     parseFloat(ethers.utils.formatEther(t.amount ?? t[0])),
      unlockTime: Number(t.unlockTime ?? t[1]),
    }));

    _rwROICapPausedAt  = capPausedAtRaw ? Number(capPausedAtRaw) : 0;
    _rwROICapPaused            = _rwROICapPausedAt > 0;
    _rwROICapExhausted         = false;
    _rwROIMidExhaustedDetected = false;
    _rwROIRetained             = false;
    // commStats[2] = totalCap (activeCap + pausedCap from expired locks).
    // When cap is paused, use 0 so per-stream amounts don't show claimable from expired-lock cap
    // (post-exhaustion accrual is blocked). When not paused, include expired-lock cap so ROI
    // earned before a lock naturally expired stays claimable.
    _rwROIAvailableCapETH = _rwROICapPaused
      ? 0
      : (commStats ? parseFloat(ethers.utils.formatEther(commStats[2])) : Infinity);
    // commStats[3] = activeCap (non-expired locks only) — mirrors contract's _getRawAvailableCap.
    // Used for real-time mid-session exhaustion detection in the ticker so yellow stops and red
    // starts the moment liveETH+pendingETH reaches this value, without waiting for the 30s poll.
    _rwROIActiveCapETH = commStats ? parseFloat(ethers.utils.formatEther(commStats[3])) : Infinity;
    _rwROILockExpired  = !_rwROICapPaused && _rwROIActiveCapETH === 0
                         && _rwROIAvailableCapETH > 0 && _rwROIAvailableCapETH < Infinity;

    // In silent (poll) mode: if core data failed, keep the existing ticker running
    if (silent && roiData === null) { _rwROILoading = false; return; }
    if (silent && activeStreams === null) { _rwROILoading = false; return; }

    // Reset stream page to 1 only on full (non-silent) loads to preserve user's position
    if (!silent) { _rwROIStreamPage = 1; }

    const streams = activeStreams || [];

    const liveETH    = roiData ? parseFloat(ethers.utils.formatEther(roiData.liveETH))    : 0;
    const pendingETH = roiData ? parseFloat(ethers.utils.formatEther(roiData.pendingETH)) : 0;
    // When cap is paused, the contract returns liveETH = 0 (post-exhaustion accrual is blocked).
    // Guard here as a safety net against stale data: only include liveETH when NOT paused.
    let baseETH      = _rwROICapPaused ? pendingETH : (liveETH + pendingETH);
    const lifetimeClaimedTokens = (roiClaimRecords || []).reduce(
      (sum, r) => sum + parseFloat(ethers.utils.formatEther(r.tokensAmount)), 0
    );
    const lifetimeClaimedETH = (roiClaimRecords || []).reduce(
      (sum, r) => sum + parseFloat(ethers.utils.formatEther(r.ethEquivalent)), 0
    );
    _rwROILifetimeClaimedETH = lifetimeClaimedETH;

    // Fetch token price and symbol.
    // The contract pays ROI in platformToken valued at the on-chain TWAP (getTWAPPrice),
    // NOT the live spot price. Use the TWAP for the displayed token quantity so the amount
    // shown on the claim button matches what's actually received. Spot is kept only as a
    // fallback for when the TWAP is stale/not-ready (getTWAPPrice reverts).
    let tokenSym = 'HORDEX', tokenPrice = 0, spotPriceEth = 0;
    if (platformToken) {
      try {
        const pool = await _dashGetPoolPrice(platformToken);
        if (pool) spotPriceEth = pool.priceEth;
      } catch(_) {}
      try {
        const tp = await contract.getTWAPPrice();   // ETH per token, 1e18
        tokenPrice = parseFloat(ethers.utils.formatEther(tp));
      } catch(_) {}
      if (!(tokenPrice > 0)) tokenPrice = spotPriceEth;   // fallback: TWAP stale/unavailable
      try { const t = await contract.getToken(platformToken); if (t.symbol) tokenSym = t.symbol; } catch(_) {}
    }

    // Compute per-second accrual rate + per-stream details — all from lock data, no extra RPC calls.
    // capETH = ethInv * commRate / 10_000  (mirrors contract's initROIStreamsExt formula)
    // accruedETH = same linear formula as _calcAccrued (recipientSince ≈ lockedAt for new streams)
    let ratePerSec = 0;
    let missedBaseETH = 0;    // genuinely lost (natural-expiry no-stake gap), static
    let heldBaseETH   = 0;    // over-cap ROI HELD (recoverable by investing more) — Method 2
    let missedRatePerSec = 0; // rate the HELD over-cap amount grows while cap is exhausted (ETH/s)
    const wallNow  = Math.floor(Date.now() / 1000);
    const blockTs  = latestBlock ? latestBlock.timestamp : wallNow;
    const effNow   = Math.max(blockTs, wallNow);

    // When A's lock has expired naturally (activeCap=0, totalCap>0, not explicitly paused),
    // find the latest expiry timestamp so per-stream accruedETH can be bounded there.
    // This ensures elapsedPotAtFetch > accruedETH on a fresh load, making the gap visible immediately.
    let _naturalExpiryTs = 0;
    if (!_rwROICapPaused && _rwROIActiveCapETH === 0 && _rwROIAvailableCapETH > 0 && _rwROIAvailableCapETH < Infinity) {
      for (const _ol of (ownLocks || [])) {
        if (!_ol.removed) {
          const _ut = Number(_ol.unlockTime);
          if (_ut <= blockTs && _ut > _naturalExpiryTs) _naturalExpiryTs = _ut;
        }
      }
    }

    // Recipient's natural-expiry timestamp — computed even when cap is PAUSED (unlike _naturalExpiryTs),
    // so blocked accrual can be split at the expiry boundary, mirroring the contract's
    // _handleNaturalExpiryResume which settles pre-expiry ROI (recoverable/claimable) and forfeits the
    // post-expiry gap as historicalMissedETH:
    //   recipientSince → expiry : HELD  (over-cap accrued while the lock was active → recoverable)
    //   expiry        → now     : MISSED (accrued after the lock went inactive → forfeited)
    // Set only when active cap is 0 (blocked) AND a non-removed lock has expired.
    let _recipientExpiryTs = 0;
    const _hasExpiredLock = (ownLocks || []).some(l => !l.removed && Number(l.unlockTime) <= blockTs);
    if (_rwROIActiveCapETH === 0 && _hasExpiredLock) {
      for (const _ol of (ownLocks || [])) {
        if (!_ol.removed) {
          const _ut = Number(_ol.unlockTime);
          if (_ut <= blockTs && _ut > _recipientExpiryTs) _recipientExpiryTs = _ut;
        }
      }
    }
    // Over-cap ROI accruing while staked is now FORFEITED (missed), not held — so any blocked
    // accrual is always MISSED regardless of expiry. (Only natural-expiry heldCarryETH stays HELD.)
    _rwROIBlockedIsMissed = true;

    _rwROIStreamDetails = [];

    if (streams.length > 0) {
      const lockDataMap   = new Map();
      const streamInfoMap = new Map();
      const uniqueInvKeys = [...new Set(streams.map(r => r.investor.toLowerCase()))];
      await Promise.all([
        ...uniqueInvKeys.map(async (key) => {
          const addr = streams.find(r => r.investor.toLowerCase() === key).investor;
          try { lockDataMap.set(key, await contract.getUserLPLocks(addr)); } catch(_) {}
        }),
        ...streams.map(async (ref) => {
          const key = `${ref.investor.toLowerCase()}:${Number(ref.lockIndex)}:${Number(ref.level)}`;
          for (let _attempt = 0; _attempt < 2; _attempt++) {
            try {
              const info = await contract.getROIStreamInfo(ref.investor, ref.lockIndex, ref.level);
              streamInfoMap.set(key, info);
              break;
            } catch(_) {}
          }
        })
      ]);

      for (const ref of streams) {
        const lock = (lockDataMap.get(ref.investor.toLowerCase()) || [])[Number(ref.lockIndex)];
        if (!lock || lock.removed) continue;
        const unlockTime = Number(lock.unlockTime);
        const lockedAt   = Number(lock.lockedAt);
        const lockDur    = unlockTime - lockedAt;
        if (lockDur <= 0) continue;
        const ethInv   = parseFloat(ethers.utils.formatEther(lock.ethInvested));
        const ratePPM  = lock.rewardRatePPM ? lock.rewardRatePPM.toNumber() : 0;
        const roiRate  = ROI_CONTRACT_RATES[Number(ref.level)] || 0;
        const streamRate = (!_rwROICapPaused && effNow < unlockTime && ratePPM > 0 && roiRate > 0)
          ? ethInv * ratePPM * roiRate / (50_000_000_000 * lockDur)
          : 0;

        const streamKey      = `${ref.investor.toLowerCase()}:${Number(ref.lockIndex)}:${Number(ref.level)}`;
        const streamInfo     = streamInfoMap.get(streamKey);
        const roiPaidRaw     = streamInfo ? streamInfo.roiPaidETH : ethers.BigNumber.from(0);
        const roiPaidETH     = parseFloat(ethers.utils.formatEther(roiPaidRaw));
        const roiPaidNonZero = roiPaidRaw.gt(0);
        const recSince       = streamInfo ? Number(streamInfo.recipientSince) : lockedAt;

        // historicalPaidETH / historicalMissedETH: cumulative across all previous restake periods.
        const histPaidRaw = streamInfo && streamInfo.historicalPaidETH
          ? streamInfo.historicalPaidETH : ethers.BigNumber.from(0);
        const histPaidETH = parseFloat(ethers.utils.formatEther(histPaidRaw));
        const histMissedRaw = streamInfo && streamInfo.historicalMissedETH
          ? streamInfo.historicalMissedETH : ethers.BigNumber.from(0);
        const histMissedETH = parseFloat(ethers.utils.formatEther(histMissedRaw));
        // Carried-over HELD: over-cap held preserved on-chain across a natural-expiry restake
        // (recoverable once cap regains). Static — adds to the stream's HELD total.
        const heldCarryRaw = streamInfo && streamInfo.heldCarryETH
          ? streamInfo.heldCarryETH : ethers.BigNumber.from(0);
        const heldCarryETH = parseFloat(ethers.utils.formatEther(heldCarryRaw));

        // Accrual since last settlement (from recipientSince to now).
        // When A's lock expired naturally, bound accrual at the expiry time so the gap period
        // (expiry → now) is not counted as earned — elapsedPotAtFetch stays unbounded to effNow,
        // giving a non-zero gap on fresh load without waiting for the ticker.
        const recSinceTs   = Math.max(lockedAt, recSince);
        // Bound HELD accrual at the recipient's expiry (when expired, paused or not) so liveWindowGapETH
        // holds only the pre-expiry over-cap (recoverable). Post-expiry accrual is the MISSED gap, below.
        const _heldBound   = _recipientExpiryTs > 0 ? Math.min(effNow, _recipientExpiryTs)
                           : (_naturalExpiryTs > 0 ? Math.min(effNow, _naturalExpiryTs) : effNow);
        const elapsed2     = Math.max(0, Math.min(unlockTime, _heldBound) - recSinceTs);
        const accrualFromRecSince = lockDur > 0 && ratePPM > 0 && roiRate > 0
          ? ethInv * ratePPM * elapsed2 * roiRate / (50_000_000_000 * lockDur)
          : 0;
        // Also zero when the raw cap is fully consumed (commStats[2] = 0): contract gates
        // _calcAccrued to 0 in this state, so raw accrual here is entirely "missed".
        const _rawCapZero = (_rwROIAvailableCapETH === 0);
        const accruedETH = (_rwROICapPaused || _rawCapZero) ? 0 : Math.max(0, accrualFromRecSince);

        // Max accrual for the full lock period — used as bar denominator.
        const periodMax = ratePPM > 0 && roiRate > 0
          ? ethInv * ratePPM * roiRate / 50_000_000_000
          : 0;

        // Potential accrual from lockedAt up to effNow (capped at one full period).
        // Used only for the bar chart gap segment — NOT for the MISSED display.
        const elapsedPotAtFetch = lockDur > 0 && periodMax > 0
          ? periodMax * Math.min(Math.max(0, effNow - lockedAt), lockDur) / lockDur
          : 0;

        // Gap in the CURRENT recipientSince window only (not from lockedAt).
        // histMissedETH already captures all gap events before the last recipientSince reset.
        // Using accrualFromRecSince avoids double-counting when histMissedETH is added for display.
        let liveWindowGapETH = Math.max(0, accrualFromRecSince - accruedETH);

        // Split the blocked accrual at the boundary where claimable accrual stopped — cap-exhaustion
        // (_rwROICapPausedAt) or the recipient's lock expiry, whichever came FIRST. Accrual BEFORE that
        // instant was earned while staked-with-cap → HELD (claimable once cap regains, mirroring the
        // contract's _absorbResume held carry); only accrual AFTER it is the forfeited gap (MISSED).
        const _heldStopTs = _rwROICapPausedAt > 0
          ? (_recipientExpiryTs > 0 ? Math.min(_rwROICapPausedAt, _recipientExpiryTs) : _rwROICapPausedAt)
          : _recipientExpiryTs;
        let projectedHeldETH = 0;
        if (_heldStopTs > 0 && liveWindowGapETH > 0) {
          const _heldElapsed = Math.max(0, Math.min(_heldStopTs, Math.min(unlockTime, _heldBound)) - recSinceTs);
          projectedHeldETH = lockDur > 0 && ratePPM > 0 && roiRate > 0
            ? ethInv * ratePPM * _heldElapsed * roiRate / (50_000_000_000 * lockDur) : 0;
          if (projectedHeldETH > liveWindowGapETH) projectedHeldETH = liveWindowGapETH;
          liveWindowGapETH -= projectedHeldETH;  // remaining = post-boundary forfeited gap
        }

        // Post-expiry MISSED accrual: from max(recipientExpiry, recipientSince) to now, bounded by the
        // investor's lock. Mirrors the contract's gapROI (lastExpiry → now → historicalMissedETH).
        // Nonzero only once the recipient's lock has expired (_recipientExpiryTs > 0).
        const _missFrom    = Math.max(_recipientExpiryTs, recSinceTs);
        const _missElapsed = _recipientExpiryTs > 0
          ? Math.max(0, Math.min(unlockTime, effNow) - _missFrom) : 0;
        const postExpiryMissedETH = lockDur > 0 && ratePPM > 0 && roiRate > 0
          ? ethInv * ratePPM * _missElapsed * roiRate / (50_000_000_000 * lockDur) : 0;

        // Rate at which this stream misses ROI when blocked (paused/exhausted at load time).
        const perStreamMissRate = (streamRate === 0 && lockDur > 0 && periodMax > 0 && effNow < unlockTime)
          ? periodMax / lockDur : 0;

        ratePerSec += streamRate;
        _rwROIStreamDetails.push({
          investor: ref.investor, lockIndex: Number(ref.lockIndex), level: Number(ref.level),
          roiRate, ethInv, periodMax, accruedETH, streamRate, roiPaidETH, roiPaidNonZero,
          histPaidETH, histMissedETH, heldCarryETH, projectedHeldETH, liveWindowGapETH, postExpiryMissedETH, lockDur, elapsedPotAtFetch, unlockTime,
          perStreamMissRate,
        });
      }
    }

    // Apply the active column sort (default: highest unclaimed rewards first)
    _rwSortROIStreams();

    // Allocate global _roiPendingETH proportionally to each stream by its total settled amount
    // (histPaidETH + roiPaidETH), not just current-period roiPaidETH.  After a restake,
    // roiPaidETH resets to 0 but the previous period's settlement stays in _roiPendingETH —
    // using histPaid+roiPaid ensures the unclaimed pending is still attributed to the stream.
    {
      const _totalSettledSum = _rwROIStreamDetails.reduce((s, d) => s + (d.histPaidETH || 0) + (d.roiPaidETH || 0), 0);
      for (const _sd of _rwROIStreamDetails) {
        const _sdSettled = (_sd.histPaidETH || 0) + (_sd.roiPaidETH || 0);
        // Use local `pendingETH` (freshly fetched this load), NOT the global `_rwROIPendingETH`
        // which is assigned after this block and would be 0 on first load / stale on re-loads.
        _sd.streamPendingETH = (_totalSettledSum > 0 && pendingETH > 0)
          ? Math.min(_sdSettled, pendingETH * _sdSettled / _totalSettledSum)
          : 0;
      }
    }

    // Compute total missed and miss rate from all streams regardless of pause state.
    // Gap = elapsed potential − (paid + currently accruing). Streams with streamRate=0
    // but still within their lock period are missing ROI at the full unblocked rate.
    // Over-cap ROI (liveWindowGapETH) is now FORFEITED (missed), not held. histMissedETH
    // (on-chain forfeit) + post-expiry gap are also missed. Only heldCarryETH (natural-expiry
    // carry) is HELD/recoverable.
    missedBaseETH    = _rwROIStreamDetails.reduce((s, d) => s + (d.histMissedETH || 0) + (d.postExpiryMissedETH || 0) + (d.liveWindowGapETH || 0), 0);
    heldBaseETH      = _rwROIStreamDetails.reduce((s, d) => s + (d.heldCarryETH || 0) + (d.projectedHeldETH || 0), 0);
    missedRatePerSec = _rwROIStreamDetails.reduce((s, d) => {
      if (d.streamRate === 0 && d.lockDur > 0 && d.periodMax > 0 && effNow < d.unlockTime)
        return s + d.periodMax / d.lockDur;
      return s;
    }, 0);

    // getROIData returns liveETH = 0 when live cap is exhausted (pending + liveAccrued = rawCap)
    // even without _capPausedAt being set (ROI-driven exhaustion). In that case baseETH = pendingETH
    // and ratePerSec > 0, which would make the ticker keep growing past cap.
    // Also fires when A's lock expired naturally (_naturalExpiryTs > 0) even if all investor locks
    // have also expired (ratePerSec = 0) — needed so the exhausted swap puts yellow before red.
    // Third trigger: investor lock expired (ratePerSec = 0, no naturalExpiry) but cap was exhausted
    // mid-stream — frontend computes accruedETH > 0 but cap has no room (_capRem0 < _feLiveETH).
    // This keeps liveWindowGapETH non-zero so the missed row doesn't vanish after stream end.
    // Fix: cap baseETH at rawCap, zero all rates (global + per-stream), and set _rwROICapExhausted
    // so _midSessionExhausted triggers immediately on the first ticker tick even in float edge cases.
    const _feLiveETH = _rwROIStreamDetails.reduce((s, d) => s + d.accruedETH, 0);
    const _capRem0 = (_rwROIAvailableCapETH > 0 && _rwROIAvailableCapETH < Infinity)
      ? Math.max(0, _rwROIAvailableCapETH - pendingETH)
      : _feLiveETH;
    if (!_rwROICapPaused && liveETH === 0 &&
        (ratePerSec > 0 || _naturalExpiryTs > 0 || (_feLiveETH > 0 && _capRem0 < _feLiveETH))) {
      if (_feLiveETH > 0) {
        const _capRem = _capRem0;
        baseETH    = pendingETH + Math.min(_feLiveETH, _capRem);
        ratePerSec = 0;
        _rwROICapExhausted = true;
        // Split each stream's accruedETH: keep the share that filled the remaining cap as
        // accruedETH (claimable); move the excess beyond that cap share into liveWindowGapETH.
        // This over-cap excess is now MISSED (forfeited forever) — NOT recoverable by re-investing.
        // _feLiveETH = sum of all streams' raw accrual; _capRem = cap still open after pending.
        for (const _sd of _rwROIStreamDetails) {
          _sd.streamRate = 0;
          const _sdRaw    = _sd.accruedETH || 0;
          const _sdCapped = _feLiveETH > 0 ? Math.min(_sdRaw, _capRem * _sdRaw / _feLiveETH) : 0;
          _sd.accruedETH       = _sdCapped;
          _sd.liveWindowGapETH = (_sd.liveWindowGapETH || 0) + Math.max(0, _sdRaw - _sdCapped);
          if (_sd.lockDur > 0 && _sd.periodMax > 0 && effNow < _sd.unlockTime)
            _sd.perStreamMissRate = _sd.periodMax / _sd.lockDur;
        }
        // Recompute held/missed — liveWindowGapETH (over-cap excess) is now MISSED (forfeited).
        missedBaseETH = _rwROIStreamDetails.reduce((s, d) => s + (d.histMissedETH || 0) + (d.postExpiryMissedETH || 0) + (d.liveWindowGapETH || 0), 0);
        heldBaseETH   = _rwROIStreamDetails.reduce((s, d) => s + (d.heldCarryETH || 0) + (d.projectedHeldETH || 0), 0);
        // Streams are now blocked; recompute miss rate using full unblocked stream rates.
        // missedBaseETH was just recomputed above (not 0 at exhaustion anymore).
        missedRatePerSec = _rwROIStreamDetails.reduce((s, d) => {
          if (d.lockDur > 0 && d.periodMax > 0 && effNow < d.unlockTime)
            return s + d.periodMax / d.lockDur;
          return s;
        }, 0);
      }
    }

    // ── Retained-after-exit: all LP removed but earned ROI is preserved on-chain. ───────
    // computeCommissionStats skips removed locks, so commStats cap comes back 0 and the
    // cap-reconstruction path would (wrongly) disable claiming. getROIData/getROIPending DO
    // account for _roiRetainedCap, so the retained liveETH is the authoritative claimable
    // budget — trust it. Surface a positive available cap (gates canClaim + clears _rawCapZero),
    // freeze accrual (the budget is fixed at exit), and split it across streams so both the
    // per-stream CLAIM and the global CLAIM ALL buttons enable. On-chain payout stays exact;
    // this split only drives the per-stream display.
    const _isRetainedExit = !_rwROICapPaused && _rwROIAvailableCapETH === 0 && liveETH > 0;
    if (_isRetainedExit) {
      _rwROIRetained        = true;
      _rwROIAvailableCapETH = liveETH + pendingETH;
      baseETH               = liveETH + pendingETH;
      ratePerSec            = 0;
      const _wSum = _rwROIStreamDetails.reduce((s, d) => s + (d.streamRate || 0), 0);
      const _nStr = _rwROIStreamDetails.length || 1;
      for (const _sd of _rwROIStreamDetails) {
        const _w = _wSum > 0 ? (_sd.streamRate || 0) / _wSum : 1 / _nStr;
        _sd.accruedETH        = liveETH * _w;
        _sd.streamRate        = 0;
        _sd.perStreamMissRate = 0;
        _sd.liveWindowGapETH  = 0;
      }
      _rwSortROIStreams();
      missedBaseETH    = 0;
      heldBaseETH      = 0;
      missedRatePerSec = 0;
    }

    _rwROIBaseETH          = baseETH;
    _rwROIRatePerSec       = ratePerSec;
    _rwROIFetchWall        = wallNow;
    _rwROITokenSym         = tokenSym;
    _rwROITokenPrice       = tokenPrice;
    _rwROIActiveCount      = streams.length;
    _rwROIPendingETH       = pendingETH;
    // heldBaseETH (pre-expiry over-cap) stays HELD even after the lock expires — it's recoverable by
    // investing more. missedBaseETH already includes the post-expiry gap. The ongoing rate grows held
    // while the lock is active and missed once it has expired (_rwROIBlockedIsMissed, in the ticker).
    _rwROIMissedBaseETH    = missedBaseETH;
    _rwROIHeldBaseETH      = heldBaseETH;
    _rwROIMissedRatePerSec = missedRatePerSec;

    // Total lifetime accrued = historical claims + current outstanding (pending + live).
    const totalAccruedETH = lifetimeClaimedETH + baseETH;

    // Claim is possible when there is raw cap available OR pre-settled pending (rawCap = 0 edge case).
    const canClaim       = baseETH * USDT_PER_ETH > 0.00001 && (_rwROIAvailableCapETH > 0 || pendingETH > 0);
    const _effectiveETH  = canClaim
      ? (_rwROIAvailableCapETH > 0 ? Math.min(baseETH, _rwROIAvailableCapETH) : pendingETH)
      : 0;
    const claimTokens    = tokenPrice > 0 && _effectiveETH > 0 ? _effectiveETH / tokenPrice : 0;

    // AVAILABLE CAP widget — rendered into the top of the rewards tab (#rwAvailableCapTop),
    // not inside the ROI section. The ROI ticker keeps it live via #rwROICapAmt / #rwROICapBadge.
    const _capWidgetHtml = (() => {
        let _cbTxt, _cbColor, _cbBg, _cbBorder, _caAmt, _caSub;
        // baseETH = liveETH + pendingETH; both reduce available cap since neither has been
        // charged to commissionsCapUsed yet (pending is pre-settled but unclaimed).
        const _initLiveCap = Math.max(0, _rwROIActiveCapETH - baseETH);
        if (_rwROIRetained) {
          _cbTxt = 'RETAINED'; _cbColor = '#a78bfa';
          _cbBg = 'rgba(167,139,250,0.10)'; _cbBorder = 'rgba(167,139,250,0.3)';
          _caAmt = `<div id="rwROICapAmt" style="font-size:16px;font-family:var(--font-display);color:#a78bfa;margin:6px 0 2px;">$${(baseETH * USDT_PER_ETH).toFixed(2)}</div>`;
          _caSub = `<div style="font-size:10px;color:var(--muted);">earned ROI preserved · claim anytime</div>`;
        } else if (_rwROICapPaused) {
          _cbTxt = 'CAP PAUSED'; _cbColor = '#ef4444';
          _cbBg = 'rgba(239,68,68,0.10)'; _cbBorder = 'rgba(239,68,68,0.3)';
          _caAmt = `<div style="font-size:16px;font-family:var(--font-display);color:#ef4444;margin:6px 0 2px;">—</div>`;
          _caSub = `<div style="font-size:10px;color:var(--muted);">invest or restake to restore</div>`;
        } else if (_rwROILockExpired) {
          _cbTxt = 'LOCK EXPIRED'; _cbColor = '#f97316';
          _cbBg = 'rgba(249,115,22,0.10)'; _cbBorder = 'rgba(249,115,22,0.3)';
          _caAmt = `<div id="rwROICapAmt" style="font-size:16px;font-family:var(--font-display);color:#f97316;margin:6px 0 2px;">$0.00</div>`;
          _caSub = `<div style="font-size:10px;color:var(--muted);">restake to reactivate</div>`;
        } else if (_rwROIActiveCapETH === 0) {
          _cbTxt = 'NO CAP'; _cbColor = '#ef4444';
          _cbBg = 'rgba(239,68,68,0.10)'; _cbBorder = 'rgba(239,68,68,0.3)';
          _caAmt = `<div style="font-size:16px;font-family:var(--font-display);color:#ef4444;margin:6px 0 2px;">$0.00</div>`;
          _caSub = `<div style="font-size:10px;color:var(--muted);">invest to earn a cap</div>`;
        } else if (_initLiveCap <= 0) {
          _cbTxt = 'EXHAUSTED'; _cbColor = '#ef4444';
          _cbBg = 'rgba(239,68,68,0.10)'; _cbBorder = 'rgba(239,68,68,0.3)';
          _caAmt = `<div id="rwROICapAmt" style="font-size:16px;font-family:var(--font-display);color:#ef4444;margin:6px 0 2px;">$0.00</div>`;
          _caSub = `<div style="font-size:10px;color:var(--muted);">claim ROI to restore accrual</div>`;
        } else {
          _cbTxt = 'ACTIVE'; _cbColor = '#4ade80';
          _cbBg = 'rgba(74,222,128,0.10)'; _cbBorder = 'rgba(74,222,128,0.3)';
          _caAmt = `<div id="rwROICapAmt" style="font-size:16px;font-family:var(--font-display);color:#4ade80;margin:6px 0 2px;">$${(_initLiveCap * USDT_PER_ETH).toFixed(2)}</div>`;
          _caSub = `<div style="font-size:10px;color:var(--muted);">live · decreases as ROI accrues</div>`;
        }
        // Reserve chip — held over-0.5× referral commission. Sits at the right of AVAILABLE CAP and
        // opens the per-package reserve modal (claim matured / buy a package). Hidden when empty.
        const _resTotal = _rwReserveTotalETH || 0;
        const _resClaim = _rwReserveClaimableETH || 0;
        const _resChip = _resTotal > 0.000001 ? `
            <span onclick="openReserveModal()" title="Held referral commission — click for the per-package breakdown"
                  style="cursor:pointer;display:inline-flex;align-items:center;gap:5px;font-size:9px;font-family:var(--font-mono);
                         letter-spacing:1px;padding:2px 8px;border-radius:3px;background:rgba(96,165,250,0.10);
                         color:#60a5fa;border:1px solid rgba(96,165,250,0.35);">
              RESERVE $${(_resTotal * USDT_PER_ETH).toFixed(2)}
              ${_resClaim > 0.000001 ? `<span style="color:#4ade80;">●</span>` : ``}
              <span style="opacity:0.6;">›</span>
            </span>` : ``;
        return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:16px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;gap:8px;">
            <div style="font-size:9px;letter-spacing:2px;color:var(--muted);">AVAILABLE CAP</div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${_resChip}
              <span id="rwROICapBadge" style="font-size:9px;font-family:var(--font-mono);letter-spacing:1px;
                    padding:2px 7px;border-radius:3px;background:${_cbBg};color:${_cbColor};border:1px solid ${_cbBorder};"
              >${_cbTxt}</span>
            </div>
          </div>
          ${_caAmt}
          ${_caSub}
        </div>`;
    })();
    { const _capTopEl = document.getElementById('rwAvailableCapTop'); if (_capTopEl) _capTopEl.innerHTML = _capWidgetHtml; }

    el.innerHTML = `
      <div class="rw-stat-grid-4 rw-roi-stat-grid" style="margin-bottom:16px;">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;"><span class="rw-stat-label-desk">ACCRUED (USDT) <span id="rwROIAccrDot" style="color:#a78bfa;font-size:9px;">●</span></span><span class="rw-stat-label-mob">Accrued <span style="color:#a78bfa;font-size:9px;">●</span></span></div>
          <div id="rwROILive" style="font-size:16px;color:#a78bfa;font-family:var(--font-display);">$${(totalAccruedETH * USDT_PER_ETH).toFixed(5)}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;"><span class="rw-stat-label-desk">HELD <span style="color:#fbbf24;font-size:9px;">●</span> / MISSED <span style="color:#ef4444;font-size:9px;">●</span></span><span class="rw-stat-label-mob">Held / Missed</span></div>
          <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;">
            <span id="rwROIHeldWrap" style="display:${heldBaseETH > 0.000001 ? '' : 'none'};"><span id="rwROIHeld" style="font-size:16px;color:#fbbf24;font-family:var(--font-display);">$${(heldBaseETH * USDT_PER_ETH).toFixed(2)}</span><span style="font-size:8px;color:var(--muted);"> held</span></span>
            <span id="rwROIMissedWrap" style="display:${missedBaseETH > 0.000001 ? '' : 'none'};"><span id="rwROIMissed" style="font-size:16px;color:#ef4444;font-family:var(--font-display);">$${(missedBaseETH * USDT_PER_ETH).toFixed(2)}</span><span style="font-size:8px;color:var(--muted);"> missed</span></span>
            <span id="rwROIHeldMissedDash" style="font-size:16px;color:var(--muted);font-family:var(--font-display);display:${(heldBaseETH > 0.000001 || missedBaseETH > 0.000001) ? 'none' : ''};">—</span>
          </div>
          <div style="font-size:8px;color:var(--muted);margin-top:3px;display:${heldBaseETH > 0.000001 ? '' : 'none'};">held is earned ROI awaiting cap · invest more to claim</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;"><span class="rw-stat-label-desk">CLAIMABLE (USDT)</span><span class="rw-stat-label-mob">Claimable</span></div>
          <div id="rwROIClaimable" style="font-size:16px;color:${_effectiveETH > 0.000001 ? 'var(--gold)' : 'var(--muted)'};font-family:var(--font-display);">${_effectiveETH > 0.000001 ? '$' + (_effectiveETH * USDT_PER_ETH).toFixed(2) : '—'}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:9px;letter-spacing:2px;color:var(--muted);margin-bottom:6px;"><span class="rw-stat-label-desk">LIFETIME CLAIMED</span><span class="rw-stat-label-mob">Claimed</span></div>
          <div style="font-size:16px;color:${lifetimeClaimedTokens > 0 ? '#4ade80' : 'var(--muted)'};font-family:var(--font-display);">${lifetimeClaimedTokens > 0 ? fmtNum(lifetimeClaimedTokens) + ' ' + tokenSym : '—'}</div>
        </div>
      </div>

      <div style="margin-bottom:12px;">
        <button id="claimROIBtn" onclick="claimAllROI()"
          style="background:${canClaim ? 'var(--gold)' : 'rgba(255,255,255,0.06)'};
                 border:1px solid ${canClaim ? 'var(--gold)' : 'var(--border)'};
                 color:${canClaim ? '#0a0a0a' : 'var(--muted)'};
                 border-radius:4px;padding:10px 24px;font-family:var(--font-mono);
                 font-size:11px;font-weight:700;letter-spacing:1px;
                 cursor:${canClaim ? 'pointer' : 'not-allowed'};transition:opacity 0.15s;"
          ${canClaim ? '' : 'disabled'}>
          ${canClaim ? 'CLAIM ALL · ' + fmtNum(claimTokens) + ' ' + tokenSym : 'NOTHING TO CLAIM'}
        </button>
      </div>

      ${streams.length === 0 && pendingETH * USDT_PER_ETH < 0.00001 ? '<div class="empty-state">No active ROI streams. Refer active investors to start earning.</div>' : ''}

      <div id="rwROIStreamsContainer">${_rwROIStreamsHtml()}</div>`;

    // Snap bars to rendered positions without CSS transition (same as staking)
    el.querySelectorAll('.dis-bar-active, .dis-bar-claimed, .dis-bar-paused').forEach(b => b.style.transition = 'none');
    requestAnimationFrame(() => requestAnimationFrame(() =>
      el.querySelectorAll('.dis-bar-active, .dis-bar-claimed, .dis-bar-paused').forEach(b => b.style.transition = '')
    ));

    _rwStopROITicker();
    _rwStartROITicker();
  } catch(e) {
    if (!silent) el.innerHTML = `<div class="empty-state">Error: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  } finally {
    _rwROILoading = false;
  }
}

async function claimROIFromStreamBtn(investor, lockIndex, level, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'CLAIMING…'; }
  try {
    toast('Confirm ROI claim in MetaMask…', 'info');
    // When the stream has pre-settled pending (_streamPendingETH > 0), claimROIFromStream would
    // settle nothing new and revert with NothingToClaim.  Route to claimAllROI which settles all
    // streams and pays out the full pending (including this stream's share).
    const _sd = _rwROIStreamDetails.find(
      d => d.investor.toLowerCase() === investor.toLowerCase() &&
           d.lockIndex === lockIndex && d.level === level
    );
    const _hasPending = _sd && (_sd.streamPendingETH || 0) > 1e-12;
    const tx = _hasPending
      ? await contract.connect(signer).claimAllROI(_GAS)
      : await contract.connect(signer).claimROIFromStream(investor, lockIndex, level, _GAS);
    toast('Transaction sent — waiting for confirmation…', 'info');
    const receipt = await tx.wait();

    // Parse exact tokens from the ROIClaimed event in the receipt.
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed.name === 'ROIClaimed') {
          const tokens = parseFloat(ethers.utils.formatEther(parsed.args.tokensAmount));
          if (tokens > 0) {
            const key = `${investor.toLowerCase()}:${lockIndex}:${level}`;
            _rwROIStreamClaimedTokens.set(key, (_rwROIStreamClaimedTokens.get(key) || 0) + tokens);
          }
          break;
        }
      } catch (_) {}
    }

    toast('ROI commission claimed!', 'success');
    _rwROILoading = false;
    loadRwROI();
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'CLAIM'; }
    toast('Claim failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

// Number of ROI streams settled per settleROIStreams() tx in the batched path.
// claimAllROI() settles ALL active streams in a single tx; once a recipient has many
// streams that can exceed the block gas limit, so we fall back to the contract's
// incremental escape hatch: settleROIStreams(from, count) in chunks, then claimPendingROI().
const _ROI_CLAIM_CHUNK = 25;

async function claimAllROI() {
  const btn = document.getElementById('claimROIBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'CLAIMING…'; }
  _txBegin();
  try {
    // Decide single-tx vs batched based on the authoritative active-stream count.
    let streamCount = 0;
    try {
      const streams = await contract.getActiveROIStreams(walletAddress);
      streamCount = streams ? streams.length : 0;
    } catch(_) {}

    if (streamCount > _ROI_CLAIM_CHUNK) {
      // Batched path — settle in chunks, then a single payout. Each step is its own tx.
      const chunks = Math.ceil(streamCount / _ROI_CLAIM_CHUNK);
      for (let i = 0; i < chunks; i++) {
        const from = i * _ROI_CLAIM_CHUNK;
        toast(`Settling ROI streams ${from + 1}–${Math.min(from + _ROI_CLAIM_CHUNK, streamCount)} of ${streamCount} (${i + 1}/${chunks})…`, 'info');
        const stx = await contract.connect(signer).settleROIStreams(from, _ROI_CLAIM_CHUNK, _GAS);
        await stx.wait();
      }
      toast('Confirm final ROI payout in MetaMask…', 'info');
      const ctx = await contract.connect(signer).claimPendingROI(_GAS);
      await ctx.wait();
    } else {
      // Single-tx path (small stream count) — original behaviour.
      toast('Confirm ROI commission claim in MetaMask…', 'info');
      const tx = await contract.connect(signer).claimAllROI(_GAS);
      toast('Transaction sent — waiting for confirmation…', 'info');
      await tx.wait();
    }

    _txDone();
    toast('ROI commissions claimed!', 'success');
    _rwROILoading = false;
    loadRwROI();
  } catch(e) {
    _txDone();
    if (btn) { btn.disabled = false; btn.textContent = 'CLAIM ALL ROI'; }
    toast('Claim failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

// ─── loadRwLPFees ─────────────────────────────────────────────────────────────

async function loadRwLPFees(silent = false) {
  const el = document.getElementById('rwLPFeesContent');
  if (!silent) {
    el.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  }
  try {
    const lpLocks = await contract.getUserLPLocks(walletAddress);
    if (!lpLocks.length) {
      el.innerHTML = `<div class="empty-state">No LP positions found. Go to INVEST to get started.</div>`;
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

    for (let i = lpLocks.length - 1; i >= 0; i--) {
      const lock        = lpLocks[i];
      const key         = lock.token.toLowerCase();
      const pool        = poolCache.get(key);
      const td          = tokenMeta.get(key) || { symbol: lock.token, meta: {} };
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
        <td class="rw-lp-col-curval" style="padding:9px 8px;text-align:right;color:var(--cream);">${currentETH > 0 ? fmtUSDT(currentETH,{noEth:true}) : '—'}</td>
        <td style="padding:9px 8px;text-align:right;">
          <span style="color:${gainClr};">${currentETH > 0 ? (gainETH >= 0 ? '+' : '') + fmtUSDT(gainETH,{noEth:true}) : '—'}</span>
          ${currentETH > 0 ? `<div style="font-size:9px;color:${gainClr};opacity:0.75;">${(gainETH >= 0 ? '+' : '') + fmtNum(gainPct, 2)}%</div>` : ''}
        </td>
        <td class="rw-lp-col-status" style="padding:9px 8px;text-align:right;font-size:10px;color:${statusClr};">${statusTxt}</td>
      </tr>`;
    }

    const totalClr = totalGainETH > 0.000001 ? '#4ade80' : totalGainETH < -0.000001 ? '#f87171' : 'var(--muted)';

    el.innerHTML = `
      <div class="rw-lp-earnings-box" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:16px;display:inline-block;min-width:200px;">
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
              <th class="rw-lp-col-curval" style="text-align:right;padding:6px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">CURRENT VALUE</th>
              <th style="text-align:right;padding:6px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">GAIN (FEES + PRICE)</th>
              <th class="rw-lp-col-status" style="text-align:right;padding:6px 8px;color:var(--muted);letter-spacing:1px;font-weight:400;">STATUS</th>
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

window._rwAppendCommission = _rwAppendCommission;
window.loadRewards        = loadRewards;
window.loadRwReferral     = loadRwReferral;
window.loadRwStaking      = loadRwStaking;
window.loadRwROI          = loadRwROI;
window.loadRwLPFees       = loadRwLPFees;
window._rwStopPoll        = _rwStopPoll;
window._rwStartPoll       = _rwStartPoll;
window.claimStakingReward      = claimStakingReward;
window.claimAllROI             = claimAllROI;
window.claimROIFromStreamBtn   = claimROIFromStreamBtn;
window.setRwRefPerPage       = setRwRefPerPage;
window.setRwRefPage          = setRwRefPage;
window.sortRwRef             = sortRwRef;
window.setRwROIStreamPage    = setRwROIStreamPage;
window.setRwROIStreamPerPage = setRwROIStreamPerPage;
window.showROIStreamPopup    = showROIStreamPopup;

// Exposed so the dashboard's ROI element and wealth display can mirror the exact value
// shown in the rewards tab ACCRUED (including mid-session exhaustion capping).
// Returns null when the rewards tab hasn't loaded ROI data yet.
window._rwROIGetAccrued = function() {
  if (!_rwROIFetchWall) return null;
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - _rwROIFetchWall);
  const totalETH = _rwROIBaseETH + elapsed * _rwROIRatePerSec;
  const _midSessExh = !_rwROICapPaused && (_rwROICapExhausted ||
      (_rwROIActiveCapETH > 0 && _rwROIActiveCapETH < Infinity && totalETH >= _rwROIActiveCapETH));
  const _outstandingETH = _rwROICapPaused
    ? _rwROIBaseETH
    : (_midSessExh && _rwROIAvailableCapETH > 0 && _rwROIAvailableCapETH < Infinity)
      ? Math.min(totalETH, _rwROIAvailableCapETH)
      : totalETH;
  return _rwROILifetimeClaimedETH + _outstandingETH;
};
