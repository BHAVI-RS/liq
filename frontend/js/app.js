// ── CONFIG ──
const contractAddress = CONTRACT_ADDRESS;

// ── MISSED COMMISSION TRACKING ──
let _missedCommWei = null;

async function checkMissedCommissions() {
  if (!contract || !walletAddress) return;
  try {
    const ownerAddr = (await contract.owner()).toLowerCase();
    if (walletAddress.toLowerCase() === ownerAddr) return;

    const referrals = await contract.getReferrals(walletAddress);
    if (!referrals.length) return;

    // Sum L1 commissions that went to the owner instead of to this user.
    // This happens when the user was ineligible (inactive LP or cap reached) at the time
    // their direct referral invested.
    const PAID_TOPIC = ethers.utils.id('CommissionPaid(address,address,uint256,uint256)');
    let missedWei = ethers.BigNumber.from(0);
    for (const referral of referrals) {
      const logs = await provider.getLogs({
        address: contract.address,
        topics: [
          PAID_TOPIC,
          ethers.utils.hexZeroPad(ownerAddr, 32),
          ethers.utils.hexZeroPad(referral.toLowerCase(), 32),
        ],
        fromBlock: 0,
        toBlock: 'latest',
      });
      for (const log of logs) {
        const [amount, level] = ethers.utils.defaultAbiCoder.decode(['uint256','uint256'], log.data);
        if (Number(level) === 1) missedWei = missedWei.add(amount);
      }
    }

    _missedCommWei = missedWei;
    if (missedWei.isZero()) return;

    // Only show the alert when the user has no active LP — prompts them to re-invest.
    const locks     = await contract.getUserLPLocks(walletAddress);
    const hasActive = locks.some(l => !l.claimed && !l.removed);
    if (hasActive) return;

    const ethMissed  = parseFloat(ethers.utils.formatEther(missedWei));
    const usdtMissed = ethToUSDT(ethMissed).toLocaleString(undefined, { maximumFractionDigits: 2 });

    document.getElementById('missedCommText').innerHTML =
      `You have <strong style="color:#f87171;">${usdtMissed} USDT</strong> in uncollected referral commissions.<br><br>` +
      `This occurred because your LP position was inactive, or you had reached your 5× earning cap, when your referrals made investments.<br><br>` +
      `<strong>To become eligible again:</strong> ensure you have an active LP investment. Your pending cap carries forward when you reinvest.`;

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
        <div style="color:var(--gold);font-size:10px;font-family:var(--font-mono);">${d.addr.slice(0,18)}...${d.addr.slice(-6)}</div>
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

const REQUIRED_CHAIN_ID = 31337; // Hardhat localhost

async function ensureCorrectNetwork(eth) {
  const chainId = parseInt(await eth.request({ method: 'eth_chainId' }), 16);
  if (chainId === REQUIRED_CHAIN_ID) return true;
  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x7a69' }]  // 31337
    });
    return true;
  } catch(switchErr) {
    if (switchErr.code === 4902) {
      try {
        await eth.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0x7a69',
            chainName: 'Hardhat Localhost',
            nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['http://127.0.0.1:8545']
          }]
        });
        return true;
      } catch(_) {}
    }
    toast('Please switch MetaMask to Hardhat Localhost (127.0.0.1:8545, chain ID 31337).', 'error');
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
      toast('Wrong network — please switch back to Hardhat Localhost.', 'error');
      return;
    }
    if (_txInFlight === 0 && App.walletAddress) {
      App.provider = new ethers.providers.Web3Provider(eth);
      App.signer   = App.provider.getSigner();
      if (contractAddress) {
        App.contract = new ethers.Contract(contractAddress, CONTRACT_ABI, App.signer);
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
    App.provider = new ethers.providers.Web3Provider(eth);
    if (App.wasDisconnected || sessionStorage.getItem('hordex_force_prompt') === '1') {
      await App.provider.send("wallet_requestPermissions", [{ eth_accounts: {} }]);
      App.wasDisconnected = false;
      sessionStorage.removeItem('hordex_force_prompt');
    } else {
      await App.provider.send("eth_requestAccounts", []);
    }
    App.signer = App.provider.getSigner();
    App.walletAddress = await App.signer.getAddress();

    document.getElementById('connectBtn').textContent = App.walletAddress.slice(0,6) + '...' + App.walletAddress.slice(-4);
    document.getElementById('connectBtn').classList.add('connected');
    document.getElementById('walletAddr').textContent = App.walletAddress;
    document.getElementById('walletBar').classList.add('show');
    document.getElementById('walletDropdownAddr').textContent = App.walletAddress;
    updateNetPill(await eth.request({ method: 'eth_chainId' }));

    localStorage.setItem('hordex_wallet', App.walletAddress);
    toast('Wallet connected: ' + App.walletAddress.slice(0,8) + '...', 'success');

    if (contractAddress) await initContract();
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
});

