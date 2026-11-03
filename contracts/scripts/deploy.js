// Deploys the full stack and writes deployments/<network>.json, deployments/abi.json,
// and a copy of both into web/public/deployments for the app.
//
//   npm run deploy:local                       (from repo root, needs `npm run chain`)
//   PRIVATE_KEY=0x.. npm run deploy:monad
//
// Env:
//   EXPIRY_MINUTES    first expiry this many minutes from now (default: next Monday 13:30 UTC = 9:30 ET open)
//   USE_REAL_TOKENS   "USDC=0x..,NVDAx=0x..,TSLAx=0x..,SPYx=0x.." to use live tokens instead of mocks
//   PYTH_ADDRESS      use PythSettlementOracle on this Pyth contract instead of the reporter oracle
//   PYTH_IDS          "NVDAx=0x..,TSLAx=0x..,SPYx=0x.." Pyth price ids (per share; multiplier applied onchain)
//   DEX_ROUTER        spot venue adapter for HedgedMaker (default: MockDex on mock deployments)
//   MAKER_OPERATOR    address that runs the HedgedMaker (default: local account #4, or the deployer)
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
  "CommitVault", "ShieldedLender", "HedgedMaker", "MockDex", "MockERC20", "MockXStock",
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

  let dexAddr = process.env.DEX_ROUTER || null;
  if (!dexAddr && mocks) dexAddr = await (await F("MockDex", O, usdcAddr)).getAddress();
  const hedged = dexAddr ? await F("HedgedMaker", P, dexAddr, deployer.address, operator) : null;

  const pythIds = parseMap(process.env.PYTH_IDS);
  const stocks = [];
  for (const st of STOCKS) {
    const addr = real[st.symbol] || (await (await F("MockXStock", st.name, st.symbol, deployer.address)).getAddress());
    await (await protocol.setUnderlying(addr, true)).wait();
    if (oracleKind === "reporter") await (await oracle.pushSpot(addr, usd(st.spot))).wait();
    else if (pythIds[st.symbol]) await (await oracle.setFeed(addr, pythIds[st.symbol], true, 3600)).wait();

    const series = [];
    const add = async (expiry, kind, strike, strike2) => {
      const ev = await sendAndParse(protocol, "createSeries", [addr, expiry, kind, usd(strike), strike2 ? usd(strike2) : 0], "SeriesCreated");
      series.push({ id: Number(ev.args.seriesId), expiry, kind, strike, strike2: strike2 || 0, token: ev.args.token });
    };
    for (const expiry of expiries) {
      for (const step of STRIKE_STEPS) {
        const k = roundStrike(st.spot * (1 + step));
        await add(expiry, KIND.CALL, k, 0);
        await add(expiry, KIND.PUT, k, 0);
      }
      for (const [a, b] of SPREAD_LEGS) {
        await add(expiry, KIND.CALL_SPREAD, roundStrike(st.spot * (1 + a)), roundStrike(st.spot * (1 + b)));
        await add(expiry, KIND.PUT_SPREAD, roundStrike(st.spot * (1 - a)), roundStrike(st.spot * (1 - b)));
      }
    }

    const gapRound = Number(await gap.roundCount());
    await (await gap.openRound(addr, now, e1, usd(st.spot))).wait();
    const vault = await F("CommitVault", P, addr, `Auto-Commit ${st.symbol}`, `ac${st.symbol}`, deployer.address);
    const lender = await F("ShieldedLender", P, addr, deployer.address);

    stocks.push({
      symbol: st.symbol, name: st.name, spot: st.spot, vol: st.vol, address: addr,
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
    if (hedged) await (await usdc.mint(await hedged.getAddress(), usd(2_000_000))).wait();
  }

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    rpc: local ? "http://127.0.0.1:8545" : network.config.url,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    expiries,
    settlementWindow: 600,
    mocks,
    oracleKind,
    usdc: usdcAddr,
    oracle: O,
    protocol: P,
    gap: await gap.getAddress(),
    dex: dexAddr,
    hedgedMaker: hedged ? await hedged.getAddress() : null,
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
