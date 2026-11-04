import { ethers } from "ethers";
import { D, ABI, config } from "../config.js";
import { log, metrics } from "./obs.js";
import { BoundedJsonRpcProvider } from "./rpc.js";

export { log };

// Monad testnet RPCs cap eth_call concurrency: drpc accepts batches but a 50-call batch
// overflows its thread pool ("queue size exceeded"). Small batches (≤5) are tolerated reliably.
// Use a FetchRequest with retryFunc disabled so 429s throw immediately instead of hanging forever.
const _req = new ethers.FetchRequest(config.rpc);
_req.retryFunc = async () => false; // never retry; callers handle errors themselves
// The public Monad testnet RPC (testnet-rpc.monad.xyz) rejects every JSON-RPC batch, even a batch of one
// ("Restricted JSON RPC method"), so batching is off by default there. RPC_BATCH overrides (never above 5 on drpc).
export const provider = new BoundedJsonRpcProvider(_req, D.chainId, { batchMaxCount: config.rpcBatch, staticNetwork: true, cacheTimeout: -1 });
provider.pollingInterval = 500;

export const usdFrom = (v) => Number(ethers.formatUnits(v, 6));
export const usdTo = (x) => ethers.parseUnits(Math.max(0, x).toFixed(6), 6);
export const shTo = (x) => ethers.parseEther(Number(x).toFixed(18).replace(/\.?0+$/, "") || "0");
export const shFrom = (v) => Number(ethers.formatEther(v));

const signers = new Map();
/// One nonce-managed signer per key, shared by every service that uses it.
export function signer(key) {
  if (!key) return null;
  key = key.toLowerCase();
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
/// receipts stay inside the queue so a failed submission cannot reset an in-flight nonce.
export async function send(s, label, fn) {
  const prev = s._queue;
  let release;
  s._queue = new Promise((r) => (release = r));
  try {
    await prev;
    s.reset(); // Fetch the pending nonce again; do not reuse a stale local counter.
    const tx = await fn();
    const rc = await tx.wait();
    metrics.inc("tx_sent_total", { label: label.split(" ")[0] });
    return rc;
  } catch (e) {
    s.reset();
    metrics.inc("tx_failed_total", { label: label.split(" ")[0] });
    log(`! ${label}: ${(e.shortMessage || e.reason || e.message || "").slice(0, 160)}`);
    return null;
  } finally {
    release();
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
