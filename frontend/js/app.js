// ── CONFIG ──
const contractAddress = CONTRACT_ADDRESS;

// Dedicated read-only RPC — bypasses the wallet relay so all view calls are fast.
// Transactions still go through the wallet signer; only eth_call goes here.
const ALCHEMY_AMOY_URL = 'https://polygon-amoy.g.alchemy.com/v2/_0p-lkCP0DWUV-Z-BQYCL';

// Returns { total: BigNumber, entries: [] } for the connected wallet.
// Reads totalMissedCommissions and getMissedRecords from on-chain storage — view calls,
// no log queries (eth_getLogs is unreliable on Polygon Amoy and silently returns []).
async function _computeMissedWei(fromBlock = 0) {
  const zero = ethers.BigNumber.from(0);
  const [total, records] = await Promise.all([
    contract.totalMissedCommissions(walletAddress).catch(() => zero),
    contract.getMissedRecords(walletAddress).catch(() => []),
  ]);
  const entries = (records || []).map(r => ({
    from:   r.from,
    level:  Number(r.level),
    reason: Number(r.reason),
    amount: r.amount,
    _ts:    r.ts.toNumber ? r.ts.toNumber() : Number(r.ts),
    received: zero,
    blockNumber: null,
    transactionHash: null,
  }));
  return { total, entries };
}

async function checkMissedCommissions() {
  if (!contract || !walletAddress) return;
  try {
    const { total: missedWei } = await _computeMissedWei();
    if (missedWei.isZero()) return;

    const totalETH   = parseFloat(ethers.utils.formatEther(missedWei));
    const usdtTotal  = ethToUSDT(totalETH).toLocaleString(undefined, { maximumFractionDigits: 2 });

    document.getElementById('missedCommText').innerHTML =
      `You missed referral commissions totalling <strong style="color:#f87171;">${usdtTotal} USDT</strong>.<br><br>` +
      `This includes commissions that fully bypassed you because your lock had expired or you had no active lock in the invested token, and commissions where your 5× cap filled mid-payment and the excess spilled to the next eligible upline.<br><br>` +
      `<strong>To receive future commissions:</strong> ensure you have an active (locked) investment in the same token your referrals are investing in, with remaining cap. Restake before your lock expires to avoid gaps.`;

    document.getElementById('missedCommAlert').style.display = 'flex';
  } catch(e) { console.warn('checkMissedCommissions:', e); }
}

function dismissMissedAlert() {
  document.getElementById('missedCommAlert').style.display = 'none';
}

// ── INVEST DROPDOWN ──
const investTokenData = new Map(); // addr.toLowerCase() → { symbol, name, logo, addr }

function toggleInvestDropdown() {
  const menu = document.getElementById('investDropdownMenu');
  const arrow = document.getElementById('investDropdownArrow');
  if (!menu) return;
  const isOpen = menu.style.display !== 'none';
  menu.style.display = isOpen ? 'none' : 'block';
  arrow.textContent = isOpen ? '▾' : '▴';
}

