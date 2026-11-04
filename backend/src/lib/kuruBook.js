// Read a Kuru stock/USDC market's top of book straight from the chain (no WebSocket, no API key).
// No config import, so scripts can use it without a deployment file.
import { ethers } from "ethers";

const ABI = ["function bestBidAsk() view returns (uint32 bid, uint32 ask)", "function pricePrecision() view returns (uint256)"];
const EMPTY_BID = 2n ** 32n - 1n; // Kuru reports an empty bid side as uint32 max, an empty ask side as 0
const precision = new Map(); // market -> price precision (fixed per market)

/// { bid, ask, mid } in USDC, or null when either side of the book is empty.
export async function kuruBook(provider, market) {
  const m = new ethers.Contract(market, ABI, provider);
  if (!precision.has(market)) precision.set(market, Number(await m.pricePrecision()));
  const pp = precision.get(market);
  const [bid, ask] = await m.bestBidAsk();
  if (ask === 0n || bid === EMPTY_BID) return null;
  const b = Number(bid) / pp;
  const a = Number(ask) / pp;
  return { bid: b, ask: a, mid: (a + b) / 2 };
}
