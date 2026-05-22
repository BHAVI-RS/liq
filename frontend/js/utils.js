// ── USDT DISPLAY SYSTEM ──
// Platform fixed rate: 1,000 USDT = 1 ETH  (testnet only — not market price)
const USDT_PER_ETH = 1000;

function ethToUSDT(ethFloat) {
  return ethFloat * USDT_PER_ETH;
}

// Format a number with max 5 decimal places, stripping trailing zeros
function fmtNum(n, maxDp = 5) {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.min(maxDp, 5) });
}

// opts.sign = true → prepend + or - sign
function fmtUSDT(ethFloat, opts = {}) {
  const usdt = ethToUSDT(ethFloat);
  const sign = opts.sign ? (ethFloat >= 0 ? '+' : '') : '';
  const maxDp = opts.decimals !== undefined ? Math.min(opts.decimals, 5) : 5;
  const usdtStr = sign + usdt.toLocaleString(undefined, { maximumFractionDigits: maxDp });
  return `${usdtStr} USDT`;
}

// ── COMMISSION RATES ──
const COMMISSION_RATES = [10.00, 5.00, 2.00, 0.60, 0.50, 0.45, 0.40, 0.40, 0.35, 0.30];

// ── TOKEN METADATA STORE (keyed by contract address, persisted in localStorage) ──
const TOKEN_META_KEY = 'hordex_token_meta';

function getAllMeta() {
  try { return JSON.parse(localStorage.getItem(TOKEN_META_KEY)) || {}; } catch(_) { return {}; }
}

function saveMeta(addr, meta) {
  const all = getAllMeta();
  all[addr.toLowerCase()] = { ...all[addr.toLowerCase()], ...meta };
  localStorage.setItem(TOKEN_META_KEY, JSON.stringify(all));
}

function getMeta(addr) {
  return getAllMeta()[addr.toLowerCase()] || {};
}

// ── TRANSACTION IN-FLIGHT GUARD ──
let _txInFlight = 0;

function _txBegin() {
  _txInFlight++;
}

function _txDone() {
  if (_txInFlight > 0) _txInFlight--;
}

window.addEventListener('beforeunload', (e) => {
  if (_txInFlight > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── TAB LOAD GUARD ──
const _tabLoaded = new Set();

function invalidateTabs(...names) {
  names.forEach(n => _tabLoaded.delete(n));
}

function _resetTabLoaded() {
  _tabLoaded.clear();
}

// ── ADDRESS COPY HELPER ──
const _COPY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function copyAddr(addr, btn) {
  navigator.clipboard.writeText(addr).then(() => {
    if (!btn) return;
    const prev = btn.innerHTML;
    btn.innerHTML = '✓';
    setTimeout(() => { btn.innerHTML = prev; }, 1200);
  }).catch(() => {});
}
window.copyAddr = copyAddr;

// ── TIMESTAMP FORMATTERS ──
function _fmtTs(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}
function _fmtTsFull(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ── REQUIRE CONNECTED ──
function requireConnected() {
  if (!App.walletAddress) { toast('Connect your wallet first', 'warn'); return false; }
  if (!App.contract) { toast('Set contract address first', 'warn'); return false; }
  return true;
}

// ── ENSURE HTTPS ──
function ensureHttps(url) {
  if (!url) return '#';
  return /^https?:\/\//i.test(url) ? url : 'https://' + url;
}

// ── TOAST ──
function toast(msg, type='info') {
  const log = document.getElementById('statusLog');
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  div.textContent = msg;
  log.appendChild(div);
  setTimeout(() => { div.style.opacity='0'; div.style.transition='opacity 0.5s'; setTimeout(()=>div.remove(), 500); }, 4000);
}

function getFromBlock(latestBlock) {
  return (typeof DEPLOY_BLOCK !== 'undefined' && DEPLOY_BLOCK > 0)
    ? DEPLOY_BLOCK
    : Math.max(0, latestBlock - 300);
}

// ── GLOBAL MODAL BODY LOCK ──
// Locks body scroll whenever any overlay is open, without touching individual open/close fns.
(function() {
  const MODAL_IDS = [
    'missedCommAlert', 'dashRefPopupOverlay', 'dashEligPopupOverlay',
    'tokenDetailOverlay', 'investConfirmModal', 'removeLPModal',
    'stakeModal', 'shortagePopup',
  ];

  function _syncBodyLock() {
    const staticOpen = MODAL_IDS.some(id => {
      const el = document.getElementById(id);
      return el && (el.style.display === 'flex' || el.style.display === 'block');
    });
    const anyOpen = staticOpen;
    document.body.style.overflow      = anyOpen ? 'hidden' : '';
    document.body.style.pointerEvents = anyOpen ? 'none'   : '';
    document.body.classList.toggle('modal-open', anyOpen);
  }

  document.addEventListener('DOMContentLoaded', function() {
    MODAL_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) new MutationObserver(_syncBodyLock).observe(el, { attributes: true, attributeFilter: ['style'] });
    });
  });
})();
