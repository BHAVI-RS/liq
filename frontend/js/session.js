// ── APP NAMESPACE ──
// All shared mutable state lives on the App object so every module can read/write it.
const App = {
  provider:      null,
  signer:        null,
  contract:      null,
  walletAddress: null,
  wasDisconnected: false,
  isOwner:       false,
};

// Expose global aliases so inline onclick handlers still work without App. prefix.
// These are set whenever App.* values change inside connectWallet / disconnectWallet.
Object.defineProperty(window, 'provider',      { get: () => App.provider,      set: v => { App.provider      = v; } });
Object.defineProperty(window, 'signer',        { get: () => App.signer,        set: v => { App.signer        = v; } });
Object.defineProperty(window, 'contract',      { get: () => App.contract,      set: v => { App.contract      = v; } });
Object.defineProperty(window, 'walletAddress', { get: () => App.walletAddress, set: v => { App.walletAddress = v; } });
