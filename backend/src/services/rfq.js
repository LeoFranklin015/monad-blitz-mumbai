// HTTP API for the app: live fair values and signed RFQ quotes for size.
//   GET /health
//   GET /markets                     fair value, delta and vol for every live series
//   GET /rfq?seriesId=12&amount=50   a signed EIP-712 quote the app fills onchain with fillRFQ
import http from "node:http";
import { ethers } from "ethers";
import { D, config, KIND } from "../config.js";
import { contracts, usdTo, shTo, usdFrom, log } from "../lib/chain.js";
import { state } from "../lib/market.js";
import { stats } from "./makers.js";

const RFQ_SPREAD = 0.03; // tighter than the book: the maker knows the size and can hedge it
const TTL = 60;

const types = {
  RFQ: [
    { name: "maker", type: "address" },
    { name: "seriesId", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "maxSize", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export function startRfq() {
  if (!config.makerKeys.length) {
    log("rfq: no maker key, quotes disabled");
  }
  const wallet = config.makerKeys.length ? new ethers.Wallet(config.makerKeys[0]) : null;
  const domain = { name: "WeekendOptions", version: "1", chainId: D.chainId, verifyingContract: D.protocol };
  let nonce = BigInt(Date.now()) * 1000n;

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url, "http://x");
    const reply = (code, body) => {
      res.statusCode = code;
      res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    };
    try {
      if (url.pathname === "/health") return reply(200, { ok: true, network: D.network, updatedAt: state.updatedAt });

      if (url.pathname === "/markets") {
        const series = [];
        for (const s of state.series) {
          const f = state.fair.get(s.id);
          if (f) series.push({ id: s.id, fair: f.price, delta: f.delta, vol: f.vol });
        }
        return reply(200, {
          now: state.now,
          closed: state.closed,
          spots: state.spots,
          gapUpBps: state.gapUpBps,
          quotesPerSec: stats.quotesPerSec,
          series,
        });
      }

      if (url.pathname === "/rfq") {
        if (!wallet) return reply(503, { error: "no maker configured" });
        const id = Number(url.searchParams.get("seriesId"));
        const amount = Number(url.searchParams.get("amount"));
        const s = state.series.find((x) => x.id === id);
        const f = state.fair.get(id);
        if (!s || !f || !(amount > 0)) return reply(400, { error: "unknown or expired series" });

        // only quote what this maker can actually collateralize right now
        const { protocol } = contracts();
        const token = s.kind === KIND.CALL ? s.stock.address : D.usdc;
        const free = await protocol.freeBalance(wallet.address, token);
        const freeNum = token === D.usdc ? usdFrom(free) : Number(ethers.formatEther(free));
        const per = s.kind === KIND.CALL ? 1 : s.kind === KIND.PUT ? s.strike : Math.abs(s.strike2 - s.strike);
        if (freeNum < per * amount) return reply(409, { error: "maker cannot size that right now" });

        const price = Math.max(f.price * (1 + RFQ_SPREAD), 0.01);
        const rfq = {
          maker: wallet.address,
          seriesId: BigInt(id),
          price: usdTo(price),
          maxSize: shTo(amount),
          nonce: nonce++,
          deadline: BigInt(state.now + TTL),
        };
        const signature = await wallet.signTypedData(domain, types, rfq);
        return reply(200, { rfq, signature, pricePerOption: price, premium: price * amount, expiresIn: TTL });
      }
      reply(404, { error: "not found" });
    } catch (e) {
      reply(500, { error: e.message });
    }
  });
  server.listen(config.rfqPort, () => log(`api: http://localhost:${config.rfqPort} (/markets, /rfq)`));
  return server;
}
