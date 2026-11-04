import { D, config } from "../config.js";
import { contracts, usdFrom, log } from "./chain.js";
import { priceSeries, marketClosed, YEAR } from "./pricing.js";
import { metrics } from "./obs.js";
import { kuruSpot } from "./kuru.js";

/// Shared market snapshot, refreshed by the market loop and read by every service.
export const state = {
  now: 0,
  closed: false,
  spots: {},
  spotAt: {},
  gapUpBps: {},
  series: [],
  fair: new Map(), // id -> { price, delta, vol, ref }
  updatedAt: 0,
  // risk: per stock, why quoting is halted (empty = quoting allowed)
  halt: {},
};

const jumpUntil = {};

// Load series from the deployment JSON — no chain calls needed since deploy script embeds them.
export function refreshSeries() {
  if (state.series.length) return;
  const out = [];
  for (const stock of D.stocks) {
    for (const s of (stock.series || [])) {
      out.push({ id: s.id, stock, expiry: s.expiry, kind: s.kind, strike: s.strike, strike2: s.strike2, token: s.token, settled: false });
    }
  }
  state.series = out;
}

const rounds = [];
/// Latest gap round per stock (by asset). New rounds are read incrementally.
export async function latestGapRounds() {
  const { gap } = contracts();
  const n = Number(await gap.roundCount());
  for (let i = rounds.length; i < n; i++) rounds.push(await gap.rounds(i));
  // settled flags change, refresh the latest per asset
  const latest = {};
  rounds.forEach((r, id) => {
    const a = r.asset.toLowerCase();
    if (!latest[a] || id > latest[a].id) latest[a] = { id, lockTime: Number(r.lockTime), refPrice: usdFrom(r.refPrice), settled: r.settled };
  });
  for (const v of Object.values(latest)) {
    if (!v.settled && state.now >= v.lockTime) {
      const r = await gap.rounds(v.id);
      rounds[v.id] = r;
      v.settled = r.settled;
    }
  }
  return latest;
}

function assessRisk() {
  for (const s of D.stocks) {
    const a = s.address;
    const px = state.spots[a];
    const reasons = [];
    if (!px) reasons.push("no price");
    // Equity feeds legitimately go quiet when the market is closed; only an open-market silence is a fault.
    if (!state.closed && state.spotAt[a] && state.now - state.spotAt[a] > config.maxStaleSec) reasons.push("stale feed");
    if (jumpUntil[a] && state.now < jumpUntil[a]) reasons.push("price jump cooldown");
    const prev = state.halt[a];
    state.halt[a] = reasons.join(", ");
    if (state.halt[a] !== (prev || "")) log(state.halt[a] ? `! risk: ${s.symbol} quoting halted (${state.halt[a]})` : `risk: ${s.symbol} quoting resumed`);
    metrics.set("quoting_halted", { stock: s.symbol }, state.halt[a] ? 1 : 0);
  }
}

export async function refreshMarket() {
  refreshSeries();
  state.now = Math.floor(Date.now() / 1000);
  state.closed = marketClosed(state.now);
  // Prices come from Kuru WS — no chain calls.
  for (const s of D.stocks) {
    const px = kuruSpot(s.address);
    if (!px) continue;
    const old = state.spots[s.address];
    if (old && Math.abs(px / old - 1) > config.jumpPct) {
      jumpUntil[s.address] = state.now + config.jumpCooldownSec;
      log(`! risk: ${s.symbol} moved ${((px / old - 1) * 100).toFixed(1)}% in one tick`);
    }
    state.spots[s.address] = px;
    state.spotAt[s.address] = state.now;
    metrics.set("spot", { stock: s.symbol }, px);
  }
  assessRisk();
  // Gap market bps — default neutral until we add a Kuru-based feed.
  for (const s of D.stocks) state.gapUpBps[s.address] = 5000;

  state.fair.clear();
  for (const s of state.series) {
    if (s.expiry <= state.now) continue;
    let ref = state.spots[s.stock.address];
    if (!ref) continue;
    // Weekend: lean slightly on the gap market's implied direction.
    if (state.closed) ref *= 1 + ((state.gapUpBps[s.stock.address] - 5000) / 5000) * 0.01;
    const vol = s.stock.vol * (state.closed ? 1.3 : 1);
    const T = (s.expiry - state.now) / YEAR;
    const { price, delta } = priceSeries(s, ref, T, vol);
    state.fair.set(s.id, { price, delta, vol, ref });
  }
  state.updatedAt = Date.now();
  metrics.beat("market");
}

/// Series that may be quoted right now: live, not about to expire, stock not halted.
export function quotableSeries() {
  return state.series.filter((s) => s.expiry > state.now + config.stopBeforeExpirySec && !state.halt[s.stock.address] && state.fair.has(s.id));
}

export function liveSeries() {
  return state.series.filter((s) => s.expiry > state.now + 5);
}
