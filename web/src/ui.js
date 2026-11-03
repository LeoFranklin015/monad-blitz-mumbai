export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function html(strings, ...vals) {
  return strings.reduce((a, s, i) => a + s + (i < vals.length ? (Array.isArray(vals[i]) ? vals[i].join("") : vals[i] ?? "") : ""), "");
}

export const fmt = {
  usd: (n, d = 2) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }),
  pnl: (n) => (n < 0 ? "-$" : "+$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  sh: (n, d = 2) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d }),
  addr: (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : ""),
  pct: (n, d = 1) => (n * 100).toFixed(d) + "%",
  date: (ts) => new Date(ts * 1000).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  left: (secs) => {
    if (secs <= 0) return "expired";
    const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  },
};

let toastTimer;
export function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

// Plain-language messages for contract errors, decoded from revert data with the deployment ABIs.
const FRIENDLY = {
  Slippage: "Price moved while you were signing. Try again.",
  InsufficientLiquidity: "Not enough quotes on the book for that size.",
  InsufficientBalance: "Not enough free balance for that.",
  Expired: "This series has expired.",
  IsPaused: "Trading is paused right now. Exits still work.",
  NotExercisable: "This one settles at expiry; it can't be exercised early.",
  BookFull: "The book is full at a better price than yours.",
  BadAmount: "Check the amount.",
  BadSignature: "That quote is no longer valid. Get a new one.",
  OracleNotReady: "Waiting for the settlement price.",
  Unhealthy: "That would take the loan past its 50% limit.",
  Healthy: "This loan is healthy and can't be liquidated.",
  BadFloor: "That Floor can't be attached to this loan.",
  RoundActive: "The vault is mid-round. Deposits and withdrawals open after expiry.",
  Locked: "Betting closed at the open.",
  Nothing: "Nothing to claim.",
  ERC20InsufficientBalance: "Not enough tokens in your wallet.",
  ERC20InsufficientAllowance: "Token approval missing. Try again.",
};
let decoders = [];
export function setErrorAbis(abis) {
  decoders = abis;
}
function revertData(e) {
  return e?.data || e?.info?.error?.data?.data || e?.info?.error?.data || e?.error?.data || null;
}
export function errMsg(e) {
  const data = revertData(e);
  if (typeof data === "string" && data.length >= 10) {
    for (const d of decoders) {
      try {
        const err = d.parseError(data);
        if (err) return FRIENDLY[err.name] || err.name.replace(/([a-z])([A-Z])/g, "$1 $2");
      } catch {}
    }
  }
  const m = e?.shortMessage || e?.info?.error?.message || e?.reason || e?.message || "Failed";
  if (/user rejected|denied|4001/i.test(m)) return "Cancelled";
  return m.replace(/^execution reverted:?\s*/i, "").slice(0, 160);
}

/// Run an action with a pending toast and a clean error.
export async function act(label, fn, after) {
  try {
    toast(label + "…", 120000);
    await fn();
    toast(label + " done");
    if (after) await after();
  } catch (e) {
    console.error(e);
    toast(errMsg(e), 7000);
  }
}

export function on(root, sel, ev, fn) {
  $$(sel, root).forEach((el) => el.addEventListener(ev, (e) => fn(e, el)));
}
