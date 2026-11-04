import { ethers } from "ethers";
import { D, ABI, config } from "../config.js";
import { log, metrics } from "./obs.js";

export { log };

// Monad testnet RPCs cap eth_call concurrency: drpc accepts batches but a 50-call batch
// overflows its thread pool ("queue size exceeded"). Small batches (≤5) are tolerated reliably.
export const provider = new ethers.JsonRpcProvider(config.rpc, D.chainId, { batchMaxCount: 5, staticNetwork: true });
provider.pollingInterval = 500;

export const usdFrom = (v) => Number(ethers.formatUnits(v, 6));
export const usdTo = (x) => ethers.parseUnits(Math.max(0, x).toFixed(6), 6);
export const shTo = (x) => ethers.parseEther(Number(x).toFixed(18).replace(/\.?0+$/, "") || "0");
export const shFrom = (v) => Number(ethers.formatEther(v));

const signers = new Map();
/// One nonce-managed signer per key, shared by every service that uses it.
export function signer(key) {
  if (!key) return null;
  if (!signers.has(key)) {
    const s = new ethers.NonceManager(new ethers.Wallet(key, provider));
    s._queue = Promise.resolve();
    signers.set(key, s);
  }
  return signers.get(key);
}

export function contracts(runner = provider) {
  return {
    protocol: new ethers.Contract(D.protocol, ABI.OptionsProtocol, runner),
    oracle: new ethers.Contract(D.oracle, D.oracleKind === "pyth" ? ABI.PythSettlementOracle : ABI.SettlementOracle, runner),
    gap: new ethers.Contract(D.gap, ABI.GapMarket, runner),
    usdc: new ethers.Contract(D.usdc, ABI.MockERC20, runner),
    stock: (a) => new ethers.Contract(a, ABI.MockXStock, runner),
    token: (a) => new ethers.Contract(a, ABI.OptionToken, runner),
    vault: (a) => new ethers.Contract(a, ABI.CommitVault, runner),
    lender: (a) => new ethers.Contract(a, ABI.ShieldedLender, runner),
    hedged: D.hedgedMaker ? new ethers.Contract(D.hedgedMaker, ABI.HedgedMaker, runner) : null,
    dex: D.dex ? new ethers.Contract(D.dex, ABI.MockDex, runner) : null,
  };
}

/// Send a tx and wait for it. Submissions from one signer are serialized so nonces never collide;
/// waiting for receipts happens outside the queue. On a failed submission the nonce is resynced.
export async function send(s, label, fn) {
  let tx;
  const prev = s._queue;
  let release;
  s._queue = new Promise((r) => (release = r));
  try {
    await prev;
    tx = await fn();
  } catch (e) {
    s.reset();
    metrics.inc("tx_failed_total", { label: label.split(" ")[0] });
    log(`! ${label}: ${(e.shortMessage || e.reason || e.message || "").slice(0, 160)}`);
    return null;
  } finally {
    release();
  }
  try {
    const rc = await tx.wait();
    metrics.inc("tx_sent_total", { label: label.split(" ")[0] });
    return rc;
  } catch (e) {
    metrics.inc("tx_failed_total", { label: label.split(" ")[0] });
    log(`! ${label} reverted: ${(e.shortMessage || e.reason || e.message || "").slice(0, 160)}`);
    return null;
  }
}

export async function chainNow() {
  return (await provider.getBlock("latest")).timestamp;
}

const seriesCache = [];
/// All series, enriched with their stock. Only new series and unsettled expired ones are re-read.
export async function loadSeries() {
  const { protocol } = contracts();
  const n = Number(await protocol.seriesCount());
  const bySym = Object.fromEntries(D.stocks.map((s) => [s.address.toLowerCase(), s]));
  const fresh = [...Array(n - seriesCache.length).keys()].map((i) => seriesCache.length + i);
  const now = Math.floor(Date.now() / 1000);
  const recheck = seriesCache.filter((s) => s && !s.settled && s.expiry < now + 3600).map((s) => s.id);
  const ids = [...fresh, ...recheck];
  const raws = await Promise.all(ids.map((i) => protocol.getSeries(i)));
  ids.forEach((id, j) => {
    const r = raws[j];
    const stock = bySym[r.underlying.toLowerCase()];
    seriesCache[id] = stock
      ? { id, stock, expiry: Number(r.expiry), kind: Number(r.kind), strike: usdFrom(r.strike), strike2: usdFrom(r.strike2), token: r.token, settled: r.settled }
      : { id, foreign: true, settled: true, expiry: 0 };
  });
  return seriesCache.filter((s) => s && !s.foreign);
}

/// Latest spot and its publish time per stock.
export async function spots() {
  const { oracle } = contracts();
  const res = await Promise.all(D.stocks.map((s) => oracle.spot(s.address)));
  const px = {}, at = {};
  D.stocks.forEach((s, i) => {
    px[s.address] = usdFrom(res[i][0]) || 0;
    at[s.address] = Number(res[i][1]);
  });
  return { px, at };
}