function syncInvestDropdownTrigger(addr) {
  _resetInvestBtn();
  const sel = document.getElementById('investDropdownSelected');
  const arrow = document.getElementById('investDropdownArrow');
  if (!sel) return;
  if (!addr) {
    sel.innerHTML = `<span style="color:var(--muted);font-size:13px;">— Select a token —</span>`;
    return;
  }
  const d = investTokenData.get(addr.toLowerCase());
  if (!d) return;
  sel.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      ${d.logo ? `<img src="${d.logo}" style="width:28px;height:28px;object-fit:contain;border-radius:6px;border:1px solid var(--border);flex-shrink:0;">` : `<div style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;">⬡</div>`}
      <div>
        <div style="color:var(--cream);font-size:13px;font-family:var(--font-mono);">${d.symbol} — ${d.name}</div>
        <div style="color:var(--gold);font-size:10px;font-family:var(--font-mono);word-break:break-all;">${d.addr}</div>
      </div>
    </div>`;
  if (arrow) arrow.textContent = '▾';
}

// close dropdown when clicking outside
document.addEventListener('click', function(e) {
  if (!e.target.closest('#investDropdownWrap')) {
    const menu = document.getElementById('investDropdownMenu');
    const arrow = document.getElementById('investDropdownArrow');
    if (menu && menu.style.display !== 'none') {
      menu.style.display = 'none';
      if (arrow) arrow.textContent = '▾';
    }
  }
});

// ── WALLET ──

// Disable MetaMask's built-in auto-reload on network/chain change.
if (window.ethereum) {
  window.ethereum.autoRefreshOnNetworkChange = false;
}

function waitForEthereum(timeout = 3000) {
  return new Promise((resolve) => {
    if (window.ethereum) {
      window.ethereum.autoRefreshOnNetworkChange = false;
      resolve(window.ethereum);
      return;
    }
    const interval = setInterval(() => {
      if (window.ethereum) {
        clearInterval(interval);
        window.ethereum.autoRefreshOnNetworkChange = false;
        resolve(window.ethereum);
      }
    }, 100);
    setTimeout(() => { clearInterval(interval); resolve(null); }, timeout);
  });
}

const REQUIRED_CHAIN_ID = 80002; // Polygon Amoy

async function ensureCorrectNetwork(eth) {
  const chainId = parseInt(await eth.request({ method: 'eth_chainId' }), 16);
  if (chainId === REQUIRED_CHAIN_ID) return true;
  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x13882' }]  // 80002
    });
    return true;
  } catch(switchErr) {
    if (switchErr.code === 4902) {
      try {
        await eth.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0x13882',
            chainName: 'Polygon Amoy',
            nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
            rpcUrls: ['https://rpc-amoy.polygon.technology']
          }]
        });
        return true;
      } catch(_) {}
    }
    toast('Please switch MetaMask to Polygon Amoy (chain ID 80002).', 'error');
    return false;
  }
}

let _ethListenersRegistered = false;
function registerEthereumListeners(eth) {
  if (_ethListenersRegistered) return;
  _ethListenersRegistered = true;

  eth.on('accountsChanged', (accounts) => {
    if (accounts.length === 0) return;
    if (accounts[0].toLowerCase() !== (App.walletAddress || '').toLowerCase()) {
      disconnectWallet();
      toast('MetaMask account changed. Please reconnect.', 'info');
    }
  });

  eth.on('chainChanged', (chainIdHex) => {
    updateNetPill(chainIdHex);
    if (parseInt(chainIdHex, 16) !== REQUIRED_CHAIN_ID) {
      toast('Wrong network — please switch back to Polygon Amoy.', 'error');
      return;
    }
    if (_txInFlight === 0 && App.walletAddress) {
      App.walletProvider = new ethers.providers.Web3Provider(eth);
      App.signer         = App.walletProvider.getSigner();
      App.provider       = new ethers.providers.StaticJsonRpcProvider(ALCHEMY_AMOY_URL, { chainId: 80002, name: 'polygon-amoy' });
      if (contractAddress) {
        App.contract = new ethers.Contract(contractAddress, CONTRACT_ABI, App.signer);
        _stopChainListeners();
        _startChainListeners();
      }
    }
  });
}

async function connectWallet() {
  const eth = await waitForEthereum();
  if (!eth) { toast('MetaMask not detected. Please install it.', 'error'); return; }
  const landingBtn = document.getElementById('landingBtnLabel');
  if (landingBtn) landingBtn.textContent = 'Connecting...';
  try {
    const onCorrectNetwork = await ensureCorrectNetwork(eth);
    if (!onCorrectNetwork) {
      if (landingBtn) landingBtn.textContent = 'Connect Wallet';
      return;
    }

    eth.autoRefreshOnNetworkChange = false;
    App.walletProvider = new ethers.providers.Web3Provider(eth);
    if (App.wasDisconnected || sessionStorage.getItem('hordex_force_prompt') === '1') {
      try {
        await App.walletProvider.send("wallet_requestPermissions", [{ eth_accounts: {} }]);
      } catch (_) {
        await App.walletProvider.send("eth_requestAccounts", []);
      }
      App.wasDisconnected = false;
      sessionStorage.removeItem('hordex_force_prompt');
    } else {
      await App.walletProvider.send("eth_requestAccounts", []);
    }
    App.signer        = App.walletProvider.getSigner();
    App.walletAddress = await App.signer.getAddress();
    App.provider      = new ethers.providers.StaticJsonRpcProvider(ALCHEMY_AMOY_URL, { chainId: 80002, name: 'polygon-amoy' });

    document.getElementById('connectBtn').textContent = App.walletAddress.slice(0,6) + '...' + App.walletAddress.slice(-4);
    document.getElementById('connectBtn').classList.add('connected');
    document.getElementById('walletAddr').textContent = App.walletAddress;
    document.getElementById('walletBar').classList.add('show');
    document.getElementById('walletDropdownAddr').textContent = App.walletAddress;
    updateNetPill(await eth.request({ method: 'eth_chainId' }));

    localStorage.setItem('hordex_wallet', App.walletAddress);
    toast('Wallet connected: ' + App.walletAddress.slice(0,8) + '...', 'success');

    if (contractAddress) await initContract();

    // Derive label encryption key as part of login — blocking so labels are
    // ready the moment the dashboard renders. sessionStorage caches the
    // signature so page-refreshes within the same browser session skip the prompt.
    if (typeof _initLabelKey === 'function') await _initLabelKey().catch(e => { console.warn('[HORDEX] label key init failed:', e); });

    await checkRegistration();

    registerEthereumListeners(eth);
  } catch(e) {
    const landingBtn = document.getElementById('landingBtnLabel');
    if (landingBtn) landingBtn.textContent = 'Connect Wallet';
    toast('Connection failed: ' + e.message, 'error');
  }
}

// Initialise package grid on load
document.addEventListener('DOMContentLoaded', () => {
  renderPkgGrid();
});

// Populate contract address footer immediately (no wallet needed)
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('lcf-contract-addr');
  if (el && typeof CONTRACT_ADDRESS !== 'undefined') el.textContent = CONTRACT_ADDRESS;
  const footerLink = document.getElementById('footerContractLink');
  if (footerLink && typeof CONTRACT_ADDRESS !== 'undefined') {
    footerLink.href = `https://amoy.polygonscan.com/address/${CONTRACT_ADDRESS}`;
    footerLink.textContent = CONTRACT_ADDRESS;
  }
});

// ── Brochures & Links ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadBrochures);

async function loadBrochures() {
  const grid = document.getElementById('bro-grid');
  if (!grid) return;
  const basePath = _brochureBasePath();
  try {
    const res = await fetch(basePath + 'manifest.json');
    if (!res.ok) throw new Error('no manifest');
    const files = await res.json();
    if (!Array.isArray(files) || files.length === 0) {
      grid.innerHTML = '<div class="bro-empty">No documents published yet.</div>';
      return;
    }
    grid.innerHTML = '';
    for (const filename of files) {
      if (typeof filename !== 'string') continue;
      const ext = filename.split('.').pop().toLowerCase();
      if (ext === 'pdf') {
        grid.appendChild(_makePdfCard(basePath, filename));
      } else if (ext === 'txt') {
        const card = _makeLinkCardSkeleton(filename);
        grid.appendChild(card);
        _hydrateLinkCard(card, filename, basePath);
      }
    }
  } catch (_) {
    grid.innerHTML = '<div class="bro-empty">Documents will be available soon.</div>';
  }
}

function _brochureBasePath() {
  const script = Array.from(document.scripts).find(s => s.src && /\/frontend\/js\/app(?:\.js|\.js\?|\/)/.test(s.src));
  if (!script) return 'frontend/brochures/';
  try {
    const url = new URL(script.src, location.href);
    const path = url.pathname.replace(/\/js\/app\.js$/, '/brochures/');
    return path.endsWith('/') ? path : path + '/';
  } catch (e) {
    return 'frontend/brochures/';
  }
}

