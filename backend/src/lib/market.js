import { D, config } from "../config.js";
import { contracts, chainNow, loadSeries, spots, usdFrom, log } from "./chain.js";
import { priceSeries, marketClosed, YEAR } from "./pricing.js";
import { metrics } from "./obs.js";

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

let lastSeriesLoad = 0;
const jumpUntil = {};

export async function refreshSeries(force = false) {
  if (!force && Date.now() - lastSeriesLoad < 15_000 && state.series.length) return;
  state.series = await loadSeries();
  lastSeriesLoad = Date.now();
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
  await refreshSeries();
  state.now = await chainNow();
  state.closed = marketClosed(state.now);
  const { px, at } = await spots();
  for (const s of D.stocks) {
    const a = s.address;
    const old = state.spots[a];
    if (old && px[a] && Math.abs(px[a] / old - 1) > config.jumpPct) {
      jumpUntil[a] = state.now + config.jumpCooldownSec;
      log(`! risk: ${s.symbol} moved ${((px[a] / old - 1) * 100).toFixed(1)}% in one tick`);
    }
    state.spots[a] = px[a];
    state.spotAt[a] = at[a];
    metrics.set("spot", { stock: s.symbol }, px[a]);
  }
  assessRisk();

  const { gap } = contracts();
  const latest = await latestGapRounds();
  for (const s of D.stocks) {
    const r = latest[s.address.toLowerCase()];
    state.gapUpBps[s.address] = r && state.now < r.lockTime ? Number(await gap.impliedUpBps(r.id)) : 5000;
  }

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
