// ── USDT DISPLAY SYSTEM ──
// Investments are denominated directly in USDT (18-decimal ERC-20).
// USDT_PER_ETH = 1 means: 1 unit of base currency = 1 USDT.
const USDT_PER_ETH = 1;

function ethToUSDT(usdtFloat) {
  return usdtFloat * USDT_PER_ETH;
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

// ── POLYGON AMOY GAS OVERRIDES ──
// Public Amoy RPC requires a minimum tip cap of 25 Gwei.
// MetaMask's automatic estimate is often ~1.5 Gwei, causing RejectedTx errors.
const _GAS = {
  maxFeePerGas:         ethers.utils.parseUnits("60", "gwei"),
  maxPriorityFeePerGas: ethers.utils.parseUnits("30", "gwei"),
};

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
  _evLogCache.clear(); // event logs only change after a confirmed tx
}

function _resetTabLoaded() {
  _tabLoaded.clear();
  _evLogCache.clear();
}

// ── EVENT LOG CACHE ──
// Caches queryFilterBatched results by wallet + filter name.
// Cleared by invalidateTabs() (called after every confirmed tx) and on wallet change.
// 5-min TTL guards against events arriving from other wallets' txs.
const _evLogCache = new Map();

async function cachedQueryFilter(filter, filterName, fromBlock) {
  const key = (walletAddress || '').toLowerCase() + ':' + filterName;
  const hit = _evLogCache.get(key);
  if (hit && Date.now() - hit.ts < 300_000) return hit.events;
  const events = await queryFilterBatched(contract, filter, fromBlock, 'latest');
  _evLogCache.set(key, { events, ts: Date.now() });
  return events;
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
function _fmtTs(ts)     { return String(ts); }
function _fmtTsFull(ts) { return String(ts); }

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

// Queries events over potentially large block ranges by splitting into chunks.
// Resolves 'latest' upfront so the range is known. For ranges larger than
// batchSize the full-range call is skipped entirely — some RPCs (including
// the public Polygon Amoy endpoint) silently return [] for oversized ranges
// instead of throwing, which would prevent the batching fallback from running.
async function queryFilterBatched(contractInstance, filterOrEvent, fromBlock, toBlock, batchSize = 200) {
  // Resolve 'latest' to a concrete block number so we know the range size.
  let to = (toBlock === 'latest' || toBlock === undefined)
    ? (await provider.getBlockNumber().catch(() => fromBlock + batchSize))
    : toBlock;

  if (to <= fromBlock) return [];

  // Small range: try the single call first (fast path).
  if (to - fromBlock < batchSize) {
    const result = await contractInstance.queryFilter(filterOrEvent, fromBlock, to).catch(() => null);
    if (result !== null) return result;
    // If the small call failed, the loop below will retry as a single batch.
  }

  // Large range (or failed small call): always batch to avoid silent truncation.
  const all = [];
  for (let start = fromBlock; start <= to; start += batchSize) {
    const end   = Math.min(start + batchSize - 1, to);
    const batch = await contractInstance.queryFilter(filterOrEvent, start, end).catch(() => []);
    all.push(...batch);
  }
  return all;
}

// Same but for provider.getLogs (used in _computeMissedWei / history).
async function getLogsBatched(filter, fromBlock, toBlock, batchSize = 100) {
  let to = (toBlock === 'latest' || toBlock === undefined)
    ? (await provider.getBlockNumber().catch(() => fromBlock + batchSize))
    : toBlock;

  if (to <= fromBlock) return [];

  if (to - fromBlock < batchSize) {
    const result = await provider.getLogs({ ...filter, fromBlock, toBlock: to }).catch(() => null);
    if (result !== null) return result;
  }

  const all = [];
  for (let start = fromBlock; start <= to; start += batchSize) {
    const end   = Math.min(start + batchSize - 1, to);
    const batch = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end }).catch(() => []);
    all.push(...batch);
  }
  return all;
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
