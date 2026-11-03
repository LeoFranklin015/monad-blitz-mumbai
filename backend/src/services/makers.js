// Maker bots. Each quotes asks and bids on every quotable series, repriced when fair value moves.
// The HedgedMaker contract quotes cash-collateralized series tighter and hedges every fill on
// spot inside the buyer's transaction.
//
// Risk controls:
//  - quotes are pulled when a stock's feed is stale while the market is open, after a price jump,
//    in the last minutes before expiry, and when the protocol is paused
//  - new asks stop on a stock once the bot's net short delta there exceeds MAX_SHORT_DELTA
//  - on shutdown (SIGTERM/SIGINT) every live quote is cancelled before exit
import { ethers } from "ethers";
import { D, config, KIND } from "../config.js";
import { contracts, signer, send, usdTo, shTo, usdFrom, shFrom, log } from "../lib/chain.js";
import { state, liveSeries, quotableSeries } from "../lib/market.js";
import { metrics } from "../lib/obs.js";

const MIN_PX = 0.01;
const UPDATE_CHUNK = 60;
const POST_CHUNK = 20; // keeps each tx well under the per-transaction gas cap

const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export const stats = { quotesPerSec: 0, started: 0, liveQuotes: 0 };

async function fundMaker(s, addr) {
  const c = contracts(s);
  if (D.mocks) {
    await send(s, "mint usdc", () => c.usdc.mint(addr, usdTo(30_000_000)));
    for (const st of D.stocks) await send(s, "mint stock", () => c.stock(st.address).mint(addr, shTo(20_000)));
  }
  if (process.env.MAKER_AUTO_DEPOSIT === "0") return;
  await send(s, "approve usdc", () => c.usdc.approve(D.protocol, ethers.MaxUint256));
  const bal = await c.usdc.balanceOf(addr);
  if (bal > 0n) await send(s, "deposit usdc", () => c.protocol.deposit(D.usdc, bal));
  for (const st of D.stocks) {
    const t = c.stock(st.address);
    await send(s, "approve stock", () => t.approve(D.protocol, ethers.MaxUint256));
    const b = await t.balanceOf(addr);
    if (b > 0n) await send(s, "deposit stock", () => c.protocol.deposit(st.address, b));
  }
}

/// Read every live book once per tick and index live quotes by maker.
async function snapshotBooks(series) {
  const { protocol } = contracts();
  const books = await Promise.all(series.map((s) => protocol.bookOf(s.id)));
  const byMaker = new Map(); // maker -> Map("id:side" -> { qid, size, price })
  series.forEach((s, i) => {
    const [asks, bids, askIds, bidIds] = books[i];
    const put = (q, qid, side) => {
      const m = q.maker.toLowerCase();
      if (!byMaker.has(m)) byMaker.set(m, new Map());
      byMaker.get(m).set(`${s.id}:${side}`, { qid, size: q.size, price: q.price, seriesId: s.id });
    };
    asks.forEach((q, j) => put(q, askIds[j], "ask"));
    bids.forEach((q, j) => put(q, bidIds[j], "bid"));
  });
  return byMaker;
}

function collateralNeed(s, size) {
  if (s.kind === KIND.CALL) return { token: s.stock.address, amount: size };
  const width = s.kind === KIND.PUT ? s.strike : Math.abs(s.strike2 - s.strike);
  return { token: D.usdc, amount: width * size };
}

