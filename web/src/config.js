const q = new URLSearchParams(location.search);

export const NETWORK = q.get("network") || import.meta.env.VITE_NETWORK || "localhost";
export const API_URL = import.meta.env.VITE_API_URL || `http://${location.hostname}:8787`;
export const JAW_API_KEY = import.meta.env.VITE_JAW_API_KEY || "";
export const PAYMASTER_URL = import.meta.env.VITE_PAYMASTER_URL || "";


export const KIND = { CALL: 0, PUT: 1, CALL_SPREAD: 2, PUT_SPREAD: 3 };
export const PRODUCTS = [
  { kind: 0, name: "Upside", blurb: "Leverage you can't get liquidated on", tone: "up" },
  { kind: 1, name: "Floor", blurb: "Sell at a fixed price, even on Saturday", tone: "down" },
  { kind: 2, name: "Capped Upside", blurb: "Cheaper Upside with a ceiling", tone: "up" },
  { kind: 3, name: "Budget Floor", blurb: "Cheaper protection for a range", tone: "down" },
];
export const kindName = (k) => PRODUCTS[k].name;
