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
    const tx = await contract.connect(signer).addToken(addr, name, symbol, _GAS);
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
          <button onclick="editToken('${addr}')"
            style="padding:6px 14px;font-family:var(--font-mono);font-size:11px;letter-spacing:1px;border:1px solid rgba(99,179,237,0.4);border-radius:4px;background:rgba(99,179,237,0.08);color:#63b3ed;cursor:pointer;transition:all 0.15s;"
            onmouseover="this.style.background='rgba(99,179,237,0.18)'" onmouseout="this.style.background='rgba(99,179,237,0.08)'">
            EDIT
          </button>
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
        </div>
        <div id="editForm_${addr}" style="display:none;margin-top:12px;padding:14px;background:rgba(99,179,237,0.05);border:1px solid rgba(99,179,237,0.2);border-radius:6px;">
          <div style="font-size:10px;color:#63b3ed;letter-spacing:.08em;margin-bottom:10px;">EDIT TOKEN DETAILS</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
            <div>
              <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">NAME</div>
              <input id="editName_${addr}" type="text" value="${t.name}"
                style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:8px 10px;font-family:var(--font-mono);font-size:12px;color:var(--cream);outline:none;"/>
            </div>
            <div>
              <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">SYMBOL</div>
              <input id="editSymbol_${addr}" type="text" value="${t.symbol}"
                style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:8px 10px;font-family:var(--font-mono);font-size:12px;color:var(--cream);outline:none;"/>
            </div>
          </div>
          <div style="display:flex;gap:8px;">
            <button onclick="saveTokenEdit('${addr}')"
              style="padding:6px 16px;font-family:var(--font-mono);font-size:11px;letter-spacing:1px;border:1px solid rgba(99,179,237,0.5);border-radius:4px;background:rgba(99,179,237,0.15);color:#63b3ed;cursor:pointer;">
              SAVE ON-CHAIN
            </button>
            <button onclick="document.getElementById('editForm_${addr}').style.display='none'"
              style="padding:6px 14px;font-family:var(--font-mono);font-size:11px;letter-spacing:1px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--muted);cursor:pointer;">
              CANCEL
            </button>
          </div>
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
    const tx = await contract.connect(signer).setFeaturedToken(addr, _GAS);
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
    const tx = await contract.connect(signer).removeToken(addr, _GAS);
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
    const tx = await contract.connect(signer).setTokenInProgress(addr, label, _GAS);
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

  const statsEl = document.getElementById('ownerStatsContent');
  statsEl.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const [totalUsersBN, totalInvestedWei] = await contract.getPlatformStats();
    const totalUsers        = totalUsersBN.toNumber();
    const totalInvestedETH  = parseFloat(ethers.utils.formatEther(totalInvestedWei));
    const totalInvestedUSDT = totalInvestedETH * USDT_PER_ETH;

    const tokenAddrs = await contract.getRegisteredTokens();
    let totalPoolUSDT = 0;
    const poolRows = [];

    await Promise.all(tokenAddrs.map(async addr => {
      try {
        const t    = await contract.getToken(addr);
        const pool = await _dashGetPoolPrice(addr);
        const usdtSide  = pool ? pool.resETH   * USDT_PER_ETH : 0;
        const tokenSide = pool ? pool.resToken                : 0;
        totalPoolUSDT  += pool ? pool.resETH * 2 * USDT_PER_ETH : 0;
        poolRows.push({ symbol: t.symbol, addr, usdtSide, tokenSide, hasPool: !!pool });
      } catch(_) {
        poolRows.push({ symbol: addr, addr, usdtSide: 0, tokenSide: 0, hasPool: false });
      }
    }));

    const totalUSDTSide  = poolRows.reduce((s, r) => s + r.usdtSide,  0);

    statsEl.innerHTML = `
      <div class="info-grid" style="grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr));gap:12px;">
        <div class="info-cell">
          <div class="info-cell-label">TOTAL USERS</div>
          <div class="info-cell-value" style="color:var(--gold);font-size:22px;">${totalUsers.toLocaleString()}</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-label">TOTAL INVESTED</div>
          <div class="info-cell-value" style="color:var(--gold);font-size:22px;">$${fmtNum(totalInvestedUSDT)}</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-label">USDT IN POOLS</div>
          <div class="info-cell-value" style="color:var(--gold);font-size:22px;">$${fmtNum(totalUSDTSide)}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:3px;">${tokenAddrs.length} pool${tokenAddrs.length!==1?'s':''} · USDT side only</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-label">TOTAL POOL VALUE</div>
          <div class="info-cell-value" style="color:var(--gold);font-size:22px;">$${fmtNum(totalPoolUSDT)}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:3px;">both sides combined</div>
        </div>
      </div>
      <div style="margin-top:20px;">
        <div class="section-header" style="margin-bottom:10px;">ALL POOLS</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${poolRows.length ? poolRows.map(r => `
            <div style="padding:10px 14px;background:var(--bg);border-radius:4px;border:1px solid var(--border);">
              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
                <div style="font-size:12px;font-family:var(--font-mono);">
                  <span style="color:var(--gold);letter-spacing:1px;">${r.symbol}</span>
                  <span style="color:var(--muted);font-size:10px;margin-left:8px;word-break:break-all;">${r.addr}</span>
                </div>
                ${r.hasPool ? `
                <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
                  <div style="text-align:right;">
                    <div style="font-size:10px;color:var(--muted);letter-spacing:.06em;margin-bottom:2px;">TOKEN SIDE</div>
                    <div style="font-size:13px;color:var(--cream);font-family:var(--font-mono);">${fmtNum(r.tokenSide)} ${r.symbol}</div>
                  </div>
                  <div style="width:1px;height:28px;background:var(--border);"></div>
                  <div style="text-align:right;">
                    <div style="font-size:10px;color:var(--muted);letter-spacing:.06em;margin-bottom:2px;">USDT SIDE</div>
                    <div style="font-size:13px;color:var(--cream);font-family:var(--font-mono);">$${fmtNum(r.usdtSide)}</div>
                  </div>
                </div>` : `<div style="font-size:11px;color:var(--muted);">No pool</div>`}
              </div>
            </div>
          `).join('') : '<div class="empty-state">No pools registered.</div>'}
        </div>
      </div>
    `;

  } catch(e) {
    statsEl.innerHTML = `<div style="color:var(--danger);font-size:12px;">Error loading stats: ${e.errorName || e.reason || e?.error?.message || e.message}</div>`;
  }
}

