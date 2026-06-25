// ── USDT DISPLAY SYSTEM ──
// Investments are denominated directly in USDT.
// USDT_PER_ETH = 1 means: 1 unit of base currency = 1 USDT (a $-value multiplier, NOT decimals).
const USDT_PER_ETH = 1;

// ── USDT (base token) decimals ──
// Polygon USDT (0xc2132D05D31c914a87C6611C10748AEb04B58e8F) has 6 DECIMALS. Every base-token /
// USDT amount on-chain — ethInvested, commissions, ROI & staking ETH-equivalent, reserve, package
// amounts, the registration fee — is in these units, so USDT amounts must be parsed/formatted at 6
// decimals, NOT 18. MUST equal 10**decimals of the deployed base token (= HordexTypes.USDT_ONE).
// HDX (platform token) and LP amounts stay 18-decimal and keep using parseEther/formatEther; the
// TWAP price is base-units * 1e18 / token-units, so a raw price is converted to human USDT/token
// with formatUnits(price, USDT_DECIMALS). If you switch to an 18-decimal base token, set this to 18.
const USDT_DECIMALS = 6;
// human USDT amount (string|number) → base-unit BigNumber (for approve / invest / transfer)
function parseUSDT(amount) { return ethers.utils.parseUnits(String(amount), USDT_DECIMALS); }
// base-unit USDT BigNumber → human float (for display / math)
function usdtToFloat(weiBN) { return parseFloat(ethers.utils.formatUnits(weiBN, USDT_DECIMALS)); }
// base-unit USDT BigNumber → human string (full precision)
function usdtToStr(weiBN)   { return ethers.utils.formatUnits(weiBN, USDT_DECIMALS); }

// ── Time scaling ──
// Seconds per "day" — MUST match SECONDS_PER_DAY in contracts/HordexTypes.sol.
//   TESTING    = 6      (1 day = 6 s)
//   PRODUCTION = 86400  (real calendar days)
// Only used to convert a lock's on-chain second-span back into whole days (e.g. the
// restake streak preview). Change this together with the contract's SECONDS_PER_DAY.
const LP_DAY_SCALE = 86400;

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

// Bundled logo for the Hordex platform token — always use the local mark.
const HORDEX_TOKEN_LOGO = 'logo/hordex-mark.png';

function getMeta(addr) {
  const meta = getAllMeta()[addr.toLowerCase()] || {};
  if (typeof TOKEN_ADDRESS === 'string' && addr.toLowerCase() === TOKEN_ADDRESS.toLowerCase()) {
    return { ...meta, logo: HORDEX_TOKEN_LOGO };
  }
  return meta;
}

// ── POLYGON GAS OVERRIDES ──
// Polygon mainnet base fees swing widely (tens to several-hundred gwei). Both failure modes
// have to be avoided: a hardcoded cap that's too low is rejected ("maxFeePerGas less than block
// base fee"), and omitting maxFeePerGas leaves it 0 ("priority fee higher than max fee"). So we
// keep BOTH fields and let maxFeePerGas TRACK the live base fee: refreshGasFromNetwork() rewrites
// _GAS to (2× base + tip) on a short interval (wired up in app.js). The values below are just a
// safe starting default until the first refresh lands. You pay only baseFee + tip — maxFeePerGas
// is merely the ceiling. The 40-gwei tip clears Polygon's priority-fee floor (MetaMask's ~1.5
// gwei default stalls).
let _GAS = {
  maxFeePerGas:         ethers.utils.parseUnits("600", "gwei"),
  maxPriorityFeePerGas: ethers.utils.parseUnits("40",  "gwei"),
};
// Rewrites _GAS so maxFeePerGas = 2× current base fee + tip — always above the live base fee,
// without over-reserving the user's POL. Called on a timer from app.js with the read provider.
async function refreshGasFromNetwork(provider) {
  try {
    if (!provider) return;
    const blk = await provider.getBlock("latest");
    if (blk && blk.baseFeePerGas) {
      const tip = ethers.utils.parseUnits("40", "gwei");
      _GAS = { maxFeePerGas: blk.baseFeePerGas.mul(2).add(tip), maxPriorityFeePerGas: tip };
    }
  } catch (_) {}
}

