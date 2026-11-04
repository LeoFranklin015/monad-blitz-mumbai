// Rules loaded: never conclude without Playwright proof, 1:1 UI, no dead code, no stopping.

import { createChart, CandlestickSeries, LineSeries, HistogramSeries } from "lightweight-charts";
import { D, S, C, call, usd, sh, fromUsd, fromSh, liveSeries, expiriesOf, seriesById, seriesLabel, read } from "../chain.js";
import { W, sendCalls, approvals, onChange as onWalletChange } from "../wallet.js";
import { API_URL, PRODUCTS, SLIPPAGE_BPS } from "../config.js";
import { $$, html, fmt, act, on, toast, errMsg } from "../ui.js";
import { openConnect, claimFaucet } from "../account.js";
import { simulate, positionsAt } from "../sim.js";

// ─── Module-level state ──────────────────────────────────────────────────────

/** Trade form state */
const T = {
  side: "buy",       // "buy" | "sell"
  type: "market",    // "market" | "limit"
  kind: 0,           // option kind 0–3
  expiry: null,      // selected expiry timestamp
  seriesId: null,    // selected series id (number)
  amount: 0.1,       // options (number); the demo book quotes 0.1 to 1 at a time
  simPx: null,       // "what you might get": the NVDAx price you expect at Monday's open (null = current spot)
  limitPrice: "",    // USDC per share (string for input binding)
};

/** OHLC candle cache keyed by symbol */
const ohlcCache = {};
let ohlcFetchedAt = {};

/** Lightweight-charts instances (recreated on render) */
let chartInst = null;
let candleSeries = null;
let premLineSeries = null;
let volHistSeries = null;
let chartResizeObserver = null;

/** Throttle: last time renderBook fetched from chain */
let _bookLastFetch = 0;
let _bookLastSeries = null;

/** Cached event log data for bottom tabs */
let tradesCache = [];
let orderHistoryCache = [];
let tradeHistoryCache = [];

/** Debounce timer for form preview */
let previewDeb = null;

const TOKEN_LOGOS = {
  NVDAx: "https://cdn.simpleicons.org/nvidia",
  TSLAx: "https://cdn.simpleicons.org/tesla",
  SPYx: "https://cdn.simpleicons.org/spglobal",
};

