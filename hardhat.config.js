require("@nomicfoundation/hardhat-ethers");
require("dotenv").config();

const MAINNET_RPC = process.env.MAINNET_RPC_URL
  || (process.env.ALCHEMY_KEY && `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`)
  || (process.env.INFURA_KEY  && `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`)
  // publicnode.com is not an archive node — set ALCHEMY_KEY or MAINNET_RPC_URL in .env
  || "https://ethereum.publicnode.com";

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
      forking: {
        url: MAINNET_RPC,
        blockNumber: 21000000,
      },
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        count: 60
      }
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: (process.env.PRIVATE_KEY && process.env.PRIVATE_KEY.length === 64)
        ? [process.env.PRIVATE_KEY]
        : [],
    },
    polygonAmoy: {
      url: process.env.POLYGON_AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      timeout: 120000,       // 2 min — prevents HeadersTimeoutError on slow RPC
      accounts: (process.env.PRIVATE_KEY && process.env.PRIVATE_KEY.length === 64)
        ? [process.env.PRIVATE_KEY]
        : [],
    },
  },
  defaultNetwork: "hardhat",
};