async function loadOwnerInfo() {
  if (!requireConnected()) return;
  try {
    const ownerAddr = await contract.owner();
    const rates = [];
    for (let i = 0; i < 10; i++) {
      const r = await contract.referralCommissionRates(i);
      rates.push(fmtNum(r.toNumber() / 500, 2) + '% of investment');
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
        const priceUSDT = pool ? fmtNum(pool.priceEth) : '—';
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
  ethEl.textContent = usdtVal.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' USDT';

  if (_ownerLiqIsNewPool) {
    const priceUSDT = parseFloat(document.getElementById('ownerInitialPrice').value) || 0;
    if (priceUSDT <= 0) { tokEl.textContent = 'Enter price above'; return; }
    const tokAmt = usdtVal / priceUSDT;
    tokEl.textContent = tokAmt.toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' ' + _ownerLiqTokenSym;
  } else {
    _dashGetPoolPrice(addr).then(pool => {
      if (!pool || pool.priceEth === 0) { tokEl.textContent = '—'; return; }
      const tokAmt = usdtVal / pool.priceEth;
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
    const usdtWei = ethers.utils.parseEther(usdtVal.toFixed(18));
    let tokenWei;

    if (_ownerLiqIsNewPool) {
      const priceUSDT = parseFloat(document.getElementById('ownerInitialPrice').value) || 0;
      if (priceUSDT <= 0) { toast('Enter initial price (USDT per token)', 'warn'); return; }
      const tokAmt = usdtVal / priceUSDT;
      tokenWei = ethers.utils.parseUnits(tokAmt.toFixed(_ownerLiqTokenDec), _ownerLiqTokenDec);
    } else {
      const pool = await _dashGetPoolPrice(addr);
      if (!pool) { toast('Could not fetch pool price', 'error'); return; }
      const tokAmt = usdtVal / pool.priceEth;
      tokenWei = ethers.utils.parseUnits(tokAmt.toFixed(_ownerLiqTokenDec), _ownerLiqTokenDec);
    }

    const usdtAddr = typeof USDT_ADDRESS !== 'undefined' ? USDT_ADDRESS : WETH_ADDRESS;
    const usdtAbi  = ['function transfer(address to, uint256 amount) external returns (bool)'];
    const usdtCt   = new ethers.Contract(usdtAddr, usdtAbi, signer);

    toast('Step 1/2 — Transfer USDT to contract in MetaMask…', 'info');
    await (await usdtCt.transfer(CONTRACT_ADDRESS, usdtWei, _GAS)).wait();

    toast('Step 2/2 — Seed pool in MetaMask…', 'info');
    await (await contract.connect(signer).seedPool(addr, tokenWei, usdtWei, _GAS)).wait();

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
      fmtNum(parseFloat(ethers.utils.formatEther(_ownerRem_LPBal))) + ' LP';
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
      fmtNum(parseFloat(ethers.utils.formatUnits(estTok, _ownerRem_TokenDec))) + ' ' + _ownerRem_TokenSym;
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
    const [[r0, r1], token0, totalSupply, latestBlock] = await Promise.all([
      pair.getReserves(), pair.token0(), pair.totalSupply(), provider.getBlock('latest')
    ]);
    const isToken0 = token0.toLowerCase() === addr.toLowerCase();
    const rawTok = isToken0 ? r0 : r1;
    const rawETH = isToken0 ? r1 : r0;
    const estTok = rawTok.mul(lpWei).div(totalSupply);
    const estETH = rawETH.mul(lpWei).div(totalSupply);
    const minTok = estTok.mul(9900).div(10000);
    const minETH = estETH.mul(9900).div(10000);
    const deadline = (latestBlock ? latestBlock.timestamp : Math.floor(Date.now() / 1000)) + 300;

    toast('Step 1/2 — Approve LP tokens in MetaMask…', 'info');
    const lpToken = new ethers.Contract(_ownerRem_PairAddr, ["function approve(address,uint256) returns (bool)"], signer);
    await (await lpToken.approve(DEX_ROUTER, lpWei, _GAS)).wait();

    toast('Step 2/2 — Remove liquidity in MetaMask…', 'info');
    const removeLiqAbi = ['function removeLiquidity(address tokenA, address tokenB, uint liquidity, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB)'];
    const router = new ethers.Contract(DEX_ROUTER, removeLiqAbi, signer);
    await (await router.removeLiquidity(
      addr, DEX_WETH, lpWei, minTok, minETH, walletAddress, deadline, _GAS
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
    const usdtAddr = typeof USDT_ADDRESS !== 'undefined' ? USDT_ADDRESS : WETH_ADDRESS;
    const usdtAbi  = ['function balanceOf(address account) view returns (uint256)'];
    const usdtCt   = new ethers.Contract(usdtAddr, usdtAbi, provider);
    const usdtWei  = await usdtCt.balanceOf(contract.address);
    const usdtBal  = parseFloat(ethers.utils.formatEther(usdtWei));
    el.textContent = `Contract USDT balance: ${fmtNum(usdtBal)} USDT`;
    el.style.color = usdtBal > 0 ? 'var(--gold)' : 'var(--muted)';
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
    const tx = await contract.connect(signer).withdrawETH(amtWei, _GAS);
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
    const tx = await contract.connect(signer).withdrawToken(addr, amtWei, _GAS);
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

function editToken(addr) {
  const form = document.getElementById('editForm_' + addr);
  if (!form) return;
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

async function saveTokenEdit(addr) {
  if (!requireConnected()) return;
  const name   = document.getElementById('editName_'   + addr).value.trim();
  const symbol = document.getElementById('editSymbol_' + addr).value.trim();
  if (!name || !symbol) { toast('Name and symbol cannot be empty', 'warn'); return; }
  _txBegin();
  try {
    toast('Confirm transaction in MetaMask…', 'info');
    const tx = await contract.connect(signer).updateToken(addr, name, symbol, _GAS);
    await tx.wait();
    _txDone();
    toast(`Token updated to ${symbol} (${name}).`, 'success');
    invalidateTabs('invest');
    loadTokenBalances();
  } catch(e) {
    _txDone();
    toast('Error: ' + (e.errorName || e.reason || e?.error?.message || e.message), 'error');
  }
}

window.setFeaturedToken              = setFeaturedToken;
window.editToken                     = editToken;
window.saveTokenEdit                 = saveTokenEdit;
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
