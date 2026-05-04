// ── LOADING HELPER ──
function ld(text = 'Loading') {
  return `${text}<span class="ld"><span></span><span></span><span></span></span>`;
}

// ── USDT DISPLAY SYSTEM ──
// Platform fixed rate: 1,000 USDT = 1 ETH  (testnet only — not market price)
const USDT_PER_ETH = 1000;

function ethToUSDT(ethFloat) {
  return ethFloat * USDT_PER_ETH;
}

// opts.sign = true → prepend + or - sign
function fmtUSDT(ethFloat, opts = {}) {
  const usdt = ethToUSDT(ethFloat);
  const sign = opts.sign ? (ethFloat >= 0 ? '+' : '') : '';
  const usdtStr = sign + usdt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