// Close mobile nav on ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMobileNav();
    document.getElementById('walletDropdown').classList.remove('open');
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
function toggleInvDetails(btn) {
  const details = btn.nextElementSibling;
  if (!details) return;
  const open = details.classList.toggle('open');
  btn.classList.toggle('open', open);
  btn.querySelector('.dit-arrow').textContent = open ? '▴' : '▾';
  btn.childNodes[0].textContent = open ? 'SHOW LESS ' : 'SHOW MORE ';
}

// Close landing dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dd = document.getElementById('landingMenuDropdown');
  if (!dd) return;
  if (!dd.classList.contains('lnd-open')) return;
  if (!e.target.closest('.landing-topbar-left')) closeLandingMenu();
});

// ── LANDING PAGE STATS ──
async function loadLandingStats(eth) {
  try {
    if (typeof CONTRACT_ADDRESS === 'undefined' || typeof CONTRACT_ABI === 'undefined') return;
    const readProvider = new ethers.providers.Web3Provider(eth);
    const readContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, readProvider);

    const [regEvents, investEvents, removeEvents] = await Promise.all([
      readContract.queryFilter(readContract.filters.UserRegistered()),
      readContract.queryFilter(readContract.filters.Invested()),
      readContract.queryFilter(readContract.filters.LPRemoved()),
    ]);

    const totalUsers = regEvents.length + 1;

    const investCount = {}, removeCount = {};
    for (const e of investEvents) {
      const u = e.args.user.toLowerCase();
      investCount[u] = (investCount[u] || 0) + 1;
    }
    for (const e of removeEvents) {
      const u = e.args.user.toLowerCase();
      removeCount[u] = (removeCount[u] || 0) + 1;
    }
    let activeUsers = 0;
    for (const u of Object.keys(investCount)) {
      if ((investCount[u] || 0) > (removeCount[u] || 0)) activeUsers++;
    }

    let totalWei = ethers.BigNumber.from(0);
    for (const e of investEvents) totalWei = totalWei.add(e.args.ethAmount);
    const totalETH = parseFloat(ethers.utils.formatEther(totalWei));

    const $ = id => document.getElementById(id);
    if ($('ls-total-users'))   $('ls-total-users').textContent   = totalUsers.toLocaleString();
    if ($('ls-active-users'))  $('ls-active-users').textContent  = activeUsers.toLocaleString();
    if ($('ls-total-funding')) $('ls-total-funding').textContent =
      totalETH > 0 ? ethToUSDT(totalETH).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' USDT' : '0 USDT';
    if ($('lcf-contract-addr') && typeof CONTRACT_ADDRESS !== 'undefined')
      $('lcf-contract-addr').textContent = CONTRACT_ADDRESS;
  } catch (_) {}
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

  loadLandingStats(eth); // fire-and-forget

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
    App.provider = new ethers.providers.Web3Provider(eth);
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

    App.signer = App.provider.getSigner();
    updateNetPill(await eth.request({ method: 'eth_chainId' }));

    if (contractAddress) await initContract();
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
    addrEl.textContent = App.walletAddress.slice(0,10) + '…' + App.walletAddress.slice(-8);
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
  App.walletAddress = null;
  App.provider = null;
  App.signer = null;
  App.contract = null;
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
  App.contract = new ethers.Contract(contractAddress, CONTRACT_ABI, App.signer);
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

// Runs once after every login.  Fetches LP locks + latest block, determines
// each lock's status using the sessionStorage-restored effectiveNow so the
// correct state is visible even right after a page reload on a frozen Hardhat
// fork.  Pre-populates the investments panel and shows a toast when locks are
// ready to claim / remove.
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

    // Mirror the sessionStorage restore from loadInvestments() so we use the
    // same effectiveNow reference even before loadInvestments() has been called.
    let effectiveNow = blockNow;
    try {
      const saved = JSON.parse(sessionStorage.getItem('hordex_eff_time') || 'null');
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

    // Pre-populate the investments panel so correct state is shown immediately
    // when the user navigates there, without an extra loading flash.
    loadInvestments();
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
        _onLoginCheckInvestments();
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
            referrerLabel = refParam.slice(0,14) + '...' + refParam.slice(-8);
          }
        } catch(_) {}
      }

      if (!referrerAddr) {
        referrerAddr = await App.contract.owner();
        referrerLabel = referrerAddr.slice(0,14) + '...' + referrerAddr.slice(-8) + '  (Platform Admin)';
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
    const tx = await App.contract.register(_pendingReferrer);
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
    const label = val.slice(0,14) + '...' + val.slice(-8);
    document.getElementById('newUserReferrerAddr').textContent = label;
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
    pill.textContent = 'HARDHAT';
    pill.className = 'net-pill sepolia';
  } else {
    pill.textContent = 'WRONG NETWORK';
    pill.className = 'net-pill wrongnet';
  }
  pill.style.display = 'inline-block';
}