/// Plan posts, reprices and pulls for one maker.
function plan(mine, quotable, spec, sides, free, blockedStocks) {
  const posts = { ids: [], isBid: [], prices: [], sizes: [] };
  const upd = { ids: [], prices: [], sizes: [] };
  const ok = new Set(quotable.map((s) => s.id));
  // pull anything quoted on a series we may not quote right now
  for (const q of mine.values()) {
    if (!ok.has(q.seriesId)) {
      upd.ids.push(q.qid);
      upd.prices.push(0n);
      upd.sizes.push(0n);
    }
  }
  for (const s of quotable) {
    const f = state.fair.get(s.id);
    const j = 1 + (Math.random() * 2 - 1) * spec.jitter;
    for (const side of sides) {
      const px = side === "ask" ? Math.max(f.price * (1 + spec.spread) * j, MIN_PX) : f.price * (1 - spec.spread) * j;
      const existing = mine.get(`${s.id}:${side}`);
      if (side === "bid" && px < MIN_PX) continue;
      if (existing && existing.size > 0n) {
        const cur = Number(existing.price) / 1e6;
        if (Math.abs(px - cur) <= Math.max((cur * config.requoteBps) / 10_000, 0.002)) continue;
        upd.ids.push(existing.qid);
        upd.prices.push(usdTo(px));
        upd.sizes.push(existing.size);
        continue;
      }
      if (side === "ask" && blockedStocks.has(s.stock.address)) continue;
      const size = side === "ask" ? config.askSize : config.bidSize;
      const need = side === "ask" ? collateralNeed(s, size) : { token: D.usdc, amount: px * size };
      if ((free[need.token] || 0) < need.amount * 1.01) continue;
      free[need.token] -= need.amount * 1.01;
      posts.ids.push(s.id);
      posts.isBid.push(side === "bid");
      posts.prices.push(usdTo(px));
      posts.sizes.push(shTo(size));
    }
  }
  return { posts, upd };
}

async function freeBalances(addr) {
  const { protocol } = contracts();
  const tokens = [D.usdc, ...D.stocks.map((s) => s.address)];
  const vals = await Promise.all(tokens.map((t) => protocol.freeBalance(addr, t)));
  return Object.fromEntries(tokens.map((t, i) => [t, t === D.usdc ? usdFrom(vals[i]) : shFrom(vals[i])]));
}

/// Net option delta per stock for a maker (negative = short delta). Options held count long, written count short.
export async function netDelta(addr, series) {
  const { protocol, token } = contracts();
  const live = series.filter((s) => state.fair.has(s.id));
  const [w, b] = await Promise.all([
    Promise.all(live.map((s) => protocol.written(s.id, addr))),
    Promise.all(live.map((s) => token(s.token).balanceOf(addr))),
  ]);
  const out = {};
  live.forEach((s, i) => {
    const pos = shFrom(b[i]) - shFrom(w[i]);
    out[s.stock.address] = (out[s.stock.address] || 0) + pos * state.fair.get(s.id).delta;
  });
  return out;
}

async function apply(s, target, label, { posts, upd }) {
  let n = 0;
  for (const ch of chunks(upd.ids.map((_, i) => i), UPDATE_CHUNK)) {
    const r = await send(s, `${label} updateQuotes`, () =>
      target.updateQuotes(ch.map((i) => upd.ids[i]), ch.map((i) => upd.prices[i]), ch.map((i) => upd.sizes[i])));
    if (r) n += ch.length;
  }
  for (const ch of chunks(posts.ids.map((_, i) => i), POST_CHUNK)) {
    const r = await send(s, `${label} postQuotes`, () =>
      target.postQuotes(ch.map((i) => posts.ids[i]), ch.map((i) => posts.isBid[i]), ch.map((i) => posts.prices[i]), ch.map((i) => posts.sizes[i])));
    if (r) n += ch.length;
  }
  return n;
}

