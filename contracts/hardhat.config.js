require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const SOLC_VERSION = "0.8.28";

// Use the solc that ships in node_modules instead of downloading one.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: SOLC_VERSION,
      longVersion: "0.8.28+commit.7893614a", // exact build, needed for explorer verification
    };
  }
  return runSuper();
});

// Keys come from the env, or from ../.wallets/wallets.json made by new-wallets.bat (never committed).
function walletKeys() {
  try {
    const w = require("../.wallets/wallets.json").wallets;
    return [w.deployer.privateKey, w.owner.privateKey];
  } catch {
    return [];
  }
}
const PK = process.env.DEPLOYER_PRIVATE_KEY;
const ACCOUNTS = PK ? [PK] : walletKeys();

module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: { optimizer: { enabled: true, runs: 1000 }, viaIR: true, evmVersion: "cancun" },
  },
  etherscan: {
    apiKey: { robinhood: "blockscout" }, // Blockscout needs no real key
    customChains: [
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
    ],
  },
  sourcify: { enabled: false },
  networks: {
    robinhood: {
      url: process.env.ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts: ACCOUNTS,
    },
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC || "",
      chainId: 46630,
      accounts: ACCOUNTS,
    },
  },
};
