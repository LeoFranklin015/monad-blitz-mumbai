// Kuru WebSocket allMids subscriber — live mid prices with no RPC polling.
// One persistent connection per process; auto-reconnects on close/error.
import { WebSocket } from "ws";
import { D } from "../config.js";
import { log } from "./obs.js";

// { lowerCaseMarketAddress -> priceFloat }
const mids = new Map();
let ws = null;
let reconnectTimer = null;

// pricePrecision is 10000 for all xStock/USDC markets on Kuru testnet.
const PP = 10_000;

function decode(buf) {
  // Binary frame layout (all big-endian):
  //   0..7   : subscription envelope id (uint64)
  //   8..11  : magic KXMD
  //   12     : wire version
  //   13     : kind (6 = allMids)
  //   14     : view
  //   15     : flags
  //   16..23 : feedEpoch (uint64)
  //   24..27 : record count (uint32)
  //   28+    : entries — 20-byte address + 16-byte uint128 price, repeated
  if (buf.length < 28) return;
  if (buf.toString("ascii", 8, 12) !== "KXMD") return;
  if (buf[13] !== 6) return; // not allMids
  const count = buf.readUInt32BE(24);
  let off = 28;
  for (let i = 0; i < count && off + 36 <= buf.length; i++) {
    const addr = "0x" + buf.slice(off, off + 20).toString("hex");
    off += 20;
    const hi = buf.readBigUInt64BE(off);
    const lo = buf.readBigUInt64BE(off + 8);
    off += 16;
    mids.set(addr, Number((hi << 64n) | lo) / PP);
  }
}

function connect() {
  if (!D.kuruWs) return; // no WS endpoint in deployment (local chain)
  if (ws) { try { ws.terminate(); } catch {} }
  ws = new WebSocket(D.kuruWs);
  ws.on("open", () => {
    ws.send(JSON.stringify({ op: "sub", id: 1, t: "allMids@f" }));
  });
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    decode(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  ws.on("close", () => schedule());
  ws.on("error", (e) => {
    log(`kuru ws error: ${e.message}`);
    schedule();
  });
}

function schedule() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
}

export function startKuruPrices() {
  connect();
}

// Returns the latest mid price for a stock address, or null if not yet received.
export function kuruSpot(stockAddress) {
  if (!D.kuruWs) return null;
  const stock = D.stocks.find((s) => s.address.toLowerCase() === stockAddress.toLowerCase());
  if (!stock?.kuruMarket) return null;
  return mids.get(stock.kuruMarket.toLowerCase()) ?? null;
}
