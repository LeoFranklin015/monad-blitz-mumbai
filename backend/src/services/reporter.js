// Price reporter.
//  - Reporter oracle: pushes spot (simulated random walk on local/demo chains) and posts
//    settlement samples during each expiry's window.
//  - Pyth oracle: pulls signed updates from Hermes and submits them as settlement samples.
//    Anyone can do this; no trust in the reporter.
import { ethers } from "ethers";
import { D, config } from "../config.js";
import { contracts, signer, send, usdTo, log, provider } from "../lib/chain.js";
import { state } from "../lib/market.js";
import { metrics } from "../lib/obs.js";
import { kuruBook } from "../lib/kuruBook.js";

const SAMPLES_PER_EXPIRY = 5;

export async function startReporter() {
  if (!config.reporterKey) {
    log("reporter: no REPORTER_KEY, skipping");
    return { tick: async () => {} };
  }
  const s = signer(config.reporterKey);
  const { oracle } = contracts(s);
  const prices = Object.fromEntries(D.stocks.map((st) => [st.address, st.spot]));
  const sampled = new Map(); // `${asset}:${expiry}` -> count
  // Only the reporter oracle takes pushed spot; a Pyth deployment ignores priceSource.
  const source = D.oracleKind === "reporter" ? config.priceSource : "none";
  const lastPush = {}; // asset -> { px, at }
  log(`reporter: ${D.oracleKind} oracle${source === "kuru" ? ", spot from Kuru mid prices" : source === "sim" ? ", simulated feed" : ""}`);

  /// Push each stock's Kuru mid when it moved enough or the last push is getting old.
  if (source === "kuru") for (const st of D.stocks) if (!st.kuruMarket) log(`! reporter: ${st.symbol} has no Kuru market in the deployment, its spot won't move`);

  async function pushKuru() {
    for (const st of D.stocks) {
      if (!st.kuruMarket) continue;
      let book;
      try {
        book = await kuruBook(provider, st.kuruMarket);
      } catch (err) {
        log(`reporter: kuru ${st.symbol}: ${err.message}`);
        continue;
      }
      if (!book) continue; // a side of the book is empty: keep the last price rather than invent one
      const last = lastPush[st.address];
      const moved = last ? Math.abs(book.mid / last.px - 1) * 10_000 : Infinity;
      if (moved < config.kuruPushBps && Date.now() - last.at < config.kuruPushMaxSec * 1000) continue;
      const r = await send(s, "pushSpot", () => oracle.pushSpot(st.address, usdTo(book.mid)));
      if (!r) continue;
      lastPush[st.address] = { px: book.mid, at: Date.now() };
      metrics.set("kuru_mid", { stock: st.symbol }, book.mid.toFixed(4)); // only prices the oracle accepted
    }
  }

  async function pythUpdate(st) {
    const id = config.pythIds[st.symbol];
    if (!id) return null;
    const r = await fetch(`${config.hermes}/v2/updates/price/latest?ids[]=${id}&encoding=hex`);
    if (!r.ok) throw new Error(`hermes ${r.status}`);
    const j = await r.json();
    return j.binary.data.map((h) => "0x" + h);
  }

  async function tick() {
    const now = state.now;
    if (!now) return;

    if (source === "kuru") await pushKuru();
    else if (source === "sim") {
      for (const st of D.stocks) {
        const cur = state.spots[st.address] || prices[st.address];
        const sigma = st.vol * Math.sqrt(config.tickMs / 1000 / (365 * 24 * 3600)) * 8; // livelier than real minute-by-minute moves, for demos
        prices[st.address] = cur * Math.exp(sigma * (Math.random() * 2 - 1));
        await send(s, "pushSpot", () => oracle.pushSpot(st.address, usdTo(prices[st.address])));
      }
    }

    const expiries = [...new Set(state.series.map((x) => x.expiry))];
    for (const e of expiries) {
      if (now < e || now > e + D.settlementWindow) continue;
      for (const st of D.stocks) {
        const key = `${st.address}:${e}`;
        const n = sampled.get(key) || 0;
        if (n >= SAMPLES_PER_EXPIRY) continue;
        if (D.oracleKind === "pyth") {
          try {
            const upd = await pythUpdate(st);
            if (!upd) continue;
            const pyth = new ethers.Contract(await oracle.pyth(), ["function getUpdateFee(bytes[]) view returns (uint256)"], provider);
            const fee = await pyth.getUpdateFee(upd);
            const r = await send(s, "recordSample", () => oracle.recordSample(st.address, e, upd, { value: fee }));
            if (r) sampled.set(key, n + 1);
          } catch (err) {
            log(`reporter: pyth ${st.symbol}: ${err.message}`);
          }
        } else {
          const px = state.spots[st.address] || prices[st.address];
          const r = await send(s, "pushSample", () => oracle.pushSample(st.address, e, usdTo(px)));
          if (r) sampled.set(key, n + 1);
        }
      }
    }
    metrics.beat("reporter");
  }
  return { tick };
}
