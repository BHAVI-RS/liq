require("@nomicfoundation/hardhat-ethers");
require("dotenv").config();

const MAINNET_RPC = process.env.MAINNET_RPC_URL
  || (process.env.INFURA_KEY  && `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`)
  || (process.env.ALCHEMY_KEY && `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      initialBaseFeePerGas: 0,
      forking: {
        url: MAINNET_RPC,
        // blockNumber: 21000000,
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
  },
  defaultNetwork: "hardhat",
};