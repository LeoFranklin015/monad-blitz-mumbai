// Maker bots: Black-Scholes quoting on every series, repriced every block.
//   npx hardhat run scripts/maker-bot.js --network localhost
// Env:
//   MAKER_KEYS   comma-separated private keys (default: local accounts #1..#3)
//   SIMULATE=1   also act as the price reporter and run a random-walk price feed (local demos)
//   TICK_MS      loop interval, default 400 (one Monad block)
//   RUN_SECONDS  stop after N seconds (default: run forever)
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const D = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`)));
const TICK_MS = Number(process.env.TICK_MS || 400);
const SIMULATE = process.env.SIMULATE === "1";
const RUN_SECONDS = Number(process.env.RUN_SECONDS || 0);
const SIZE = 25; // shares per quote

// ---------------------------------------------------------------- pricing

function erf(x) {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const N = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

function blackScholes(S, K, T, vol, isCall) {
  if (T <= 0) return Math.max(0, isCall ? S - K : K - S);
  const d1 = (Math.log(S / K) + 0.5 * vol * vol * T) / (vol * Math.sqrt(T));
  const d2 = d1 - vol * Math.sqrt(T);
  return isCall ? S * N(d1) - K * N(d2) : K * N(-d2) - S * N(-d1);
}

/// US cash session closed? (rough: weekends, or outside 13:30-20:00 UTC)
function marketClosed(ts) {
  const d = new Date(ts * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return true;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins < 13 * 60 + 30 || mins >= 20 * 60;
}

// ---------------------------------------------------------------- bot

async function main() {
  const signers = await ethers.getSigners();
  const reporter = signers[0];
  const makers = process.env.MAKER_KEYS
    ? process.env.MAKER_KEYS.split(",").map((k) => new ethers.Wallet(k.trim(), ethers.provider))
    : signers.slice(1, 4);
  const spreads = makers.map((_, i) => 0.06 + i * 0.03); // each maker quotes a different edge

  const protocol = await ethers.getContractAt("OptionsProtocol", D.protocol);
  const oracle = await ethers.getContractAt("SettlementOracle", D.oracle);
  const gap = await ethers.getContractAt("GapMarket", D.gap);
  const usdc = await ethers.getContractAt("MockERC20", D.usdc);

  // collateral: mint (mock only), approve, deposit
  for (const m of makers) {
    if (D.mocks) await (await usdc.connect(m).mint(m.address, ethers.parseUnits("5000000", 6))).wait();
    await (await usdc.connect(m).approve(D.protocol, ethers.MaxUint256)).wait();
    const needUsd = D.stocks.reduce((a, st) => a + st.series.filter((s) => !s.isCall).reduce((b, s) => b + s.strike * SIZE, 0), 0);
    await (await protocol.connect(m).deposit(D.usdc, ethers.parseUnits(String(Math.ceil(needUsd * 1.05)), 6))).wait();
    for (const st of D.stocks) {
      const tok = await ethers.getContractAt("MockERC20", st.address);
      const shares = st.series.filter((s) => s.isCall).length * SIZE;
      if (D.mocks) await (await tok.connect(m).mint(m.address, ethers.parseEther(String(shares)))).wait();
      await (await tok.connect(m).approve(D.protocol, ethers.MaxUint256)).wait();
      await (await protocol.connect(m).deposit(st.address, ethers.parseEther(String(shares)))).wait();
    }
  }

  const prices = Object.fromEntries(D.stocks.map((s) => [s.address, s.spot]));

  async function quoteFor(maker, i, now) {
    const out = [];
    for (const st of D.stocks) {
      const [raw] = await oracle.spot(st.address);
      let S = Number(ethers.formatUnits(raw, 6)) || st.spot;
      // weekend: lean on the gap market's implied probability as a small drift on the reference
      const closed = marketClosed(now);
      if (closed) {
        const up = Number(await gap.impliedUpBps(st.gapRound));
        S *= 1 + ((up - 5000) / 5000) * 0.01;
      }
      const vol = st.vol * (closed ? 1.3 : 1);
      const T = Math.max(D.expiry - now, 0) / (365 * 24 * 3600);
      for (const s of st.series) {
        const fair = blackScholes(S, s.strike, T, vol, s.isCall);
        const ask = Math.max(fair * (1 + spreads[i]), S * 0.0005);
        out.push({ seriesId: s.id, ask });
      }
    }
    return out;
  }

  // initial quotes
  const quoteIds = makers.map(() => ({}));
  let now = (await ethers.provider.getBlock("latest")).timestamp;
  for (let i = 0; i < makers.length; i++) {
    for (const q of await quoteFor(makers[i], i, now)) {
      const tx = await protocol.connect(makers[i]).postQuote(q.seriesId, ethers.parseUnits(q.ask.toFixed(6), 6), ethers.parseEther(String(SIZE)));
      const rc = await tx.wait();
      const ev = rc.logs.map((l) => { try { return protocol.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "QuotePosted");
      quoteIds[i][q.seriesId] = ev.args.quoteId;
    }
  }
  console.log(`${makers.length} makers quoting ${Object.keys(quoteIds[0]).length} series each`);

  let updates = 0;
  let windowStart = Date.now();
  const started = Date.now();

  while (!RUN_SECONDS || Date.now() - started < RUN_SECONDS * 1000) {
    const tick = Date.now();
    now = (await ethers.provider.getBlock("latest")).timestamp;
    if (now >= D.expiry) {
      console.log("series expired, stopping quotes");
      break;
    }

    if (SIMULATE) {
      for (const st of D.stocks) {
        const sigma = st.vol / Math.sqrt(365 * 24 * 3600 / (TICK_MS / 1000)) * 20; // exaggerated for demos
        prices[st.address] *= Math.exp(sigma * (Math.random() * 2 - 1));
        await (await oracle.connect(reporter).pushSpot(st.address, ethers.parseUnits(prices[st.address].toFixed(6), 6))).wait();
      }
    }

    await Promise.all(makers.map(async (m, i) => {
      const qs = await quoteFor(m, i, now);
      const ids = [], px = [], sz = [];
      for (const q of qs) {
        const qid = quoteIds[i][q.seriesId];
        const cur = await protocol.getQuote(qid);
        if (cur.size === 0n) continue; // filled or cancelled; leave it
        ids.push(qid);
        px.push(ethers.parseUnits(q.ask.toFixed(6), 6));
        sz.push(cur.size);
      }
      if (ids.length) {
        await (await protocol.connect(m).updateQuotes(ids, px, sz)).wait();
        updates += ids.length;
      }
    }));

    const el = (Date.now() - windowStart) / 1000;
    if (el >= 5) {
      const spots = D.stocks.map((s) => `${s.symbol} ${prices[s.address].toFixed(2)}`).join("  ");
      console.log(`${(updates / el).toFixed(0)} quote updates/s   ${SIMULATE ? spots : ""}`);
      updates = 0;
      windowStart = Date.now();
    }
    const wait = TICK_MS - (Date.now() - tick);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
