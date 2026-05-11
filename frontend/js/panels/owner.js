let _tokenFetchTimer = null;
let _logoBase64 = '';

function onLogoChange(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    _logoBase64 = e.target.result;
    document.getElementById('logoPreviewImg').src = _logoBase64;
    document.getElementById('logoPreview').style.display = 'block';
  };
  reader.readAsDataURL(file);
}

function onTokenAddrInput(value) {
  const status    = document.getElementById('tokenFetchStatus');
  const nameEl    = document.getElementById('newTokenName');
  const symbolEl  = document.getElementById('newTokenSymbol');
  const supplyEl  = document.getElementById('newTokenTotalSupply');
  const balanceEl = document.getElementById('newTokenBalance');

  clearTimeout(_tokenFetchTimer);
  nameEl.value = '';
  symbolEl.value = '';
  supplyEl.value = '';
  balanceEl.value = '';
  status.style.color = 'var(--muted)';
  status.textContent = '';

  const addr = value.trim();
  if (!ethers.utils.isAddress(addr)) return;

  status.textContent = 'Fetching token info...';

  _tokenFetchTimer = setTimeout(async () => {
    try {
      const tokenAbi = [
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function totalSupply() view returns (uint256)",
        "function decimals() view returns (uint8)"
      ];
      const tokenContract = new ethers.Contract(addr, tokenAbi, provider);
      const [name, symbol, totalSupply, decimals] = await Promise.all([
        tokenContract.name(),
        tokenContract.symbol(),
        tokenContract.totalSupply(),
        tokenContract.decimals().catch(() => 18)
      ]);

      const dec = Number(decimals);
      const formattedSupply = parseFloat(ethers.utils.formatUnits(totalSupply, dec)).toLocaleString(undefined, { maximumFractionDigits: 4 });

      nameEl.value   = name;
      symbolEl.value = symbol;
      supplyEl.value = `${formattedSupply} ${symbol}`;

      try {
        const rawBal = await contract.getContractTokenBalance(addr);
        const formattedBal = parseFloat(ethers.utils.formatUnits(rawBal, dec));
        balanceEl.value = formattedBal >= 0.0001
          ? `${formattedBal.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${symbol}`
          : `${Number(rawBal.toString()).toLocaleString()} ${symbol} (raw)`;
      } catch(_) {
        balanceEl.value = 'Not yet registered';
      }

      status.style.color = 'var(--success)';
      status.textContent = `✓ Found: ${name} (${symbol})`;
    } catch(e) {
      status.style.color = 'var(--danger)';
      status.textContent = 'Could not fetch token info — fill in manually.';
    }
  }, 400);
}

