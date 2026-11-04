import { ethers } from "ethers";
import { NETWORK, API_URL, RPC_URL } from "./config.js";

export let D = null;
export let ABI = null;
export let read = null;
export const LOCAL_RPC = "http://127.0.0.1:8545";

export const usd = (x) => ethers.parseUnits(Math.max(0, Number(x)).toFixed(6), 6);
export const sh = (x) => ethers.parseEther(Number(x).toFixed(18).replace(/\.?0+$/, "") || "0");
export const fromUsd = (v) => Number(ethers.formatUnits(v, 6));
export const fromSh = (v) => Number(ethers.formatEther(v));

/// Shared app state, refreshed by the poll loop.
export const S = {
  now: 0,
  spots: {},
  fair: new Map(), // seriesId -> { fair, delta }
  closed: false,
  quotesPerSec: 0,
  series: [],
  stock: null,
  apiUp: false,
};

export async function load() {
  const [d, a] = await Promise.all([
    fetch(`/deployments/${NETWORK}.json`).then((r) => (r.ok ? r.json() : null)),
    fetch(`/deployments/abi.json`).then((r) => (r.ok ? r.json() : null)),
  ]);
  if (!d || !a) throw new Error(`No deployment for "${NETWORK}". Run the deploy script first.`);
  D = d;
  ABI = a;
  const rpc = D.chainId === 31337 ? `http://${location.hostname}:8545` : RPC_URL;
  // Monad testnet RPCs choke on large batches ("queue size exceeded"); keep batches small.
  read = new ethers.JsonRpcProvider(rpc, D.chainId, { staticNetwork: true, batchMaxCount: 5 });
  S.stock = D.stocks[0];
  return D;
}

export const isLocal = () => D && D.chainId === 31337;

const iface = {};
export function I(name) {
  if (!iface[name]) iface[name] = new ethers.Interface(ABI[name]);
  return iface[name];
}

/// Build a call object for wallet.sendCalls.
export const call = (to, name, fn, args) => ({ to, data: I(name).encodeFunctionData(fn, args) });

export const C = {
  protocol: () => new ethers.Contract(D.protocol, ABI.OptionsProtocol, read),
  oracle: () => new ethers.Contract(D.oracle, D.oracleKind === "pyth" ? ABI.PythSettlementOracle : ABI.SettlementOracle, read),
  gap: () => new ethers.Contract(D.gap, ABI.GapMarket, read),
  erc20: (a) => new ethers.Contract(a, ABI.MockERC20, read),
  token: (a) => new ethers.Contract(a, ABI.OptionToken, read),
  vault: (a) => new ethers.Contract(a, ABI.CommitVault, read),
  lender: (a) => new ethers.Contract(a, ABI.ShieldedLender, read),
};

export async function loadSeries() {
  // Prefer backend /markets — it already has full series data, no chain calls needed.
  if (S.apiUp) {
    try {
      const r = await fetch(`${API_URL}/markets`);
      const j = await r.json();
      if (j.series?.length) {
        const by = Object.fromEntries(D.stocks.map((s) => [s.address.toLowerCase(), s]));
        S.series = j.series
          .filter((x) => by[x.stock?.toLowerCase()])
          .map((x) => ({
            id: x.id, stock: by[x.stock.toLowerCase()],
            expiry: x.expiry, kind: x.kind, strike: x.strike, strike2: x.strike2,
            token: x.token, settled: x.settled,
          }));
        return S.series;
      }
    } catch { /* fall through to chain */ }
  }
  // Fallback: load from chain (only on first boot if backend is down).
  const p = C.protocol();
  const n = Number(await p.seriesCount());
  if (n === S.series.length && n) {
    const tail = S.series.filter((s) => s.expiry <= S.now && !s.settled);
    const raws = await Promise.all(tail.map((s) => p.getSeries(s.id)));
    tail.forEach((s, i) => (s.settled = raws[i].settled));
    return S.series;
  }
  const by = Object.fromEntries(D.stocks.map((s) => [s.address.toLowerCase(), s]));
  const raws = await Promise.all([...Array(n).keys()].map((i) => p.getSeries(i)));
  S.series = raws
    .map((r, id) => ({
      id, stock: by[r.underlying.toLowerCase()],
      expiry: Number(r.expiry), kind: Number(r.kind),
      strike: fromUsd(r.strike), strike2: fromUsd(r.strike2),
      token: r.token, settled: r.settled,
    }))
    .filter((s) => s.stock);
  return S.series;
}

