import { D, S, C, call, usd, sh, fromUsd, fromSh, liveSeries, expiriesOf, payoff } from "../chain.js";
import { W, sendCalls, approvals } from "../wallet.js";
import { API_URL, PRODUCTS } from "../config.js";
import { $, html, fmt, toast, act, on } from "../ui.js";
import { openConnect } from "../account.js";

const T = { kind: 0, expiry: null, seriesId: null, amount: 10, mon: 55, wick: 11, quote: null, rfq: null };

export function trade(root, refreshAll) {
  root.innerHTML = html`
    <div class="hero"><h2>Leverage on stocks that can't be liquidated</h2>
      <p>Tokenized stocks trade all weekend. Wall Street doesn't. Buy the move with your worst case fixed up front, or lock an exit price that works on a Saturday.</p></div>
    <div class="layout">
      <div class="stack">
        <section class="card">
          <div class="tabs" id="stocks"></div>
          <div class="products" id="products"></div>
          <div class="chips" id="expiries"></div>
          <div class="strikes" id="strikes"></div>
        </section>
        <section class="card" id="ticket"></section>
      </div>
      <div class="stack">
        <section class="card"><h3>Order book <span class="dim" id="bookName"></span></h3><div id="book"></div>
          <div class="note">Asks are backed by writer collateral, bids by USDC, all locked onchain. Makers reprice every block.</div></section>
        <section class="card" id="gap"></section>
      </div>
    </div>`;

  const renderStocks = () => {
    $("#stocks", root).innerHTML = D.stocks.map((s) => html`
      <button class="tab ${s === S.stock ? "on" : ""}" data-a="${s.address}"><span class="muted">${s.symbol}</span>
      <span class="px">${fmt.usd(S.spots[s.address] || s.spot)}</span></button>`).join("");
    on(root, "#stocks .tab", "click", (_, b) => { S.stock = D.stocks.find((s) => s.address === b.dataset.a); T.seriesId = null; T.expiry = null; renderAll(); });
  };

  const renderProducts = () => {
    $("#products", root).innerHTML = PRODUCTS.map((p) => html`
      <button class="product t-${p.tone} ${p.kind === T.kind ? "on" : ""}" data-k="${p.kind}">${p.name}<small>${p.blurb}</small></button>`).join("");
    on(root, "#products .product", "click", (_, b) => { T.kind = Number(b.dataset.k); T.seriesId = null; renderAll(); });
  };

  const candidates = () => liveSeries(S.stock).filter((s) => s.kind === T.kind && s.expiry === T.expiry).sort((a, b) => a.strike - b.strike);

  async function renderStrikes() {
    const exps = expiriesOf(S.stock);
    if (!exps.includes(T.expiry)) T.expiry = exps[0];
    $("#expiries", root).innerHTML = exps.map((e) => html`<button class="chip ${e === T.expiry ? "on" : ""}" data-e="${e}">${fmt.date(e)} · ${fmt.left(e - S.now)}</button>`).join("");
    on(root, "#expiries .chip", "click", (_, b) => { T.expiry = Number(b.dataset.e); T.seriesId = null; renderAll(); });

    const list = candidates();
    if (!list.find((s) => s.id === T.seriesId)) {
      const spot = S.spots[S.stock.address];
      const otm = T.kind === 0 || T.kind === 2 ? list.find((s) => s.strike >= spot) : [...list].reverse().find((s) => s.strike <= spot);
      T.seriesId = (otm || list[0])?.id ?? null;
    }
    const p = C.protocol();
    const quotes = await Promise.all(list.map((s) => p.quoteBuy(s.id, sh(1)).catch(() => [0n, 0n])));
    $("#strikes", root).innerHTML = list.length ? list.map((s, i) => {
      const [prem, fill] = quotes[i];
      const label = T.kind >= 2 ? `$${s.strike} → $${s.strike2}` : `$${s.strike}`;
      const pre = ["Above", "At", "From", "From"][T.kind];
      return html`<button class="strike ${s.id === T.seriesId ? "on" : ""}" data-id="${s.id}">
        <span class="q">${pre}</span><b>${label}</b><span class="q">${fill >= sh(1) ? fmt.usd(fromUsd(prem)) + " / share" : "no asks"}</span></button>`;
    }).join("") : `<div class="empty">No series for this expiry yet.</div>`;
    on(root, "#strikes .strike", "click", (_, b) => { T.seriesId = Number(b.dataset.id); T.rfq = null; renderAll(); });
  }

  async function renderTicket() {
    const s = liveSeries(S.stock).find((x) => x.id === T.seriesId);
    const el = $("#ticket", root);
    if (!s) { el.innerHTML = `<div class="empty">Pick a strike.</div>`; return; }
    const spot = S.spots[S.stock.address];
    const p = C.protocol();
    const [prem, fill] = await p.quoteBuy(s.id, sh(T.amount || 0)).catch(() => [0n, 0n]);
    const [, depth] = await p.quoteBuy(s.id, sh(1e6)).catch(() => [0n, 0n]);
    const premium = T.rfq ? T.rfq.premium : fromUsd(prem);
    const per = T.amount ? premium / T.amount : 0;
    const fair = S.fair.get(s.id)?.fair;
    const enough = fromSh(fill) >= T.amount;

    const lo = spot * 0.8, hi = spot * 1.2;
    const mon = lo + ((hi - lo) * T.mon) / 100;
    const wickPx = spot * (1 - T.wick / 100);
    const opt = payoff(s, mon) * T.amount - premium;
    const isUp = s.kind === 0 || s.kind === 2;
    const maxPay = s.kind >= 2 ? Math.abs(s.strike2 - s.strike) * T.amount : null;
    const be = isUp ? s.strike + per : s.strike - per;

    let left, right, rightK, leftK;
    if (isUp) {
      const margin = (spot * T.amount) / 10;
      const liq = T.wick >= 10;
      leftK = `This ${PRODUCTS[s.kind].name}`;
      left = { v: opt, note: `Saturday wick: nothing happens. Worst case ${fmt.pnl(-premium)}${maxPay ? `, best case ${fmt.pnl(maxPay - premium)}` : ""}.` };
      rightK = "10x perp, same size";
      right = liq
        ? { v: -margin, note: `Liquidated Saturday at ${fmt.usd(wickPx)}. Monday never comes.` }
        : { v: Math.max((mon - spot) * T.amount, -margin), note: `Survived with ${fmt.usd(margin, 0)} margin at risk.` };
    } else {
      const floored = (mon - spot) * T.amount + payoff(s, mon) * T.amount - premium;
      leftK = `Shares + this ${PRODUCTS[s.kind].name}`;
      left = { v: floored, note: s.kind === 1 ? `Exit at $${s.strike} any time, even Saturday.` : `Covers the drop from $${s.strike} to $${s.strike2}.` };
      rightK = "Shares alone";
      const liqPx = spot * (1 - 0.5 / 0.65);
      right = { v: (mon - spot) * T.amount, note: wickPx <= liqPx ? `A 50% loan on these shares is liquidated at the ${fmt.usd(wickPx)} Saturday low.` : `You take the full drop. Saturday low ${fmt.usd(wickPx)}.` };
    }

    el.innerHTML = html`
      <div class="between"><h3 style="margin:0">${PRODUCTS[s.kind].name} · ${S.stock.symbol} ${s.kind >= 2 ? `$${s.strike}–$${s.strike2}` : `$${s.strike}`}</h3>
        <span class="tag">${s.kind <= 1 ? "Exercise any time" : "Settles at expiry"}</span></div>
      <div class="grid2" style="margin-top:12px">
        <label><span>Shares</span><input id="amt" type="number" min="0.1" step="1" value="${T.amount}" /></label>
        <div class="stat"><div class="k">You pay now = max loss</div><div class="v">${T.amount ? fmt.usd(premium) : "-"}</div></div>
        <div class="stat"><div class="k">Break-even</div><div class="v">${fmt.usd(be)}</div></div>
        <div class="stat"><div class="k">${maxPay ? "Max payout" : "Fair value (model)"}</div><div class="v">${maxPay ? fmt.usd(maxPay) : fair != null ? fmt.usd(fair * T.amount) : "-"}</div></div>
      </div>
      <div style="margin-top:14px">
        <div class="between"><span class="muted">If ${S.stock.symbol} opens Monday at</span><span class="big">${fmt.usd(mon)}</span></div>
        <input type="range" id="mon" min="0" max="100" value="${T.mon}" />
        <div class="between"><span class="muted">Saturday wick</span><span class="mono">-${T.wick}%</span></div>
        <input type="range" id="wick" min="0" max="30" value="${T.wick}" />
      </div>
      <div class="grid2" style="margin-top:10px">
        <div class="stat"><div class="k">${leftK}</div><div class="v ${left.v >= 0 ? "pos" : "neg"}">${fmt.pnl(left.v)}</div><div class="note">${left.note}</div></div>
        <div class="stat"><div class="k">${rightK}</div><div class="v ${right.v >= 0 ? "pos" : "neg"}">${fmt.pnl(right.v)}</div><div class="note">${right.note}</div></div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="primary" id="buy" style="flex:2" ${!enough && !T.rfq ? "disabled" : ""}>${!W.address ? "Connect to buy" : T.rfq ? `Buy at quoted ${fmt.usd(T.rfq.premium)} · ${T.rfq.left}s` : enough ? `Buy from book for ${fmt.usd(premium)}` : "Book too thin, get a quote"}</button>
        <button id="rfq" style="flex:1">Quote for size</button>
      </div>
      <div class="note">Book depth ${fmt.sh(fromSh(depth), 0)} shares. A quote is a maker's signed price for your exact size, filled onchain.</div>`;

    $("#amt", el).oninput = (e) => { T.amount = Math.max(0, Number(e.target.value)); T.rfq = null; debounce(renderTicket); };
    $("#mon", el).oninput = (e) => { T.mon = Number(e.target.value); renderTicket(); };
    $("#wick", el).oninput = (e) => { T.wick = Number(e.target.value); renderTicket(); };
    $("#rfq", el).onclick = () => getQuote(s);
    $("#buy", el).onclick = () => buy(s);
  }

  let deb;
  const debounce = (fn) => { clearTimeout(deb); deb = setTimeout(fn, 250); };

  async function getQuote(s) {
    try {
      const r = await fetch(`${API_URL}/rfq?seriesId=${s.id}&amount=${T.amount}`);
      const j = await r.json();
      if (!r.ok) return toast(j.error || "No quote");
      T.rfq = { ...j, left: j.expiresIn, at: Date.now() };
      clearInterval(T.rfqTimer);
      T.rfqTimer = setInterval(() => {
        if (!T.rfq) return clearInterval(T.rfqTimer);
        T.rfq.left = Math.max(0, j.expiresIn - Math.floor((Date.now() - T.rfq.at) / 1000));
        if (T.rfq.left <= 5) { T.rfq = null; clearInterval(T.rfqTimer); }
        const b = $("#buy", root);
        if (b && T.rfq) b.textContent = `Buy at quoted ${fmt.usd(T.rfq.premium)} · ${T.rfq.left}s`;
      }, 1000);
      renderTicket();
    } catch {
      toast("Quote service offline");
    }
  }

  async function buy(s) {
    if (!W.address) return openConnect();
    const amt = sh(T.amount);
    if (T.rfq) {
      const r = T.rfq.rfq;
      const prem = (BigInt(r.price) * amt + 10n ** 18n - 1n) / 10n ** 18n;
      return act("Buying at quoted price", async () => {
        const calls = [...(await approvals(D.usdc, D.protocol, prem)),
          call(D.protocol, "OptionsProtocol", "fillRFQ", [[r.maker, r.seriesId, r.price, r.maxSize, r.nonce, r.deadline], T.rfq.signature, amt, W.address])];
        await sendCalls(calls);
        T.rfq = null;
      }, refreshAll);
    }
    const [prem] = await C.protocol().quoteBuy(s.id, amt);
    const max = (prem * 102n) / 100n + 1n; // makers reprice every block
    await act("Buying", async () => {
      await sendCalls([...(await approvals(D.usdc, D.protocol, max)), call(D.protocol, "OptionsProtocol", "buy", [s.id, amt, max, W.address])]);
    }, refreshAll);
  }

  async function renderBook() {
    const s = liveSeries(S.stock).find((x) => x.id === T.seriesId);
    if (!s) return;
    $("#bookName", root).textContent = `· ${PRODUCTS[s.kind].name} ${s.kind >= 2 ? `$${s.strike}–$${s.strike2}` : `$${s.strike}`}`;
    const [asks, bids] = await C.protocol().bookOf(s.id);
    const row = (q, cls) => html`<tr><td class="mono dim">${fmt.addr(q.maker)}${q.maker.toLowerCase() === D.hedgedMaker?.toLowerCase() ? " ⇄" : ""}</td>
      <td class="r mono ${cls}">${fmt.usd(fromUsd(q.price), 3)}</td><td class="r mono">${fmt.sh(fromSh(q.size), 1)}</td></tr>`;
    const a = [...asks].sort((x, y) => (x.price < y.price ? -1 : 1)).slice(0, 8);
    const b = [...bids].sort((x, y) => (x.price > y.price ? -1 : 1)).slice(0, 8);
    $("#book", root).innerHTML = html`<div class="book">
      <table><thead><tr><th>Bids</th><th class="r">Price</th><th class="r">Size</th></tr></thead><tbody>${b.length ? b.map((q) => row(q, "pos")) : `<tr><td colspan=3 class="empty">No bids</td></tr>`}</tbody></table>
      <table><thead><tr><th>Asks</th><th class="r">Price</th><th class="r">Size</th></tr></thead><tbody>${a.length ? a.map((q) => row(q, "neg")) : `<tr><td colspan=3 class="empty">No asks</td></tr>`}</tbody></table></div>
      ${D.hedgedMaker ? `<div class="note">⇄ hedged maker: buys or sells the stock on spot inside your transaction.</div>` : ""}`;
  }

  async function renderGap() {
    const g = C.gap();
    const n = Number(await g.roundCount());
    let id = -1, r;
    for (let i = n - 1; i >= 0; i--) {
      const x = await g.rounds(i);
      if (x.asset.toLowerCase() === S.stock.address.toLowerCase()) { id = i; r = x; break; }
    }
    const el = $("#gap", root);
    if (id < 0) { el.innerHTML = `<h3>Weekend gap</h3><div class="empty">No round open.</div>`; return; }
    const up = Number(await g.impliedUpBps(id)) / 100;
    const locked = S.now >= Number(r.lockTime);
    let mine = "";
    if (W.address) {
      const [u, d] = await Promise.all([g.upStake(id, W.address), g.downStake(id, W.address)]);
      if (u || d) mine = `You: ${fmt.usd(fromUsd(u), 0)} up, ${fmt.usd(fromUsd(d), 0)} down`;
    }
    el.innerHTML = html`<h3>Weekend gap</h3>
      <p class="muted">Will ${S.stock.symbol} open ${fmt.date(Number(r.lockTime))} above its reference of <span class="mono">${fmt.usd(fromUsd(r.refPrice))}</span>?</p>
      <div class="bar"><i style="width:${up}%"></i></div>
      <div class="between"><span class="pos mono">${up.toFixed(0)}% up · ${fmt.usd(fromUsd(r.upPool), 0)}</span><span class="neg mono">${(100 - up).toFixed(0)}% down · ${fmt.usd(fromUsd(r.downPool), 0)}</span></div>
      <div class="row" style="margin-top:10px"><input id="gapAmt" type="number" value="50" min="1" style="flex:1" />
        <button class="up" id="gUp" ${locked ? "disabled" : ""}>Up</button><button class="down" id="gDown" ${locked ? "disabled" : ""}>Down</button></div>
      <div class="note">${locked ? "Betting closed at the open. Winnings are in Portfolio once it settles." : mine || "Pooled USDC. Winners split the losing side, minus a 1% fee."}</div>`;
    const bet = async (upSide) => {
      if (!W.address) return openConnect();
      const a = usd(Number($("#gapAmt", el).value));
      await act("Placing bet", async () => {
        await sendCalls([...(await approvals(D.usdc, D.gap, a)), call(D.gap, "GapMarket", "bet", [id, upSide, a])]);
      }, refreshAll);
    };
    $("#gUp", el).onclick = () => bet(true);
    $("#gDown", el).onclick = () => bet(false);
  }

  async function renderAll() {
    renderStocks();
    renderProducts();
    await renderStrikes();
    await Promise.all([renderTicket(), renderBook(), renderGap()]);
  }

  return {
    render: renderAll,
    tick: async () => {
      renderStocks();
      const busy = $("#ticket", root).contains(document.activeElement); // don't redraw under a slider or input
      await Promise.all([renderBook(), busy ? null : renderTicket()]);
    },
    slow: async () => { await renderStrikes(); await renderGap(); },
  };
}

