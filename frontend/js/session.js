// ── APP NAMESPACE ──
// All shared mutable state lives on the App object so every module can read/write it.
const App = {
  provider:      null,  // StaticJsonRpcProvider (Alchemy) — fast reads, no wallet relay
  walletProvider: null, // Web3Provider (wallet) — signing only
  signer:        null,
  contract:      null,  // connected to provider (read-only) — view calls go to Alchemy
  walletAddress: null,
  wasDisconnected: false,
  isOwner:       false,
};

// Expose global aliases so inline onclick handlers still work without App. prefix.
Object.defineProperty(window, 'provider',      { get: () => App.provider,       set: v => { App.provider       = v; } });
Object.defineProperty(window, 'walletProvider',{ get: () => App.walletProvider, set: v => { App.walletProvider = v; } });
Object.defineProperty(window, 'signer',        { get: () => App.signer,         set: v => { App.signer         = v; } });
Object.defineProperty(window, 'contract',      { get: () => App.contract,       set: v => { App.contract       = v; } });
Object.defineProperty(window, 'walletAddress', { get: () => App.walletAddress,  set: v => { App.walletAddress  = v; } });