export async function startMakers() {
  const makers = config.makerKeys.map((k, i) => ({ s: signer(k), spec: { spread: 0.05 + i * 0.03, jitter: 0.001 }, label: `maker${i + 1}` }));
  for (const m of makers) {
    m.addr = (await m.s.getAddress()).toLowerCase();
    m.target = contracts(m.s).protocol;
    m.blocked = new Set();
    await fundMaker(m.s, m.addr);
  }

  let hedged = null;
  if (D.hedgedMaker && config.operatorKey) {
    const s = signer(config.operatorKey);
    const c = contracts(s).hedged;
    hedged = { s, c, target: c, addr: D.hedgedMaker.toLowerCase(), spec: { spread: 0.035, jitter: 0.002 }, sent: new Map(), label: "hedged", blocked: new Set() };
    const free = await contracts().protocol.freeBalance(D.hedgedMaker, D.usdc);
    const usdcBal = await contracts().usdc.balanceOf(D.hedgedMaker);
    // keep half the USDC in the contract for buying hedges, put half in the protocol as collateral
    if (free === 0n && usdcBal > 0n) await send(s, "hedged deposit", () => c.depositToProtocol(D.usdc, usdcBal / 2n));
  }
  log(`makers: ${makers.length} bots${hedged ? " + hedged maker" : ""}`);

  let updates = 0;
  let t0 = Date.now();
  let ticks = 0;
  stats.started = Date.now();
  const { protocol } = contracts();

  async function tick() {
    if (!state.updatedAt) return;
    const paused = await protocol.paused();
    const series = liveSeries();
    if (!series.length) return;
    const quotable = paused ? [] : quotableSeries();
    const books = await snapshotBooks(series);

    // delta limits, refreshed every ~10 ticks
    if (ticks++ % 10 === 0) {
      for (const m of [...makers, ...(hedged ? [hedged] : [])]) {
        const d = await netDelta(m.addr, series);
        m.blocked = new Set(Object.entries(d).filter(([, v]) => v < -config.maxShortDelta).map(([a]) => a));
        for (const st of D.stocks) metrics.set("maker_net_delta", { maker: m.label, stock: st.symbol }, (d[st.address] || 0).toFixed(3));
      }
    }

    const jobs = makers.map(async (m) => {
      const free = await freeBalances(m.addr);
      updates += await apply(m.s, m.target, m.label, plan(books.get(m.addr) || new Map(), quotable, m.spec, ["ask", "bid"], free, m.blocked));
    });

    if (hedged) {
      jobs.push((async () => {
        const cash = quotable.filter((s) => s.kind !== KIND.CALL);
        const free = await freeBalances(hedged.addr);
        // hedge ratio = option delta: a sold option leaves the maker short delta, so it buys delta in stock
        const ids = cash.map((s) => s.id).filter((id) => Math.abs(state.fair.get(id).delta - (hedged.sent.get(id) ?? 99)) > 0.02);
        if (ids.length) {
          const ok = await send(hedged.s, "setHedges", () => hedged.c.setHedges(ids, ids.map((id) => shTo(state.fair.get(id).delta.toFixed(6)))));
          if (ok) ids.forEach((id) => hedged.sent.set(id, state.fair.get(id).delta));
        }
        updates += await apply(hedged.s, hedged.target, "hedged", plan(books.get(hedged.addr) || new Map(), cash, hedged.spec, ["ask"], free, hedged.blocked));
      })());
    }
    await Promise.all(jobs);

    let live = 0;
    for (const m of [...makers, ...(hedged ? [hedged] : [])]) live += (books.get(m.addr) || new Map()).size;
    stats.liveQuotes = live;
    metrics.set("maker_live_quotes", null, live);
    metrics.beat("makers");

    const el = (Date.now() - t0) / 1000;
    if (el >= 10) {
      stats.quotesPerSec = updates / el;
      metrics.set("quote_updates_per_sec", null, stats.quotesPerSec.toFixed(1));
      log(`makers: ${stats.quotesPerSec.toFixed(0)} quote updates/s · ${live} live quotes · ${quotable.length}/${series.length} series quotable${paused ? " · PROTOCOL PAUSED" : ""}`);
      updates = 0;
      t0 = Date.now();
    }
  }

  /// Cancel every live quote. Used on shutdown and by the kill switch.
  async function cancelAll() {
    const all = [...makers.map((m) => ({ ...m, viaHedged: false })), ...(hedged ? [{ ...hedged, viaHedged: true }] : [])];
    // makers in parallel, each sequentially; then re-read the book and retry until nothing is left
    const sweep = async (m) => {
      const ids = await protocol.quotesOf(m.addr);
      const qs = await Promise.all(ids.map((i) => protocol.getQuote(i)));
      const live = ids.filter((_, i) => qs[i].size > 0n);
      for (const ch of chunks(live, UPDATE_CHUNK)) {
        const zeros = ch.map(() => 0n);
        const ok = await send(m.s, `${m.label} cancel`, () => m.target.updateQuotes(ch, zeros, zeros));
        if (!ok) for (const id of ch) await send(m.s, `${m.label} cancel`, () => m.target.cancelQuote(id));
      }
      return live.length;
    };
    for (let pass = 1; pass <= 4; pass++) {
      const left = await Promise.all(all.map(sweep));
      const n = left.reduce((a, b) => a + b, 0);
      if (!n) break;
      log(`makers: cancel pass ${pass}: ${all.map((m, i) => `${m.label} ${left[i]}`).join(", ")}`);
    }
  }

  return { tick, cancelAll, makers, hedged };
}
