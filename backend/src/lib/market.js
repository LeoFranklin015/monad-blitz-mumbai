import { D } from "../config.js";
import { contracts, chainNow, loadSeries, spots, usdFrom } from "./chain.js";
import { priceSeries, marketClosed, YEAR } from "./pricing.js";

/// Shared market snapshot, refreshed by the market loop and read by every service.
export const state = {
  now: 0,
  closed: false,
  spots: {},
  gapUpBps: {},
  series: [],
  fair: new Map(), // id -> { price, delta, vol, ref }
  updatedAt: 0,
};

let lastSeriesLoad = 0;

export async function refreshSeries(force = false) {
  if (!force && Date.now() - lastSeriesLoad < 15_000 && state.series.length) return;
  state.series = await loadSeries();
  lastSeriesLoad = Date.now();
}

/// Latest gap round per stock (by asset), from chain.
export async function latestGapRounds() {
  const { gap } = contracts();
  const n = Number(await gap.roundCount());
  const rounds = await Promise.all([...Array(n).keys()].map((i) => gap.rounds(i)));
  const latest = {};
  rounds.forEach((r, id) => {
    const a = r.asset.toLowerCase();
    if (!latest[a] || id > latest[a].id) latest[a] = { id, lockTime: Number(r.lockTime), refPrice: usdFrom(r.refPrice), settled: r.settled };
  });
  return latest;
}

export async function refreshMarket() {
  await refreshSeries();
  state.now = await chainNow();
  state.closed = marketClosed(state.now);
  state.spots = await spots();

  const { gap } = contracts();
  const rounds = await latestGapRounds();
  for (const s of D.stocks) {
    const r = rounds[s.address.toLowerCase()];
    state.gapUpBps[s.address] = r && state.now < r.lockTime ? Number(await gap.impliedUpBps(r.id)) : 5000;
  }

  state.fair.clear();
  for (const s of state.series) {
    if (s.expiry <= state.now) continue;
    let ref = state.spots[s.stock.address];
    // Weekend: lean slightly on the gap market's implied direction.
    if (state.closed) ref *= 1 + ((state.gapUpBps[s.stock.address] - 5000) / 5000) * 0.01;
    const vol = s.stock.vol * (state.closed ? 1.3 : 1);
    const T = (s.expiry - state.now) / YEAR;
    const { price, delta } = priceSeries(s, ref, T, vol);
    state.fair.set(s.id, { price, delta, vol, ref });
  }
  state.updatedAt = Date.now();
}

export function liveSeries() {
  return state.series.filter((s) => s.expiry > state.now + 5);
}