function tokenRibbon() {
  const items = (D?.stocks || []).map((stock) => {
    const price = S.spots[stock.address] || stock.spot || 0;
    const logo = TOKEN_LOGOS[stock.symbol] || "";
    return `<span class="pro-chart__ribbon-item"><span class="pro-chart__token-logo">${logo ? `<img src="${logo}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ""}</span><b>${stock.symbol}</b><span>${fmt.usd(price)}</span></span>`;
  }).join("");
  return items ? `<div class="pro-chart__ribbon" aria-label="Token prices"><div class="pro-chart__ribbon-track"><div class="pro-chart__ribbon-group">${items}</div><div class="pro-chart__ribbon-group" aria-hidden="true">${items}</div></div></div>` : "";
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function pro(root, refreshAll) {
  // Add full-width shell class; will be removed when another view mounts
  root.className = "pro-shell";

  root.innerHTML = html`
<div class="pro-page">

  <!-- 1. TICKER BAR -->
  <div class="pro-ticker">
    <button class="pro-ticker__pair" id="pro-pair-btn">
      <span id="pro-pair-label">NVDAx / USDC</span>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
    <span class="pro-ticker__price mono" id="pro-price">—</span>
    <span class="pro-ticker__change mono" id="pro-change">—</span>
    <div class="pro-ticker__stats">
      <div class="pro-ticker__stat"><span class="k">24h High</span><span class="v" id="pro-high">—</span></div>
      <div class="pro-ticker__stat"><span class="k">24h Low</span><span class="v" id="pro-low">—</span></div>
      <div class="pro-ticker__stat"><span class="k">24h Vol</span><span class="v" id="pro-vol">—</span></div>
    </div>
  </div>

  <!-- 2. MAIN GRID -->
  <div class="pro-main">

    <!-- 2a. CHART -->
    <div class="pro-chart">
      ${tokenRibbon()}
      <div class="pro-chart__toolbar">
        <button class="pro-chart__interval on" data-iv="1m">1m</button>
        <button class="pro-chart__interval" data-iv="5m">5m</button>
        <button class="pro-chart__interval" data-iv="15m">15m</button>
        <button class="pro-chart__interval" data-iv="1h">1h</button>
        <button class="pro-chart__interval" data-iv="4h">4h</button>
        <button class="pro-chart__interval" data-iv="1D">1D</button>
        <button class="pro-chart__interval" data-iv="1W">1W</button>
      </div>
      <div class="pro-chart__mount" id="pro-chart-mount"><div class="pro-hover" id="pro-hover" hidden></div></div>
    </div>

    <!-- 2b. ORDERBOOK + TRADES -->
    <div class="pro-book">
      <div class="pro-panel-tabs">
        <button class="pro-panel-tab on" data-panel="book">Order Book</button>
        <button class="pro-panel-tab" data-panel="trades">Trades</button>
      </div>
      <div id="pro-panel-book" style="display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;">
        <div class="pro-book__header">
          <span>Price (USDC)</span><span>Size (sh)</span><span>Total</span>
        </div>
        <div class="pro-book__asks" id="pro-asks"></div>
        <div class="pro-book__spread" id="pro-spread">Spread: —</div>
        <div class="pro-book__bids" id="pro-bids"></div>
      </div>
      <div id="pro-panel-trades" style="display:none;flex:1;min-height:0;overflow:hidden;">
        <div class="pro-trades">
          <table>
            <thead><tr><th>Time</th><th class="r">Price</th><th class="r">Size</th></tr></thead>
            <tbody id="pro-trades-body"><tr><td colspan="3" class="empty">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 2c. ORDER FORM -->
    <div class="pro-form">
      <div class="pro-form__side-tabs">
        <button class="pro-form__side-tab pro-form__side-tab--buy on" data-side="buy">Buy</button>
        <button class="pro-form__side-tab pro-form__side-tab--sell" data-side="sell">Sell</button>
      </div>
      <div class="pro-form__type-tabs">
        <button class="pro-form__type-tab on" data-type="market">Market</button>
        <button class="pro-form__type-tab" data-type="limit">Limit</button>
      </div>
      <div class="pro-pick" id="pro-pick"></div>
      <button class="pro-form__series" id="pro-series-btn" aria-expanded="false" hidden>
        <span class="pro-form__series-badge" id="pro-kind-badge">Upside</span>
        <span class="pro-form__series-label" id="pro-series-label">Select a series</span>
        <span class="pro-form__series-chevron">▾</span>
      </button>
      <div class="pro-series-panel" id="pro-series-panel" hidden>
        <div class="pro-series-panel__kind-chips" id="pro-kind-chips"></div>
        <div class="pro-series-panel__expiry-chips" id="pro-expiry-chips"></div>
        <div class="pro-series-panel__strikes" id="pro-strike-list"></div>
      </div>
      <div class="pro-form__inputs" id="pro-form-inputs" hidden>
        <label>
          <span>Amount (shares)</span>
          <input id="pro-amt" type="number" min="0.01" step="0.1" value="0.1" />
        </label>
        <label id="pro-limit-row" hidden>
          <span>Limit Price (USDC / share)</span>
          <input id="pro-limit-price" type="number" min="0" step="0.01" placeholder="0.00" />
        </label>
      </div>
      <div class="pro-form__stats" id="pro-form-stats"></div>
      <button class="pro-form__action pro-form__action--buy" id="pro-action-btn">Connect to buy</button>
      <div class="pro-form__balance" id="pro-balance">Available: — USDC</div>
      <div class="pro-sim" id="pro-sim"></div>
    </div>

  </div>

  <!-- 3. BOTTOM TABS -->
  <div class="pro-tabs">
    <div class="pro-tabs__bar">
      <button class="pro-tabs__tab on" data-tab="balances">Balances</button>
      <button class="pro-tabs__tab" data-tab="open-orders">Open Orders</button>
      <button class="pro-tabs__tab" data-tab="order-history">Order History</button>
      <button class="pro-tabs__tab" data-tab="trade-history">Trade History</button>
    </div>
    <div class="pro-tabs__content">
      <div class="pro-tabs__panel on" id="pro-tab-balances">
        ${D.chainId !== 143 ? `<div class="pro-balances-toolbar"><button id="pro-faucet-btn" class="sm">Get test funds</button></div>` : ""}
        <table>
          <thead><tr><th>Token</th><th class="r">Wallet</th><th class="r">Deposited</th><th class="r">Value (USDC)</th><th></th></tr></thead>
          <tbody id="pro-balances-body"><tr><td colspan="5" class="empty">Connect wallet</td></tr></tbody>
        </table>
      </div>
      <div class="pro-tabs__panel" id="pro-tab-open-orders">
        <table>
          <thead><tr><th>Series</th><th>Side</th><th class="r">Price</th><th class="r">Size</th><th></th></tr></thead>
          <tbody id="pro-open-orders-body"><tr><td colspan="5" class="empty">Connect wallet</td></tr></tbody>
        </table>
      </div>
      <div class="pro-tabs__panel" id="pro-tab-order-history">
        <table>
          <thead><tr><th>Time</th><th>Series</th><th>Side</th><th class="r">Price</th><th class="r">Size</th><th>Status</th></tr></thead>
          <tbody id="pro-order-history-body"><tr><td colspan="6" class="empty">Connect wallet</td></tr></tbody>
        </table>
      </div>
      <div class="pro-tabs__panel" id="pro-tab-trade-history">
        <table>
          <thead><tr><th>Time</th><th>Series</th><th>Side</th><th class="r">Price</th><th class="r">Size</th><th class="r">Total</th></tr></thead>
          <tbody id="pro-trade-history-body"><tr><td colspan="6" class="empty">Connect wallet</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

</div>`;

  // ── Helpers ────────────────────────────────────────────────────────────────

  const q = (sel) => root.querySelector(sel);

  function shortTime(ts) {
    return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function activeInterval() {
    return q(".pro-chart__interval.on")?.dataset.iv || "1D";
  }

  function intervalToYahoo(iv) {
    const map = { "1m": { range: "1d", interval: "1m" }, "5m": { range: "5d", interval: "5m" }, "15m": { range: "5d", interval: "15m" },
      "1h": { range: "1mo", interval: "60m" }, "4h": { range: "3mo", interval: "1d" }, "1D": { range: "1y", interval: "1d" }, "1W": { range: "5y", interval: "1wk" } };
    return map[iv] || { range: "1y", interval: "1d" };
  }

  function stockSymbol() {
    return (S.stock?.symbol || "NVDAx").replace(/x$/, "");
  }

  // ── OHLC fetch ─────────────────────────────────────────────────────────────

  async function fetchOhlc(sym, iv) {
    const { range, interval } = intervalToYahoo(iv);
    const key = `${sym}:${iv}`;
    if (ohlcCache[key] && Date.now() - (ohlcFetchedAt[key] || 0) < 3_600_000) return ohlcCache[key];
    try {
      const r = await fetch(`${API_URL}/ohlc?symbol=${sym}&range=${range}&interval=${interval}`);
      if (!r.ok) return ohlcCache[key] || [];
      const data = await r.json();
      ohlcCache[key] = Array.isArray(data) ? data : [];
      ohlcFetchedAt[key] = Date.now();
      return ohlcCache[key];
    } catch {
      return ohlcCache[key] || [];
    }
  }

  // ── Chart setup ────────────────────────────────────────────────────────────

  function destroyChart() {
    if (chartResizeObserver) { chartResizeObserver.disconnect(); chartResizeObserver = null; }
    if (chartInst) { chartInst.remove(); chartInst = null; }
    candleSeries = null;
    premLineSeries = null;
    volHistSeries = null;
  }

  async function buildChart() {
    destroyChart();
    const mount = q("#pro-chart-mount");
    if (!mount) return;

    const w = mount.clientWidth || 600;
    const h = mount.clientHeight || 400;

    chartInst = createChart(mount, {
      width: w,
      height: h,
      layout: { background: { color: "#0b0d10" }, textColor: "#8a93a3" },
      grid: { vertLines: { color: "#1a1e25" }, horzLines: { color: "#1a1e25" } },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: "#232831" },
      timeScale: { borderColor: "#232831", timeVisible: true, secondsVisible: false },
    });

    candleSeries = chartInst.addSeries(CandlestickSeries, {
      upColor: "#3ecf8e", downColor: "#f2555a",
      borderVisible: false, wickUpColor: "#3ecf8e", wickDownColor: "#f2555a",
    });

    // Volume histogram on its own scale
    volHistSeries = chartInst.addSeries(HistogramSeries, {
      color: "#3ecf8e", priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chartInst.priceScale("volume").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    premLineSeries = chartInst.addSeries(LineSeries, {
      color: "#8c52ff", lineWidth: 2,
      priceScaleId: "premium", title: "Fair value",
    });
    chartInst.priceScale("premium").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartInst.subscribeCrosshairMove(onChartHover);
    chartInst.subscribeClick((param) => {
      if (!param.point || !candleSeries) return;
      const px = candleSeries.coordinateToPrice(param.point.y);
      if (px > 0) { T.simPx = Math.round(px * 100) / 100; renderSim().catch(() => {}); }
    });

    // Load candle data
    const sym = stockSymbol();
    const iv = activeInterval();
    const ohlc = await fetchOhlc(sym, iv);
    if (!candleSeries || !volHistSeries) return; // the user left Pro (or the chart was rebuilt) while candles loaded
    if (ohlc.length) {
      candleSeries.setData(ohlc.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
      const validVol = ohlc.filter((c) => c.volume != null && c.volume > 0);
      if (validVol.length) {
        volHistSeries.setData(validVol.map((c) => ({
          time: c.time,
          value: c.volume,
          color: c.close >= c.open ? "rgba(62,207,142,0.4)" : "rgba(242,85,90,0.4)",
        })));
      }
      chartInst.timeScale().fitContent();
    }

    // Seed premium line from fill history
    if (T.seriesId != null) {
      seedPremiumLine().catch(() => {});
    }

    // ResizeObserver
    chartResizeObserver = new ResizeObserver(() => {
      if (chartInst && mount) {
        chartInst.resize(mount.clientWidth, mount.clientHeight);
      }
    });
    chartResizeObserver.observe(mount);
  }

  async function seedPremiumLine() {
    if (!premLineSeries || T.seriesId == null) return;
    try {
      const proto = C.protocol();
      const latest = await read.getBlockNumber();
      const fromBlock = Math.max(0, Number(latest) - 500);
      const fills = await proto.queryFilter(proto.filters.Filled(T.seriesId), fromBlock, "latest");
      if (!fills.length) return;
      // Deduplicate block numbers then batch-fetch with Promise.all
      const blockNums = [...new Set(fills.map((f) => f.blockNumber))];
      const blocks = await Promise.all(blockNums.map((n) => read.getBlock(n).catch(() => null)));
      const blockMap = new Map(blockNums.map((n, i) => [n, blocks[i]]));
      const pts = fills
        .map((f) => {
          const blk = blockMap.get(f.blockNumber);
          return blk ? { time: blk.timestamp, value: fromUsd(f.args.price) } : null;
        })
        .filter(Boolean);
      pts.sort((a, b) => a.time - b.time);
      if (pts.length) premLineSeries.setData(pts);
    } catch {
      // non-fatal
    }
  }

  // ── Ticker bar ─────────────────────────────────────────────────────────────

  function renderTickerBar() {
    const stock = S.stock;
    if (!stock) return;
    const spot = S.spots[stock.address] || stock.spot || 0;
    q("#pro-pair-label").textContent = `${stock.symbol} / USDC`;

    const priceEl = q("#pro-price");
    priceEl.textContent = fmt.usd(spot);

    // 24h change from cached OHLC yesterday close
    const sym = stockSymbol();
    const key = `${sym}:1D`;
    const ohlc = ohlcCache[key];
    let changeEl = q("#pro-change");
    if (ohlc && ohlc.length >= 2) {
      const prevClose = ohlc[ohlc.length - 2].close;
      const change = spot - prevClose;
      const pct = prevClose ? change / prevClose : 0;
      changeEl.textContent = `${change >= 0 ? "+" : ""}${fmt.usd(change, 2)} (${fmt.pct(pct, 2)})`;
      changeEl.className = "pro-ticker__change mono " + (change >= 0 ? "pos" : "neg");
      // 24h high / low / vol from today's candle
      const today = ohlc[ohlc.length - 1];
      q("#pro-high").textContent = fmt.usd(today.high, 2);
      q("#pro-low").textContent = fmt.usd(today.low, 2);
      q("#pro-vol").textContent = today.volume ? fmt.sh(today.volume / 1e6, 2) + "M" : "—";
    } else {
      changeEl.textContent = "—";
      q("#pro-high").textContent = "—";
      q("#pro-low").textContent = "—";
      q("#pro-vol").textContent = "—";
    }
  }

  // ── Stock pair dropdown ───────────────────────────────────────────────────

  function closePairDropdown() {
    q("#pro-pair-dropdown")?.remove();
    q("#pro-pair-btn")?.classList.remove("open");
  }

  function openPairDropdown() {
    if (q("#pro-pair-dropdown")) { closePairDropdown(); return; }
    const btn = q("#pro-pair-btn");
    btn.classList.add("open");
    const dd = document.createElement("div");
    dd.id = "pro-pair-dropdown";
    dd.className = "pro-pair-dropdown";
    dd.innerHTML = D.stocks.map((s) => html`
      <button class="pro-pair-option ${s === S.stock ? "on" : ""}" data-addr="${s.address}">
        <span class="name">${s.symbol} / USDC</span>
        <span class="price mono">${fmt.usd(S.spots[s.address] || s.spot)}</span>
      </button>`).join("");
    // Position below the pair button
    btn.parentElement.style.position = "relative";
    btn.parentElement.appendChild(dd);
    // Close on outside click
    const outside = (e) => { if (!dd.contains(e.target) && e.target !== btn) { closePairDropdown(); document.removeEventListener("click", outside, true); } };
    document.addEventListener("click", outside, true);
    // Close on Escape
    const esc = (e) => { if (e.key === "Escape") { closePairDropdown(); document.removeEventListener("keydown", esc); } };
    document.addEventListener("keydown", esc);
    dd.onclick = (e) => {
      const opt = e.target.closest("[data-addr]");
      if (!opt) return;
      S.stock = D.stocks.find((s) => s.address === opt.dataset.addr) || S.stock;
      T.seriesId = null; T.expiry = null;
      $$(".pro-chart__interval", root).forEach((b) => b.classList.toggle("on", b.dataset.iv === "1D"));
      destroyChart();
      closePairDropdown();
      renderAll();
    };
  }

  function bindPairBtn() {
    q("#pro-pair-btn").onclick = (e) => { e.stopPropagation(); openPairDropdown(); };
  }

  // ── Orderbook ──────────────────────────────────────────────────────────────

  async function renderBook() {
    if (T.seriesId == null) return;
    // Only re-fetch from chain when series changed or 8s have elapsed.
    const now = Date.now();
    if (T.seriesId === _bookLastSeries && now - _bookLastFetch < 8_000) return;
    let asks = [], bids = [];
    try {
      [asks, bids] = await C.protocol().bookOf(T.seriesId);
      _bookLastFetch = Date.now();
      _bookLastSeries = T.seriesId;
    } catch { return; }

    const sortedAsks = [...asks].sort((a, b) => (a.price < b.price ? -1 : 1)).slice(0, 12);
    const sortedBids = [...bids].sort((a, b) => (a.price > b.price ? -1 : 1)).slice(0, 12);

    const maxAskCum = sortedAsks.reduce((acc, q) => acc + fromSh(q.size), 0);
    const maxBidCum = sortedBids.reduce((acc, q) => acc + fromSh(q.size), 0);
    const maxCum = Math.max(maxAskCum, maxBidCum) || 1;

    let askCum = 0;
    const askRows = [...sortedAsks].reverse().map((q) => {
      askCum += fromSh(q.size);
      const pct = (askCum / maxCum * 100).toFixed(1);
      const total = (fromUsd(q.price) * fromSh(q.size)).toFixed(2);
      const own = W.address && q.maker.toLowerCase() === W.address.toLowerCase();
      return html`<div class="pro-ob-row pro-ob-row--ask${own ? " pro-ob-row--own" : ""}">
        <div class="depth-bar" style="width:${pct}%"></div>
        <span class="price">${fmt.usd(fromUsd(q.price), 3)}</span>
        <span class="size">${fmt.sh(fromSh(q.size), 1)}</span>
        <span class="total">${fmt.usd(Number(total), 2)}</span>
      </div>`;
    });

    let bidCum = 0;
    const bidRows = sortedBids.map((q) => {
      bidCum += fromSh(q.size);
      const pct = (bidCum / maxCum * 100).toFixed(1);
      const total = (fromUsd(q.price) * fromSh(q.size)).toFixed(2);
      const own = W.address && q.maker.toLowerCase() === W.address.toLowerCase();
      return html`<div class="pro-ob-row pro-ob-row--bid${own ? " pro-ob-row--own" : ""}">
        <div class="depth-bar" style="width:${pct}%"></div>
        <span class="price">${fmt.usd(fromUsd(q.price), 3)}</span>
        <span class="size">${fmt.sh(fromSh(q.size), 1)}</span>
        <span class="total">${fmt.usd(Number(total), 2)}</span>
      </div>`;
    });

    q("#pro-asks").innerHTML = askRows.join("") || `<div class="empty" style="padding:8px 10px;font-size:12px">No asks</div>`;
    q("#pro-bids").innerHTML = bidRows.join("") || `<div class="empty" style="padding:8px 10px;font-size:12px">No bids</div>`;

    const bestAsk = sortedAsks[0];
    const bestBid = sortedBids[0];
    if (bestAsk && bestBid) {
      const spread = fromUsd(bestAsk.price) - fromUsd(bestBid.price);
      const mid = (fromUsd(bestAsk.price) + fromUsd(bestBid.price)) / 2;
      const pct = mid > 0 ? spread / mid : 0;
      q("#pro-spread").textContent = `Spread: ${fmt.usd(spread, 3)} (${fmt.pct(pct, 2)})`;
    } else {
      q("#pro-spread").textContent = "Spread: —";
    }
  }

  // ── Trades tab ─────────────────────────────────────────────────────────────

  async function refreshTrades() {
    try {
      const proto = C.protocol();
      const latest = await read.getBlockNumber();
      const fromBlock = Math.max(0, Number(latest) - 500);
      // When a specific series is selected filter to it; otherwise show all fills for current stock.
      const seriesIds = T.seriesId != null
        ? [T.seriesId]
        : liveSeries(S.stock).map((s) => s.id);
      const allFills = await Promise.all(
        seriesIds.map((id) => proto.queryFilter(proto.filters.Filled(id), fromBlock, "latest").catch(() => []))
      );
      tradesCache = allFills.flat().sort((a, b) => b.blockNumber - a.blockNumber);
    } catch { /* keep stale */ }
  }

  async function renderTrades() {
    const tbody = q("#pro-trades-body");
    if (!tradesCache.length) { tbody.innerHTML = `<tr><td colspan="3" class="empty">No trades</td></tr>`; return; }
    const rows = await Promise.all(tradesCache.slice(0, 50).map(async (f) => {
      let ts = 0;
      try { const blk = await read.getBlock(f.blockNumber); ts = blk?.timestamp || 0; } catch {}
      const price = fromUsd(f.args.price);
      const size = fromSh(f.args.amount);
      return html`<tr>
        <td>${ts ? shortTime(ts) : "—"}</td>
        <td class="r mono pos">${fmt.usd(price, 3)}</td>
        <td class="r mono">${fmt.sh(size, 1)}</td>
      </tr>`;
    }));
    tbody.innerHTML = rows.join("");
  }

  // ── Series picker panel ────────────────────────────────────────────────────

  async function renderSeriesPanel() {
    const kindChips = q("#pro-kind-chips");
    const expiryChips = q("#pro-expiry-chips");
    const strikeList = q("#pro-strike-list");

    kindChips.innerHTML = PRODUCTS.map((p) =>
      html`<button class="chip ${p.kind === T.kind ? "on" : ""}" data-k="${p.kind}">${p.name}</button>`
    ).join("");

    // Use onclick on the container (not addEventListener) so re-renders don't stack listeners
    kindChips.onclick = (e) => {
      const b = e.target.closest("[data-k]");
      if (!b) return;
      T.kind = Number(b.dataset.k); T.seriesId = null;
      renderSeriesPanel();
    };

    const exps = expiriesOf(S.stock);
    if (!exps.includes(T.expiry)) T.expiry = exps[0] ?? null;

    expiryChips.innerHTML = exps.map((e) =>
      html`<button class="chip ${e === T.expiry ? "on" : ""}" data-e="${e}">${fmt.date(e)} · ${fmt.left(e - S.now)}</button>`
    ).join("");

    // Same pattern: assign onclick to container, not individual chips
    expiryChips.onclick = (e) => {
      const b = e.target.closest("[data-e]");
      if (!b) return;
      T.expiry = Number(b.dataset.e); T.seriesId = null;
      renderSeriesPanel();
    };

    const list = liveSeries(S.stock).filter((s) => s.kind === T.kind && s.expiry === T.expiry).sort((a, b) => a.strike - b.strike);

    // Auto-select first if none selected
    if (!list.find((s) => s.id === T.seriesId)) {
      const spot = S.spots[S.stock?.address];
      const otm = (T.kind === 0 || T.kind === 2)
        ? list.find((s) => s.strike >= spot)
        : [...list].reverse().find((s) => s.strike <= spot);
      T.seriesId = (otm || list[0])?.id ?? null;
      T.autoPicked = true; // replaced below by the nearest strike with asks, if this one has none
    }

    if (!list.length) {
      strikeList.innerHTML = `<div class="empty" style="padding:8px;font-size:12px">No series for this expiry.</div>`;
      return;
    }

    strikeList.innerHTML = `<div class="empty" style="padding:8px;font-size:12px">Loading premiums…</div>`;

    const proto = C.protocol();
    // Price each strike at the ticket's own size, so a 0.1 ask counts as available for a 0.1 order.
    const want = sh(T.amount || 0.1);
    const quotes = await Promise.all(list.map((s) => proto.quoteBuy(s.id, want).catch(() => [0n, 0n])));
    const available = (i) => quotes[i][1] >= want;

    // Pro picked this strike itself and nobody is selling it: move to the closest strike that has asks.
    const sel = list.findIndex((s) => s.id === T.seriesId);
    if (T.autoPicked && sel >= 0 && !available(sel)) {
      const spot = S.spots[S.stock?.address] || 0;
      const best = list.map((s, i) => ({ s, i })).filter(({ i }) => available(i)).sort((a, b) => Math.abs(a.s.strike - spot) - Math.abs(b.s.strike - spot))[0];
      if (best) { T.seriesId = best.s.id; updateSeriesLabel(); debouncedPreview(); }
    }

    strikeList.innerHTML = list.map((s, i) => {
      const [prem, fill] = quotes[i];
      const label = s.kind >= 2 ? `$${s.strike}–$${s.strike2}` : `$${s.strike}`;
      const premStr = available(i) ? fmt.usd(fromUsd(prem) / (T.amount || 0.1), 3) : "no asks";
      return html`<div class="pro-strike-row ${s.id === T.seriesId ? "on" : ""}" data-id="${s.id}">
        <span>${label}</span><span class="prem">${premStr} / sh</span>
      </div>`;
    }).join("");

    // Assign onclick to container to avoid stacking listeners on re-render
    strikeList.onclick = (e) => {
      const b = e.target.closest("[data-id]");
      if (!b) return;
      T.seriesId = Number(b.dataset.id);
      T.autoPicked = false; // the owner chose it: keep it even with no asks
      collapseSeriesPanel();
      updateSeriesLabel();
      debouncedPreview();
    };
  }

  function collapseSeriesPanel() {
    const panel = q("#pro-series-panel");
    panel.hidden = true;
    q("#pro-series-btn").setAttribute("aria-expanded", "false");
  }

  function updateSeriesLabel() {
    const s = seriesById(T.seriesId);
    if (!s) return;
    const names = ["Upside", "Floor", "Capped Upside", "Budget Floor"];
    q("#pro-kind-badge").textContent = names[s.kind] || "Option";
    const label = s.kind >= 2 ? `${S.stock?.symbol} $${s.strike}–$${s.strike2}` : `${S.stock?.symbol} $${s.strike}`;
    q("#pro-series-label").textContent = `${label} · ${fmt.date(s.expiry)}`;
  }

  // ── Order form preview ─────────────────────────────────────────────────────

  function debouncedPreview() {
    clearTimeout(previewDeb);
    previewDeb = setTimeout(() => renderFormStats().catch(() => {}), 250);
  }

  async function renderFormStats() {
    renderSim().catch(() => {});
    const statsEl = q("#pro-form-stats");
    const actionBtn = q("#pro-action-btn");
    const balanceEl = q("#pro-balance");
    const s = seriesById(T.seriesId);

    if (!s) {
      statsEl.innerHTML = "";
      actionBtn.textContent = "Select a series";
      actionBtn.disabled = true;
      return;
    }

    const proto = C.protocol();
    const amtSh = sh(T.amount || 0);

    // Update action button class for side
    actionBtn.className = `pro-form__action pro-form__action--${T.side}`;

    if (!W.address) {
      statsEl.innerHTML = statRow("", "");
      actionBtn.textContent = `Connect to ${T.side}`;
      actionBtn.disabled = false;
      actionBtn.onclick = openConnect;
      balanceEl.textContent = "Available: — USDC";
      return;
    }

    // Balance line
    if (T.side === "buy") {
      try {
        const usdcBal = await C.erc20(D.usdc).balanceOf(W.address);
        balanceEl.textContent = `Available: ${fmt.usd(fromUsd(usdcBal))} USDC`;
      } catch { balanceEl.textContent = "Available: —"; }
    } else {
      try {
        const optBal = await C.token(s.token).balanceOf(W.address);
        balanceEl.textContent = `Holding: ${fmt.sh(fromSh(optBal), 2)} shares`;
      } catch { balanceEl.textContent = "Holding: —"; }
    }

    if (T.type === "market" && T.side === "buy") {
      try {
        const [prem, fill] = await proto.quoteBuy(s.id, amtSh).catch(() => [0n, 0n]);
        // Guard: T.type may have changed while we awaited the RPC call — don't overwrite
        if (T.type !== "market" || T.side !== "buy") return;
        const enough = fromSh(fill) >= T.amount;
        const premNum = fromUsd(prem);
        const slipCost = premNum * Number(SLIPPAGE_BPS) / 10000;
        statsEl.innerHTML = [
          statRow("Order Size", `${fmt.sh(T.amount, 1)} sh`),
          statRow("Premium Total", fmt.usd(premNum)),
          statRow("Est. Received", `${fmt.sh(T.amount, 1)} sh`),
          statRow("Max Slippage", fmt.usd(slipCost)),
          statRow("Protocol Fee", "0.05%"),
        ].join("");
        actionBtn.disabled = !enough;
        actionBtn.textContent = enough
          ? `Buy ${fmt.sh(T.amount, 1)} sh for ${fmt.usd(premNum)}`
          : "Book too thin — get a quote";
        actionBtn.onclick = () => execMarketBuy(s);
      } catch {
        if (T.type !== "market" || T.side !== "buy") return;
        statsEl.innerHTML = statRow("Premium", "—");
        actionBtn.textContent = "Quote unavailable";
        actionBtn.disabled = true;
      }
    } else if (T.type === "market" && T.side === "sell") {
      try {
        const [receive, fill] = await proto.quoteSell(s.id, amtSh).catch(() => [0n, 0n]);
        // Guard: T.type may have changed while we awaited the RPC call
        if (T.type !== "market" || T.side !== "sell") return;
        const enough = fromSh(fill) >= T.amount;
        const recNum = fromUsd(receive);
        const slipCost = recNum * Number(SLIPPAGE_BPS) / 10000;
        statsEl.innerHTML = [
          statRow("Order Size", `${fmt.sh(T.amount, 1)} sh`),
          statRow("Proceeds", fmt.usd(recNum)),
          statRow("Est. Received", fmt.usd(recNum * (1 - Number(SLIPPAGE_BPS) / 10000))),
          statRow("Slippage", fmt.usd(slipCost)),
          statRow("Protocol Fee", "0.05%"),
        ].join("");
        actionBtn.disabled = !enough;
        actionBtn.textContent = enough
          ? `Sell ${fmt.sh(T.amount, 1)} sh for ${fmt.usd(recNum)}`
          : "No bids — post a limit ask";
        actionBtn.onclick = () => execMarketSell(s);
      } catch {
        if (T.type !== "market" || T.side !== "sell") return;
        statsEl.innerHTML = statRow("Receive", "—");
        actionBtn.textContent = "Quote unavailable";
        actionBtn.disabled = true;
      }
    } else if (T.type === "limit" && T.side === "buy") {
      const lp = Number(T.limitPrice) || 0;
      const cost = lp * (T.amount || 0);
      statsEl.innerHTML = [
        statRow("Order Size", `${fmt.sh(T.amount, 1)} sh`),
        statRow("Limit Price", fmt.usd(lp, 3)),
        statRow("Estimated Cost", fmt.usd(cost)),
        statRow("Protocol Fee", "0.05%"),
      ].join("");
      actionBtn.disabled = lp <= 0 || !(T.amount > 0);
      actionBtn.textContent = "Place Buy Limit";
      actionBtn.onclick = () => execLimitBuy(s);
    } else {
      // limit sell
      const lp = Number(T.limitPrice) || 0;
      const cost = lp * (T.amount || 0);
      statsEl.innerHTML = [
        statRow("Order Size", `${fmt.sh(T.amount, 1)} sh`),
        statRow("Limit Price", fmt.usd(lp, 3)),
        statRow("Estimated Proceeds", fmt.usd(cost)),
        statRow("Protocol Fee", "0.05%"),
      ].join("");
      actionBtn.disabled = lp <= 0 || !(T.amount > 0);
      actionBtn.textContent = "Place Sell Limit";
      actionBtn.onclick = () => execLimitSell(s);
    }
  }

  // ── Simple ticket: Upside or Floor, the nearest expiry, 2-3 strikes that have sellers, a few sizes ──

  const PICK_SIZES = [0.1, 0.5, 1];
  async function renderPicker() {
    const el = q("#pro-pick");
    if (!el) return;
    if (T.kind > 1) T.kind = 0;
    const exp = expiriesOf(S.stock)[0];
    if (exp != null && T.expiry !== exp) { T.expiry = exp; T.seriesId = null; }
    const spot = S.spots[S.stock?.address] || 0;
    const list = liveSeries(S.stock).filter((x) => x.kind === T.kind && x.expiry === T.expiry).sort((a, b) => a.strike - b.strike);
    const proto = C.protocol();
    const quotes = await Promise.all(list.map((x) => proto.quoteBuy(x.id, sh(PICK_SIZES[0])).catch(() => [0n, 0n])));
    // Up to 3 strikes with sellers, closest to the price; strikes nobody sells are left out.
    let cards = list.map((x, i) => ({ s: x, per: fromUsd(quotes[i][0]) / PICK_SIZES[0], ok: quotes[i][1] >= sh(PICK_SIZES[0]) }))
      .filter((c) => c.ok).sort((a, b) => Math.abs(a.s.strike - spot) - Math.abs(b.s.strike - spot)).slice(0, 3).sort((a, b) => a.s.strike - b.s.strike);
    // Default to the strike closest to the price: the clearest one to demo.
    if (!cards.find((c) => c.s.id === T.seriesId)) T.seriesId = [...cards].sort((a, b) => Math.abs(a.s.strike - spot) - Math.abs(b.s.strike - spot))[0]?.s.id ?? null;
    const sel = cards.find((c) => c.s.id === T.seriesId);
    // Sizes the book can fill for the selected strike.
    const fills = sel ? await Promise.all(PICK_SIZES.map((n) => proto.quoteBuy(sel.s.id, sh(n)).then((r) => r[1] >= sh(n)).catch(() => false))) : PICK_SIZES.map(() => false);
    // A typed custom size is kept as typed; otherwise snap to the smallest preset the book can fill.
    if (!T.customSize && (!PICK_SIZES.includes(T.amount) || !fills[PICK_SIZES.indexOf(T.amount)])) T.amount = PICK_SIZES[Math.max(0, fills.lastIndexOf(true) >= 0 ? fills.indexOf(true) : 0)];
    // How much the selected strike can fill right now, for the custom-size hint.
    let maxFill = 0;
    if (sel && T.customSize) {
      const [, f] = await proto.quoteBuy(sel.s.id, sh(T.amount)).catch(() => [0n, 0n]);
      maxFill = fromSh(f);
    }
    const blurb = T.kind === 0 ? "Profit if NVDAx rises. Worst case: what you pay." : "Sell at a fixed price, even on Saturday. Worst case: what you pay.";
    el.innerHTML = html`
      <div class="pro-pick__kinds">
        <button class="pro-pick__kind ${T.kind === 0 ? "on up" : ""}" data-kind="0"><b>Upside</b><small>if it goes up</small></button>
        <button class="pro-pick__kind ${T.kind === 1 ? "on down" : ""}" data-kind="1"><b>Floor</b><small>if it goes down</small></button>
      </div>
      <div class="pro-pick__blurb">${blurb}</div>
      <div class="pro-pick__label">${T.kind === 0 ? "Pays above" : "Pays below"}</div>
      <div class="pro-pick__strikes">
        ${cards.length ? cards.map((c) => `<button class="pro-pick__strike ${c.s.id === T.seriesId ? "on" : ""}" data-id="${c.s.id}"><b>$${c.s.strike}</b><small>${fmt.usd(c.per)} / option</small></button>`).join("") : `<div class="pro-pick__empty">No sellers right now. Quotes refresh every few seconds.</div>`}
      </div>
      <div class="pro-pick__label">Size</div>
      <div class="pro-pick__sizes">
        ${PICK_SIZES.map((n, i) => `<button class="pro-pick__size ${!T.customSize && n === T.amount ? "on" : ""}" data-n="${n}" ${fills[i] ? "" : "disabled"}>${n}</button>`).join("")}
        <input class="pro-pick__custom ${T.customSize ? "on" : ""}" id="pro-pick-custom" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="Custom" value="${T.customSize ? T.amount : ""}" aria-label="Custom size" />
      </div>
      ${T.customSize && sel && maxFill + 1e-9 < T.amount ? `<div class="pro-pick__hint">Only ${fmt.sh(maxFill, 2)} available at $${sel.s.strike} right now.</div>` : ""}`;
    updateSeriesLabel();
    el.onclick = (e) => {
      const k = e.target.closest("[data-kind]"), st = e.target.closest("[data-id]"), n = e.target.closest("[data-n]");
      if (k) { T.kind = Number(k.dataset.kind); T.seriesId = null; T.simPx = null; }
      else if (st) T.seriesId = Number(st.dataset.id);
      else if (n && !n.disabled) { T.amount = Number(n.dataset.n); T.customSize = false; const a = q("#pro-amt"); if (a) a.value = T.amount; }
      else return;
      updateSeriesLabel();
      renderPicker().then(() => { renderBook().catch(() => {}); debouncedPreview(); }).catch(() => {});
    };
    // Custom size: applied when typing pauses or on Enter/blur, so the field keeps focus while you type.
    const custom = el.querySelector("#pro-pick-custom");
    let typing = null;
    const applyCustom = () => {
      const v = Number(custom.value);
      if (!(v > 0)) return;
      T.amount = Math.round(v * 1e6) / 1e6; T.customSize = true;
      const a = q("#pro-amt"); if (a) a.value = T.amount;
      el.querySelectorAll(".pro-pick__size").forEach((b) => b.classList.remove("on"));
      custom.classList.add("on");
      debouncedPreview();
    };
    custom.oninput = () => { clearTimeout(typing); typing = setTimeout(applyCustom, 400); };
    custom.onkeydown = (e) => { if (e.key === "Enter") { clearTimeout(typing); applyCustom(); renderPicker().catch(() => {}); } };
    custom.onblur = () => { clearTimeout(typing); if (Number(custom.value) > 0) { applyCustom(); renderPicker().catch(() => {}); } };
  }

  /// Pro picked the strike itself and nobody is selling it at the ticket size: switch to the closest strike that has asks.
  async function preferAvailable(list) {
    const sel = list.find((x) => x.id === T.seriesId);
    if (!T.autoPicked || !sel) return;
    const want = sh(T.amount || 0.1);
    const proto = C.protocol();
    const [, fill] = await proto.quoteBuy(sel.id, want).catch(() => [0n, 0n]);
    if (fill >= want) return;
    const fills = await Promise.all(list.map((x) => proto.quoteBuy(x.id, want).then((r) => r[1]).catch(() => 0n)));
    const spot = S.spots[S.stock?.address] || 0;
    const best = list.filter((_, i) => fills[i] >= want).sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
    if (best) T.seriesId = best.id;
  }

  // ── What you might get ─────────────────────────────────────────────────────
  // Same settlement math as the contract (sim.js): type or click a Monday-open price and see the payout.

  let simPremium = { key: "", value: 0 };
  async function ticketPremium(s) {
    const key = `${s.id}:${T.amount}`;
    if (simPremium.key !== key) {
      const [prem, fill] = await C.protocol().quoteBuy(s.id, sh(T.amount)).catch(() => [0n, 0n]);
      simPremium = { key, value: fromUsd(prem), filled: fromSh(fill) >= T.amount };
    }
    return simPremium;
  }

  function payoffSvg(s, amount, premium, spot, at) {
    const lo = spot * 0.8, hi = spot * 1.2, W_ = 260, H = 84, n = 48;
    const pts = Array.from({ length: n + 1 }, (_, i) => { const P = lo + ((hi - lo) * i) / n; return [P, simulate(s, P, amount, premium).pnl]; });
    const ys = pts.map((p) => p[1]);
    const yMin = Math.min(...ys, 0), yMax = Math.max(...ys, 0), span = yMax - yMin || 1;
    const X = (P) => ((P - lo) / (hi - lo)) * W_, Y = (v) => H - 6 - ((v - yMin) / span) * (H - 12);
    const line = pts.map(([P, v], i) => `${i ? "L" : "M"}${X(P).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    const atP = Math.min(hi, Math.max(lo, at));
    const atV = simulate(s, atP, amount, premium).pnl;
    return `<svg class="pro-sim__curve" viewBox="0 0 ${W_} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="${W_}" y1="${Y(0)}" y2="${Y(0)}" class="zero"/>
      <line x1="${X(spot)}" x2="${X(spot)}" y1="0" y2="${H}" class="spot"/>
      <path d="${line}" class="pnl"/>
      <circle cx="${X(atP)}" cy="${Y(atV)}" r="3.5" class="${atV >= 0 ? "up" : "down"}"/>
    </svg>`;
  }

  /// One "what you might get" card. `ctx`: { s, amount, premium, estimated, getPx, setPx, title, note }.
  /// Used by the ticket (before you buy) and by the trade popup (the position you just bought).
  function drawSim(el, ctx) {
    const { s, amount, premium, estimated } = ctx;
    const spot = S.spots[S.stock.address] || s.stock.spot;
    const P = ctx.getPx() ?? Math.round(spot * 100) / 100;
    const r = simulate(s, P, amount, premium);
    const got = r.receive.token === "USDC" ? fmt.usd(r.receive.amount) : `${fmt.sh(r.receive.amount, 4)} ${r.receive.token}`;
    const chip = (pct) => { const v = Math.round(spot * (1 + pct / 100) * 100) / 100; return `<button class="pro-sim__chip ${Math.abs(v - P) < 0.01 ? "on" : ""}" data-px="${v}">${pct === 0 ? "now" : (pct > 0 ? "+" : "") + pct + "%"}</button>`; };
    el.innerHTML = html`
      <div class="pro-sim__head"><span>${ctx.title || "What you might get"}</span><span class="pro-sim__hint">${ctx.hint || ""}</span></div>
      <label class="pro-sim__px"><span>${s.stock.symbol} at Monday's open</span>
        <span class="pro-sim__px-input"><b>$</b><input class="pro-sim-px" type="number" step="0.5" value="${P}" /></span></label>
      <div class="pro-sim__chips">${[-10, -5, 0, 5, 10].map(chip).join("")}</div>
      ${payoffSvg(s, amount, premium, spot, P)}
      <div class="pro-sim__rows">
        ${statRow("You receive", got)}
        ${statRow("Worth", fmt.usd(r.receive.usd))}
        ${statRow(estimated ? "Premium (est. fair value)" : "Premium paid", premium ? fmt.usd(premium) : "—")}
        <div class="pro-form__stat-row pro-sim__pnl ${r.pnl >= 0 ? "up" : "down"}"><span class="k">Profit / loss</span><span class="v">${premium ? `${r.pnl >= 0 ? "+" : "−"}${fmt.usd(Math.abs(r.pnl))}` : "—"}</span></div>
        ${statRow("Break-even", fmt.usd(r.breakEven))}
        ${r.maxPayout != null ? statRow("Best case", fmt.usd(r.maxPayout)) : ""}
      </div>
      <div class="pro-sim__note">${ctx.note || (s.kind === 0 ? `Settles in ${s.stock.symbol} shares, paid automatically at expiry. Worst case: the premium.` : "Settles in USDC, paid automatically at expiry. Worst case: the premium.")}</div>`;
    const redraw = () => drawSim(el, ctx);
    el.querySelector(".pro-sim-px").onchange = (e) => { const v = Number(e.target.value); ctx.setPx(v > 0 ? v : null); redraw(); };
    el.querySelectorAll(".pro-sim__chip").forEach((b) => (b.onclick = () => { ctx.setPx(Number(b.dataset.px)); redraw(); }));
  }

  async function renderSim() {
    const el = q("#pro-sim");
    if (!el) return;
    const s = seriesById(T.seriesId);
    if (!s || T.side !== "buy") { el.innerHTML = ""; return; }
    const book = await ticketPremium(s);
    const fair = S.fair?.get(s.id)?.fair || 0;
    const estimated = !(book.value > 0 && book.filled) && fair > 0; // no asks: price it at the backend's fair value
    drawSim(el, {
      s, amount: T.amount, premium: estimated ? fair * T.amount : book.value, estimated,
      getPx: () => T.simPx, setPx: (v) => (T.simPx = v), hint: "click the chart to pick a price",
    });
  }

  /// After a buy lands: a receipt and the simulator for exactly what was bought.
  function showTradePopup({ s, amount, premium, hash }) {
    const m = document.getElementById("modal");
    if (!m) return;
    const label = `${PRODUCTS[s.kind].name} ${s.stock.symbol} $${s.strike}${s.strike2 ? "–$" + s.strike2 : ""}`;
    const explorer = D.chainId === 10143 && hash ? `https://testnet.monadvision.com/tx/${hash}` : null;
    let px = T.simPx;
    m.innerHTML = html`<div class="card pro-receipt" role="dialog" aria-label="Trade placed">
      <div class="pro-receipt__head">
        <span class="pro-receipt__tick" aria-hidden="true">✓</span>
        <div><div class="pro-receipt__title">Trade placed</div>
          <div class="pro-receipt__sub">Bought ${fmt.sh(amount, 4)} ${label}</div></div>
        <button class="ghost sm" id="pro-receipt-close">Close</button>
      </div>
      <div class="pro-receipt__facts">
        <div><span>Paid</span><b>${fmt.usd(premium)}</b></div>
        <div><span>Worst case</span><b>−${fmt.usd(premium)}</b></div>
        <div><span>Liquidation</span><b class="up">None</b></div>
        <div><span>Expires</span><b>${fmt.date(s.expiry)}</b></div>
      </div>
      <div class="pro-sim pro-receipt__sim" id="pro-receipt-sim"></div>
      <div class="pro-receipt__foot">
        ${explorer ? `<a href="${explorer}" target="_blank" rel="noopener">View transaction ↗</a>` : `<span class="dim mono">${hash ? fmt.addr(hash) : ""}</span>`}
        <button class="primary sm" id="pro-receipt-done">Done</button>
      </div>
    </div>`;
    m.hidden = false;
    drawSim(m.querySelector("#pro-receipt-sim"), {
      s, amount, premium, estimated: false, getPx: () => px, setPx: (v) => { px = v; T.simPx = v; },
      title: "What you might get on Monday", hint: "drag the price, see your payout",
    });
    const close = () => { m.hidden = true; m.innerHTML = ""; };
    m.querySelector("#pro-receipt-close").onclick = close;
    m.querySelector("#pro-receipt-done").onclick = close;
    m.onclick = null; // only Done / Close dismiss it: a stray click outside must not lose the receipt
  }

  // Held positions in this stock, with what they cost (remembered at buy time, else from recent fills).
  let held = [], heldAt = 0;
  const costKey = (id) => `wkend.cost.${D.chainId}.${(W.address || "").toLowerCase()}.${id}`;
  function rememberCost(id, usdPaid) {
    try { localStorage.setItem(costKey(id), String((Number(localStorage.getItem(costKey(id))) || 0) + usdPaid)); } catch {}
  }
  async function loadHeld() {
    if (!W.address) { held = []; return held; }
    if (Date.now() - heldAt < 20_000) return held;
    heldAt = Date.now();
    const list = (S.stock.series || []).filter((s) => s.expiry > S.now);
    const bals = await Promise.all(list.map((s) => C.token(s.token).balanceOf(W.address).catch(() => 0n)));
    held = list.map((s, i) => ({ series: seriesById(s.id) || s, amount: fromSh(bals[i]) })).filter((h) => h.amount > 1e-9).map((h) => {
      let cost = null;
      try { const c = localStorage.getItem(costKey(h.series.id)); if (c != null) cost = Number(c); } catch {}
      if (cost == null) {
        const buys = tradeHistoryCache.filter((t) => t.isBuy && Number(t.e.args.seriesId) === h.series.id);
        if (buys.length) cost = buys.reduce((a, t) => a + fromUsd(t.e.args.price) * fromSh(t.e.args.amount), 0);
      }
      return { ...h, cost: cost ?? 0, costKnown: cost != null };
    });
    return held;
  }

  function onChartHover(param) {
    const tip = q("#pro-hover");
    if (!tip || !candleSeries) return;
    if (!param.point) { tip.hidden = true; return; }
    const P = candleSeries.coordinateToPrice(param.point.y);
    if (!(P > 0)) { tip.hidden = true; return; }
    loadHeld().catch(() => {});
    const parts = [`<div class="pro-hover__px">If ${S.stock.symbol} settles Monday at <b>${fmt.usd(P)}</b></div>`];
    if (held.length) {
      const at = positionsAt(held, P);
      const allCosts = held.every((h) => h.costKnown);
      parts.push(`<div class="pro-hover__row"><span>Your ${held.length === 1 ? "position pays" : `${held.length} positions pay`}</span><b>${fmt.usd(at.usd)}</b></div>`);
      if (allCosts) parts.push(`<div class="pro-hover__row ${at.pnl >= 0 ? "up" : "down"}"><span>Profit / loss</span><b>${at.pnl >= 0 ? "+" : "−"}${fmt.usd(Math.abs(at.pnl))}</b></div>`);
    }
    const s = seriesById(T.seriesId);
    if (s && T.side === "buy") {
      const r = simulate(s, P, T.amount, simPremium.value);
      parts.push(`<div class="pro-hover__row dim"><span>This ticket (${fmt.sh(T.amount, 2)} ${PRODUCTS[s.kind].name} $${s.strike}${s.strike2 ? "–$" + s.strike2 : ""})</span><b>${fmt.usd(r.receive.usd)}</b></div>`);
    }
    tip.innerHTML = parts.join("");
    tip.hidden = false;
    const mount = q("#pro-chart-mount");
    const x = Math.min(param.point.x + 16, mount.clientWidth - tip.offsetWidth - 70);
    const y = Math.max(8, Math.min(param.point.y - tip.offsetHeight - 12, mount.clientHeight - tip.offsetHeight - 8));
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  function statRow(k, v) {
    return html`<div class="pro-form__stat-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  }

  // ── Order execution ────────────────────────────────────────────────────────

  async function execMarketBuy(s) {
    if (!W.address) return openConnect();
    const amt = sh(T.amount);
    let prem;
    try {
      [prem] = await C.protocol().quoteBuy(s.id, amt);
    } catch (e) {
      toast(errMsg(e), 7000);
      return;
    }
    const maxCost = (prem * (10000n + SLIPPAGE_BPS)) / 10000n + 1n;
    showBuyLoader(s);
    await act("Buying", async () => {
      try {
      const approveCalls = await approvals(D.usdc, D.protocol, maxCost);
      const rc = await sendCalls([...approveCalls, call(D.protocol, "OptionsProtocol", "buy", [s.id, amt, maxCost, W.address])]);
      rememberCost(s.id, fromUsd(prem));
      heldAt = 0; // reload held positions
      showTradePopup({ s, amount: T.amount, premium: fromUsd(prem), hash: rc?.hash || rc?.transactionHash || rc?.receipts?.[0]?.transactionHash });
      } catch (e) { hideBuyLoader(); throw e; }
    }, refreshAll);
  }

  // Shown from the Buy click until the trade popup replaces it (or an error closes it).
  function showBuyLoader(s) {
    const m = document.getElementById("modal");
    if (!m) return;
    const label = `${PRODUCTS[s.kind].name} ${s.stock.symbol} $${s.strike}`;
    const ask = W.kind === "mera" ? "Confirm with your passkey" : "Confirm in your wallet";
    m.innerHTML = html`<div class="card pro-loader" role="status" aria-live="polite" id="pro-buy-loader">
      <div class="pro-loader__spin" aria-hidden="true"></div>
      <div class="pro-loader__title">Buying ${fmt.sh(T.amount, 4)} ${label}</div>
      <div class="pro-loader__sub">${ask}, then we wait for the transaction to be mined.</div>
    </div>`;
    m.onclick = null;
    m.hidden = false;
  }

  function hideBuyLoader() {
    const m = document.getElementById("modal");
    if (m?.querySelector("#pro-buy-loader")) { m.hidden = true; m.innerHTML = ""; }
  }

  async function execMarketSell(s) {
    if (!W.address) return openConnect();
    const amt = sh(T.amount);
    let receive;
    try {
      [receive] = await C.protocol().quoteSell(s.id, amt);
    } catch (e) {
      toast(errMsg(e), 7000);
      return;
    }
    const minReceive = (receive * (10000n - SLIPPAGE_BPS)) / 10000n;
    await act("Selling", async () => {
      await sendCalls([call(D.protocol, "OptionsProtocol", "sell", [s.id, amt, minReceive, false])]);
    }, refreshAll);
  }

  async function execLimitBuy(s) {
    if (!W.address) return openConnect();
    const price = usd(T.limitPrice);
    const size = sh(T.amount);
    const collateralNeeded = (price * size) / (10n ** 18n);
    let approveCalls;
    try {
      approveCalls = await approvals(D.usdc, D.protocol, collateralNeeded);
    } catch (e) {
      toast(errMsg(e), 7000);
      return;
    }
    await act("Placing bid", async () => {
      await sendCalls([...approveCalls, call(D.protocol, "OptionsProtocol", "postBid", [s.id, price, size])]);
    }, refreshAll);
  }

  async function execLimitSell(s) {
    if (!W.address) return openConnect();
    const price = usd(T.limitPrice);
    const size = sh(T.amount);
    // Upside options require stock as collateral; others require USDC
    const collateralToken = s.kind === 0 ? s.stock.address : D.usdc;
    const collateralAmt = s.kind === 0 ? size : (price * size) / (10n ** 18n);
    let approveCalls;
    try {
      approveCalls = await approvals(collateralToken, D.protocol, collateralAmt);
    } catch (e) {
      toast(errMsg(e), 7000);
      return;
    }
    await act("Posting ask", async () => {
      await sendCalls([...approveCalls, call(D.protocol, "OptionsProtocol", "postQuote", [s.id, price, size])]);
    }, refreshAll);
  }

  // ── Bottom tabs: Balances ──────────────────────────────────────────────────

  async function renderBalances() {
    const faucetBtn = q("#pro-faucet-btn");
    if (faucetBtn) faucetBtn.onclick = execFaucet;
    const tbody = q("#pro-balances-body");
    if (!W.address) { tbody.innerHTML = `<tr><td colspan="5" class="empty">Connect wallet</td></tr>`; return; }
    tbody.innerHTML = `<tr><td colspan="5" class="empty">Loading…</td></tr>`;
    try {
      const proto = C.protocol();
      const tokens = [{ a: D.usdc, sym: "USDC", isUsd: true }, ...D.stocks.map((s) => ({ a: s.address, sym: s.symbol, isUsd: false }))];
      const [walletBals, depositedBals] = await Promise.all([
        Promise.all(tokens.map((t) => C.erc20(t.a).balanceOf(W.address))),
        Promise.all(tokens.map((t) => proto.freeBalance(W.address, t.a))),
      ]);
      // Also load option token balances for live series
      const live = liveSeries(S.stock);
      const optBals = await Promise.all(live.map((s) => C.token(s.token).balanceOf(W.address).catch(() => 0n)));

      const fmtToken = (num, isUsd) => isUsd ? fmt.usd(num) : `${fmt.sh(num, 4)} sh`;
      const fmtVal = (val) => val === 0 ? `<span class="dim">—</span>` : fmt.usd(val);
      const rows = tokens.map((t, i) => {
        const walletNum = t.isUsd ? fromUsd(walletBals[i]) : fromSh(walletBals[i]);
        const depNum = t.isUsd ? fromUsd(depositedBals[i]) : fromSh(depositedBals[i]);
        const spot = t.isUsd ? 1 : (S.spots[t.a] || 0);
        const val = (walletNum + depNum) * spot;
        return html`<tr>
          <td>${t.sym}</td>
          <td class="r mono">${fmtToken(walletNum, t.isUsd)}</td>
          <td class="r mono">${fmtToken(depNum, t.isUsd)}</td>
          <td class="r mono">${fmtVal(val)}</td>
          <td class="r"><button class="pro-dep-btn" data-token="${t.a}" data-sym="${t.sym}" data-isusd="${t.isUsd}">Dep</button> <button class="pro-wd-btn" data-token="${t.a}" data-sym="${t.sym}" data-isusd="${t.isUsd}">Wd</button></td>
        </tr>`;
      });

      // Option token rows (wallet-held only; protocol holds writer collateral separately)
      const optRows = live.map((s, i) => {
        if (optBals[i] === 0n) return "";
        const optNum = fromSh(optBals[i]);
        const fair = S.fair.get(s.id)?.fair || 0;
        return html`<tr>
          <td>${seriesLabel(s)}</td>
          <td class="r mono">${fmt.sh(optNum, 2)} sh</td>
          <td class="r mono dim">—</td>
          <td class="r mono">${fmtVal(optNum * fair)}</td>
          <td></td>
        </tr>`;
      }).filter(Boolean);

        const combined = rows.join("") + optRows.join("");
      tbody.innerHTML = combined || `<tr><td colspan="5" class="empty">No balances found</td></tr>`;
      tbody.querySelectorAll(".pro-dep-btn").forEach((b) => {
        b.onclick = () => execDeposit(b.dataset.token, b.dataset.sym, b.dataset.isusd === "true");
      });
      tbody.querySelectorAll(".pro-wd-btn").forEach((b) => {
        b.onclick = () => execWithdraw(b.dataset.token, b.dataset.sym, b.dataset.isusd === "true");
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">Error loading balances</td></tr>`;
      console.error(e);
    }
  }

  async function execFaucet() {
    if (!W.address) return openConnect();
    if (!D.mocks) return claimFaucet(refreshAll); // real Kuru tokens can't be minted: the backend faucet sends some
    const MINT_USDC = usd(10_000);
    await act("Minting test funds", async () => {
      const mintCalls = [call(D.usdc, "MockERC20", "mint", [W.address, MINT_USDC])];
      for (const s of D.stocks) mintCalls.push(call(s.address, "MockXStock", "mint", [W.address, sh(100)]));
      await sendCalls(mintCalls);
    }, refreshAll);
    // auto-deposit the USDC into the protocol
    await act("Depositing USDC", async () => {
      const approveCalls = await approvals(D.usdc, D.protocol, MINT_USDC);
      await sendCalls([...approveCalls, call(D.protocol, "OptionsProtocol", "deposit", [D.usdc, MINT_USDC])]);
    }, refreshAll);
  }

  async function execDeposit(tokenAddr, sym, isUsd) {
    if (!W.address) return openConnect();
    const amtStr = prompt(`Deposit how many ${sym}? (e.g. 1000)`);
    if (!amtStr) return;
    const parsed = isUsd ? usd(amtStr) : sh(amtStr);
    if (parsed === 0n) return;
    await act(`Depositing ${sym}`, async () => {
      const approveCalls = await approvals(tokenAddr, D.protocol, parsed);
      await sendCalls([...approveCalls, call(D.protocol, "OptionsProtocol", "deposit", [tokenAddr, parsed])]);
    }, refreshAll);
  }

  async function execWithdraw(tokenAddr, sym, isUsd) {
    if (!W.address) return openConnect();
    const amtStr = prompt(`Withdraw how many ${sym}? (e.g. 1000)`);
    if (!amtStr) return;
    const parsed = isUsd ? usd(amtStr) : sh(amtStr);
    if (parsed === 0n) return;
    await act(`Withdrawing ${sym}`, async () => {
      await sendCalls([call(D.protocol, "OptionsProtocol", "withdraw", [tokenAddr, parsed])]);
    }, refreshAll);
  }

  // ── Bottom tabs: Open Orders ───────────────────────────────────────────────

  async function renderOpenOrders() {
    const tbody = q("#pro-open-orders-body");
    if (!W.address) { tbody.innerHTML = `<tr><td colspan="5" class="empty">Connect wallet</td></tr>`; return; }
    tbody.innerHTML = `<tr><td colspan="5" class="empty">Loading…</td></tr>`;
    try {
      const proto = C.protocol();
      const quoteIds = await proto.quotesOf(W.address);
      if (!quoteIds.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty">No open orders</td></tr>`; return; }
      const quotes = await Promise.all(quoteIds.map((id) => proto.getQuote(id)));
      const live = quotes.map((q, i) => ({ q, id: quoteIds[i] })).filter((x) => x.q.size > 0n);
      if (!live.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty">No open orders</td></tr>`; return; }
      tbody.innerHTML = live.map(({ q: qt, id }) => {
        const s = seriesById(Number(qt.seriesId));
        return html`<tr>
          <td>${s ? seriesLabel(s) : qt.seriesId.toString()}</td>
          <td>${qt.isBid ? '<span class="pos">Bid</span>' : '<span class="neg">Ask</span>'}</td>
          <td class="r mono">${fmt.usd(fromUsd(qt.price), 3)}</td>
          <td class="r mono">${fmt.sh(fromSh(qt.size), 1)}</td>
          <td class="r"><button class="pro-cancel-btn" data-cancel="${id}">Cancel</button></td>
        </tr>`;
      }).join("");
      q("#pro-tab-open-orders").querySelectorAll("[data-cancel]").forEach((b) => {
        b.onclick = () => act("Cancelling", () => sendCalls([call(D.protocol, "OptionsProtocol", "cancelQuote", [BigInt(b.dataset.cancel)])]), refreshAll);
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">Error loading orders</td></tr>`;
      console.error(e);
    }
  }

  // ── Bottom tabs: Order History ─────────────────────────────────────────────

  async function refreshOrderHistory() {
    if (!W.address) return;
    try {
      const proto = C.protocol();
      const latest = await read.getBlockNumber();
      const fromBlock = Math.max(0, Number(latest) - 1000);
      const [posted, cancelled] = await Promise.all([
        proto.queryFilter(proto.filters.QuotePosted(null, null, W.address), fromBlock, "latest"),
        proto.queryFilter(proto.filters.QuoteCancelled(), fromBlock, "latest"),
      ]);
      const cancelledIds = new Set(cancelled.map((e) => e.args.quoteId.toString()));
      const filledFilter = proto.filters.Filled();
      const filled = await proto.queryFilter(filledFilter, fromBlock, "latest");
      const filledIds = new Set(filled.map((e) => e.args.quoteId?.toString()).filter(Boolean));

      orderHistoryCache = [...posted].sort((a, b) => b.blockNumber - a.blockNumber).slice(0, 50).map((e) => {
        const qid = e.args.quoteId.toString();
        const status = cancelledIds.has(qid) ? "Cancelled" : filledIds.has(qid) ? "Filled" : "Active";
        return { e, status };
      });
    } catch { /* keep stale */ }
  }

  async function renderOrderHistory() {
    const tbody = q("#pro-order-history-body");
    if (!W.address) { tbody.innerHTML = `<tr><td colspan="6" class="empty">Connect wallet</td></tr>`; return; }
    if (!orderHistoryCache.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty">No order history</td></tr>`; return; }
    const rows = await Promise.all(orderHistoryCache.map(async ({ e, status }) => {
      let ts = 0;
      try { const blk = await read.getBlock(e.blockNumber); ts = blk?.timestamp || 0; } catch {}
      const s = seriesById(Number(e.args.seriesId));
      const statusClass = status === "Filled" ? "pos" : status === "Cancelled" ? "neg" : "muted";
      return html`<tr>
        <td>${ts ? fmt.date(ts) : "—"}</td>
        <td>${s ? seriesLabel(s) : e.args.seriesId.toString()}</td>
        <td>${e.args.isBid ? '<span class="pos">Bid</span>' : '<span class="neg">Ask</span>'}</td>
        <td class="r mono">${fmt.usd(fromUsd(e.args.price), 3)}</td>
        <td class="r mono">${fmt.sh(fromSh(e.args.size), 1)}</td>
        <td><span class="${statusClass}">${status}</span></td>
      </tr>`;
    }));
    tbody.innerHTML = rows.join("") || `<tr><td colspan="6" class="empty">No history</td></tr>`;
  }

  // ── Bottom tabs: Trade History ─────────────────────────────────────────────

  async function refreshTradeHistory() {
    if (!W.address) return;
    try {
      const response = await fetch(`${API_URL}/trades?address=${encodeURIComponent(W.address)}`);
      if (response.ok) {
        const { trades = [] } = await response.json();
        tradeHistoryCache = trades.map((trade) => ({
          e: {
            blockNumber: trade.blockNumber,
            args: {
              seriesId: BigInt(trade.seriesId), buyer: trade.buyer, seller: trade.seller,
              amount: BigInt(trade.amount), price: BigInt(trade.price),
            },
          },
          isBuy: trade.buyer.toLowerCase() === W.address.toLowerCase(),
          isRfq: trade.via === "rfq",
        }));
        return;
      }
      const proto = C.protocol();
      const latest = await read.getBlockNumber();
      const fromBlock = Math.max(0, Number(latest) - 1000);
      const addr = W.address;
      const [filledBuy, filledSell, rfqBuy, rfqSell] = await Promise.all([
        proto.queryFilter(proto.filters.Filled(null, null, addr), fromBlock, "latest"),
        proto.queryFilter(proto.filters.Filled(null, addr, null), fromBlock, "latest"),
        proto.queryFilter(proto.filters.RFQFilled(null, null, addr), fromBlock, "latest"),
        proto.queryFilter(proto.filters.RFQFilled(null, addr, null), fromBlock, "latest"),
      ]);
      const seen = new Set();
      const all = [...filledBuy, ...filledSell, ...rfqBuy, ...rfqSell].filter((e) => {
        const key = `${e.transactionHash}-${e.logIndex}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      tradeHistoryCache = all.sort((a, b) => b.blockNumber - a.blockNumber).slice(0, 50).map((e) => {
        const isBuy = e.args.buyer?.toLowerCase() === addr.toLowerCase();
        return { e, isBuy, isRfq: !e.args.quoteId || e.args.quoteId === undefined };
      });
    } catch { /* keep stale */ }
  }

  async function renderTradeHistory() {
    const tbody = q("#pro-trade-history-body");
    if (!W.address) { tbody.innerHTML = `<tr><td colspan="6" class="empty">Connect wallet</td></tr>`; return; }
    if (!tradeHistoryCache.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty">No trade history</td></tr>`; return; }
    const rows = await Promise.all(tradeHistoryCache.map(async ({ e, isBuy }) => {
      let ts = 0;
      try { const blk = await read.getBlock(e.blockNumber); ts = blk?.timestamp || 0; } catch {}
      const s = seriesById(Number(e.args.seriesId));
      const price = fromUsd(e.args.price);
      const size = fromSh(e.args.amount);
      const total = price * size;
      return html`<tr>
        <td>${ts ? fmt.date(ts) : "—"}</td>
        <td>${s ? seriesLabel(s) : e.args.seriesId.toString()}</td>
        <td><span class="${isBuy ? "pos" : "neg"}">${isBuy ? "Bought" : "Sold"}</span></td>
        <td class="r mono">${fmt.usd(price, 3)}</td>
        <td class="r mono">${fmt.sh(size, 1)}</td>
        <td class="r mono">${fmt.usd(total)}</td>
      </tr>`;
    }));
    tbody.innerHTML = rows.join("") || `<tr><td colspan="6" class="empty">No trades</td></tr>`;
  }

  // ── Active bottom tab routing ──────────────────────────────────────────────

  function activeBottomTab() {
    return q(".pro-tabs__tab.on")?.dataset.tab || "balances";
  }

  async function renderActiveBottomTab() {
    const tab = activeBottomTab();
    if (tab === "balances") await renderBalances();
    else if (tab === "open-orders") await renderOpenOrders();
    else if (tab === "order-history") await renderOrderHistory();
    else if (tab === "trade-history") await renderTradeHistory();
  }

  // ── Event wiring ───────────────────────────────────────────────────────────

  function bindEvents() {
    // Pair button
    bindPairBtn();

    // Chart interval buttons
    on(root, ".pro-chart__interval", "click", (_, b) => {
      $$(".pro-chart__interval", root).forEach((el) => el.classList.remove("on"));
      b.classList.add("on");
      const sym = stockSymbol();
      fetchOhlc(sym, b.dataset.iv).then((ohlc) => {
        if (candleSeries && ohlc.length) {
          candleSeries.setData(ohlc.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
          chartInst?.timeScale().fitContent();
        }
      });
    });

    // Orderbook/Trades panel tabs
    on(root, ".pro-panel-tab", "click", (_, b) => {
      $$(".pro-panel-tab", root).forEach((el) => el.classList.remove("on"));
      b.classList.add("on");
      const panel = b.dataset.panel;
      q("#pro-panel-book").style.display = panel === "book" ? "flex" : "none";
      q("#pro-panel-trades").style.display = panel === "trades" ? "flex" : "none";
      if (panel === "trades") refreshTrades().then(renderTrades);
    });

    // Buy/Sell side tabs
    on(root, ".pro-form__side-tab", "click", (_, b) => {
      $$(".pro-form__side-tab", root).forEach((el) => el.classList.remove("on"));
      b.classList.add("on");
      T.side = b.dataset.side;
      debouncedPreview();
    });

    // Market/Limit type tabs
    on(root, ".pro-form__type-tab", "click", (_, b) => {
      $$(".pro-form__type-tab", root).forEach((el) => el.classList.remove("on"));
      b.classList.add("on");
      T.type = b.dataset.type;
      const limitRow = q("#pro-limit-row");
      limitRow.hidden = T.type !== "limit";
      debouncedPreview();
    });

    // Series selector toggle
    q("#pro-series-btn").onclick = () => {
      const panel = q("#pro-series-panel");
      const expanded = panel.hidden;
      panel.hidden = !expanded;
      q("#pro-series-btn").setAttribute("aria-expanded", String(expanded));
      if (expanded) renderSeriesPanel().catch(() => {});
    };

    // Amount input
    q("#pro-amt").oninput = (e) => {
      T.amount = Math.max(0.01, Number(e.target.value) || 0);
      debouncedPreview();
    };

    // Limit price input
    q("#pro-limit-price").oninput = (e) => {
      T.limitPrice = e.target.value;
      debouncedPreview();
    };

    // Bottom tabs
    on(root, ".pro-tabs__tab", "click", (_, b) => {
      $$(".pro-tabs__tab", root).forEach((el) => el.classList.remove("on"));
      b.classList.add("on");
      $$(".pro-tabs__panel", root).forEach((el) => el.classList.remove("on"));
      const panel = q(`#pro-tab-${b.dataset.tab}`);
      if (panel) panel.classList.add("on");
      renderActiveBottomTab().catch(() => {});
    });
  }

  // ── Full render ────────────────────────────────────────────────────────────

  async function renderAll() {
    // Ensure correct stock series state
    if (!S.stock) S.stock = D.stocks[0];

    // Pre-fetch 1D candles for the ticker 24h stats independent of the chart interval.
    fetchOhlc(stockSymbol(), "1D").then(() => renderTickerBar()).catch(() => {});

    renderTickerBar();

    // Resolve series selection
    const exps = expiriesOf(S.stock);
    if (!exps.includes(T.expiry)) T.expiry = exps[0] ?? null;
    const list = T.expiry != null
      ? liveSeries(S.stock).filter((s) => s.kind === T.kind && s.expiry === T.expiry).sort((a, b) => a.strike - b.strike)
      : [];
    if (!list.find((s) => s.id === T.seriesId)) {
      const spot = S.spots[S.stock?.address];
      const otm = (T.kind === 0 || T.kind === 2)
        ? list.find((s) => s.strike >= spot)
        : [...list].reverse().find((s) => s.strike <= spot);
      T.seriesId = (otm || list[0])?.id ?? null;
      T.autoPicked = true;
    }
    await preferAvailable(list);
    await renderPicker().catch(() => {});
    updateSeriesLabel();

    await buildChart();
    await Promise.all([
      renderBook(),
      renderFormStats(),
      renderActiveBottomTab(),
    ]);
  }

  // ── tick (fast, ~2s) ───────────────────────────────────────────────────────

  async function tick() {
    renderTickerBar();
    await renderBook();

    // Append live fair-value point to premium line
    if (premLineSeries && T.seriesId != null) {
      const fair = S.fair.get(T.seriesId)?.fair;
      if (fair != null) {
        try { premLineSeries.update({ time: Math.floor(Date.now() / 1000), value: fair }); } catch {}
      }
    }

    // Update form preview if inputs not focused
    const formEl = q(".pro-form");
    if (formEl && !formEl.contains(document.activeElement)) {
      debouncedPreview();
    }
  }

  // ── slow (heavy, ~6s) ─────────────────────────────────────────────────────

  async function slow() {
    renderTickerBar();

    // Always keep the 1D candles warm for the ticker 24h stats.
    const sym = stockSymbol();
    const key1D = `${sym}:1D`;
    if (!ohlcFetchedAt[key1D] || Date.now() - ohlcFetchedAt[key1D] > 3_600_000) {
      fetchOhlc(sym, "1D").then(() => renderTickerBar()).catch(() => {});
    }

    // Refresh chart OHLC if stale
    const iv = activeInterval();
    const key = `${sym}:${iv}`;
    if (!ohlcFetchedAt[key] || Date.now() - ohlcFetchedAt[key] > 3_600_000) {
      const ohlc = await fetchOhlc(sym, iv);
      if (candleSeries && ohlc.length) {
        candleSeries.setData(ohlc.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
      }
    }

    // Refresh bottom tab data for the visible tab
    const tab = activeBottomTab();
    if (tab === "open-orders") {
      await renderOpenOrders();
    } else if (tab === "order-history") {
      await refreshOrderHistory();
      await renderOrderHistory();
    } else if (tab === "trade-history") {
      await refreshTradeHistory();
      await renderTradeHistory();
    } else {
      await renderBalances();
    }

    // Refresh trades cache for the orderbook trades panel
    const tradesPanel = q("#pro-panel-trades");
    if (tradesPanel && tradesPanel.style.display !== "none") {
      await refreshTrades();
      await renderTrades();
    }
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  bindEvents();

  // Re-render bottom tab and form immediately when wallet connects/disconnects.
  onWalletChange(() => {
    renderActiveBottomTab().catch(() => {});
    renderFormStats().catch(() => {});
  });

  // Cleanup: when root gets replaced, destroy chart
  const observer = new MutationObserver(() => {
    if (!document.contains(q(".pro-page"))) {
      destroyChart();
      observer.disconnect();
      root.className = "";
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return {
    render: renderAll,
    tick,
    slow,
  };
}