// ── CONTRACT ERROR DECODING ───────────────────────────────────────────────────
// Turns the many shapes an ethers v5 / MetaMask revert can take into a clear,
// user-facing reason. The contract's custom errors are all zero-argument, so we
// match on the 4-byte selector (keccak256("Name()")[:4]) — version-independent and
// robust even when estimateGas wraps the data several objects deep.

// Friendly explanations for the errors a normal user can actually hit. Anything not
// listed falls back to "Reverted: <Name>" so the name is always shown.
const _ERR_FRIENDLY = {
  InvalidPackageAmount:             'That package amount is not allowed — pick a listed investment package.',
  TokenNotRegistered:               'This token is not registered on the platform.',
  TokenDelisted:                    'This token has been delisted and can no longer be invested in.',
  TokenInProgress:                  'This token is still launching — please try again in a moment.',
  InsufficientContractTokenBalance: 'The platform is temporarily low on this token’s reserve. Try a smaller package or a different token.',
  USDTTransferFailed:               'USDT transfer failed — check your USDT balance and that the spend was approved.',
  MustSendUSDT:                     'USDT amount missing — enter a valid amount.',
  PriceUnavailable:                 'The price feed for this token isn’t ready yet. Wait ~1 minute (it needs two price updates) and try again.',
  TokenTWAPStale:                   'This token’s average price (TWAP) is stale. Make a small trade or wait for a price update, then retry.',
  TWAPStale:                        'The USDT average price (TWAP) is stale — please retry shortly.',
  PriceDeviationTooHigh:            'The token price moved too far from its recent average; the trade was blocked to protect you. Try again shortly.',
  PoolNotFound:                     'No liquidity pool exists for this token yet.',
  NoLPTokens:                       'No LP tokens were minted (pool ratio / slippage). Try again.',
  NotRegistered:                    'Your wallet is not registered yet — register before investing.',
  NothingToClaim:                   'There is nothing to claim right now.',
  LPStillLocked:                    'These LP tokens are still locked.',
  AlreadyRemoved:                   'This position has already been removed.',
  LPAlreadyClaimed:                 'This LP has already been claimed.',
  ClaimLPFirst:                     'Claim your LP first before doing this.',
  NotOwner:                         'Only the contract owner can do this — connect the wallet that deployed the contract (the owner address).',
  TokenAlreadyRegistered:           'This token is already registered on the platform.',
  InvalidTokenAddress:              'Invalid token address (the zero address is not allowed).',
  AlreadyRegistered:                'This wallet is already registered.',
  ReferrerNotRegistered:            'The referrer address is not registered yet.',
  CannotReferSelf:                  'You cannot refer yourself.',
  RegistrationFeeFailed:            'The 1 USDT registration fee transfer failed — check your USDT balance and approval.',
};

// Every zero-arg custom error in the contract suite (union across all facets), so the
// selector map can name any of them even without a friendly string.
const _ALL_ERROR_NAMES = [
  'NotDelegatecall','NotDirectCall','NotOwner','NoETHToWithdraw','ETHWithdrawFailed',
  'NoTokensToWithdraw','TokenWithdrawFailed','Reentrant','MustSendETH','InsufficientContractTokenBalance',
  'ETHReturnFailed','SurplusTransferFailed','InvalidPackageAmount','TokenNotRegistered','TokenDelisted',
  'TokenInProgress','PoolNotFound','NoLPTokens','PriceUnavailable','PriceDeviationTooHigh','AlreadyRemoved',
  'LPAlreadyClaimed','LPStillLocked','ClaimLPFirst','LPPullFailed','TokenReturnFailed','CommissionTransferFailed',
  'StakingRewardTransferFailed','NothingToClaim','InsufficientTokenBalance','TokenTransferFailed','InvalidDuration',
  'InvalidDurationIndex','InvalidTierIndex','InvalidStreakLevel','TWAPStale','TokenTWAPStale','AlreadyRegistered',
  'NotRegistered','CannotReferSelf','ReferrerNotRegistered','MustSendUSDT','USDTTransferFailed','MustSpecifyTokenAmount',
  'InvalidTokenAddress','TokenAlreadyRegistered','AlreadyClaimed','LPTransferFailed','RegistrationFeeFailed','LPTransferFailed',
];
const _ERR_SELECTORS = {};
for (const _n of _ALL_ERROR_NAMES) {
  try { _ERR_SELECTORS[ethers.utils.id(_n + '()').slice(0, 10)] = _n; } catch (_) {}
}