function _broFileTitle(filename) {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function _makePdfCard(basePath, filename) {
  const a = document.createElement('a');
  a.className = 'bro-card bro-pdf';
  a.href = basePath + filename;
  a.setAttribute('download', '');
  a.innerHTML =
    '<div class="bro-pdf-icon">📄</div>' +
    '<div class="bro-info">' +
      '<div class="bro-title">' + _broFileTitle(filename) + '</div>' +
      '<div class="bro-badge">PDF · Download</div>' +
    '</div>';
  return a;
}

function _makeLinkCardSkeleton(filename) {
  const a = document.createElement('a');
  a.className = 'bro-card bro-link bro-link-loading';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.innerHTML =
    '<div class="bro-thumb"><div class="bro-thumb-icon">🔗</div></div>' +
    '<div class="bro-info">' +
      '<div class="bro-title" style="color:var(--muted);">' + _broFileTitle(filename) + '</div>' +
    '</div>';
  return a;
}

function _broYouTubeId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function _broGDriveId(url) {
  const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

async function _hydrateLinkCard(card, filename, basePath) {
  try {
    const txtRes = await fetch(basePath + filename);
    if (!txtRes.ok) throw new Error('txt missing');
    const url = (await txtRes.text()).split('\n')[0].trim();
    if (!url || !url.startsWith('http')) throw new Error('bad url');
    card.href = url;

    let domain = url;
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}

    const thumbEl = card.querySelector('.bro-thumb');
    const titleEl = card.querySelector('.bro-title');

    const gdId = _broGDriveId(url);
    const ytId = _broYouTubeId(url);
    if (gdId) {
      thumbEl.style.backgroundImage = 'url(https://drive.google.com/thumbnail?id=' + gdId + '&sz=w400)';
      thumbEl.innerHTML = '';
      try {
        const ml = await fetch('https://api.microlink.io/?url=' + encodeURIComponent(url));
        const { status, data } = await ml.json();
        if (status === 'success' && data.title) {
          titleEl.textContent = data.title.replace(/\s*[-–|]\s*google drive\s*$/i, '').trim();
        } else { titleEl.textContent = 'Google Drive Document'; }
      } catch (_) { titleEl.textContent = 'Google Drive Document'; }
      titleEl.style.color = '';
    } else if (ytId) {
      thumbEl.style.backgroundImage = 'url(https://img.youtube.com/vi/' + ytId + '/hqdefault.jpg)';
      thumbEl.innerHTML = '';
      try {
        const oe = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json');
        const { title } = await oe.json();
        if (title) { titleEl.textContent = title; titleEl.style.color = ''; }
      } catch (_) {}
    } else {
      try {
        const ml = await fetch('https://api.microlink.io/?url=' + encodeURIComponent(url));
        const { status, data } = await ml.json();
        if (status !== 'success') throw new Error('ml failed');
        const imgUrl = data.image?.url || data.logo?.url || '';
        if (imgUrl) { thumbEl.style.backgroundImage = 'url(' + imgUrl + ')'; thumbEl.innerHTML = ''; }
        if (data.title) { titleEl.textContent = data.title; titleEl.style.color = ''; }
      } catch (_) {
        titleEl.style.color = '';
      }
    }

    if (!card.querySelector('.bro-domain')) {
      titleEl.insertAdjacentHTML('afterend', '<div class="bro-domain">' + domain + ' ↗</div>');
    }
    card.classList.remove('bro-link-loading');
  } catch (_) {
    card.classList.remove('bro-link-loading');
  }
}

// Close mobile nav on ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMobileNav();
    document.getElementById('walletDropdown').classList.remove('open');
    if (typeof closeRefPopup === 'function') closeRefPopup();
  }
});

// Redraw stat graph on resize
let _resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    const panel = document.getElementById('dashGraphPanel');
    if (panel && panel.style.display !== 'none') {
      const type = panel.dataset.type;
      if (type) {
        const opts   = GRAPH_OPTS[type];
        const series = buildSeries(type, _graphCache);
        const canvas = document.getElementById('dashGraphCanvas');
        drawLineGraph(canvas, series, opts.color, opts.unit);
      }
    }
  }, 200);
});

// ── LANDING MENU ──
function toggleLandingMenu() {
  document.getElementById('landingMenuDropdown').classList.toggle('lnd-open');
}
function closeLandingMenu() {
  document.getElementById('landingMenuDropdown').classList.remove('lnd-open');
}
function scrollToLandingSection(id) {
  closeLandingMenu();
  const el        = document.getElementById(id);
  const container = document.getElementById('landingMainScroll');
  if (!el || !container) return;
  const elRect        = el.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  container.scrollBy({ top: elRect.top - containerRect.top - 20, behavior: 'smooth' });
}
function toggleFaq(btn) {
  const item = btn.closest('.lnd-faq-item');
  if (!item) return;
  const isOpen = item.classList.contains('open');
  item.closest('.landing-section')?.querySelectorAll('.lnd-faq-item.open').forEach(el => el.classList.remove('open'));
  if (!isOpen) item.classList.add('open');
}
// Close landing dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dd = document.getElementById('landingMenuDropdown');
  if (!dd) return;
  if (!dd.classList.contains('lnd-open')) return;
  if (!e.target.closest('.landing-topbar-left')) closeLandingMenu();
});

// ── LANDING PAGE STATS ──
let _landingStatsPollInterval = null;

function _computeWealthLanding(params) {
  if (!params || !params.locks) return 0;
  const now = Math.floor(Date.now() / 1000);
  const refEarningsETH = parseFloat(ethers.utils.formatEther(params.refEarnings));
  const tokenPriceEth  = parseFloat(ethers.utils.formatEther(params.platformTokenPriceEth));
  const defaultLockDur = params.lpLockDuration ? Number(params.lpLockDuration) : 7776000;
  let totalInvestedETH = 0, totalCurrentLP = 0, stakingETH = 0;
  for (const lock of params.locks) {
    const ethInv = parseFloat(ethers.utils.formatEther(lock.ethInvested));
    totalInvestedETH += ethInv;
    if (!lock.removed) {
      const lpAmt      = parseFloat(ethers.utils.formatEther(lock.lpAmount));
      const totalLPSup = parseFloat(ethers.utils.formatEther(lock.totalLPSupply));
      const resETH     = parseFloat(ethers.utils.formatEther(lock.reserveETH));
      if (totalLPSup > 0 && lpAmt > 0) totalCurrentLP += (lpAmt / totalLPSup) * resETH * 2;
      const lockedAt   = Number(lock.lockedAt);
      const unlockTime = Number(lock.unlockTime);
      const lockDur    = unlockTime > lockedAt ? unlockTime - lockedAt : defaultLockDur;
      const elapsed    = Math.min(lockDur, Math.max(0, now - lockedAt));
      const ratePPM    = Number(lock.rewardRatePPM);
      if (ratePPM > 0 && lockDur > 0) stakingETH += ethInv * ratePPM * elapsed / (1_000_000 * lockDur);
      const tokAcc = parseFloat(ethers.utils.formatEther(lock.tokensAccumulated));
      if (tokAcc > 0 && tokenPriceEth > 0) stakingETH += tokAcc * tokenPriceEth;
    }
  }
  const lpFees = Math.max(0, totalCurrentLP - totalInvestedETH);
  return refEarningsETH + lpFees + totalInvestedETH + stakingETH;
}
const _LANDING_STATS_CACHE_KEY = 'hordex_landing_stats_v2';