// ── REGISTER ──
async function register() {
  if (!requireConnected()) return;
  const ref = document.getElementById('referrerAddr').value.trim();
  if (!ethers.utils.isAddress(ref)) { toast('Invalid referrer address', 'error'); return; }
  _txBegin();
  try {
    toast('Sending transaction...', 'info');
    const tx = await App.contract.register(ref);
    toast('Transaction sent. Waiting...', 'info');
    await tx.wait();
    _txDone();
    toast('Registered successfully! 🎉', 'success');
    invalidateTabs('myinfo', 'genealogy');
  } catch(e) {
    _txDone();
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function checkUser() {
  if (!requireConnected()) return;
  const addr = document.getElementById('checkAddr').value.trim();
  if (!ethers.utils.isAddress(addr)) { toast('Invalid address', 'error'); return; }
  try {
    const user = await App.contract.users(addr);
    const referrer = user.referrer;
    const referrals = await App.contract.getReferrals(addr);
    const el = document.getElementById('checkResult');
    el.style.display = 'grid';
    el.innerHTML = `
      <div class="info-cell">
        <div class="info-cell-label">REGISTERED</div>
        <div class="info-cell-value" style="color:${user.isRegistered ? 'var(--success)' : 'var(--danger)'}">${user.isRegistered ? 'YES' : 'NO'}</div>
      </div>
      <div class="info-cell">
        <div class="info-cell-label">REFERRER</div>
        <div class="info-cell-value">${referrer === ethers.constants.AddressZero ? '—' : referrer.slice(0,10) + '...'}</div>
      </div>
      <div class="info-cell">
        <div class="info-cell-label">TOTAL REFERRALS</div>
        <div class="info-cell-value">${referrals.length}</div>
      </div>
      <div class="info-cell">
        <div class="info-cell-label">REGISTERED AT</div>
        <div class="info-cell-value">${user.registeredAt.toNumber() > 0 ? new Date(user.registeredAt.toNumber() * 1000).toLocaleString() : '—'}</div>
      </div>
    `;
  } catch(e) {
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
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
  if (name === 'invest') { loadInvestTokens(); fetchEthPrice(); renderPkgGrid(); }
  if (name === 'pool')   { fetchEthPrice(); loadPoolPanel(); }
  if (name === 'owner')  { loadOwnerStats(); ownerPopulateLiqDropdowns(); }
  if (name === 'dashboard'   && !_tabLoaded.has('dashboard'))   { _tabLoaded.add('dashboard');   loadDashboard(); }
  if (name === 'investments') { _tabLoaded.add('investments'); loadInvestments(); }
  if (name === 'myinfo'      && !_tabLoaded.has('myinfo'))      { _tabLoaded.add('myinfo');      loadMyInfo(); }
  if (name === 'history'     && !_tabLoaded.has('history'))     { _tabLoaded.add('history');     switchHistoryTab(_activeHistTab); }
  if (name === 'genealogy'   && !_tabLoaded.has('genealogy'))   { _tabLoaded.add('genealogy');   loadGenealogy(); }
  if (name === 'rewards'     && !_tabLoaded.has('rewards'))     { _tabLoaded.add('rewards');     loadRewards(); }
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
window.register            = register;
window.checkUser           = checkUser;
window.loadTokens          = loadTokens;
window.toggleLandingMenu   = toggleLandingMenu;
window.closeLandingMenu    = closeLandingMenu;
window.scrollToLandingSection = scrollToLandingSection;
window.toggleFaq           = toggleFaq;
window.toggleInvDetails    = toggleInvDetails;
window.toggleInvestDropdown = toggleInvestDropdown;
window.syncInvestDropdownTrigger = syncInvestDropdownTrigger;
window.switchTab           = switchTab;
window.switchTabByName     = switchTabByName;
window.toggleTabsCollapse  = toggleTabsCollapse;
window.dismissMissedAlert  = dismissMissedAlert;
window.checkMissedCommissions = checkMissedCommissions;