async function addToken() {
  if (!requireConnected()) return;
  const addr        = document.getElementById('newTokenAddr').value.trim();
  const name        = document.getElementById('newTokenName').value.trim();
  const symbol      = document.getElementById('newTokenSymbol').value.trim();

  if (!ethers.utils.isAddress(addr)) { toast('Invalid token address', 'error'); return; }
  if (!name || !symbol) { toast('Token name and symbol are required', 'warn'); return; }

  _txBegin();
  try {
    toast('Sending transaction...', 'info');
    const tx = await contract.addToken(addr, name, symbol);
    await tx.wait();

    saveMeta(addr, {
      logo:        _logoBase64,
      website:     document.getElementById('newTokenWebsite').value.trim(),
      whitepaper:  document.getElementById('newTokenWhitepaper').value.trim(),
      description: document.getElementById('newTokenDescription').value.trim()
    });

    _txDone();
    toast(`Token ${symbol} added successfully!`, 'success');
    invalidateTabs('invest', 'history');

    document.getElementById('newTokenAddr').value        = '';
    document.getElementById('newTokenName').value        = '';
    document.getElementById('newTokenSymbol').value      = '';
    document.getElementById('newTokenTotalSupply').value = '';
    document.getElementById('newTokenBalance').value     = '';
    document.getElementById('newTokenWebsite').value     = '';
    document.getElementById('newTokenWhitepaper').value  = '';
    document.getElementById('newTokenDescription').value = '';
    document.getElementById('newTokenLogo').value        = '';
    document.getElementById('logoPreview').style.display = 'none';
    document.getElementById('tokenFetchStatus').textContent = '';
    _logoBase64 = '';
  } catch(e) {
    _txDone();
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function loadTokenBalances() {
  if (!requireConnected()) return;
  const list = document.getElementById('tokenBalanceList');
  list.innerHTML = '<div class="empty-state">Loading<span class="ld"><span></span><span></span><span></span></span></div>';

  let addrs;
  try {
    addrs = await contract.getRegisteredTokens();
  } catch(e) {
    list.innerHTML = '<div class="empty-state">Failed to load tokens.</div>';
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
    return;
  }

  if (addrs.length === 0) {
    list.innerHTML = '<div class="empty-state">No tokens registered yet.</div>';
    return;
  }

  list.innerHTML = '';
  const decimalAbi = ["function decimals() view returns (uint8)"];
  let currentFeatured = '';
  try { currentFeatured = (await contract.featuredToken()).toLowerCase(); } catch(_) {}

  for (const addr of addrs) {
    const div = document.createElement('div');
    div.className = 'token-item';
    div.innerHTML = `<div class="token-info" style="width:100%"><div class="token-addr">${addr}</div><div style="font-size:11px;color:var(--muted);margin-top:4px;">Loading<span class="ld"><span></span><span></span><span></span></span></div></div>`;
    list.appendChild(div);

    try {
      const t          = await contract.getToken(addr);
      const rawBalance = await contract.getContractTokenBalance(addr);

      let decimals = 18;
      try {
        const tokenContract = new ethers.Contract(addr, decimalAbi, provider);
        decimals = Number(await tokenContract.decimals());
      } catch(_) {}

      const isEmpty      = rawBalance.toString() === '0';
      const formatted    = ethers.utils.formatUnits(rawBalance, decimals);
      const formattedNum = parseFloat(formatted);
      const displayBalance = formattedNum >= 0.0001
        ? formattedNum.toLocaleString(undefined, { maximumFractionDigits: 4 })
        : Number(rawBalance.toString()).toLocaleString();

      const isRemoved        = t.removed;
      const inProgressLabel  = t.inProgressLabel || '';
      const isInProgress     = inProgressLabel.length > 0;
      const isFeatured       = addr.toLowerCase() === currentFeatured;
      const statusBadge = isRemoved
        ? `<span style="background:rgba(224,80,80,0.15);color:var(--danger);border:1px solid rgba(224,80,80,0.3);font-size:10px;letter-spacing:1px;padding:2px 8px;border-radius:4px;">DELISTED</span>`
        : `<span style="background:rgba(62,207,142,0.12);color:var(--success);border:1px solid rgba(62,207,142,0.3);font-size:10px;letter-spacing:1px;padding:2px 8px;border-radius:4px;">ACTIVE</span>`;
      const inProgressBadge = (!isRemoved && isInProgress)
        ? `<span style="background:rgba(234,179,8,0.15);color:#eab308;border:1px solid rgba(234,179,8,0.35);font-size:10px;letter-spacing:1px;padding:2px 8px;border-radius:4px;">${inProgressLabel}</span>`
        : '';
      const featuredBadge = isFeatured
        ? `<span style="background:var(--success,#26d97f);color:#000;font-size:10px;font-weight:700;letter-spacing:.07em;padding:2px 8px;border-radius:4px;">FEATURED</span>`
        : '';
      const actionBtns = isRemoved ? '' : `
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
          ${!isFeatured ? `<button onclick="setFeaturedToken('${addr}')"
            style="padding:6px 14px;font-family:var(--font-mono);font-size:11px;letter-spacing:1px;border:1px solid rgba(201,168,76,0.4);border-radius:4px;background:rgba(201,168,76,0.08);color:var(--gold);cursor:pointer;transition:all 0.15s;"
            onmouseover="this.style.background='rgba(201,168,76,0.18)'" onmouseout="this.style.background='rgba(201,168,76,0.08)'">
            SET FEATURED
          </button>` : ''}
          <button onclick="toggleTokenInProgress('${addr}')"
            style="padding:6px 14px;font-family:var(--font-mono);font-size:11px;letter-spacing:1px;border:1px solid rgba(234,179,8,0.4);border-radius:4px;background:${isInProgress ? 'rgba(234,179,8,0.18)' : 'rgba(234,179,8,0.08)'};color:#eab308;cursor:pointer;transition:all 0.15s;"
            onmouseover="this.style.background='rgba(234,179,8,0.22)'" onmouseout="this.style.background='${isInProgress ? 'rgba(234,179,8,0.18)' : 'rgba(234,179,8,0.08)'}'">
            ${isInProgress ? 'CLEAR TAG' : 'SET TAG'}
          </button>
          <button onclick="delistToken('${addr}')"
            style="padding:6px 14px;font-family:var(--font-mono);font-size:11px;letter-spacing:1px;border:1px solid rgba(224,80,80,0.4);border-radius:4px;background:rgba(224,80,80,0.08);color:var(--danger);cursor:pointer;transition:all 0.15s;"
            onmouseover="this.style.background='rgba(224,80,80,0.18)'" onmouseout="this.style.background='rgba(224,80,80,0.08)'">
            DELIST
          </button>
        </div>`;

      div.innerHTML = `
        <div class="token-info">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;flex-wrap:wrap;">
            <span class="token-symbol">${t.symbol}</span>
            ${statusBadge}
            ${inProgressBadge}
            ${featuredBadge}
          </div>
          <div class="token-name">${t.name}</div>
          <div class="token-addr">${t.tokenAddress}</div>
          ${actionBtns}
        </div>
        <div style="text-align:right;flex-shrink:0;margin-left:16px;opacity:${isRemoved ? '0.4' : '1'};">
          <div style="font-family:var(--font-mono);font-size:18px;font-weight:600;color:${isEmpty ? 'var(--danger)' : 'var(--success)'};">
            ${isEmpty ? '0' : displayBalance}
          </div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;letter-spacing:1px;">${t.symbol} IN CONTRACT</div>
          ${!isRemoved && isEmpty ? '<div style="font-size:10px;color:var(--danger);margin-top:6px;">⚠ No balance — users cannot invest</div>' : ''}
        </div>
      `;
    } catch(e) {
      div.innerHTML = `
        <div class="token-info">
          <div class="token-addr">${addr}</div>
          <div style="font-size:11px;color:var(--danger);margin-top:4px;">Failed to load</div>
        </div>
      `;
    }
  }
}

async function setFeaturedToken(addr) {
  if (!requireConnected()) return;
  _txBegin();
  try {
    toast('Confirm transaction in MetaMask…', 'info');
    const tx = await contract.setFeaturedToken(addr);
    await tx.wait();
    _txDone();
    toast('Featured token updated on-chain.', 'success');
    invalidateTabs('invest');
    loadTokenBalances();
  } catch(e) {
    _txDone();
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function delistToken(addr) {
  if (!requireConnected()) return;
  if (!confirm('Delist this token? Users will no longer be able to invest in it. Existing stakers are unaffected.')) return;
  _txBegin();
  try {
    toast('Confirm transaction in MetaMask…', 'info');
    const tx = await contract.removeToken(addr);
    await tx.wait();
    _txDone();
    toast('Token delisted successfully.', 'success');
    invalidateTabs('invest');
    loadTokenBalances();
  } catch(e) {
    _txDone();
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function toggleTokenInProgress(addr) {
  if (!requireConnected()) return;
  let t;
  try { t = await contract.getToken(addr); } catch(e) { return; }
  const current = t.inProgressLabel || '';
  let label;
  if (current.length > 0) {
    if (!confirm(`Clear the tag "${current}" from this token? Users will be able to invest and swap it.`)) return;
    label = '';
  } else {
    const input = prompt('Enter tag text to show on this token (e.g. "Coming Soon"):');
    if (input === null) return;
    label = input.trim();
    if (!label) { toast('Tag text cannot be empty.', 'error'); return; }
  }
  _txBegin();
  try {
    toast('Confirm transaction in MetaMask…', 'info');
    const tx = await contract.setTokenInProgress(addr, label);
    await tx.wait();
    _txDone();
    toast(label ? `Tag "${label}" set on token.` : 'Tag cleared.', 'success');
    invalidateTabs('invest');
    loadTokenBalances();
  } catch(e) {
    _txDone();
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

async function loadOwnerStats() {
  if (!requireConnected()) return;

  const statsEl    = document.getElementById('ownerStatsContent');
  const approvalEl = document.getElementById('ownerApprovalContent');
  statsEl.innerHTML    = '<div class="empty-state">Loading…</div>';
  approvalEl.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const ownerAddr = await contract.owner();

    const userFilter = contract.filters.UserRegistered();
    const userEvents = await contract.queryFilter(userFilter);
    const uniqueUsers = new Set(userEvents.map(e => e.args.user.toLowerCase()));
    const totalUsers  = uniqueUsers.size;

    const invFilter = contract.filters.Invested();
    const invEvents = await contract.queryFilter(invFilter);
    let totalInvestedWei = ethers.BigNumber.from(0);
    for (const ev of invEvents) totalInvestedWei = totalInvestedWei.add(ev.args.ethAmount);
    const totalInvestedETH  = parseFloat(ethers.utils.formatEther(totalInvestedWei));
    const totalInvestedUSDT = totalInvestedETH * 1000;

    const tokenAddrs = await contract.getRegisteredTokens();
    let totalPoolUSDT = 0;
    const poolRows   = [];
    const tokenInfos = [];

    await Promise.all(tokenAddrs.map(async addr => {
      try {
        const t    = await contract.getToken(addr);
        const pool = await _dashGetPoolPrice(addr);
        const poolUSDT = pool ? pool.resETH * 2 * 1000 : 0;
        totalPoolUSDT += poolUSDT;
        poolRows.push({ symbol: t.symbol, addr, poolUSDT, hasPool: !!pool });
        tokenInfos.push({ symbol: t.symbol, addr });
      } catch(_) {
        poolRows.push({ symbol: addr, addr, poolUSDT: 0, hasPool: false });
        tokenInfos.push({ symbol: addr, addr });
      }
    }));

    const SHORTAGE_THRESHOLD = 100;
    const shortageTokens = [];
    const allowanceRows  = [];

    await Promise.all(tokenInfos.map(async ({ symbol, addr }) => {
      try {
        const erc20 = new ethers.Contract(addr, [
          'function allowance(address,address) view returns (uint256)',
          'function decimals() view returns (uint8)'
        ], provider);
        const [rawAllow, dec] = await Promise.all([
          erc20.allowance(ownerAddr, CONTRACT_ADDRESS),
          erc20.decimals().catch(() => 18)
        ]);
        const allowFloat = parseFloat(ethers.utils.formatUnits(rawAllow, dec));
        const isShort    = allowFloat < SHORTAGE_THRESHOLD;
        if (isShort) shortageTokens.push({ symbol, addr, allowFloat });
        allowanceRows.push({ symbol, addr, allowFloat, dec, isShort });
      } catch(_) {
        allowanceRows.push({ symbol, addr, allowFloat: null, isShort: false });
      }
    }));

    statsEl.innerHTML = `
      <div class="info-grid" style="grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr));gap:12px;">
        <div class="info-cell">
          <div class="info-cell-label">TOTAL USERS</div>
          <div class="info-cell-value" style="color:var(--gold);font-size:22px;">${totalUsers.toLocaleString()}</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-label">TOTAL INVESTED</div>
          <div class="info-cell-value" style="color:var(--gold);font-size:22px;">$${totalInvestedUSDT.toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:2})}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:3px;">${totalInvestedETH.toFixed(4)} ETH</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-label">POOL LIQUIDITY (USDT)</div>
          <div class="info-cell-value" style="color:var(--gold);font-size:22px;">$${totalPoolUSDT.toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:2})}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:3px;">${tokenAddrs.length} pool${tokenAddrs.length!==1?'s':''}</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-label">TOKENS IN SHORTAGE</div>
          <div class="info-cell-value" style="color:${shortageTokens.length>0?'var(--danger)':'var(--success)'};font-size:22px;">${shortageTokens.length}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:3px;">${shortageTokens.length>0?'<span style="color:var(--danger);">↓ See below</span>':'All OK'}</div>
        </div>
      </div>
      ${poolRows.length ? `
      <div style="margin-top:20px;">
        <div class="section-header" style="margin-bottom:10px;">POOL BREAKDOWN</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${poolRows.map(r => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg);border-radius:4px;border:1px solid var(--border);">
              <div style="font-size:12px;font-family:var(--font-mono);color:var(--text);">
                <span style="color:var(--gold);letter-spacing:1px;">${r.symbol}</span>
                <span style="color:var(--muted);font-size:10px;margin-left:8px;word-break:break-all;">${r.addr}</span>
              </div>
              <div style="text-align:right;">
                ${r.hasPool
                  ? `<div style="font-size:13px;color:var(--cream);">$${r.poolUSDT.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>`
                  : `<div style="font-size:11px;color:var(--muted);">No pool</div>`
                }
              </div>
            </div>
          `).join('')}
        </div>
      </div>` : ''}
    `;

    approvalEl.innerHTML = allowanceRows.length ? `
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${allowanceRows.map(r => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg);border-radius:4px;border:1px solid ${r.isShort?'rgba(224,80,80,0.3)':'var(--border)'};">
            <div>
              <span style="color:var(--gold);font-size:12px;letter-spacing:1px;">${r.symbol}</span>
              <span style="color:var(--muted);font-size:10px;margin-left:8px;">${r.addr.slice(0,10)}…</span>
            </div>
            <div style="text-align:right;">
              ${r.allowFloat === null
                ? `<span style="font-size:11px;color:var(--muted);">Unable to read</span>`
                : `<span style="font-size:13px;color:${r.isShort?'var(--danger)':'var(--success)'};">${r.isShort?'⚠ ':''} ${r.allowFloat.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} tokens</span>`
              }
            </div>
          </div>
        `).join('')}
      </div>
    ` : '<div class="empty-state">No tokens registered.</div>';

  } catch(e) {
    statsEl.innerHTML    = `<div style="color:var(--danger);font-size:12px;">Error loading stats: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
    approvalEl.innerHTML = `<div style="color:var(--danger);font-size:12px;">Error loading allowances.</div>`;
  }
}

async function loadOwnerInfo() {
  if (!requireConnected()) return;
  try {
    const ownerAddr = await contract.owner();
    const rates = [];
    for (let i = 0; i < 10; i++) {
      const r = await contract.referralCommissionRates(i);
      rates.push((r.toNumber() / 500).toFixed(2).replace(/\.?0+$/, '') + '% of investment');
    }
    const el = document.getElementById('ownerInfoContent');
    el.innerHTML = `
      <div class="info-grid" style="margin-top:16px;">
        <div class="info-cell">
          <div class="info-cell-label">OWNER ADDRESS</div>
          <div class="info-cell-value" style="color:${ownerAddr.toLowerCase() === walletAddress.toLowerCase() ? 'var(--success)' : 'var(--text)'}; word-break:break-all;">${ownerAddr} ${ownerAddr.toLowerCase() === walletAddress.toLowerCase() ? '(YOU)' : ''}</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-label">YOU ARE OWNER</div>
          <div class="info-cell-value" style="color:${ownerAddr.toLowerCase() === walletAddress.toLowerCase() ? 'var(--success)' : 'var(--danger)'}">${ownerAddr.toLowerCase() === walletAddress.toLowerCase() ? 'YES ✓' : 'NO ✗'}</div>
        </div>
      </div>
      <div style="margin-top:20px;">
        <div class="section-header">REFERRAL COMMISSION RATES</div>
        <div class="referral-chain">
          ${rates.map((r,i) => `
            <div class="referral-item">
              <span class="referral-level">LEVEL ${i+1}</span>
              <span style="color:var(--gold)">${r}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } catch(e) {
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

// ── OWNER LIQUIDITY MANAGEMENT ──

let _ownerLiqTokenDec  = 18;
let _ownerLiqTokenSym  = '';
let _ownerLiqIsNewPool = false;

async function ownerPopulateLiqDropdowns() {
  const selAdd = document.getElementById('ownerLiqToken');
  const selRem = document.getElementById('ownerRemoveLiqToken');
  if (!selAdd || !selRem) return;
  while (selAdd.options.length > 1) selAdd.remove(1);
  while (selRem.options.length > 1) selRem.remove(1);
  try {
    const addrs = await contract.getRegisteredTokens();
    for (const addr of addrs) {
      const t = await contract.getToken(addr);
      const label = `${t.symbol} — ${t.name}`;
      selAdd.appendChild(new Option(label, addr));
      selRem.appendChild(new Option(label, addr));
    }
  } catch(_) {}
}

async function onOwnerLiqTokenChange(addr) {
  const statusEl   = document.getElementById('ownerLiqPoolStatus');
  const newPoolSec = document.getElementById('ownerNewPoolSection');
  const symLabel   = document.getElementById('ownerLiqTokenSymLabel');
  document.getElementById('ownerLiqETH').textContent      = '—';
  document.getElementById('ownerLiqTokenAmt').textContent = '—';
  if (!addr) { statusEl.textContent = ''; newPoolSec.style.display = 'none'; return; }
  try {
    const t = await contract.getToken(addr);
    _ownerLiqTokenSym = t.symbol;
    symLabel.textContent = t.symbol;
    const erc20 = new ethers.Contract(addr, ERC20_ABI, provider);
    _ownerLiqTokenDec = Number(await erc20.decimals().catch(() => 18));

    const factory  = getFactory();
    const pairAddr = await factory.getPair(addr, DEX_WETH);
    const noPool   = !pairAddr || pairAddr === ethers.constants.AddressZero;

    if (noPool) {
      _ownerLiqIsNewPool = true;
      newPoolSec.style.display = 'block';
      statusEl.style.color = 'var(--gold)';
      statusEl.textContent = 'No pool exists — you will create it at the price you set.';
    } else {
      const pair = getPairContract(pairAddr);
      const [r0, r1] = await pair.getReserves();
      if (r0.eq(0) && r1.eq(0)) {
        _ownerLiqIsNewPool = true;
        newPoolSec.style.display = 'block';
        statusEl.style.color = 'var(--gold)';
        statusEl.textContent = 'Pool exists but is empty — set an initial price.';
      } else {
        _ownerLiqIsNewPool = false;
        newPoolSec.style.display = 'none';
        const pool = await _dashGetPoolPrice(addr);
        const priceUSDT = pool ? (pool.priceEth * 1000).toFixed(6) : '—';
        statusEl.style.color = 'var(--success)';
        statusEl.textContent = `Pool found — current price: $${priceUSDT} USDT per ${t.symbol}`;
      }
    }
    onOwnerLiqUSDTChange();
  } catch(e) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Error: ' + (e.message || e);
  }
}

function onOwnerLiqUSDTChange() {
  const addr    = document.getElementById('ownerLiqToken').value;
  const usdtVal = parseFloat(document.getElementById('ownerLiqUSDT').value) || 0;
  const ethEl   = document.getElementById('ownerLiqETH');
  const tokEl   = document.getElementById('ownerLiqTokenAmt');
  if (!addr || usdtVal <= 0) { ethEl.textContent = '—'; tokEl.textContent = '—'; return; }
  const ethAmt = usdtVal / 1000;
  ethEl.textContent = (ethAmt * USDT_PER_ETH).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' USDT';

  if (_ownerLiqIsNewPool) {
    const priceUSDT = parseFloat(document.getElementById('ownerInitialPrice').value) || 0;
    if (priceUSDT <= 0) { tokEl.textContent = 'Enter price above'; return; }
    const tokAmt = ethAmt / (priceUSDT / 1000);
    tokEl.textContent = tokAmt.toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' ' + _ownerLiqTokenSym;
  } else {
    _dashGetPoolPrice(addr).then(pool => {
      if (!pool || pool.priceEth === 0) { tokEl.textContent = '—'; return; }
      const tokAmt = ethAmt / pool.priceEth;
      tokEl.textContent = tokAmt.toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' ' + _ownerLiqTokenSym;
    });
  }
}

async function ownerAddLiquidity() {
  if (!requireConnected()) return;
  const addr    = document.getElementById('ownerLiqToken').value;
  const usdtVal = parseFloat(document.getElementById('ownerLiqUSDT').value) || 0;
  if (!addr)        { toast('Select a token', 'warn'); return; }
  if (usdtVal <= 0) { toast('Enter USDT amount', 'warn'); return; }

  const btn = document.getElementById('ownerAddLiqBtn');
  btn.disabled = true; btn.textContent = 'Processing…';
  try {
    const ethAmt = usdtVal / 1000;
    const ethWei = ethers.utils.parseEther(ethAmt.toFixed(18));
    let tokenWei;

    if (_ownerLiqIsNewPool) {
      const priceUSDT = parseFloat(document.getElementById('ownerInitialPrice').value) || 0;
      if (priceUSDT <= 0) { toast('Enter initial price', 'warn'); return; }
      const tokAmt = ethAmt / (priceUSDT / 1000);
      tokenWei = ethers.utils.parseUnits(tokAmt.toFixed(_ownerLiqTokenDec), _ownerLiqTokenDec);
    } else {
      const pool = await _dashGetPoolPrice(addr);
      if (!pool) { toast('Could not fetch pool price', 'error'); return; }
      const tokAmt = ethAmt / pool.priceEth;
      tokenWei = ethers.utils.parseUnits(tokAmt.toFixed(_ownerLiqTokenDec), _ownerLiqTokenDec);
    }

    toast('Confirm in MetaMask — sending ETH to seed the pool…', 'info');
    await (await contract.seedPool(addr, tokenWei, { value: ethWei })).wait();

    toast('Liquidity added successfully!', 'success');
    document.getElementById('ownerLiqUSDT').value          = '';
    document.getElementById('ownerLiqETH').textContent      = '—';
    document.getElementById('ownerLiqTokenAmt').textContent = '—';
    onOwnerLiqTokenChange(addr);
    onOwnerRemoveLiqTokenChange(document.getElementById('ownerRemoveLiqToken').value);
  } catch(e) {
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'ADD LIQUIDITY';
  }
}

// ── REMOVE OWNER LIQUIDITY ──

let _ownerRem_PairAddr  = null;
let _ownerRem_TokenAddr = null;
let _ownerRem_TokenDec  = 18;
let _ownerRem_TokenSym  = '';
let _ownerRem_LPBal     = null;

async function onOwnerRemoveLiqTokenChange(addr) {
  const infoEl = document.getElementById('ownerRemoveLiqInfo');
  if (!addr) { infoEl.style.display = 'none'; return; }
  _ownerRem_TokenAddr = addr;
  infoEl.style.display = 'block';
  document.getElementById('ownerLPBalance').textContent      = 'Loading…';
  document.getElementById('ownerRemoveEstETH').textContent   = '—';
  document.getElementById('ownerRemoveEstToken').textContent = '—';
  try {
    const t = await contract.getToken(addr);
    _ownerRem_TokenSym = t.symbol;
    const erc20 = new ethers.Contract(addr, ERC20_ABI, provider);
    _ownerRem_TokenDec = Number(await erc20.decimals().catch(() => 18));

    const factory = getFactory();
    _ownerRem_PairAddr = await factory.getPair(addr, DEX_WETH);
    if (!_ownerRem_PairAddr || _ownerRem_PairAddr === ethers.constants.AddressZero) {
      document.getElementById('ownerLPBalance').textContent = 'No pool';
      return;
    }
    const lpToken = new ethers.Contract(_ownerRem_PairAddr, [
      "function balanceOf(address) view returns (uint256)"
    ], provider);
    _ownerRem_LPBal = await lpToken.balanceOf(walletAddress);
    document.getElementById('ownerLPBalance').textContent =
      parseFloat(ethers.utils.formatEther(_ownerRem_LPBal)).toFixed(8) + ' LP';
    await _ownerUpdateRemoveEstimate(_ownerRem_LPBal);
  } catch(e) {
    document.getElementById('ownerLPBalance').textContent = 'Error';
    toast('Error: ' + (e.message || e), 'error');
  }
}

async function _ownerUpdateRemoveEstimate(lpWei) {
  if (!_ownerRem_PairAddr || !lpWei || lpWei.eq(0)) return;
  try {
    const pair = getPairContract(_ownerRem_PairAddr);
    const [[r0, r1], token0, totalSupply] = await Promise.all([
      pair.getReserves(), pair.token0(), pair.totalSupply()
    ]);
    if (totalSupply.eq(0)) return;
    const isToken0 = token0.toLowerCase() === _ownerRem_TokenAddr.toLowerCase();
    const rawTok = isToken0 ? r0 : r1;
    const rawETH = isToken0 ? r1 : r0;
    const estTok = rawTok.mul(lpWei).div(totalSupply);
    const estETH = rawETH.mul(lpWei).div(totalSupply);
    document.getElementById('ownerRemoveEstETH').textContent =
      (parseFloat(ethers.utils.formatEther(estETH)) * USDT_PER_ETH).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' USDT';
    document.getElementById('ownerRemoveEstToken').textContent =
      parseFloat(ethers.utils.formatUnits(estTok, _ownerRem_TokenDec)).toFixed(4) + ' ' + _ownerRem_TokenSym;
  } catch(_) {}
}

function ownerSetMaxLP() {
  if (!_ownerRem_LPBal) return;
  document.getElementById('ownerRemoveLPAmt').value = ethers.utils.formatEther(_ownerRem_LPBal);
  _ownerUpdateRemoveEstimate(_ownerRem_LPBal);
}

function onOwnerRemoveLPAmtChange() {
  const val = parseFloat(document.getElementById('ownerRemoveLPAmt').value) || 0;
  if (val <= 0) return;
  try { _ownerUpdateRemoveEstimate(ethers.utils.parseEther(String(val))); } catch(_) {}
}

async function ownerRemoveLiquidity() {
  if (!requireConnected()) return;
  const addr  = document.getElementById('ownerRemoveLiqToken').value;
  const lpStr = document.getElementById('ownerRemoveLPAmt').value;
  if (!addr)                              { toast('Select a token', 'warn'); return; }
  if (!lpStr || parseFloat(lpStr) <= 0)  { toast('Enter LP amount', 'warn'); return; }
  if (!_ownerRem_PairAddr || _ownerRem_PairAddr === ethers.constants.AddressZero) {
    toast('No pool found', 'error'); return;
  }
  let lpWei;
  try { lpWei = ethers.utils.parseEther(lpStr); } catch { toast('Invalid LP amount', 'error'); return; }

  const btn = document.getElementById('ownerRemoveLiqBtn');
  btn.disabled = true; btn.textContent = 'Processing…';
  try {
    const pair = getPairContract(_ownerRem_PairAddr);
    const [[r0, r1], token0, totalSupply] = await Promise.all([
      pair.getReserves(), pair.token0(), pair.totalSupply()
    ]);
    const isToken0 = token0.toLowerCase() === addr.toLowerCase();
    const rawTok = isToken0 ? r0 : r1;
    const rawETH = isToken0 ? r1 : r0;
    const estTok = rawTok.mul(lpWei).div(totalSupply);
    const estETH = rawETH.mul(lpWei).div(totalSupply);
    const minTok = estTok.mul(9900).div(10000);
    const minETH = estETH.mul(9900).div(10000);
    const deadline = Math.floor(Date.now() / 1000) + 300;

    toast('Step 1/2 — Approve LP tokens in MetaMask…', 'info');
    const lpToken = new ethers.Contract(_ownerRem_PairAddr, ["function approve(address,uint256) returns (bool)"], signer);
    await (await lpToken.approve(DEX_ROUTER, lpWei)).wait();

    toast('Step 2/2 — Remove liquidity in MetaMask…', 'info');
    const router = getRouter();
    await (await router.removeLiquidityETH(
      addr, lpWei, minTok, minETH, walletAddress, deadline
    )).wait();

    toast('Liquidity removed successfully!', 'success');
    document.getElementById('ownerRemoveLPAmt').value = '';
    await onOwnerRemoveLiqTokenChange(addr);
  } catch(e) {
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'REMOVE LIQUIDITY';
  }
}

// ── WITHDRAW FUNDS ──

let _ownerWithdrawTokenDec = 18;
let _ownerWithdrawTokenSym = '';

async function ownerLoadWithdrawBals() {
  const el = document.getElementById('ownerETHBal');
  try {
    const wei = await provider.getBalance(contract.address);
    const eth = parseFloat(ethers.utils.formatEther(wei));
    el.textContent = `Contract ETH balance: ${eth.toFixed(6)} ETH ($${(eth * USDT_PER_ETH).toFixed(2)} USDT)`;
    el.style.color = eth > 0 ? 'var(--gold)' : 'var(--muted)';
  } catch(e) {
    el.textContent = 'Failed to load balance.';
  }
}

async function ownerWithdrawTokenAddrChange(addr) {
  const infoEl  = document.getElementById('ownerWithdrawTokenInfo');
  const symSpan = document.getElementById('ownerWithdrawTokenSymSpan');
  _ownerWithdrawTokenSym = 'TOKEN';
  _ownerWithdrawTokenDec = 18;
  symSpan.textContent = 'TOKEN';
  if (!ethers.utils.isAddress(addr)) { infoEl.textContent = ''; return; }
  infoEl.textContent = 'Loading…';
  try {
    const erc20 = new ethers.Contract(addr, [
      'function symbol() view returns (string)',
      'function decimals() view returns (uint8)',
      'function balanceOf(address) view returns (uint256)'
    ], provider);
    const [sym, dec, rawBal] = await Promise.all([
      erc20.symbol().catch(() => 'TOKEN'),
      erc20.decimals().catch(() => 18),
      erc20.balanceOf(contract.address).catch(() => ethers.BigNumber.from(0))
    ]);
    _ownerWithdrawTokenSym = sym;
    _ownerWithdrawTokenDec = Number(dec);
    symSpan.textContent = sym;
    const bal = parseFloat(ethers.utils.formatUnits(rawBal, _ownerWithdrawTokenDec));
    infoEl.textContent = `Contract balance: ${bal.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${sym}`;
    infoEl.style.color = bal > 0 ? 'var(--gold)' : 'var(--muted)';
  } catch(e) {
    infoEl.textContent = 'Could not fetch token info.';
    infoEl.style.color = 'var(--danger)';
  }
}

async function ownerWithdrawETH() {
  if (!requireConnected()) return;
  const btn = document.getElementById('ownerWithdrawETHBtn');
  const rawAmt = document.getElementById('ownerWithdrawETHAmt').value.trim();
  const amtWei = rawAmt ? ethers.utils.parseEther(rawAmt) : ethers.BigNumber.from(0);
  btn.disabled = true; btn.textContent = 'Processing…';
  try {
    toast('Confirm in MetaMask…', 'info');
    const tx = await contract.withdrawETH(amtWei);
    await tx.wait();
    toast('ETH withdrawn successfully.', 'success');
    document.getElementById('ownerWithdrawETHAmt').value = '';
    ownerLoadWithdrawBals();
  } catch(e) {
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'WITHDRAW ETH';
  }
}

async function ownerWithdrawToken() {
  if (!requireConnected()) return;
  const addr = document.getElementById('ownerWithdrawTokenAddr').value.trim();
  if (!ethers.utils.isAddress(addr)) { toast('Enter a valid token address', 'warn'); return; }
  const btn = document.getElementById('ownerWithdrawTokenBtn');
  const rawAmt = document.getElementById('ownerWithdrawTokenAmt').value.trim();
  const amtWei = rawAmt
    ? ethers.utils.parseUnits(rawAmt, _ownerWithdrawTokenDec)
    : ethers.BigNumber.from(0);
  btn.disabled = true; btn.textContent = 'Processing…';
  try {
    toast('Confirm in MetaMask…', 'info');
    const tx = await contract.withdrawToken(addr, amtWei);
    await tx.wait();
    toast(`${_ownerWithdrawTokenSym} withdrawn successfully.`, 'success');
    document.getElementById('ownerWithdrawTokenAmt').value = '';
    ownerWithdrawTokenAddrChange(addr);
  } catch(e) {
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'WITHDRAW TOKEN';
  }
}

window.setFeaturedToken              = setFeaturedToken;
window.delistToken                   = delistToken;
window.onLogoChange                  = onLogoChange;
window.onTokenAddrInput              = onTokenAddrInput;
window.addToken                      = addToken;
window.loadTokenBalances             = loadTokenBalances;
window.loadOwnerStats                = loadOwnerStats;
window.loadOwnerInfo                 = loadOwnerInfo;
window.ownerPopulateLiqDropdowns     = ownerPopulateLiqDropdowns;
window.onOwnerLiqTokenChange         = onOwnerLiqTokenChange;
window.onOwnerLiqUSDTChange          = onOwnerLiqUSDTChange;
window.ownerAddLiquidity             = ownerAddLiquidity;
window.onOwnerRemoveLiqTokenChange   = onOwnerRemoveLiqTokenChange;
window.ownerSetMaxLP                 = ownerSetMaxLP;
window.onOwnerRemoveLPAmtChange      = onOwnerRemoveLPAmtChange;
window.ownerRemoveLiquidity          = ownerRemoveLiquidity;
window.ownerLoadWithdrawBals         = ownerLoadWithdrawBals;
window.ownerWithdrawTokenAddrChange  = ownerWithdrawTokenAddrChange;
window.ownerWithdrawETH              = ownerWithdrawETH;
window.ownerWithdrawToken            = ownerWithdrawToken;