function _applyLandingStats(stats) {
  const $ = id => document.getElementById(id);
  if ($('ls-total-users'))     $('ls-total-users').textContent     = stats.totalUsers;
  if ($('ls-wealth-built'))    $('ls-wealth-built').textContent    = stats.wealthBuilt;
  if ($('ls-total-funding'))   $('ls-total-funding').textContent   = stats.totalFunding;
  if ($('ls-staking-rewards')) $('ls-staking-rewards').textContent = stats.stakingRewards;
}

async function loadLandingStats() {
  if (typeof CONTRACT_ADDRESS === 'undefined' || typeof CONTRACT_ABI === 'undefined') return;

  // ── Show cached stats instantly (< 1 ms) ──
  try {
    const cached = JSON.parse(localStorage.getItem(_LANDING_STATS_CACHE_KEY) || 'null');
    if (cached) _applyLandingStats(cached);
  } catch(_) {}

  const readProvider = new ethers.providers.StaticJsonRpcProvider(ALCHEMY_AMOY_URL, { chainId: 80002, name: 'polygon-amoy' });
  const readContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, readProvider);

  // ── Fast path: single view call — shows 3 stats with no event scanning ──
  try {
    const platformStats = await readContract.getPlatformStats();
    const totalUsers    = Number(platformStats._totalUsers);
    const totalETH      = parseFloat(ethers.utils.formatEther(platformStats._totalEthInvested));
    const stakingETH    = parseFloat(ethers.utils.formatEther(platformStats._totalStakingRewardsPaidETH));

    const partial = {
      totalUsers:     totalUsers.toLocaleString(),
      wealthBuilt:    '—',
      totalFunding:   totalETH > 0   ? ethToUSDT(totalETH).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' USDT' : '0 USDT',
      stakingRewards: stakingETH > 0 ? ethToUSDT(stakingETH).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' USDT' : '0 USDT',
    };
    _applyLandingStats(partial);

    const lcfEl = document.getElementById('lcf-contract-addr');
    if (lcfEl && typeof CONTRACT_ADDRESS !== 'undefined') lcfEl.textContent = CONTRACT_ADDRESS;

    try { localStorage.setItem(_LANDING_STATS_CACHE_KEY, JSON.stringify(partial)); } catch(_) {}

    // ── Slow path: wealth built = sum of all users' current wealth (best-effort) ──
    try {
      const allUsers = await readContract.getAllRegisteredUsers();
      const wealthParams = await Promise.all(
        allUsers.map(a => readContract.getWealthParams(a).catch(() => null))
      );
      let totalWealthETH = 0;
      for (const p of wealthParams) totalWealthETH += _computeWealthLanding(p);
      const full = {
        ...partial,
        wealthBuilt: totalWealthETH > 0
          ? ethToUSDT(totalWealthETH).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' USDT'
          : '0 USDT',
      };
      _applyLandingStats(full);
      try { localStorage.setItem(_LANDING_STATS_CACHE_KEY, JSON.stringify(full)); } catch(_) {}
    } catch (_) { /* wealth computation failed — keep showing '—' */ }

  } catch (_) { /* getPlatformStats failed — cached data already shown above */ }

  // Poll every 30 s while landing overlay is visible — avoids overlapping scans
  if (!_landingStatsPollInterval) {
    _landingStatsPollInterval = setInterval(() => {
      const overlay = document.getElementById('landingOverlay');
      if (!overlay || overlay.style.display === 'none' || overlay.classList.contains('hidden')) {
        clearInterval(_landingStatsPollInterval);
        _landingStatsPollInterval = null;
        return;
      }
      loadLandingStats();
    }, 30000);
  }
}

// Auto-connect on load — restores session on every page reload without landing screen
window.addEventListener('load', async () => {
  const eth = await waitForEthereum(2000);
  if (!eth) {
    document.getElementById('connectBtn').textContent = 'METAMASK NOT FOUND';
    document.getElementById('connectBtn').style.borderColor = 'var(--danger)';
    document.getElementById('connectBtn').style.color = 'var(--danger)';
    return;
  }

  loadLandingStats(); // fire-and-forget

  history.replaceState(null, '', window.location.pathname);

  if (sessionStorage.getItem('hordex_logged_out') === '1') {
    sessionStorage.removeItem('hordex_logged_out');
    return;
  }

  const savedWallet = localStorage.getItem('hordex_wallet');
  if (!savedWallet) return;

  // ── Step 1: Optimistic restore ──
  App.walletAddress = savedWallet;
  const shortAddr = savedWallet.slice(0,6) + '...' + savedWallet.slice(-4);
  document.getElementById('connectBtn').textContent = shortAddr;
  document.getElementById('connectBtn').classList.add('connected');
  document.getElementById('walletAddr').textContent = savedWallet;
  document.getElementById('walletDropdownAddr').textContent = savedWallet;
  document.getElementById('walletBar').classList.add('show');
  const _overlay = document.getElementById('landingOverlay');
  _overlay.classList.add('hidden');
  setTimeout(() => { _overlay.style.display = 'none'; }, 500);
  document.querySelector('.tabs').classList.add('visible');
  document.querySelector('main').classList.add('visible');

  // ── Step 2: Background verification ──
  try {
    eth.autoRefreshOnNetworkChange = false;
    App.walletProvider = new ethers.providers.Web3Provider(eth);
    App.provider       = new ethers.providers.StaticJsonRpcProvider(ALCHEMY_AMOY_URL, { chainId: 80002, name: 'polygon-amoy' });
    const accounts = await eth.request({ method: 'eth_accounts' });

    if (!accounts || accounts.length === 0 ||
        accounts[0].toLowerCase() !== savedWallet.toLowerCase()) {
      App.walletAddress = null;
      App.signer = null;
      document.getElementById('connectBtn').textContent = 'RECONNECT';
      document.getElementById('connectBtn').classList.remove('connected');
      toast('Wallet session expired — please reconnect.', 'info');
      return;
    }

    App.signer = App.walletProvider.getSigner();
    updateNetPill(await eth.request({ method: 'eth_chainId' }));

    if (contractAddress) await initContract();

    // Same as connectWallet: derive label key before dashboard renders.
    // On page-refresh this resolves instantly from sessionStorage (no prompt).
    if (typeof _initLabelKey === 'function') await _initLabelKey().catch(e => { console.warn('[HORDEX] label key init failed (restore):', e); });

    await checkRegistration();

    registerEthereumListeners(eth);
  } catch(e) {
    console.warn('Background wallet verify failed:', e.message);
  }
});

