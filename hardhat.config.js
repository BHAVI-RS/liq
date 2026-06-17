require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

const MAINNET_RPC = process.env.MAINNET_RPC_URL
  || (process.env.ALCHEMY_KEY && `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`)
  || (process.env.INFURA_KEY  && `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`)
  // publicnode.com is not an archive node — set ALCHEMY_KEY or MAINNET_RPC_URL in .env
  || "https://ethereum.publicnode.com";

// Accepts a private key with or without the 0x prefix; returns [] if missing/invalid
// so Hardhat can still load read-only networks without a key configured.
function normalizeKey(key) {
  if (!key) return [];
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  return /^[0-9a-fA-F]{64}$/.test(hex) ? ["0x" + hex] : [];
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 1 },
          viaIR: true,
        },
      },
      {
        // UniswapV2Router02.sol
        version: "0.6.6",
        settings: { optimizer: { enabled: true, runs: 1 } },
      },
      {
        // UniswapV2Factory.sol (includes Pair, ERC20, libraries)
        version: "0.5.16",
        settings: { optimizer: { enabled: true, runs: 1 } },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 31337,
      initialBaseFeePerGas: 0,
      allowUnlimitedContractSize: true,
      ...(process.env.FORK_MAINNET ? {
        forking: { url: MAINNET_RPC, blockNumber: 21000000 },
      } : {}),
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        count: 60
      }
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    // Amoy testnet → AMOY_RPC_URL + AMOY_PRIVATE_KEY
    polygonAmoy: {
      url: process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      timeout: 120000,       // 2 min — prevents HeadersTimeoutError on slow RPC
      accounts: normalizeKey(process.env.AMOY_PRIVATE_KEY),
    },

    // Polygon mainnet → RPC_URL + PRIVATE_KEY
    polygon: {
      url: process.env.RPC_URL || "https://polygon-rpc.com",
      chainId: 137,
      timeout: 120000,       // 2 min — prevents HeadersTimeoutError on slow RPC
      accounts: normalizeKey(process.env.PRIVATE_KEY),
    },
  },
  // Source-code verification on block explorers (Amoy / Polygon PolygonScan).
  // PolygonScan runs on the Etherscan V2 unified API, so a single key from
  // etherscan.io/myapikey covers both Amoy (80002) and Polygon mainnet (137).
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
  sourcify: { enabled: false },
  defaultNetwork: "hardhat",
};