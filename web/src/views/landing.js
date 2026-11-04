// Landing: the story in the order a judge needs it. The gap, the evidence, the damage, the products, how it works.
// Live bits (hero chart, ticker, NVDAx price line, quote count, contract addresses) read the shared app state; nothing here signs.
import { createChart, CandlestickSeries, LineSeries, createSeriesMarkers } from "lightweight-charts";
import { D, S } from "../chain.js";
import { API_URL } from "../config.js";
import { fmt } from "../ui.js";

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const H = 3600;
const IST = 19800; // the chart reads in IST, like the Kuru capture: shift unix seconds so the axis prints IST
const FROM = Date.UTC(2026, 9, 28, 0, 30) / 1000; // Wed Oct 28 06:00 IST, start of the Kuru capture
// The three moments from the Kuru NVDAx capture (Claude.md "The chart"), as UTC hour slots on the :30 grid.
const CALLOUTS = [
  { n: 1, t: Date.UTC(2026, 9, 29, 20, 30) / 1000, on: "gap", pos: "aboveBar", text: "1 · -1.4%" },
  { n: 2, t: Date.UTC(2026, 9, 30, 3, 30) / 1000, on: "gap", pos: "belowBar", text: "2 · ~12h, no trades" },
  { n: 3, t: Date.UTC(2026, 9, 30, 15, 30) / 1000, on: "candle", text: "3 · -2.7%" },
];
const C = { bg: "#0b0d10", grid: "#1a1e25", text: "#8a93a3", up: "#3ecf8e", down: "#f2555a", warn: "#f5b84a", accent: "#8c52ff" };

/// Nasdaq 1h candles laid on a continuous hourly axis. Hours with no candle are the gap.
async function loadWeek() {
  const r = await fetch(`${API_URL}/ohlc?symbol=NVDA&range=1mo&interval=60m`);
  if (!r.ok) throw new Error(`ohlc ${r.status}`);
  const raw = (await r.json()).filter((c) => c.time >= FROM && c.volume > 0 && c.time % H === 1800);
  if (raw.length < 14) throw new Error("not enough candles");
  const by = new Map(raw.map((c) => [c.time, c]));
  const end = Math.max(raw[raw.length - 1].time, Math.floor(Date.now() / 1000 / H) * H + 1800);
  const candles = [], dashes = [], slots = [];
  let run = null; // one flat dashed run per closed stretch: a line series doesn't break on whitespace
  let last = null;
  for (let t = FROM; t <= end; t += H) {
    const c = by.get(t), time = t + IST;
    if (c) {
      candles.push({ time, open: c.open, high: c.high, low: c.low, close: c.close });
      last = c.close;
      run = null;
      // the flat dashed line starts at the close of the last candle before a gap
      if (!by.has(t + H)) dashes.push((run = [{ time, value: c.close }]));
    } else {
      candles.push({ time });
      if (last != null) { if (!run) dashes.push((run = [])); run.push({ time, value: last }); }
    }
    slots.push({ time, open: !!c });
  }
  return { candles, dashes, slots };
}

/// Payoff shape at expiry, as an honest glyph: x = stock price, y = value of the position.
function payoff(kind) {
  const paths = {
    upside: "M2 22 L30 22 L58 4",
    floor: "M2 4 L30 22 L58 22",
    protect: "M2 14 L22 14 L58 6",
    earn: "M2 10 L30 10 L58 10",
  };
  const floorLine = kind === "protect" ? `<path d="M2 14 L22 14" class="lp-pay__guard"/>` : "";
  return `<svg class="lp-pay lp-pay--${kind}" viewBox="0 0 60 26" aria-hidden="true"><path d="M2 22 H58" class="lp-pay__axis"/><path d="${paths[kind]}" class="lp-pay__line"/>${floorLine}</svg>`;
}