function handleWalletBtn() {
  if (App.walletAddress) {
    document.getElementById('walletDropdown').classList.toggle('open');
  } else {
    connectWallet();
  }
}

// ── SIDEBAR / NAV ──

// Restore sidebar collapsed state on load
(function() {
  if (localStorage.getItem('sidebarCollapsed') === '1') {
    document.body.classList.add('sidebar-collapsed');
  }
})();

function handleSidebarBtn() {
  if (window.innerWidth > 768) {
    toggleSidebar();
  } else {
    const nav = document.getElementById('mobileNav');
    if (nav.classList.contains('open')) closeMobileNav();
    else openMobileNav();
  }
}

function toggleSidebar() {
  document.body.classList.toggle('sidebar-collapsed');
  localStorage.setItem('sidebarCollapsed', document.body.classList.contains('sidebar-collapsed') ? '1' : '0');
}

function openMobileNav() {
  document.getElementById('mobileNav').classList.add('open');
  document.getElementById('mobileNavOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  const addrEl = document.getElementById('mobileNavAddr');
  if (App.walletAddress) {
    addrEl.textContent = App.walletAddress;
    addrEl.style.display = 'block';
  } else {
    addrEl.style.display = 'none';
  }
}

function closeMobileNav() {
  document.getElementById('mobileNav').classList.remove('open');
  document.getElementById('mobileNavOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

function mobileNavSwitch(name) {
  if (window.innerWidth <= 768) closeMobileNav();
  switchTabByName(name);
}

function disconnectWallet() {
  _stopChainListeners();
  App.walletAddress  = null;
  App.provider       = null;
  App.walletProvider = null;
  App.signer         = null;
  App.contract       = null;
  App.wasDisconnected = true;
  localStorage.removeItem('hordex_wallet');
  _userSelectedToken = false;
  sessionStorage.setItem('hordex_logged_out', '1');
  sessionStorage.setItem('hordex_force_prompt', '1');
  document.getElementById('landingBtnLabel').textContent = 'Connect Wallet';
  history.replaceState(null, '', window.location.pathname);

  const btn = document.getElementById('connectBtn');
  btn.textContent = 'CONNECT WALLET';
  btn.classList.remove('connected');

  document.getElementById('walletBar').classList.remove('show');
  document.getElementById('walletDropdown').classList.remove('open');
  document.getElementById('ownerTab').style.display = 'none';
  document.getElementById('mobileOwnerTab').style.display = 'none';
  _resetTabLoaded();

  document.getElementById('landingConnectScreen').style.display = 'block';
  document.getElementById('landingNewUserScreen').style.display = 'none';
  document.getElementById('newUserBtnLabel').textContent = 'YES, REGISTER ME';
  document.getElementById('newUserRegisterBtn').disabled = false;
  const overlay = document.getElementById('landingOverlay');
  overlay.style.display = 'flex';
  setTimeout(() => overlay.classList.remove('hidden'), 10);

  document.querySelector('.tabs').classList.remove('visible');
  document.querySelector('main').classList.remove('visible');

  toast('Wallet disconnected.', 'info');
}

// close wallet dropdown when clicking outside
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('walletDropdownWrap');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('walletDropdown').classList.remove('open');
  }
});

async function initContract() {
  App.contract = new ethers.Contract(contractAddress, CONTRACT_ABI, App.provider);
  await checkOwner();
}

let _isOwner = false;
async function checkOwner() {
  try {
    const ownerAddr = await App.contract.owner();
    _isOwner = ownerAddr.toLowerCase() === App.walletAddress.toLowerCase();
    App.isOwner = _isOwner;
    document.getElementById('ownerTab').style.display        = _isOwner ? 'block' : 'none';
    document.getElementById('mobileOwnerTab').style.display  = _isOwner ? 'flex'  : 'none';
  } catch(e) {
    // silently ignore — owner tab stays hidden
  }
}

let _pendingReferrer = null;

// Runs ~4s after login (delayed so dashboard's RPC calls get clear bandwidth first).
// Shows a toast when LP positions are unlocked or still locked.
async function _onLoginCheckInvestments() {
  if (!App.contract || !App.walletAddress) return;
  try {
    const [lpLocks, latestBlock] = await Promise.all([
      App.contract.getUserLPLocks(App.walletAddress),
      App.provider.getBlock('latest').catch(() => null),
    ]);
    if (!lpLocks.length) return;

    const blockNow = latestBlock ? latestBlock.timestamp : Math.floor(Date.now() / 1000);
    const wallNow  = Math.floor(Date.now() / 1000);

    let effectiveNow = blockNow;
    try {
      const _rawEff = localStorage.getItem('hordex_eff_time') || sessionStorage.getItem('hordex_eff_time');
      const saved = JSON.parse(_rawEff || 'null');
      if (saved && saved.blockNow === blockNow) {
        effectiveNow = Math.max(blockNow, saved.effectiveNow + Math.max(0, wallNow - saved.wallNow));
      }
    } catch(_) {}

    const active   = lpLocks.filter(l => !l.claimed && !l.removed);
    const unlocked = active.filter(l => Number(l.unlockTime) <= effectiveNow);
    const locked   = active.filter(l => Number(l.unlockTime)  > effectiveNow);

    if (unlocked.length > 0) {
      toast(
        unlocked.length === 1
          ? '1 LP position is unlocked — go to INVESTMENTS to remove or stake.'
          : `${unlocked.length} LP positions are unlocked — go to INVESTMENTS.`,
        'success'
      );
    } else if (locked.length > 0) {
      const soonest  = locked.reduce((mn, l) => Math.min(mn, Number(l.unlockTime)), Infinity);
      const secsLeft = Math.max(0, soonest - effectiveNow);
      const m = Math.floor(secsLeft / 60), s = secsLeft % 60;
      toast(
        `${locked.length} active LP lock${locked.length > 1 ? 's' : ''}. ` +
        `Next unlock in ${m > 0 ? m + 'm ' : ''}${s}s.`,
        'info'
      );
    }
  } catch(e) {
    console.warn('_onLoginCheckInvestments:', e);
  }
}

