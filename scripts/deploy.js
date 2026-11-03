// Deploys the full stack plus demo tokens, a strike grid and a gap round.
//   npx hardhat run scripts/deploy.js --network localhost
//   PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network monadTestnet
// Env:
//   EXPIRY_MINUTES   minutes until expiry (default: next Monday 13:30 UTC, i.e. 9:30 ET open)
//   USE_REAL_TOKENS  "NVDAx=0x..,TSLAx=0x..,USDC=0x.." to skip mocks on a live network
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const usd = (x) => ethers.parseUnits(String(x), 6);
const sh = (x) => ethers.parseEther(String(x));

const STOCKS = [
  { symbol: "NVDAx", name: "NVIDIA xStock", spot: 200, vol: 0.5 },
  { symbol: "TSLAx", name: "Tesla xStock", spot: 440, vol: 0.65 },
  { symbol: "SPYx", name: "SP500 xStock", spot: 680, vol: 0.18 },
];
const STRIKE_STEPS = [-0.1, -0.05, -0.025, 0.025, 0.05, 0.1];

function nextMondayOpen() {
  const d = new Date();
  const day = d.getUTCDay();
  const add = ((1 - day + 7) % 7) || 7;
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 13, 30));
  return Math.floor(m.getTime() / 1000);
}

function roundStrike(px) {
  const step = px >= 500 ? 5 : px >= 100 ? 2.5 : 1;
  return Math.round(px / step) * step;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const latest = (await ethers.provider.getBlock("latest")).timestamp;
  const expiry = process.env.EXPIRY_MINUTES
    ? latest + Number(process.env.EXPIRY_MINUTES) * 60
    : nextMondayOpen();
  const real = Object.fromEntries(
    (process.env.USE_REAL_TOKENS || "").split(",").filter(Boolean).map((kv) => kv.split("="))
  );

  console.log(`network ${network.name}, deployer ${deployer.address}`);
  const ERC20 = await ethers.getContractFactory("MockERC20");

  const usdcAddr = real.USDC || (await (await ERC20.deploy("USD Coin", "USDC", 6)).getAddress());
  const usdc = await ethers.getContractAt("MockERC20", usdcAddr);

  const oracle = await (await ethers.getContractFactory("SettlementOracle")).deploy(deployer.address, 600);
  const protocol = await (await ethers.getContractFactory("OptionsProtocol")).deploy(
    usdcAddr,
    await oracle.getAddress(),
    deployer.address
  );
  const gap = await (await ethers.getContractFactory("GapMarket")).deploy(
    usdcAddr,
    await oracle.getAddress(),
    deployer.address
  );
  const P = await protocol.getAddress();

  const stocks = [];
  for (const st of STOCKS) {
    const addr = real[st.symbol] || (await (await ERC20.deploy(st.name, st.symbol, 18)).getAddress());
    await (await protocol.setUnderlying(addr, true)).wait();
    await (await oracle.pushSpot(addr, usd(st.spot))).wait();

    const series = [];
    for (const step of STRIKE_STEPS) {
      const strike = roundStrike(st.spot * (1 + step));
      const isCall = step > 0;
      const tx = await protocol.createSeries(addr, expiry, isCall, usd(strike));
      const rc = await tx.wait();
      const ev = rc.logs.map((l) => { try { return protocol.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "SeriesCreated");
      series.push({ id: Number(ev.args.seriesId), isCall, strike, token: ev.args.token });
    }

    const gapId = Number(await gap.roundCount());
    await (await gap.openRound(addr, latest, expiry, usd(st.spot))).wait();

    const vault = await (await ethers.getContractFactory("CommitVault")).deploy(
      P, addr, `Auto-Commit ${st.symbol}`, `ac${st.symbol}`, deployer.address
    );
    const lender = await (await ethers.getContractFactory("ShieldedLender")).deploy(P, addr, deployer.address);

    stocks.push({
      ...st,
      address: addr,
      series,
      gapRound: gapId,
      vault: await vault.getAddress(),
      lender: await lender.getAddress(),
    });
    console.log(`${st.symbol} ${addr}: ${series.length} series, gap round ${gapId}`);
  }

  // Seed demo balances and lender liquidity when we control the mocks.
  if (!real.USDC) {
    await (await usdc.mint(deployer.address, usd(10_000_000))).wait();
    await (await usdc.approve(stocks[0].lender, ethers.MaxUint256)).wait();
    for (const st of stocks) {
      const lender = await ethers.getContractAt("ShieldedLender", st.lender);
      await (await usdc.approve(st.lender, ethers.MaxUint256)).wait();
      await (await lender.fund(usd(500_000))).wait();
    }
  }

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    expiry,
    settlementWindow: 600,
    usdc: usdcAddr,
    oracle: await oracle.getAddress(),
    protocol: P,
    gap: await gap.getAddress(),
    rpc: network.config.url || null,
    mocks: !real.USDC,
    stocks,
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
  fs.mkdirSync(path.join(__dirname, "..", "app"), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, "..", "app", "deployment.js"),
    `window.DEPLOYMENT = ${JSON.stringify(out, null, 2)};\n`
  );
  console.log(`saved deployments/${network.name}.json and app/deployment.js`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
