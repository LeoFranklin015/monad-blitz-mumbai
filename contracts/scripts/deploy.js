// Deploys the full stack and writes deployments/<network>.json, deployments/abi.json,
// and a copy of both into web/public/deployments for the app.
//
//   npm run deploy:local                       (from repo root, needs `npm run chain`)
//   PRIVATE_KEY=0x.. npm run deploy:monad
//   npm run deploy:monad-testnet               (Kuru's test tokens and books: see contracts/monad-testnet.env.example)
//
// Env:
//   EXPIRY_MINUTES    first expiry this many minutes from now (default: next Monday 13:30 UTC = 9:30 ET open)
//   USE_REAL_TOKENS   "USDC=0x..,NVDAx=0x..,TSLAx=0x..,SPYx=0x.." to use live tokens instead of mocks
//   PYTH_ADDRESS      use PythSettlementOracle on this Pyth contract instead of the reporter oracle
//   PYTH_IDS          "NVDAx=0x..,TSLAx=0x..,SPYx=0x.." Pyth price ids (per share; multiplier applied onchain)
//   DEX_ROUTER        spot venue adapter for HedgedMaker (default: MockDex on mock deployments)
//   MAKER_OPERATOR    address that runs the HedgedMaker (default: local account #4, or the deployer)
//   KURU_ACCOUNT_CORE Kuru AccountCore. With KURU_MARKETS, deploys KuruAdapter as the hedge venue (unless DEX_ROUTER
//                     is set), centres spots and strikes on Kuru's mid prices, and records each market for the backend
//   KURU_MARKETS      "NVDAx=0x..,TSLAx=0x..,SPYx=0x.." Kuru stock/USDC markets
//   HOOK_GAS          fill-hook gas budget (default 1,000,000 with Kuru: a hedge there is ~430k-490k gas)
const fs = require("fs");
const path = require("path");
const { ethers, network, artifacts } = require("hardhat");

const usd = (x) => ethers.parseUnits(Number(x).toFixed(6), 6);
const sh = (x) => ethers.parseEther(String(x));
const KIND = { CALL: 0, PUT: 1, CALL_SPREAD: 2, PUT_SPREAD: 3 };

const STOCKS = [
  { symbol: "NVDAx", name: "NVIDIA xStock", spot: 200, vol: 0.5 },
  { symbol: "TSLAx", name: "Tesla xStock", spot: 440, vol: 0.65 },
  { symbol: "SPYx", name: "SP500 xStock", spot: 680, vol: 0.18 },
];
const STRIKE_STEPS = [-0.1, -0.05, -0.025, 0, 0.025, 0.05, 0.1];
const SPREAD_LEGS = [[0.025, 0.075], [0.05, 0.1]]; // Capped Upside legs above spot, mirrored for Budget Floors
const ABI_CONTRACTS = [
  "OptionsProtocol", "OptionToken", "SettlementOracle", "PythSettlementOracle", "GapMarket",
  "CommitVault", "ShieldedLender", "HedgedMaker", "MockDex", "MockERC20", "MockXStock", "KuruAdapter",
];

const parseMap = (s) => Object.fromEntries((s || "").split(",").filter(Boolean).map((kv) => kv.split("=").map((x) => x.trim())));

function nextMondayOpen(nowSec) {
  const d = new Date(nowSec * 1000);
  const add = ((1 - d.getUTCDay() + 7) % 7) || 7;
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 13, 30) / 1000);
}

function roundStrike(px) {
  const step = px >= 500 ? 5 : px >= 100 ? 2.5 : 1;
  return Math.round(px / step) * step;
}

async function sendAndParse(contract, fn, args, eventName) {
  const rc = await (await contract[fn](...args)).wait();
  for (const l of rc.logs) {
    try {
      const ev = contract.interface.parseLog(l);
      if (ev && ev.name === eventName) return ev;
    } catch {}
  }
  return null;
}