async function checkRegistration() {
  if (!App.contract) { revealDashboard(); return; }
  try {
    const user = await App.contract.users(App.walletAddress);
    if (user.isRegistered) {
      revealDashboard();
      setTimeout(() => {
        switchTabByName('dashboard');
        loadInvestTokens();
        _prefetchAllTabs();
        // Delay the investments check so dashboard's RPC calls get clear bandwidth first
        setTimeout(_onLoginCheckInvestments, 4000);
      }, 600);
    } else {
      const params = new URLSearchParams(window.location.search);
      const refParam = params.get('ref');
      let referrerAddr = null;
      let referrerLabel = '';

      if (refParam && ethers.utils.isAddress(refParam)) {
        try {
          const refUser = await App.contract.users(refParam);
          if (refUser.isRegistered) {
            referrerAddr = refParam;
            referrerLabel = refParam;
          }
        } catch(_) {}
      }

      if (!referrerAddr) {
        referrerAddr = await App.contract.owner();
        referrerLabel = referrerAddr + '  (Platform Admin)';
        document.getElementById('newUserPromptText').textContent = 'Register under the platform admin, or enter a referrer below.';
        // No referral link — show the manual address entry section
        document.getElementById('customReferrerSection').style.display = 'block';
        document.getElementById('customReferrerInput').value = '';
        document.getElementById('customReferrerStatus').textContent = '';
      } else {
        document.getElementById('newUserPromptText').textContent = 'Register under this referrer?';
        document.getElementById('customReferrerSection').style.display = 'none';
      }

      _pendingReferrer = referrerAddr;
      document.getElementById('newUserReferrerAddr').textContent = referrerLabel;

      const overlay = document.getElementById('landingOverlay');
      overlay.style.display = 'flex';
      overlay.classList.remove('hidden');
      document.getElementById('landingConnectScreen').style.display = 'none';
      document.getElementById('landingNewUserScreen').style.display = 'block';
    }
  } catch(e) {
    revealDashboard();
  }
}

