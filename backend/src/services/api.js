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
import { contracts, provider, usdTo, shTo, usdFrom, shFrom, log } from "../lib/chain.js";
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
const ohlcCache = new Map(); // "SYMBOL:range:interval" -> { data, expiresAt }
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
    if (allow) {
      res.setHeader("Access-Control-Allow-Origin", allow);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
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
      if (url.pathname === "/rpc" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1_000_000) return reply(413, { error: "RPC request too large" });
        }
        const upstream = await fetch(config.rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", "application/json");
        return res.end(await upstream.text());
      }
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
      if (url.pathname === "/trades") {
        const address = url.searchParams.get("address");
        if (!ethers.isAddress(address)) return reply(400, { error: "valid address required" });
        const latest = await provider.getBlockNumber();
        const requested = Number(url.searchParams.get("blocks") || 2_000);
        const blocks = Math.min(Math.max(Number.isFinite(requested) ? requested : 2_000, 100), 10_000);
        const minBlock = Math.max(Number(D.deployBlock || 0), latest - blocks + 1);
        const addr = ethers.getAddress(address);
        const topics = [[
          protocol.interface.getEvent("Filled").topicHash,
          protocol.interface.getEvent("RFQFilled").topicHash,
        ]];
        const matching = [];
        let fromBlock = latest;
        for (let toBlock = latest; toBlock >= minBlock; toBlock -= 100) {
          fromBlock = Math.max(minBlock, toBlock - 99);
          const page = await provider.getLogs({ address: D.protocol, topics, fromBlock, toBlock });
          for (const log of page) {
            const event = protocol.interface.parseLog(log);
            const seller = event.args.seller || event.args.maker;
            if (event.args.buyer.toLowerCase() === addr.toLowerCase() || seller.toLowerCase() === addr.toLowerCase()) {
              matching.push({ log, event });
            }
          }
          if (matching.length) break;
        }
        const seen = new Set();
        const trades = matching
          .filter(({ log }) => {
            const key = `${log.transactionHash}:${log.index}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .sort((a, b) => b.log.blockNumber - a.log.blockNumber)
          .slice(0, 50)
          .map(({ log, event }) => ({
            transactionHash: log.transactionHash,
            logIndex: log.index,
            blockNumber: log.blockNumber,
            seriesId: Number(event.args.seriesId),
            seller: event.args.seller || event.args.maker,
            buyer: event.args.buyer,
            amount: event.args.amount,
            price: event.args.price,
            via: event.fragment.name === "RFQFilled" ? "rfq" : "book",
          }));
        return reply(200, { fromBlock, latest, trades });
      }
      if (url.pathname === "/metrics") return reply(200, metrics.text(), "text/plain; version=0.0.4");

      if (url.pathname === "/markets") {
        const series = [];
        for (const s of state.series) {
          const f = state.fair.get(s.id);
          series.push({
            id: s.id, fair: f?.price ?? null, delta: f?.delta ?? null, vol: f?.vol ?? null,
            expiry: s.expiry, kind: s.kind, strike: s.strike, strike2: s.strike2,
            token: s.token, stock: s.stock.address, settled: s.settled,
          });
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
      if (url.pathname === "/ohlc") {
        const rawSymbol = url.searchParams.get("symbol") || "";
        const range = url.searchParams.get("range") || "1y";
        const interval = url.searchParams.get("interval") || "1d";
        // strip trailing "x" for Yahoo compatibility: "NVDAx" -> "NVDA"
        const symbol = rawSymbol.replace(/x$/i, "").toUpperCase();
        if (!symbol) return reply(400, { error: "symbol required" });

        const cacheKey = `${symbol}:${range}:${interval}`;
        const cached = ohlcCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          return reply(200, cached.data);
        }

        let yahooRes;
        try {
          yahooRes = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`,
            { headers: { "User-Agent": "Mozilla/5.0 (compatible; weekend-options/1.0)" } }
          );
        } catch (_) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          return reply(502, { error: "upstream failed" });
        }

        if (!yahooRes.ok) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          return reply(502, { error: "upstream failed" });
        }

        let json;
        try {
          json = await yahooRes.json();
        } catch (_) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          return reply(502, { error: "upstream failed" });
        }

        const result = json?.chart?.result?.[0];
        if (!result) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          return reply(502, { error: "upstream failed" });
        }

        const timestamps = result.timestamp || [];
        const q = result.indicators?.quote?.[0] || {};
        const opens = q.open || [];
        const highs = q.high || [];
        const lows = q.low || [];
        const closes = q.close || [];
        const volumes = q.volume || [];

        const data = [];
        for (let i = 0; i < timestamps.length; i++) {
          const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
          // filter out null/NaN candles
          if (o == null || h == null || l == null || c == null) continue;
          data.push({ time: timestamps[i], open: o, high: h, low: l, close: c, volume: volumes[i] ?? 0 });
        }

        ohlcCache.set(cacheKey, { data, expiresAt: Date.now() + 5 * 60 * 1000 });
        res.setHeader("Access-Control-Allow-Origin", "*");
        return reply(200, data);
      }

      reply(404, { error: "not found" });
    } catch (e) {
      metrics.inc("http_errors_total");
      reply(500, { error: e.shortMessage || e.message });
    }
  });
  server.listen(config.port, () => log(`api: http://0.0.0.0:${config.port} (/health /status /metrics /markets /rfq /ohlc)`));
  return server;
}
