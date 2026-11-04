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
import { contracts, usdTo, shTo, usdFrom, shFrom, log, signer, send } from "../lib/chain.js";
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
const faucetClaims = new Map(); // lowercase address -> last claim time (ms)
const faucet = config.faucetKey ? signer(config.faucetKey) : null;
const rpcCache = new Map(); // normalized-request-key -> { body, expiresAt }

// Read-only JSON-RPC methods whose result is stable enough to cache for a few seconds.
const RPC_CACHEABLE = new Set(["eth_call", "eth_chainId", "eth_getBalance", "eth_getCode", "eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs", "net_version"]);
const rpcCacheable = (parsed) => {
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.length > 0 && arr.every((c) => c && RPC_CACHEABLE.has(c.method));
};
// Rewrite cached response ids to match the current request's ids (ethers correlates by id).
function restampIds(cachedBody, reqParsed) {
  try {
    const resp = JSON.parse(cachedBody);
    if (Array.isArray(resp) && Array.isArray(reqParsed)) {
      reqParsed.forEach((c, i) => { if (resp[i]) resp[i].id = c.id; });
      return JSON.stringify(resp);
    }
    if (!Array.isArray(resp) && !Array.isArray(reqParsed)) {
      resp.id = reqParsed.id;
      return JSON.stringify(resp);
    }
  } catch { /* fall through */ }
  return cachedBody;
}
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
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* forward as-is, don't cache */ }

        // Short-TTL cache keyed on method+params (ids stripped) so the poll loop's repeated
        // reads don't re-hit the upstream. State-changing methods are never cached.
        const cacheable = config.rpcCacheMs > 0 && parsed && rpcCacheable(parsed);
        let key = null;
        if (cacheable) {
          const norm = (c) => ({ method: c.method, params: c.params });
          key = JSON.stringify(Array.isArray(parsed) ? parsed.map(norm) : norm(parsed));
          const hit = rpcCache.get(key);
          if (hit && hit.expiresAt > Date.now()) {
            metrics.inc("rpc_cache_total", { result: "hit" });
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            return res.end(restampIds(hit.body, parsed));
          }
          metrics.inc("rpc_cache_total", { result: "miss" });
        }

        const upstream = await fetch(config.nextUpstream(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        const text = await upstream.text();
        if (cacheable && upstream.ok) {
          rpcCache.set(key, { body: text, expiresAt: Date.now() + config.rpcCacheMs });
          if (rpcCache.size > 5_000) rpcCache.clear();
        }
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", "application/json");
        return res.end(text);
      }
      // Test funds on a real-token deployment (Kuru's tokens can't be minted): the faucet key sends a little of each
      // token and some gas money. One claim per address per day, plus the per-IP limit.
      if (url.pathname === "/faucet" && req.method === "POST") {
        if (D.mocks) return reply(400, { error: "mock deployment: mint test funds from the app" });
        if (!faucet) return reply(503, { error: "faucet not configured" });
        if (limited(ip)) return reply(429, { error: "too many requests" });
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 2000) return reply(413, { error: "too large" }); }
        let to;
        try { to = ethers.getAddress(JSON.parse(body).address); } catch { return reply(400, { error: "send { address }" }); }
        const last = faucetClaims.get(to.toLowerCase()) || 0;
        if (Date.now() - last < 24 * 3600 * 1000) return reply(429, { error: "this wallet already got test funds today" });
        faucetClaims.set(to.toLowerCase(), Date.now());
        const c = contracts(faucet);
        const sent = [];
        const pay = async (label, fn) => { const r = await send(faucet, label, fn); if (r) sent.push({ label, tx: r.hash }); return r; };
        // Send only what the faucet actually holds, so one empty token doesn't fail the whole claim.
        const me = await faucet.getAddress();
        const usdcAmt = usdTo(config.faucetUsdc);
        if ((await c.usdc.balanceOf(me)) >= usdcAmt) await pay(`${config.faucetUsdc} USDC`, () => c.usdc.transfer(to, usdcAmt, { gasLimit: 90_000 }));
        for (const st of D.stocks) {
          const amt = shTo(config.faucetStock);
          if ((await c.stock(st.address).balanceOf(me)) >= amt) await pay(`${config.faucetStock} ${st.symbol}`, () => c.stock(st.address).transfer(to, amt, { gasLimit: 90_000 }));
        }
        const bal = await faucet.provider.getBalance(to);
        if (bal < ethers.parseEther(String(config.faucetNative))) await pay(`${config.faucetNative} MON`, () => faucet.sendTransaction({ to, value: ethers.parseEther(String(config.faucetNative)), gasLimit: 21_000 }));
        if (!sent.length) { faucetClaims.delete(to.toLowerCase()); return reply(502, { error: "faucet is empty or the chain refused, try again later" }); }
        log(`faucet: ${to} ${sent.map((x) => x.label).join(", ")}`);
        return reply(200, { to, sent });
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
