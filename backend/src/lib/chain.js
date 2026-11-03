import { ethers } from "ethers";
import { D, ABI, config } from "../config.js";

export const provider = new ethers.JsonRpcProvider(config.rpc, undefined, { batchMaxCount: 50, staticNetwork: true });
provider.pollingInterval = 500;

export const usdFrom = (v) => Number(ethers.formatUnits(v, 6));
export const usdTo = (x) => ethers.parseUnits(Math.max(0, x).toFixed(6), 6);
export const shTo = (x) => ethers.parseEther(String(x));
export const shFrom = (v) => Number(ethers.formatEther(v));

const signers = new Map();
/// One nonce-managed signer per key, shared by every service that uses it.
export function signer(key) {
  if (!signers.has(key)) signers.set(key, new ethers.NonceManager(new ethers.Wallet(key, provider)));
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
  };
}

/// Send a tx and wait; on failure resync the nonce so the next send works.
export async function send(s, label, fn) {
  try {
    const tx = await fn();
    return await tx.wait();
  } catch (e) {
    if (s && s.reset) s.reset();
    log(`! ${label}: ${(e.shortMessage || e.reason || e.message || "").slice(0, 140)}`);
    return null;
  }
}

export async function chainNow() {
  return (await provider.getBlock("latest")).timestamp;
}

/// All series from chain, enriched with the stock they belong to.
export async function loadSeries() {
  const { protocol } = contracts();
  const n = Number(await protocol.seriesCount());
  const bySym = Object.fromEntries(D.stocks.map((s) => [s.address.toLowerCase(), s]));
  const out = [];
  const raws = await Promise.all([...Array(n).keys()].map((i) => protocol.getSeries(i)));
  raws.forEach((r, id) => {
    const stock = bySym[r.underlying.toLowerCase()];
    if (!stock) return;
    out.push({
      id,
      stock,
      expiry: Number(r.expiry),
      kind: Number(r.kind),
      strike: usdFrom(r.strike),
      strike2: usdFrom(r.strike2),
      token: r.token,
      settled: r.settled,
    });
  });
  return out;
}

export async function spots() {
  const { oracle } = contracts();
  const res = await Promise.all(D.stocks.map((s) => oracle.spot(s.address)));
  return Object.fromEntries(D.stocks.map((s, i) => [s.address, usdFrom(res[i][0]) || s.spot]));
}

export function log(...a) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(t, ...a);
}