// Friendlier wording for Uniswap router string reverts (these arrive as Error(string)).
function _friendlyRouterMsg(s) {
  if (!s) return s;
  if (/INSUFFICIENT_(OUTPUT_AMOUNT|A_AMOUNT|B_AMOUNT)/.test(s))
    return 'Price moved during the transaction (slippage). Please try again.';
  if (/EXPIRED/.test(s))              return 'The transaction took too long and expired. Please try again.';
  if (/ds-math-sub-underflow/.test(s)) return 'Pool math underflow — the price moved too far. Please try again.';
  if (/TRANSFER_FROM_FAILED|TRANSFER_FAILED/.test(s))
    return 'A token transfer failed — check your balances and approvals.';
  return s;
}

// Depth-first walk to find the raw revert data ("0x" + selector + args) wherever the
// provider buried it (e.data, e.error.data, e.error.error.data, JSON body, etc.).
function _extractRevertData(e) {
  const seen = new Set();
  const stack = [e];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    for (const k of ['data', 'return', 'returnData']) {
      const v = cur[k];
      if (typeof v === 'string' && v.startsWith('0x') && v.length >= 10) return v;
      if (v && typeof v === 'object' && typeof v.data === 'string' && v.data.startsWith('0x')) return v.data;
    }
    if (typeof cur.body === 'string') {
      try { const b = JSON.parse(cur.body); if (b && b.error && typeof b.error.data === 'string') return b.error.data; } catch (_) {}
    }
    for (const k of ['error', 'data', 'info', 'cause', 'originalError']) {
      if (cur[k] && typeof cur[k] === 'object') stack.push(cur[k]);
    }
  }
  return null;
}

// Main entry: returns a user-facing string explaining any failed contract tx/estimate.
// `iface` is optional (e.g. contract.interface) — used as a secondary decode path.
function decodeContractError(e, iface) {
  // Wallet-level outcomes first.
  if (e && (e.code === 4001 || e.code === 'ACTION_REJECTED')) return 'You rejected the transaction in your wallet.';
  if (e && e.code === 'INSUFFICIENT_FUNDS') return 'Not enough MATIC to pay for gas.';

  // Ethers already decoded a custom error.
  if (e && e.errorName) return _ERR_FRIENDLY[e.errorName] || ('Reverted: ' + e.errorName);

  const data = _extractRevertData(e);
  if (data && data.length >= 10) {
    const sel = data.slice(0, 10);
    // Standard Error(string) — router slippage / require messages.
    if (sel === '0x08c379a0') {
      try {
        const reason = ethers.utils.defaultAbiCoder.decode(['string'], '0x' + data.slice(10))[0];
        return _friendlyRouterMsg(reason);
      } catch (_) {}
    }
    // Panic(uint256) — overflow / divide-by-zero (e.g. too many ROI streams).
    if (sel === '0x4e487b71') {
      try {
        const code = Number(ethers.utils.defaultAbiCoder.decode(['uint256'], '0x' + data.slice(10))[0]);
        if (code === 0x11) return 'Internal overflow — this can occur with a very large number of ROI streams. Please contact support.';
        if (code === 0x12) return 'Internal division-by-zero error. Please contact support.';
        return 'Internal contract error (panic 0x' + code.toString(16) + ').';
      } catch (_) {}
    }
    // Known zero-arg custom error by selector.
    if (_ERR_SELECTORS[sel]) {
      const name = _ERR_SELECTORS[sel];
      return _ERR_FRIENDLY[name] || ('Reverted: ' + name);
    }
    // Last resort: let the ABI try (covers any error with arguments).
    if (iface) {
      try { const p = iface.parseError(data); if (p && p.name) return _ERR_FRIENDLY[p.name] || ('Reverted: ' + p.name); } catch (_) {}
    }
  }

  // String reasons the provider surfaced without structured data.
  const raw = (e && (e.reason || (e.error && e.error.message) || (e.data && e.data.message) || e.message)) || '';
  const friendly = _friendlyRouterMsg(raw);
  if (friendly && !/cannot estimate gas|UNPREDICTABLE_GAS_LIMIT|^execution reverted$/i.test(friendly.trim())) {
    return friendly;
  }
  if (/out of gas|gas required exceeds/i.test(raw)) {
    return 'The transaction ran out of gas (you may have many ROI streams). Try again — gas headroom was increased.';
  }
  return raw || 'Transaction reverted for an unknown reason.';
}

