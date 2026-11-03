// HTTP API for the app and for operators.
//   GET /health      200 when the market loop is fresh, 503 otherwise (for load balancers)
//   GET /status      per-service tick ages, risk halts, indexer block, pause state
//   GET /metrics     Prometheus text
//   GET /markets     fair value, delta and vol for every live series
//   GET /rfq?seriesId=12&amount=50   a signed EIP-712 quote the app fills onchain with fillRFQ
//
// RFQs are rate limited per IP, capped in size, and budgeted: the maker never has more signed,
// unexpired size outstanding than its free collateral can back.
import http from "node:http";
import { ethers } from "ethers";
import { D, config, KIND, NETWORK } from "../config.js";
import { contracts, usdTo, shTo, usdFrom, shFrom, log } from "../lib/chain.js";
import { state } from "../lib/market.js";
import { metrics } from "../lib/obs.js";
import { index } from "../lib/indexer.js";
import { stats } from "./makers.js";

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

const hits = new Map(); // ip -> [timestamps]
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 10_000) hits.clear();
  return arr.length > config.rateLimitPerMin;
}

export function startApi() {
  const wallet = config.makerKeys.length ? new ethers.Wallet(config.makerKeys[0]) : null;
  const domain = { name: "WeekendOptions", version: "1", chainId: D.chainId, verifyingContract: D.protocol };
  let nonce = BigInt(Date.now()) * 1000n;
  const outstanding = []; // { token, amount, deadline }
  const { protocol } = contracts();

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || "";
    const allow = config.corsOrigins.includes("*") ? "*" : config.corsOrigins.includes(origin) ? origin : "";
    if (allow) res.setHeader("Access-Control-Allow-Origin", allow);
    res.setHeader("Vary", "Origin");
    const url = new URL(req.url, "http://x");
    const reply = (code, body, type = "application/json") => {
      res.statusCode = code;
      res.setHeader("Content-Type", type);
      res.end(type === "application/json" ? JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : body);
    };
    metrics.inc("http_requests_total", { path: url.pathname.split("/")[1] || "root" });
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    try {
      if (req.method === "OPTIONS") return reply(204, "");
      if (url.pathname === "/health") {
        const age = (Date.now() - state.updatedAt) / 1000;
        return reply(age < 30 ? 200 : 503, { ok: age < 30, network: NETWORK, marketAgeSec: Math.round(age) });
      }
      if (url.pathname === "/status") {
        return reply(200, {
          network: NETWORK,
          chainId: D.chainId,
          protocol: D.protocol,
          chainTime: state.now,
          marketClosed: state.closed,
          paused: await protocol.paused(),
          indexerBlock: index.block(),
          serviceTickAgeSec: metrics.ages(),
          halts: Object.fromEntries(D.stocks.map((s) => [s.symbol, state.halt[s.address] || null])),
          liveQuotes: stats.liveQuotes,
          quotesPerSec: stats.quotesPerSec,
        });
      }
      if (url.pathname === "/metrics") return reply(200, metrics.text(), "text/plain; version=0.0.4");

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
          halts: Object.fromEntries(D.stocks.map((s) => [s.address, state.halt[s.address] || ""])),
          quotesPerSec: stats.quotesPerSec,
          series,
        });
      }

      if (url.pathname === "/rfq") {
        if (limited(ip)) return reply(429, { error: "too many requests" });
        if (!wallet) return reply(503, { error: "no maker configured" });
        const id = Number(url.searchParams.get("seriesId"));
        const amount = Number(url.searchParams.get("amount"));
        const s = state.series.find((x) => x.id === id);
        const f = state.fair.get(id);
        if (!s || !f || !Number.isFinite(amount) || !(amount > 0)) return reply(400, { error: "unknown or expired series" });
        if (amount > config.rfqMaxSize) return reply(400, { error: `max ${config.rfqMaxSize} per quote` });
        if (state.halt[s.stock.address]) return reply(409, { error: `quoting paused: ${state.halt[s.stock.address]}` });
        if (s.expiry <= state.now + config.stopBeforeExpirySec) return reply(409, { error: "too close to expiry" });

        // budget: free collateral minus what is already promised in live signed quotes
        const token = s.kind === KIND.CALL ? s.stock.address : D.usdc;
        const per = s.kind === KIND.CALL ? 1 : s.kind === KIND.PUT ? s.strike : Math.abs(s.strike2 - s.strike);
        const free = await protocol.freeBalance(wallet.address, token);
        const freeNum = token === D.usdc ? usdFrom(free) : shFrom(free);
        for (let i = outstanding.length - 1; i >= 0; i--) if (outstanding[i].deadline < state.now) outstanding.splice(i, 1);
        const promised = outstanding.filter((o) => o.token === token).reduce((a, o) => a + o.amount, 0);
        if (freeNum - promised < per * amount) return reply(409, { error: "maker cannot size that right now" });

        const price = Math.max(f.price * (1 + config.rfqSpread), 0.01);
        const deadline = state.now + config.rfqTtlSec;
        const rfq = { maker: wallet.address, seriesId: BigInt(id), price: usdTo(price), maxSize: shTo(amount), nonce: nonce++, deadline: BigInt(deadline) };
        const signature = await wallet.signTypedData(domain, types, rfq);
        outstanding.push({ token, amount: per * amount, deadline });
        metrics.inc("rfq_signed_total");
        return reply(200, { rfq, signature, pricePerOption: price, premium: price * amount, expiresIn: config.rfqTtlSec });
      }
      reply(404, { error: "not found" });
    } catch (e) {
      metrics.inc("http_errors_total");
      reply(500, { error: e.shortMessage || e.message });
    }
  });
  server.listen(config.port, () => log(`api: http://0.0.0.0:${config.port} (/health /status /metrics /markets /rfq)`));
  return server;
}
