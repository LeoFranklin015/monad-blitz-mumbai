// Shared setup for tests that fork Monad testnet and trade on Kuru's real books.
// Addresses read from the chain on Nov 4 2026 (docs.kuru.io/deployments/testnet).
const { ethers, network } = require("hardhat");
const { clearSnapshots } = require("@nomicfoundation/hardhat-network-helpers");

const FORK_RPC = process.env.FORK_RPC;
const KURU = {
  accountCore: "0xe08573a1Ecc4aa507c9626071fA0c4513caf7906",
  usdc: "0xb01DC575a7ef75e58A05D2bde73ab79f8e7dd0Be", // Kuru Test USDC, 6 decimals
  tokenAdmin: "0xfeb3BF5CE7A6b0A59bcc6cb8308661b45aCa002c", // owner of the test tokens, can mint
  stocks: {
    NVDAx: { token: "0x1cA0772B36E70ff54525afee1DAEe846Cd914D02", market: "0xE9C2B9E0F296dbeC9dcc3C8F0F64928F2F8bC081" },
    TSLAx: { token: "0x7DA7742FCdFD472697A52B0Aaff818CAe3139656", market: "0x7A53BB8d8A8765418FfE331A02BF5984264922AA" },
    SPYx: { token: "0x8BF70Ce58A038f741b4e187ADea126c8cAB867c2", market: "0x185Af307dAfd968033337A0180E66B920B4b05Ca" },
  },
};

const ERC20 = [
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

/// `describe` when FORK_RPC is set, `describe.skip` otherwise, so `npm test` stays offline.
const forkDescribe = FORK_RPC ? describe : describe.skip;

/// Reset the in-process chain onto Monad testnet and return token handles that can mint.
async function forkKuru() {
  await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: FORK_RPC } }] });
  await clearSnapshots(); // loadFixture snapshots from earlier files point at the chain we just replaced
  // Calls at the fork block itself need a hardfork history for chain 10143, which hardhat_reset doesn't pick up.
  // One local block puts every later call on a block Hardhat runs itself.
  await network.provider.request({ method: "hardhat_mine", params: ["0x1"] });
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [KURU.tokenAdmin] });
  await network.provider.request({ method: "hardhat_setBalance", params: [KURU.tokenAdmin, "0x56BC75E2D63100000"] });
  const admin = await ethers.getSigner(KURU.tokenAdmin);
  const usdc = new ethers.Contract(KURU.usdc, ERC20, admin);
  const nvdax = new ethers.Contract(KURU.stocks.NVDAx.token, ERC20, admin);
  const core = new ethers.Contract(
    KURU.accountCore,
    ["function getBalance(uint40,address) view returns (uint256)", "function rootAccountIdOf(address) view returns (uint40)"],
    ethers.provider
  );
  return { usdc, nvdax, core };
}

/// Put the in-process chain back, so later test files run on a clean local chain.
async function unfork() {
  await network.provider.request({ method: "hardhat_reset", params: [] });
  await clearSnapshots();
}

module.exports = { FORK_RPC, KURU, forkDescribe, forkKuru, unfork };
