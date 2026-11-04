const q = new URLSearchParams(location.search);

export const NETWORK = q.get("network") || import.meta.env.VITE_NETWORK || "localhost";
// Local dev talks to the backend on :8787; production serves it under /api on the same origin.
const devHost = ["localhost", "127.0.0.1"].includes(location.hostname) || location.port === "5173";
export const API_URL = import.meta.env.VITE_API_URL || (devHost ? `http://${location.hostname}:8787` : "/api");
export const JAW_API_KEY = import.meta.env.VITE_JAW_API_KEY || "";
export const PAYMASTER_URL = import.meta.env.VITE_PAYMASTER_URL || "";
export const ALCHEMY_KEY = import.meta.env.VITE_ALCHEMY_KEY || "";


export const KIND = { CALL: 0, PUT: 1, CALL_SPREAD: 2, PUT_SPREAD: 3 };
export const PRODUCTS = [
  { kind: 0, name: "Upside", blurb: "Leverage you can't get liquidated on", tone: "up" },
  { kind: 1, name: "Floor", blurb: "Sell at a fixed price, even on Saturday", tone: "down" },
  { kind: 2, name: "Capped Upside", blurb: "Cheaper Upside with a ceiling", tone: "up" },
  { kind: 3, name: "Budget Floor", blurb: "Cheaper protection for a range", tone: "down" },
];
export const kindName = (k) => PRODUCTS[k].name;

// Max price drift accepted between quote and inclusion. A limit, not a fee: fills execute at the book price.
export const SLIPPAGE_BPS = BigInt(import.meta.env.VITE_SLIPPAGE_BPS || 500);