/// Mid price of a Kuru stock/USDC market from its order book, in USDC.
async function kuruMid(market) {
  const m = await ethers.getContractAt("IKuruMarket", market);
  const [[bid, ask], pp] = await Promise.all([m.bestBidAsk(), m.pricePrecision()]);
  if (ask === 0n || bid === 2n ** 32n - 1n) throw new Error(`Kuru market ${market} has an empty side`);
  return Number(bid + ask) / 2 / Number(pp);
}

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const local = network.name === "localhost" || network.name === "hardhat";
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const e1 = process.env.EXPIRY_MINUTES ? now + Number(process.env.EXPIRY_MINUTES) * 60 : nextMondayOpen(now);
  const expiries = [e1, e1 + 7 * 24 * 3600];
  const real = parseMap(process.env.USE_REAL_TOKENS);
  const mocks = !real.USDC;
  const operator = process.env.MAKER_OPERATOR || (local ? signers[4].address : deployer.address);
  // Each backend service runs with its own key. Local defaults are well-known dev accounts.
  const roles = {
    keeper: process.env.KEEPER_ADDRESS || (local ? signers[10].address : deployer.address),
    reporter: process.env.REPORTER_ADDRESS || (local ? signers[12].address : deployer.address),
    hedger: process.env.HEDGER_ADDRESS || (local ? signers[11].address : deployer.address),
    guardian: process.env.GUARDIAN_ADDRESS || deployer.address,
  };
  const deployBlock = await ethers.provider.getBlockNumber();

  console.log(`network ${network.name} · deployer ${deployer.address}`);
  const F = async (name, ...args) => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  const usdcAddr = real.USDC || (await (await F("MockERC20", "USD Coin", "USDC", 6)).getAddress());
  const usdc = await ethers.getContractAt("MockERC20", usdcAddr);

  let oracle;
  let oracleKind;
  if (process.env.PYTH_ADDRESS) {
    oracle = await F("PythSettlementOracle", process.env.PYTH_ADDRESS, deployer.address, 600);
    oracleKind = "pyth";
  } else {
    oracle = await F("SettlementOracle", deployer.address, 600);
    oracleKind = "reporter";
  }
  const O = await oracle.getAddress();
  const protocol = await F("OptionsProtocol", usdcAddr, O, deployer.address);
  const P = await protocol.getAddress();
  const gap = await F("GapMarket", usdcAddr, O, deployer.address);
  await (await protocol.setGuardian(roles.guardian)).wait();
  await (await gap.setGuardian(roles.guardian)).wait();
  await (await gap.setOpener(roles.keeper)).wait();
  if (oracleKind === "reporter" && roles.reporter !== deployer.address) await (await oracle.setReporter(roles.reporter, true)).wait();

  const kuruCore = process.env.KURU_ACCOUNT_CORE || null;
  const kuruMarkets = parseMap(process.env.KURU_MARKETS);
  let dexAddr = process.env.DEX_ROUTER || null;
  let kuruAdapter = null;
  if (!dexAddr && kuruCore) {
    kuruAdapter = await F("KuruAdapter", kuruCore, usdcAddr, deployer.address);
    dexAddr = await kuruAdapter.getAddress();
  }
  if (!dexAddr && mocks) dexAddr = await (await F("MockDex", O, usdcAddr)).getAddress();
  if (kuruCore) await (await protocol.setHookGas(Number(process.env.HOOK_GAS || 1_000_000))).wait();
  const hedged = dexAddr ? await F("HedgedMaker", P, dexAddr, deployer.address, operator) : null;
  if (hedged) await (await hedged.setHook(true)).wait();

  const pythIds = parseMap(process.env.PYTH_IDS);
  const multSource = parseMap(process.env.MULTIPLIER_SOURCES); // SYMBOL=contract exposing multiplier()
  const stocks = [];
  for (const st of STOCKS) {
    const addr = real[st.symbol] || (await (await F("MockXStock", st.name, st.symbol, deployer.address)).getAddress());
    const kuruMarket = kuruMarkets[st.symbol] || null;
    const spot = kuruMarket ? await kuruMid(kuruMarket) : st.spot; // strikes centre on the price being hedged
    if (kuruAdapter && kuruMarket) await (await kuruAdapter.setMarket(addr, kuruMarket)).wait();
    await (await protocol.setUnderlying(addr, true)).wait();
    if (oracleKind === "reporter") await (await oracle.pushSpot(addr, usd(spot))).wait();
    else if (pythIds[st.symbol]) await (await oracle.setFeed(addr, pythIds[st.symbol], multSource[st.symbol] || (mocks ? addr : ethers.ZeroAddress), 3600, 50)).wait();

    const series = [];
    const add = async (expiry, kind, strike, strike2) => {
      const ev = await sendAndParse(protocol, "createSeries", [addr, expiry, kind, usd(strike), strike2 ? usd(strike2) : 0], "SeriesCreated");
      series.push({ id: Number(ev.args.seriesId), expiry, kind, strike, strike2: strike2 || 0, token: ev.args.token });
    };
    for (const expiry of expiries) {
      for (const step of STRIKE_STEPS) {
        const k = roundStrike(spot * (1 + step));
        await add(expiry, KIND.CALL, k, 0);
        await add(expiry, KIND.PUT, k, 0);
      }
      for (const [a, b] of SPREAD_LEGS) {
        await add(expiry, KIND.CALL_SPREAD, roundStrike(spot * (1 + a)), roundStrike(spot * (1 + b)));
        await add(expiry, KIND.PUT_SPREAD, roundStrike(spot * (1 - a)), roundStrike(spot * (1 - b)));
      }
    }

    const gapRound = Number(await gap.roundCount());
    await (await gap.openRound(addr, now, e1, usd(spot))).wait();
    const vault = await F("CommitVault", P, addr, `Auto-Commit ${st.symbol}`, `ac${st.symbol}`, deployer.address);
    await (await vault.setKeeper(roles.keeper)).wait();
    const lender = await F("ShieldedLender", P, addr, deployer.address);

    stocks.push({
      symbol: st.symbol, name: st.name, spot, vol: st.vol, address: addr, kuruMarket,
      series, gapRounds: [{ id: gapRound, lockTime: e1 }],
      vault: await vault.getAddress(), lender: await lender.getAddress(),
    });
    console.log(`${st.symbol} ${addr} · ${series.length} series · vault + lender + gap round ${gapRound}`);
  }

  if (mocks) {
    // Seed lender liquidity, spot venue inventory and the hedged maker's inventory.
    await (await usdc.mint(deployer.address, usd(50_000_000))).wait();
    for (const st of stocks) {
      await (await usdc.approve(st.lender, ethers.MaxUint256)).wait();
      await (await (await ethers.getContractAt("ShieldedLender", st.lender)).fund(usd(1_000_000))).wait();
      const tok = await ethers.getContractAt("MockXStock", st.address);
      if (dexAddr) await (await tok.mint(dexAddr, sh(100_000))).wait();
      if (hedged) await (await tok.mint(await hedged.getAddress(), sh(2_000))).wait();
    }
    if (dexAddr) await (await usdc.mint(dexAddr, usd(20_000_000))).wait();
    await (await usdc.mint(roles.keeper, usd(5_000_000))).wait(); // liquidation float
    await (await usdc.mint(roles.hedger, usd(5_000_000))).wait(); // hedge float
    for (const st of stocks) await (await (await ethers.getContractAt("MockXStock", st.address)).mint(roles.hedger, sh(5_000))).wait();
    if (hedged) await (await usdc.mint(await hedged.getAddress(), usd(2_000_000))).wait();
  }

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    rpc: local ? process.env.LOCAL_RPC || "http://127.0.0.1:8545" : network.config.url,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    deployBlock,
    roles,
    expiries,
    settlementWindow: 600,
    mocks,
    oracleKind,
    usdc: usdcAddr,
    oracle: O,
    pyth: process.env.PYTH_ADDRESS || null,
    protocol: P,
    tokenFactory: await protocol.tokenFactory(),
    gap: await gap.getAddress(),
    dex: dexAddr,
    hedgedMaker: hedged ? await hedged.getAddress() : null,
    kuruAccountCore: kuruCore,
    kuruAdapter: kuruAdapter ? await kuruAdapter.getAddress() : null,
    makerOperator: operator,
    stocks,
  };

  const abi = {};
  for (const n of ABI_CONTRACTS) abi[n] = (await artifacts.readArtifact(n)).abi;

  const root = path.join(__dirname, "..", "..");
  for (const dir of [path.join(root, "deployments"), path.join(root, "web", "public", "deployments")]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(dir, "abi.json"), JSON.stringify(abi));
  }
  const total = stocks.reduce((a, s) => a + s.series.length, 0);
  console.log(`${total} series across ${expiries.length} expiries · saved deployments/${network.name}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
