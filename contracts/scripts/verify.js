// Verifies every deployed contract on the network's explorer (Sourcify, plus Etherscan-style if configured).
//   npx hardhat run scripts/verify.js --network monad
// Set VERIFY_TOKENS=1 to also verify each option token (one per series).
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function verify(address, constructorArguments, contract) {
  try {
    await hre.run("verify:verify", { address, constructorArguments, contract });
    console.log(`verified ${contract || ""} ${address}`);
  } catch (e) {
    const m = e.message || String(e);
    console.log(/already verified/i.test(m) ? `already verified ${address}` : `! ${address}: ${m.split("\n")[0]}`);
  }
}

async function main() {
  const D = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "deployments", `${hre.network.name}.json`)));
  const owner = D.deployer;
  if (D.mocks) await verify(D.usdc, ["USD Coin", "USDC", 6], "src/mocks/MockERC20.sol:MockERC20");
  if (D.oracleKind === "pyth") await verify(D.oracle, [D.pyth, owner, D.settlementWindow], "src/oracle/PythSettlementOracle.sol:PythSettlementOracle");
  else await verify(D.oracle, [owner, D.settlementWindow], "src/oracle/SettlementOracle.sol:SettlementOracle");
  await verify(D.protocol, [D.usdc, D.oracle, owner], "src/core/OptionsProtocol.sol:OptionsProtocol");
  await verify(D.tokenFactory, [], "src/core/OptionToken.sol:OptionTokenFactory");
  await verify(D.gap, [D.usdc, D.oracle, owner], "src/products/GapMarket.sol:GapMarket");
  if (D.mocks && D.dex) await verify(D.dex, [D.oracle, D.usdc], "src/mocks/MockDex.sol:MockDex");
  if (D.hedgedMaker) await verify(D.hedgedMaker, [D.protocol, D.dex, owner, D.makerOperator], "src/integrations/HedgedMaker.sol:HedgedMaker");
  for (const st of D.stocks) {
    if (D.mocks) await verify(st.address, [st.name, st.symbol, owner], "src/mocks/MockXStock.sol:MockXStock");
    await verify(st.vault, [D.protocol, st.address, `Auto-Commit ${st.symbol}`, `ac${st.symbol}`, owner], "src/products/CommitVault.sol:CommitVault");
    await verify(st.lender, [D.protocol, st.address, owner], "src/integrations/ShieldedLender.sol:ShieldedLender");
    if (process.env.VERIFY_TOKENS === "1") {
      for (const s of st.series) {
        const tag = ["UP", "FLOOR", "CAPUP", "BFLOOR"][s.kind];
        await verify(s.token, [`Weekend ${tag} #${s.id}`, `${tag}-${s.id}`, s.id, D.protocol], "src/core/OptionToken.sol:OptionToken");
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
