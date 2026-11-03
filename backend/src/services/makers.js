// Maker bots. Each one quotes asks and bids on every live series, repriced every tick.
// A separate HedgedMaker contract quotes the cash-collateralized series tighter and
// hedges every fill on spot inside the buyer's transaction.
import { ethers } from "ethers";
import { D, config, KIND } from "../config.js";
import { contracts, signer, send, usdTo, shTo, usdFrom, log } from "../lib/chain.js";
import { state, liveSeries } from "../lib/market.js";

const MIN_PX = 0.01;
const CHUNK = 60;
const POST_CHUNK = 20; // keeps each tx well under the 16.7M per-transaction gas cap

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function makerSpec(i) {
  return { spread: 0.05 + i * 0.03, jitter: 0.001 };
}

async function fundMaker(s, addr) {
  const c = contracts(s);
  if (D.mocks) {
    await send(s, "mint usdc", () => c.usdc.mint(addr, usdTo(30_000_000)));
    for (const st of D.stocks) await send(s, "mint stock", () => c.stock(st.address).mint(addr, shTo(20_000)));
  }
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
      byMaker.get(m).set(`${s.id}:${side}`, { qid, size: q.size, price: q.price });
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

/// Plan posts and updates for one maker. `filter` limits which series it quotes.
function plan(mine, series, spec, sides, free) {
  const posts = { ids: [], isBid: [], prices: [], sizes: [] };
  const upd = { ids: [], prices: [], sizes: [] };
  for (const s of series) {
    const f = state.fair.get(s.id);
    if (!f) continue;
    const j = 1 + (Math.random() * 2 - 1) * spec.jitter;
    for (const side of sides) {
      const px = side === "ask" ? Math.max(f.price * (1 + spec.spread) * j, MIN_PX) : f.price * (1 - spec.spread) * j;
      const existing = mine.get(`${s.id}:${side}`);
      if (side === "bid" && px < MIN_PX) continue;
      if (existing && existing.size > 0n) {
        // requote only when fair value moved enough to matter, like a real maker
        const cur = Number(existing.price) / 1e6;
        if (Math.abs(px - cur) <= Math.max(cur * config.requoteBps / 10_000, 0.002)) continue;
        upd.ids.push(existing.qid);
        upd.prices.push(usdTo(px));
        upd.sizes.push(existing.size);
        continue;
      }
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
  return Object.fromEntries(tokens.map((t, i) => [t, t === D.usdc ? usdFrom(vals[i]) : Number(ethers.formatEther(vals[i]))]));
}

export async function startMakers() {
  const makers = config.makerKeys.map((k, i) => ({ s: signer(k), spec: makerSpec(i) }));
  for (const m of makers) {
    m.addr = (await m.s.getAddress()).toLowerCase();
    await fundMaker(m.s, m.addr);
  }

  let hedged = null;
  if (D.hedgedMaker && config.operatorKey) {
    const s = signer(config.operatorKey);
    hedged = { s, c: contracts(s).hedged, addr: D.hedgedMaker.toLowerCase(), spec: { spread: 0.035, jitter: 0.002 }, sent: new Map() };
    const usdcBal = await contracts().usdc.balanceOf(D.hedgedMaker);
    // keep half the USDC in the contract for buying hedges, put half in the protocol as collateral
    if (usdcBal > 0n) await send(s, "hedged deposit", () => hedged.c.depositToProtocol(D.usdc, usdcBal / 2n));
  }
  log(`makers: ${makers.length} bots${hedged ? " + hedged maker" : ""}`);

  let updates = 0;
  let t0 = Date.now();
  stats.started = Date.now();

  async function tick() {
    if (!state.updatedAt) return;
    const series = liveSeries();
    if (!series.length) return;
    const books = await snapshotBooks(series);

    const jobs = makers.map(async (m) => {
      const c = contracts(m.s);
      const free = await freeBalances(m.addr);
      const { posts, upd } = plan(books.get(m.addr) || new Map(), series, m.spec, ["ask", "bid"], free);
      for (const ch of chunks(upd.ids.map((_, i) => i), CHUNK)) {
        const r = await send(m.s, "updateQuotes", () =>
          c.protocol.updateQuotes(ch.map((i) => upd.ids[i]), ch.map((i) => upd.prices[i]), ch.map((i) => upd.sizes[i])));
        if (r) updates += ch.length;
      }
      for (const ch of chunks(posts.ids.map((_, i) => i), POST_CHUNK)) {
        const r = await send(m.s, "postQuotes", () =>
          c.protocol.postQuotes(ch.map((i) => posts.ids[i]), ch.map((i) => posts.isBid[i]), ch.map((i) => posts.prices[i]), ch.map((i) => posts.sizes[i])));
        if (r) updates += ch.length;
      }
    });

    if (hedged) {
      jobs.push((async () => {
        const cash = series.filter((s) => s.kind !== KIND.CALL);
        const free = await freeBalances(hedged.addr);
        const { posts, upd } = plan(books.get(hedged.addr) || new Map(), cash, hedged.spec, ["ask"], free);
        // hedge ratio = option delta: sold options leave the maker short delta, so it buys delta in stock
        const ids = cash.map((s) => s.id).filter((id) => state.fair.has(id) && Math.abs(state.fair.get(id).delta - (hedged.sent.get(id) ?? 99)) > 0.02);
        if (ids.length) {
          const ok = await send(hedged.s, "setHedges", () => hedged.c.setHedges(ids, ids.map((id) => shTo(state.fair.get(id).delta.toFixed(6)))));
          if (ok) ids.forEach((id) => hedged.sent.set(id, state.fair.get(id).delta));
        }
        for (const ch of chunks(upd.ids.map((_, i) => i), CHUNK)) {
          const r = await send(hedged.s, "hedged update", () =>
            hedged.c.updateQuotes(ch.map((i) => upd.ids[i]), ch.map((i) => upd.prices[i]), ch.map((i) => upd.sizes[i])));
          if (r) updates += ch.length;
        }
        for (const ch of chunks(posts.ids.map((_, i) => i), POST_CHUNK)) {
          const r = await send(hedged.s, "hedged post", () =>
            hedged.c.postQuotes(ch.map((i) => posts.ids[i]), ch.map((i) => posts.isBid[i]), ch.map((i) => posts.prices[i]), ch.map((i) => posts.sizes[i])));
          if (r) updates += ch.length;
        }
      })());
    }
    await Promise.all(jobs);

    const el = (Date.now() - t0) / 1000;
    if (el >= 10) {
      stats.quotesPerSec = updates / el;
      log(`makers: ${stats.quotesPerSec.toFixed(0)} quote updates/s on ${series.length} live series`);
      updates = 0;
      t0 = Date.now();
    }
  }

  return { tick, makers };
}

export const stats = { quotesPerSec: 0, started: 0 };