async function registerNewUser() {
  if (!App.contract || !_pendingReferrer) return;
  const btn = document.getElementById('newUserBtnLabel');
  btn.textContent = 'Registering...';
  document.getElementById('newUserRegisterBtn').disabled = true;
  _txBegin();
  try {
    const tx = await App.contract.connect(App.signer).register(_pendingReferrer, _GAS);
    btn.textContent = 'Waiting for confirmation...';
    await tx.wait();
    _txDone();
    toast('Registered successfully! Welcome to Hordex 🎉', 'success');
    history.replaceState(null, '', window.location.pathname);
    _pendingReferrer = null;
    document.getElementById('landingConnectScreen').style.display = 'block';
    document.getElementById('landingNewUserScreen').style.display = 'none';
    document.getElementById('newUserBtnLabel').textContent = 'YES, REGISTER ME';
    document.getElementById('newUserRegisterBtn').disabled = false;
    revealDashboard();
    setTimeout(() => {
      switchTabByName('dashboard');
      loadInvestTokens();
    }, 600);
  } catch(e) {
    _txDone();
    toast('Registration failed: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
    btn.textContent = 'YES, REGISTER ME';
    document.getElementById('newUserRegisterBtn').disabled = false;
  }
}

// Live feedback as the user types in the custom referrer field.
function onCustomReferrerInput(val) {
  const statusEl = document.getElementById('customReferrerStatus');
  if (!val || val.trim() === '') {
    statusEl.textContent = '';
    statusEl.style.color = 'var(--muted)';
    return;
  }
  if (!ethers.utils.isAddress(val.trim())) {
    statusEl.textContent = 'Not a valid Ethereum address.';
    statusEl.style.color = '#f87171';
  } else {
    statusEl.textContent = 'Press USE to verify this address.';
    statusEl.style.color = 'var(--muted)';
  }
}

// Validates the entered address and updates the pending referrer if it is a registered user.
async function applyCustomReferrer() {
  const input    = document.getElementById('customReferrerInput');
  const statusEl = document.getElementById('customReferrerStatus');
  const val      = (input.value || '').trim();

  if (!ethers.utils.isAddress(val)) {
    statusEl.textContent = 'Not a valid Ethereum address.';
    statusEl.style.color = '#f87171';
    return;
  }

  statusEl.textContent = 'Checking…';
  statusEl.style.color = 'var(--muted)';

  try {
    const refUser = await App.contract.users(val);
    if (!refUser.isRegistered) {
      statusEl.textContent = 'This address is not registered on the platform.';
      statusEl.style.color = '#f87171';
      return;
    }

    _pendingReferrer = val;
    document.getElementById('newUserReferrerAddr').textContent = val;
    document.getElementById('newUserPromptText').textContent = 'Register under this referrer?';
    statusEl.textContent = 'Referrer set. Click YES, REGISTER ME to continue.';
    statusEl.style.color = '#4ade80';
  } catch(e) {
    statusEl.textContent = 'Could not verify address: ' + (e.reason || e.message);
    statusEl.style.color = '#f87171';
  }
}

function updateNetPill(chainIdHex) {
  const pill = document.getElementById('netPill');
  if (!pill) return;
  const id = parseInt(chainIdHex, 16);
  if (id === REQUIRED_CHAIN_ID) {
    pill.textContent = 'AMOY';
    pill.className = 'net-pill sepolia';
  } else {
    pill.textContent = 'WRONG NETWORK';
    pill.className = 'net-pill wrongnet';
  }
  pill.style.display = 'inline-block';
}

// ── TOKENS ──
async function loadTokens() {
  if (!requireConnected()) return;
  const list = document.getElementById('tokenList');
  list.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';
  try {
    const addrs = await App.contract.getRegisteredTokens();
    if (addrs.length === 0) { list.innerHTML = '<div class="empty-state">No tokens registered yet.</div>'; return; }
    list.innerHTML = '';
    for (const addr of addrs) {
      const t = await App.contract.getToken(addr);
      const meta = getMeta(addr);
      const div = document.createElement('div');
      div.className = 'token-item';
      div.innerHTML = `
        <div style="display:flex;align-items:center;gap:14px;flex:1;">
          ${meta.logo ? `<img src="${meta.logo}" style="width:40px;height:40px;object-fit:contain;border-radius:8px;border:1px solid var(--border);background:var(--bg);padding:3px;flex-shrink:0;"/>` : `<div style="width:40px;height:40px;border-radius:8px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">⬡</div>`}
          <div class="token-info">
            <div class="token-symbol">${t.symbol}</div>
            <div class="token-name">${t.name}</div>
            <div class="token-addr">${t.tokenAddress}</div>
            ${meta.website ? `<a href="${meta.website}" target="_blank" style="font-size:10px;color:var(--gold);margin-top:4px;display:block;text-decoration:none;">🌐 Website</a>` : ''}
            ${meta.whitepaper ? `<a href="${meta.whitepaper}" target="_blank" style="font-size:10px;color:var(--gold);margin-top:2px;display:block;text-decoration:none;">📄 Whitepaper</a>` : ''}
            ${meta.description ? `<div style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.6;max-width:400px;">${meta.description}</div>` : ''}
          </div>
        </div>
        <div class="token-badge">ACTIVE</div>
      `;
      list.appendChild(div);
    }
  } catch(e) {
    toast('Error loading tokens: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
    list.innerHTML = '<div class="empty-state">Failed to load tokens.</div>';
  }
}

// ── TABS ──
let _tabsCollapsed = false;
function toggleTabsCollapse() {
  _tabsCollapsed = !_tabsCollapsed;
  const bar  = document.getElementById('tabsBar');
  const cbar = document.getElementById('tabsCollapsedBar');
  bar.classList.toggle('nav-collapsed', _tabsCollapsed);
  cbar.classList.toggle('show', _tabsCollapsed);
}
function _syncCollapsedLabel(name) {
  const lbl = document.getElementById('tabsCollapsedLabel');
  if (lbl) lbl.textContent = name.toUpperCase();
}

function switchTab(name) {
  _syncCollapsedLabel(name);
  switchTabByName(name);
}

function switchTabByName(name) {
  if (name !== 'dashboard' && _dashCountdownInterval) {
    clearInterval(_dashCountdownInterval); _dashCountdownInterval = null;
  }
  if (name !== 'investments' && _invCountdownInterval) {
    clearInterval(_invCountdownInterval); _invCountdownInterval = null;
  }
  if (name !== 'dashboard'   && window._dashStopPoll)    window._dashStopPoll();
  if (name !== 'investments' && window._invStopPoll)     window._invStopPoll();
  if (name !== 'rewards'     && window._rwStopPoll)      window._rwStopPoll();
  if (name !== 'invest'      && window._investStopPoll)  window._investStopPoll();

  // Close any open overlays/popups on tab switch
  if (typeof closeRefPopup      === 'function') closeRefPopup();
  if (typeof closeDashEligPopup === 'function') closeDashEligPopup();
  if (typeof closeTokenDetail   === 'function') closeTokenDetail();
  if (typeof closeStakeModal    === 'function') closeStakeModal();
  if (typeof closeRemoveLPModal === 'function') closeRemoveLPModal();

  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const activeTab = document.getElementById('tab-' + name) ||
    document.querySelector(`.tab[onclick="switchTab('${name}')"]`);
  if (activeTab) activeTab.classList.add('active');
  document.getElementById('panel-' + name).classList.add('active');

  document.querySelectorAll('.mobile-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });

  if (!App.contract || !App.walletAddress) return;
  if (name === 'invest') { loadInvestTokens(); fetchEthPrice(); renderPkgGrid(); if (window._investStartPoll) window._investStartPoll(); }
  if (name === 'pool')   { fetchEthPrice(); loadPoolPanel(); }
  if (name === 'owner')  { loadOwnerStats(); ownerPopulateLiqDropdowns(); loadTokenBalances(); ownerLoadWithdrawBals(); }
  if (name === 'dashboard')   { _tabLoaded.add('dashboard');   loadDashboard();   if (window._dashStartPoll) window._dashStartPoll(); }
  if (name === 'investments') { _tabLoaded.add('investments'); loadInvestments(); if (window._invStartPoll)  window._invStartPoll();  }
  if (name === 'myinfo')    { _tabLoaded.add('myinfo');    loadMyInfo(); }
  if (name === 'history')   { _tabLoaded.add('history');   switchHistoryTab(_activeHistTab); }
  if (name === 'genealogy') { _tabLoaded.add('genealogy'); loadGenealogy(); }
  if (name === 'rewards')     { _tabLoaded.add('rewards');     loadRewards();     if (window._rwStartPoll)   window._rwStartPoll();   }
}

// ── CHAIN EVENT LISTENERS ──
// Subscribes to contract events so every device refreshes within ~1 s of any
// on-chain action — including actions taken on another device.

const _refreshDebounce = {};

function _prefetchAllTabs() {
  // Background-load tabs after login so first visit feels instant.
  // Pollers are intentionally NOT started — they only activate when the user
  // actually navigates to that tab. The _tabLoaded.has() guards below prevent
  // a redundant background fetch if the user already navigated there first.
  const ok = () => !!(contract && walletAddress);

  // Rewards (referral + staking + LP fees) — skip if user already navigated there
  setTimeout(() => {
    if (!ok() || _tabLoaded.has('rewards')) return;
    if (window.loadRewards) window.loadRewards();
  }, 3000);

  // My Info — light call, start sooner
  setTimeout(() => {
    if (!ok() || _tabLoaded.has('myinfo')) return;
    if (window.loadMyInfo) window.loadMyInfo();
  }, 5000);

  // Genealogy — tree traversal, give dashboard + rewards time to settle first
  setTimeout(() => {
    if (!ok() || _tabLoaded.has('genealogy')) return;
    if (window.loadGenealogy) window.loadGenealogy();
  }, 9000);

  // History — defer furthest to avoid RPC contention
  setTimeout(() => {
    if (!ok() || _tabLoaded.has('history')) return;
    if (window.switchHistoryTab) window.switchHistoryTab('invest');
  }, 13000);
}

function _triggerRefresh(panels, delay = 600) {
  for (const panel of panels) {
    clearTimeout(_refreshDebounce[panel]);
    _refreshDebounce[panel] = setTimeout(() => {
      delete _refreshDebounce[panel];
      // Bust event log + graph caches so on-chain events from other wallets show up immediately
      if (typeof _evLogCache !== 'undefined') _evLogCache.clear();
      if (typeof _graphCache !== 'undefined') _graphCache = null;
      _doRefresh(panel);
    }, delay);
  }
}

function _doRefresh(panel) {
  switch (panel) {
    case 'dashboard':
      if (window.loadDashboard)   window.loadDashboard(true);   break;
    case 'investments':
      if (window.loadInvestments) window.loadInvestments();      break;
    case 'rewards-ref':
      if (window.loadRwReferral)  window.loadRwReferral();       break;
    case 'rewards-staking':
      if (window.loadRwStaking)   window.loadRwStaking(true);
      if (window.loadRwLPFees)    window.loadRwLPFees(true);     break;
    case 'history-rewards':
      if (_activeHistTab === 'rewards' && window.loadRewardHistory) window.loadRewardHistory(); break;
  }
}

let _chainListenersActive = false;
let _listenedContract     = null;

function _startChainListeners() {
  _stopChainListeners(); // always tear down before re-subscribing
  if (!contract || !walletAddress) return;

  _listenedContract     = contract;
  _chainListenersActive = true;
  const addr = walletAddress;

  try {
    // ── User's own on-chain actions ──────────────────────────────────────
    contract.on(contract.filters.Invested(addr), () =>
      _triggerRefresh(['dashboard', 'investments']));

    contract.on(contract.filters.LPClaimed(addr), () =>
      _triggerRefresh(['dashboard', 'investments', 'rewards-staking']));

    contract.on(contract.filters.LPRemoved(addr), () =>
      _triggerRefresh(['dashboard', 'investments', 'rewards-staking']));

    contract.on(contract.filters.LPRestaked(addr), () =>
      _triggerRefresh(['dashboard', 'investments', 'rewards-staking']));

    contract.on(contract.filters.StakingRewardClaimed(addr), () =>
      _triggerRefresh(['rewards-staking', 'history-rewards']));

    // ── Commission received — fires on ANY device when a referral invests ──
    // This is the core cross-device sync event.
    contract.on(contract.filters.CommissionPaid(addr),
      (_recipient, _from, amount, level, ev) => {
        try {
          const eth  = parseFloat(ethers.utils.formatEther(amount));
          const usdt = ethToUSDT(eth);
          toast(`+${usdt.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT commission · L${Number(level)}`, 'success');
        } catch (_) {}
        // If rewards tab is already rendered, do a lightweight row append instead of full reload
        if (_tabLoaded.has('rewards') && window._rwAppendCommission) {
          window._rwAppendCommission(ev, _from, amount, level);
        } else {
          _triggerRefresh(['rewards-ref']);
        }
        _triggerRefresh(['dashboard']);
      });

    // ── Any investment on the platform ───────────────────────────────────
    // A referral investing changes active-referral counts and eligibility.
    // Use a longer delay so the commission cascade has time to land first.
    contract.on(contract.filters.Invested(), () =>
      _triggerRefresh(['dashboard'], 2000));

    // ── New token registered by owner ─────────────────────────────────────
    // Reload the invest token list so the new token appears immediately.
    contract.on(contract.filters.TokenRegistered(), () => {
      if (_tabLoaded.has('invest') && window.loadInvestTokens) {
        window.loadInvestTokens();
      }
    });

  } catch (e) {
    console.warn('_startChainListeners:', e);
    _chainListenersActive = false;
    _listenedContract     = null;
  }
}

function _stopChainListeners() {
  if (_listenedContract) {
    try { _listenedContract.removeAllListeners(); } catch (_) {}
    _listenedContract = null;
  }
  _chainListenersActive = false;
  for (const key of Object.keys(_refreshDebounce)) {
    clearTimeout(_refreshDebounce[key]);
    delete _refreshDebounce[key];
  }
}

// ── EXPOSE TO WINDOW ──
window.connectWallet       = connectWallet;
window.handleWalletBtn     = handleWalletBtn;
window.handleSidebarBtn    = handleSidebarBtn;
window.toggleSidebar       = toggleSidebar;
window.openMobileNav       = openMobileNav;
window.closeMobileNav      = closeMobileNav;
window.mobileNavSwitch     = mobileNavSwitch;
window.disconnectWallet    = disconnectWallet;
window.registerNewUser     = registerNewUser;
window.updateNetPill       = updateNetPill;
window.loadTokens          = loadTokens;
window.toggleLandingMenu   = toggleLandingMenu;
window.closeLandingMenu    = closeLandingMenu;
window.scrollToLandingSection = scrollToLandingSection;
window.toggleFaq           = toggleFaq;
window.toggleInvestDropdown = toggleInvestDropdown;
window.syncInvestDropdownTrigger = syncInvestDropdownTrigger;
window.switchTab           = switchTab;
window.switchTabByName     = switchTabByName;
window.toggleTabsCollapse  = toggleTabsCollapse;
window.dismissMissedAlert  = dismissMissedAlert;
window.checkMissedCommissions = checkMissedCommissions;
window._computeMissedWei   = _computeMissedWei;
window._startChainListeners = _startChainListeners;
window._stopChainListeners  = _stopChainListeners;