// Estimate gas for a contract method and return a limit with headroom, so variable-cost
// loops (e.g. growing ROI-stream settlement) don't run out of gas on a tight estimate.
// Throws the original revert (decodable by decodeContractError) if the call would revert.
async function gasLimitWithBuffer(boundContract, method, args, bufferPct) {
  const est = await boundContract.estimateGas[method](...args);
  const pct = bufferPct || 30;
  return est.mul(100 + pct).div(100);
}

window.decodeContractError = decodeContractError;
window.gasLimitWithBuffer   = gasLimitWithBuffer;

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
  _evLogCache.clear();  // event logs only change after a confirmed tx
  _constCache.clear();  // rate tables can change via an owner setter — re-read after any tx
}

function _resetTabLoaded() {
  _tabLoaded.clear();
  _evLogCache.clear();
  _constCache.clear();
}

// ── SESSION-CONSTANT CACHE ──
// For on-chain reads that don't change during normal viewing (contract owner,
// platform token, commission-rate tables). Stores the in-flight promise so
// concurrent callers coalesce onto ONE RPC call and later callers reuse the
// resolved value. Cleared on wallet/contract change (_resetTabLoaded) and after
// any confirmed tx (invalidateTabs), so a stale value can never mask a write.
const _constCache = new Map();

function cachedConstant(name, fetchFn) {
  if (_constCache.has(name)) return _constCache.get(name);
  const p = Promise.resolve().then(fetchFn).catch(err => { _constCache.delete(name); throw err; });
  _constCache.set(name, p);
  return p;
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

// ── CACHED BLOCK NUMBER ──
// provider.getBlockNumber() is called by every log scan and several pollers. Polygon
// produces a block ~every 2s, so caching the value for a few seconds avoids dozens of
// redundant eth_blockNumber RPCs per tab visit without ever returning a stale-enough
// number to miss events (the next scan still covers any gap).
let _blockNumCache = { value: 0, ts: 0 };
async function getCachedBlockNumber(prov) {
  const p = prov || (typeof provider !== 'undefined' ? provider : null);
  if (!p) return 0;
  if (Date.now() - _blockNumCache.ts < 8000 && _blockNumCache.value > 0) return _blockNumCache.value;
  const bn = await p.getBlockNumber();
  _blockNumCache = { value: bn, ts: Date.now() };
  return bn;
}
window.getCachedBlockNumber = getCachedBlockNumber;

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
    ? (await getCachedBlockNumber(contractInstance.provider).catch(() => fromBlock + batchSize))
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
    ? (await getCachedBlockNumber().catch(() => fromBlock + batchSize))
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

// ── MULTICALL3 ──────────────────────────────────────────────────────────────────
// Collapses many view reads into a single RPC request. Multicall3 is deployed at the
// same canonical address on nearly every chain (Polygon mainnet, Amoy, …). aggregate3
// allows per-call failure, so one reverting read returns `undefined` instead of
// blowing up the whole batch.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)"
];
function getMulticall(prov) {
  return new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, prov || (typeof provider !== 'undefined' ? provider : undefined));
}

// Batch many VIEW calls on ONE contract into a single RPC.
//   calls: [ [fnName, argsArray?], ... ]
// Returns an array aligned to `calls`; each entry is the decoded result — unwrapped to
// the bare value when the function has a single output (exactly like a normal ethers
// call), or `undefined` if that individual call reverted. The returned promise rejects
// only if the whole multicall request fails, so callers that relied on per-call
// `.catch(default)` should keep applying their default via `?? default`, and wrap the
// call in try/catch (or `.catch`) for the all-or-nothing transport-failure case.
async function multicallRead(contract, calls) {
  const iface = contract.interface;
  const mc = getMulticall(contract.provider);
  const res = await mc.aggregate3(calls.map(([fn, args]) => ({
    target: contract.address,
    allowFailure: true,
    callData: iface.encodeFunctionData(fn, args || []),
  })));
  return res.map((r, i) => {
    if (!r.success) return undefined;
    try {
      const decoded = iface.decodeFunctionResult(calls[i][0], r.returnData);
      return decoded.length === 1 ? decoded[0] : decoded;
    } catch (_) { return undefined; }
  });
}