const PRODUCTS = [
  { k: "upside", name: "Upside", route: "pro", line: "Leverage with a fixed worst case. Nothing to liquidate.", worst: "The premium you paid", where: "Pro" },
  { k: "floor", name: "Floor", route: "pro", line: "Sell at a fixed price any time before expiry, even on Saturday.", worst: "The premium you paid", where: "Pro" },
  { k: "protect", name: "Protect", route: "protect", line: "A stock-backed loan with a Floor bought from inside the lender. The wick can't liquidate it.", worst: "Loan interest plus the Floor premium", where: "Protect", soon: true },
  { k: "earn", name: "Earn", route: "earn", line: "Write Upside against your xStocks and collect the premium, or deposit into Auto-Commit and it writes every week within fixed rules.", worst: "You give up gains above the agreed price", where: "Earn", soon: true },
];

export function landing(root) {
  root.className = "lp-shell";
  const hasKuru = !!D?.kuruAdapter;
  const windowMin = Math.round((D?.settlementWindow || 600) / 60);

  const steps = [
    { t: "Every quote is backed", d: "Makers lock the stock or the USDC before they quote. No margin, so there is nothing to liquidate.", a: [["OptionsProtocol", D?.protocol]] },
    { t: "An onchain book on Monad", d: "Bids and asks live onchain and makers reprice them as the stock moves. Fast blocks and cheap gas keep it there, so any contract can buy a Floor in one call.", a: [], live: true },
    hasKuru
      ? { t: "Hedged on Kuru, inside your transaction", d: "When you buy, the maker's contract hedges on Kuru's NVDAx book in the same transaction as your fill.", a: [["HedgedMaker", D.hedgedMaker], ["KuruAdapter", D.kuruAdapter]] }
      : { t: "Hedged inside your transaction", d: "When you buy, the maker's contract hedges its stock exposure on spot in the same transaction as your fill.", a: [["HedgedMaker", D?.hedgedMaker]] },
    { t: `Settles to a ${windowMin}-minute average`, d: "Options nobody exercised settle on the average price over the window after expiry. Not a single print that can be wicked.", a: [["Oracle", D?.oracle]] },
    { t: "Paid automatically", d: "After expiry a keeper pays holders and writers. No claim button.", a: [] },
  ];

  root.innerHTML = `
<div class="lp">
  <div class="lp-tape" id="lp-tape" aria-label="Live market"></div>

  <section class="lp-hero" aria-labelledby="lp-h1">
    <div class="lp-hero__copy">
      <h1 id="lp-h1">Nasdaq is open <span class="lp-num">32.5</span> hours a week. <span class="lp-hero__b">NVDAx trades all <span class="lp-num">168</span>.</span></h1>
      <p class="lp-lede">Weekend Options lets you trade, hedge and earn on that gap, with a worst case you know before you click. Fully collateralized options on tokenized stocks, on an onchain order book on Monad.</p>
      <div class="lp-cta">
        <a class="lp-btn lp-btn--primary" href="#pro" data-cta="launch">Launch Pro</a>
        <a class="lp-btn" href="#lp-evidence">See last week's chart</a>
      </div>
    </div>
    <figure class="lp-live" id="lp-live">
      <figcaption class="lp-live__bar">
        <span class="lp-live__sym"><b>NVDA</b><span class="dim">· 1h · Nasdaq · IST</span></span>
        <span class="lp-live__ohlc mono" id="lp-ohlc"></span>
        <span class="lp-live__now mono" id="lp-now"></span>
      </figcaption>
      <div class="lp-live__plot" id="lp-plot">
        <div class="lp-live__bands" id="lp-bands" aria-hidden="true"></div>
        <div class="lp-live__mount" id="lp-mount" role="img" aria-label="NVDA hourly candles since Oct 28 2026. Shaded columns are hours Nasdaq is closed while NVDAx keeps trading onchain. Markers show the three moments from the Kuru NVDAx chart below."></div>
      </div>
      <div class="lp-live__key">
        <span><i class="k-band"></i>Nasdaq closed · NVDAx still trades</span>
        <span><i class="k-dash"></i>No stock price</span>
        <span><i class="k-dot"></i>NVDAx now, Monad</span>
        <span><i class="k-mark"></i>What NVDAx did on Kuru</span>
      </div>
    </figure>
  </section>

  <section class="lp-sec" id="lp-evidence" aria-labelledby="lp-ev-h">
    <div class="lp-sec__head">
      <h2 id="lp-ev-h">When the stock market shuts, the book goes thin and prices jump.</h2>
      <p>Every dashed flat line is an hour with no trades. Real candles show up mostly while Nasdaq is open. Outside it the token barely trades, and when it does, it gaps.</p>
    </div>
    <div class="lp-ev">
      <figure class="lp-chart" id="lp-chart">
        <div class="lp-chart__frame">
          <img src="/nvdax-kuru-1h.png" alt="NVDAx on Kuru, 1 hour candles, October 28 to November 1 2026. Sparse candles with long dashed gaps; price falls from about 218 to 204 dollars." width="1632" height="1302" />
          <a class="lp-mark" href="#lp-c1" data-n="1" style="left:43%;top:33.5%;width:4.6%;height:24%" aria-label="Callout 1"><span>1</span></a>
          <a class="lp-mark lp-mark--span" href="#lp-c2" data-n="2" style="left:46.6%;top:53.6%;width:11.4%;height:5.6%" aria-label="Callout 2"><span>2</span></a>
          <a class="lp-mark lp-mark--down" href="#lp-c3" data-n="3" style="left:62.2%;top:66.5%;width:3.6%;height:19%" aria-label="Callout 3"><span>3</span></a>
        </div>
        <figcaption>NVDAx on Kuru, Oct 28 to Nov 1 2026 <span class="dim">· 1h candles · IST · kuru.io</span></figcaption>
      </figure>
      <ol class="lp-callouts">
        <li id="lp-c1"><span class="lp-callouts__n">1</span><div><b class="down">-1.4%</b><span class="lp-callouts__t">between two trades</span><p>Fri Oct 30, about 01:00 to 03:00 IST, right after Thursday's close. Last trade near $212.7, next one near $209.7. Nothing in between, so no one could react.</p></div></li>
        <li id="lp-c2"><span class="lp-callouts__n">2</span><div><b>~12h</b><span class="lp-callouts__t">almost no trades</span><p>Fri Oct 30, about 03:00 to 15:00 IST. The price on screen is a stale print.</p></div></li>
        <li id="lp-c3"><span class="lp-callouts__n">3</span><div><b class="down">-2.7%</b><span class="lp-callouts__t">in an hour, then back</span><p>Fri Oct 30, about 21:00 IST. $207.1 to a low near $201.6, then back to $204.9 the next hour.</p></div></li>
      </ol>
    </div>
  </section>

  <section class="lp-sec" aria-labelledby="lp-dmg-h">
    <div class="lp-sec__head">
      <h2 id="lp-dmg-h">The position was right. It still died.</h2>
      <p>Callout 3, replayed on three longs opened at $207.10. A 40x perp is liquidated on the wick. The price was back an hour later. It wasn't.</p>
    </div>
    <div class="lp-dmg">
      <div class="lp-tbl" role="table" aria-label="Callout 3 replayed">
        <div class="lp-tbl__r lp-tbl__h" role="row">
          <span role="columnheader">Long NVDAx at $207.10</span>
          <span role="columnheader" class="r">Wick low $201.60 <em class="down">-2.7%</em></span>
          <span role="columnheader" class="r">Next hour $204.90</span>
        </div>
        <div class="lp-tbl__r" role="row">
          <span role="cell"><b>40x perp</b></span>
          <span role="cell" class="r"><i class="lp-tag lp-tag--down">Liquidated</i></span>
          <span role="cell" class="r t dim">Closed out. Can't come back.</span>
        </div>
        <div class="lp-tbl__r" role="row">
          <span role="cell"><b>10x perp</b></span>
          <span role="cell" class="r down">-27% of margin</span>
          <span role="cell" class="r">-11% of margin</span>
        </div>
        <div class="lp-tbl__r lp-tbl__r--ours" role="row">
          <span role="cell"><b class="up">Upside</b> <span class="dim">Weekend Options</span></span>
          <span role="cell" class="r t">Still open. Nothing to liquidate.</span>
          <span role="cell" class="r t up">Still open. Worst case was the premium.</span>
        </div>
      </div>
      <ul class="lp-also" aria-label="What else breaks in the gap">
        <li><b>Stock-backed loans</b><span>A wick on a thin weekend book liquidates a healthy loan before Monday's open gives the real price.</span></li>
        <li><b>No weekend protection</b><span>Listed options don't trade while the market is closed, and there was no onchain options market for xStocks.</span></li>
        <li><b>Idle xStocks</b><span>Holders earn nothing. The tokens sit there all weekend.</span></li>
      </ul>
    </div>
  </section>

  <section class="lp-sec" aria-labelledby="lp-prod-h" id="lp-products">
    <div class="lp-sec__head">
      <h2 id="lp-prod-h">Know your worst case before you click.</h2>
      <p>Four ways to use the gap, each fully collateralized so none can be liquidated. Upside and Floor are live today; Protect and Earn are coming soon.</p>
    </div>
    <div class="lp-prod" role="table" aria-label="Products">
      <div class="lp-prod__r lp-prod__h" role="row"><span role="columnheader">Product</span><span role="columnheader">Payoff</span><span role="columnheader">What it does</span><span role="columnheader">Worst case</span><span role="columnheader"></span></div>
      ${PRODUCTS.map((p) => `
      <a class="lp-prod__r lp-prod__r--${p.k}${p.soon ? " lp-prod__r--soon" : ""}" role="row" href="#${p.route}" data-product="${p.name}">
        <span role="cell" class="lp-prod__name">${p.name}</span>
        <span role="cell">${payoff(p.k)}</span>
        <span role="cell" class="lp-prod__line">${p.line}</span>
        <span role="cell" class="lp-prod__worst"><span class="lp-prod__wk">Worst case</span>${p.worst}</span>
        <span role="cell" class="lp-prod__go">${p.soon ? `<span class="soon-tag">Coming soon</span>` : `Open in ${p.where} <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 9L9 3M4 3h5v5"/></svg>`}</span>
      </a>`).join("")}
    </div>
  </section>

  <section class="lp-sec" aria-labelledby="lp-how-h">
    <div class="lp-sec__head">
      <h2 id="lp-how-h">What happens when you buy.</h2>
      <p>Running now on Monad testnet. These are the contracts this page is reading.</p>
    </div>
    <ol class="lp-trace">
      ${steps.map((s) => `
      <li>
        <b>${s.t}</b>
        <p>${s.d}</p>
        <div class="lp-trace__a">${s.a.filter(([, v]) => v).map(([k, v]) => `<code title="${v}"><span>${k}</span>${short(v)}</code>`).join("")}${s.live ? `<code><span>On the book</span><em id="lp-quotes">-</em></code>` : ""}</div>
      </li>`).join("")}
    </ol>
  </section>

  <section class="lp-end" aria-label="Launch">
    <div>
      <h2>Trade the gap.</h2>
      <p class="muted" id="lp-end-state">Options trade when stocks don't.</p>
    </div>
    <a class="lp-btn lp-btn--primary" href="#pro" data-cta="launch-end">Launch Pro</a>
  </section>

  <footer class="lp-foot">
    <span>Built on Monad · Monad Blitz Mumbai</span>
    <span class="dim">Monad testnet. Not audited. Not investment advice, and no promise of returns. Options on tokenized US stocks carry the same geographic restrictions as the xStocks themselves.</span>
  </footer>
</div>`;

  const $ = (sel) => root.querySelector(sel);
  let chart = null, candleSeries = null, nowLine = null, slots = [];

  /// Shaded columns behind the (transparent) chart canvas, one per run of closed hours.
  function drawBands() {
    const host = $("#lp-bands");
    if (!chart || !host || !slots.length) return;
    const ts = chart.timeScale();
    const plotW = $("#lp-mount").clientWidth - chart.priceScale("right").width();
    const a = ts.timeToCoordinate(slots[0].time), b = ts.timeToCoordinate(slots[1].time);
    const sp = a != null && b != null ? b - a : 6;
    const runs = [];
    for (const s of slots) {
      if (s.open) continue;
      const r = runs[runs.length - 1];
      if (r && r.end === s.time - H) r.end = s.time; else runs.push({ start: s.time, end: s.time });
    }
    let widest = null, html = "";
    for (const r of runs) {
      const x0 = Math.max(0, ts.timeToCoordinate(r.start) - sp / 2), x1 = Math.min(plotW, ts.timeToCoordinate(r.end) + sp / 2);
      if (!(x1 > x0)) continue;
      if (!widest || x1 - x0 > widest.w) widest = { x0, w: x1 - x0 };
      html += `<i style="left:${x0}px;width:${x1 - x0}px"></i>`;
    }
    if (widest && widest.w > 120) html += `<span class="lp-live__label" style="left:${widest.x0}px;width:${widest.w}px">Nasdaq closed<br>NVDAx still trades</span>`;
    host.innerHTML = html;
  }

  async function buildChart() {
    const mount = $("#lp-mount");
    let data;
    try { data = await loadWeek(); } catch (e) {
      console.warn("landing chart: falling back to the Kuru capture", e);
      $("#lp-plot").innerHTML = `<img class="lp-live__fallback" src="/nvdax-kuru-1h.png" alt="NVDAx on Kuru, 1 hour candles, Oct 28 to Nov 1 2026" />`;
      $("#lp-live").classList.add("is-fallback");
      return;
    }
    await document.fonts?.ready; // price-axis width is measured once; measure it in Geist Mono
    if (!mount.isConnected) return;
    slots = data.slots;
    chart = createChart(mount, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: C.text, fontFamily: "Geist Mono, ui-monospace, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: { mode: 0, vertLine: { color: "#3a4150", labelBackgroundColor: "#232831" }, horzLine: { color: "#3a4150", labelBackgroundColor: "#232831" } },
      rightPriceScale: { borderColor: "#232831", scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: "#232831", timeVisible: true, secondsVisible: false, rightOffset: 4, fixLeftEdge: true },
      handleScroll: false, handleScale: false,
    });
    const dashOpts = { color: "#8a93a3", lineWidth: 1, lineStyle: 3, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
    const dashSeries = data.dashes.filter((r) => r.length > 1).map((r) => { const l = chart.addSeries(LineSeries, dashOpts); l.setData(r); return { l, r }; });
    candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down,
      lastValueVisible: false, priceLineVisible: false,
    });
    candleSeries.setData(data.candles);
    const at = (c) => c.t + IST;
    for (const c of CALLOUTS.filter((x) => x.on === "gap")) {
      const host = dashSeries.find(({ r }) => r.some((p) => p.time === at(c)));
      if (host) createSeriesMarkers(host.l, [{ time: at(c), position: c.pos, shape: c.pos === "aboveBar" ? "arrowDown" : "arrowUp", color: C.warn, text: c.text }]);
    }
    createSeriesMarkers(candleSeries, CALLOUTS.filter((c) => c.on === "candle").map((c) => ({ time: at(c), position: "aboveBar", shape: "arrowDown", color: C.down, text: c.text })));
    chart.subscribeCrosshairMove((p) => {
      const c = p?.seriesData?.get(candleSeries);
      $("#lp-ohlc").innerHTML = c && c.open != null
        ? `O<b>${c.open.toFixed(2)}</b> H<b>${c.high.toFixed(2)}</b> L<b>${c.low.toFixed(2)}</b> C<b class="${c.close >= c.open ? "up" : "down"}">${c.close.toFixed(2)}</b>`
        : p?.time ? `<span class="dim">Nasdaq closed this hour. No stock price.</span>` : "";
    });
    // Narrow screens: frame the callouts and the weekend instead of squeezing all 8 days.
    const narrow = mount.clientWidth < 640;
    const first = data.slots[0].time, lastT = data.slots[data.slots.length - 1].time;
    const frame = () => narrow
      ? chart.timeScale().setVisibleRange({ from: Date.UTC(2026, 9, 29, 12, 30) / 1000 + IST, to: Math.min(lastT, Date.UTC(2026, 9, 31, 12, 30) / 1000 + IST) })
      : chart.timeScale().setVisibleRange({ from: first, to: lastT });
    frame();
    requestAnimationFrame(frame); // autoSize lays the chart out a frame later
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestAnimationFrame(drawBands));
    new ResizeObserver(() => requestAnimationFrame(drawBands)).observe(mount);
    const live = $("#lp-live");
    live.dataset.candles = data.candles.filter((c) => c.open != null).length;
    live.dataset.callouts = CALLOUTS.length;
    livePrice();
    requestAnimationFrame(drawBands);
  }

  /// Dotted last-price line with a tag: NVDAx's live price on the Monad deployment.
  function livePrice() {
    const st = D?.stocks?.[0];
    const px = st ? S.spots[st.address] || st.spot : 0;
    if (!px) return;
    $("#lp-now").innerHTML = `<span class="dim">${st.symbol} on Monad</span> <b>${fmt.usd(px)}</b>`;
    if (!candleSeries) return;
    const opts = { price: px, color: C.up, lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: st.symbol };
    if (nowLine) nowLine.applyOptions(opts); else nowLine = candleSeries.createPriceLine(opts);
  }

  function tape() {
    const items = (D?.stocks || []).map((st) => {
      const px = S.spots[st.address] || st.spot || 0;
      return `<span class="lp-tape__i"><b>${st.symbol}</b><span class="mono">${fmt.usd(px)}</span></span>`;
    });
    const closed = S.closed;
    items.push(`<span class="lp-tape__i"><span class="lp-dot ${closed ? "warn" : "up"}"></span>${closed ? "Nasdaq closed · options open" : "Nasdaq open"}</span>`);
    if (S.liveQuotes !== undefined) items.push(`<span class="lp-tape__i"><span class="dim">Live quotes</span><b class="mono">${S.liveQuotes}</b></span>`);
    items.push(`<span class="lp-tape__i"><span class="dim">Network</span>${D?.chainId === 10143 ? "Monad testnet" : D?.chainId === 31337 ? "Local chain" : `Chain ${D?.chainId ?? "-"}`}</span>`);
    if (S.now) items.push(`<span class="lp-tape__i"><span class="dim">Chain time</span><span class="mono">${new Date(S.now * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></span>`);
    $("#lp-tape").innerHTML = `<div class="lp-tape__track">${items.join("")}</div>`;
  }

  function live() {
    livePrice();
    const q = $("#lp-quotes");
    if (q) q.textContent = S.liveQuotes !== undefined ? `${S.liveQuotes} live quotes` : "-";
    $("#lp-end-state").textContent = S.closed
      ? `Nasdaq is closed right now${S.liveQuotes ? `, and ${S.liveQuotes} quotes are live on the book` : ""}.`
      : "Nasdaq is open right now. The book is open around the clock.";
  }

  let built = false;
  async function render() {
    tape();
    live();
    if (!built) { built = true; buildChart(); }
  }
  return { render, tick: async () => { tape(); live(); }, slow: async () => { tape(); live(); } };
}