let _lastChainFetch = 0;

export async function refreshMarket() {
  // Use wall clock as initial timestamp — no RPC needed.
  if (!S.now) S.now = Math.floor(Date.now() / 1000);

  // Fetch backend /markets — has spot prices, series data, chain time, and market-closed flag.
  try {
    const r = await fetch(`${API_URL}/markets`);
    const j = await r.json();
    S.fair = new Map(j.series.map((x) => [x.id, { fair: x.fair, delta: x.delta, vol: x.vol }]));
    S.quotesPerSec = j.quotesPerSec;
    S.apiUp = true;
    if (j.now) S.now = j.now;
    if (j.closed !== undefined) S.closed = j.closed;
    if (j.spots) D.stocks.forEach((s) => { if (j.spots[s.address]) S.spots[s.address] = j.spots[s.address]; });
    // Reset chain-fetch timer if we got a fresh server timestamp — no need for a getBlock call.
    if (j.now) _lastChainFetch = Date.now();
  } catch {
    S.apiUp = false;
    // Fallback: compute market-closed from wall clock when backend is unreachable.
    const d = new Date(S.now * 1000), day = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
    S.closed = day === 0 || day === 6 || m < 810 || m >= 1200;
  }

  // Only hit the chain directly every 30s (fallback when backend is down).
  if (Date.now() - _lastChainFetch < 30_000) return;
  _lastChainFetch = Date.now();
  try {
    const o = C.oracle();
    const [blk, ...sp] = await Promise.all([read.getBlock("latest"), ...D.stocks.map((s) => o.spot(s.address))]);
    if (blk) S.now = blk.timestamp;
    D.stocks.forEach((s, i) => { if (sp[i]) S.spots[s.address] = fromUsd(sp[i][0]) || S.spots[s.address] || s.spot; });
  } catch { /* keep cached */ }
}

export const liveSeries = (stock) => S.series.filter((s) => s.stock === stock && s.expiry > S.now);
export const expiriesOf = (stock) => [...new Set(liveSeries(stock).map((s) => s.expiry))].sort((a, b) => a - b);
export const seriesById = (id) => S.series.find((s) => s.id === id);

export function seriesLabel(s) {
  const names = ["Upside", "Floor", "Capped Upside", "Budget Floor"];
  const k = s.kind >= 2 ? `$${s.strike}–$${s.strike2}` : `$${s.strike}`;
  return `${s.stock.symbol} ${names[s.kind]} ${k}`;
}

/// Payoff per option at price P.
export function payoff(s, P) {
  if (s.kind === 0) return Math.max(0, P - s.strike);
  if (s.kind === 1) return Math.max(0, s.strike - P);
  if (s.kind === 2) return Math.min(Math.max(0, P - s.strike), s.strike2 - s.strike);
  return Math.min(Math.max(0, s.strike - P), s.strike - s.strike2);
}

/// Collateral token and amount (number) a writer needs for `n` options.
export function collateral(s, n) {
  if (s.kind === 0) return { token: s.stock.address, symbol: s.stock.symbol, amount: n, isStock: true };
  const w = s.kind === 1 ? s.strike : Math.abs(s.strike2 - s.strike);
  return { token: D.usdc, symbol: "USDC", amount: w * n, isStock: false };
}
