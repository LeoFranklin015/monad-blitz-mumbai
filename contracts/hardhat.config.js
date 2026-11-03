require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Compile with the solc package from npm, so builds work offline and behind strict proxies.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: "0.8.24+commit.e11b9ed9",
    };
  }
  return runSuper();
});

// Load contracts/.env if present. Real env vars win.
const fs = require("fs");
const envFile = require("path").join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined && m[2] !== "") process.env[m[1]] = m[2];
  }
}

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" },
  },
  paths: { sources: "./src" },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: process.env.LOCAL_RPC || "http://127.0.0.1:8545" },
    // JAW passkey accounts are supported on Monad mainnet and Base Sepolia, not Monad testnet.
    monad: { url: process.env.MONAD_RPC || "https://rpc.monad.xyz", chainId: 143, accounts },
    monadTestnet: { url: process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz", chainId: 10143, accounts },
    baseSepolia: { url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org", chainId: 84532, accounts },
  },
  // `npm run verify -- --network <name>` verifies every contract in deployments/<name>.json
  sourcify: { enabled: true },
  etherscan: { apiKey: process.env.ETHERSCAN_API_KEY || "" },
};
