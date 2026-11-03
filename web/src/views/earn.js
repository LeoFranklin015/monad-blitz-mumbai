import { D, S, C, call, usd, sh, fromUsd, fromSh, liveSeries, expiriesOf, seriesById, seriesLabel, collateral } from "../chain.js";
import { W, sendCalls, approvals } from "../wallet.js";
import { PRODUCTS } from "../config.js";
import { $, html, fmt, act, on } from "../ui.js";
import { openConnect } from "../account.js";

const E = { kind: 0, expiry: null, seriesId: null, amount: 10, price: null };

export function earn(root, refreshAll) {
  root.innerHTML = html`
    <div class="hero"><h2>Earn premium on stocks and dollars</h2>
      <p>Write Upsides on stock you hold or Floors with USDC, and collect the premium up front. Or let an Auto-Commit vault do it every week inside fixed rules.</p></div>
    <div class="layout">
      <div class="stack">
        <section class="card" id="write"></section>
        <section class="card"><h3>Your open quotes</h3><div id="myQuotes" class="empty">Connect to see your quotes.</div></section>
        <section class="card"><h3>Your written positions</h3><div id="myWritten" class="empty">Nothing written yet.</div></section>
      </div>
      <div class="stack">
        <section class="card"><h3>Auto-Commit vaults</h3><div id="vaults"></div></section>
        <section class="card"><h3>Your balances in the protocol</h3><div id="free" class="empty">-</div></section>
      </div>
    </div>`;

  async function renderWrite() {
    const el = $("#write", root);
    const exps = expiriesOf(S.stock);
    if (!exps.includes(E.expiry)) E.expiry = exps[0];
    const list = liveSeries(S.stock).filter((s) => s.kind === E.kind && s.expiry === E.expiry).sort((a, b) => a.strike - b.strike);
    if (!list.find((s) => s.id === E.seriesId)) {
      const spot = S.spots[S.stock.address];
      E.seriesId = (E.kind === 0 || E.kind === 2 ? list.find((s) => s.strike > spot * 1.02) : [...list].reverse().find((s) => s.strike < spot * 0.98))?.id ?? list[0]?.id;
      E.price = null;
    }
    const s = seriesById(E.seriesId);
    let body = `<div class="empty">No series.</div>`;
    if (s) {
      const p = C.protocol();
      const [[bidGross, bidFill], [askPrem, askFill]] = await Promise.all([p.quoteSell(s.id, sh(E.amount || 0)), p.quoteBuy(s.id, sh(1))]);
      const fair = S.fair.get(s.id)?.fair || 0;
      const bestAsk = askFill > 0n ? fromUsd(askPrem) : 0;
      if (E.price == null) E.price = Math.max(+(fair * 1.08).toFixed(2), 0.01);
      const col = collateral(s, E.amount || 0);
      const proceeds = fromUsd(bidGross) * 0.999;
      const canHit = fromSh(bidFill) >= E.amount && proceeds > 0;
      const width = s.kind === 0 ? null : col.amount / (E.amount || 1);
      body = html`
        <div class="grid2" style="margin-top:12px">
          <label><span>Options to write</span><input id="wAmt" type="number" min="1" value="${E.amount}" /></label>
          <div class="stat"><div class="k">You lock</div><div class="v">${col.isStock ? fmt.sh(col.amount) + " " + col.symbol : fmt.usd(col.amount)}</div></div>
          <div class="stat"><div class="k">Fair value / option</div><div class="v">${fmt.usd(fair, 3)}</div></div>
          <div class="stat"><div class="k">Best bid now</div><div class="v">${canHit ? fmt.usd(proceeds) : "-"}</div></div>
        </div>
        <div class="note">${s.kind === 0 ? `Covered: if ${S.stock.symbol} ends above $${s.strike}, your shares are sold at $${s.strike}. Otherwise you keep them and the premium.`
          : s.kind === 1 ? `Cash-secured: if ${S.stock.symbol} ends below $${s.strike}, you buy it at $${s.strike}. Otherwise you keep the USDC and the premium.`
          : `Spread: you lock only the ${fmt.usd(width)} width per option. Max loss is that width minus the premium.`}</div>
        <div class="row" style="margin-top:12px">
          <button class="up" id="hit" style="flex:1" ${canHit ? "" : "disabled"}>Sell now for ${canHit ? fmt.usd(proceeds) : "-"}</button>
        </div>
        <div class="row" style="margin-top:8px">
          <label style="flex:1"><span>Or post an ask (per option)${bestAsk ? `, best ask ${fmt.usd(bestAsk, 3)}` : ""}</span><input id="wPx" type="number" step="0.01" min="0.01" value="${E.price}" /></label>
          <button class="primary" id="post" style="align-self:flex-end">Post ask</button>
        </div>`;
    }
    el.innerHTML = html`<h3>Write options</h3>
      <div class="tabs">${D.stocks.map((st) => `<button class="tab ${st === S.stock ? "on" : ""}" data-a="${st.address}"><span class="muted">${st.symbol}</span><span class="px">${fmt.usd(S.spots[st.address])}</span></button>`)}</div>
      <div class="products">${PRODUCTS.map((p) => `<button class="product t-${p.tone} ${p.kind === E.kind ? "on" : ""}" data-k="${p.kind}">${["Covered Upside", "Cash-secured Floor", "Capped Upside", "Budget Floor"][p.kind]}<small>${["Lock stock", "Lock USDC", "Lock the width", "Lock the width"][p.kind]}</small></button>`)}</div>
      <div class="chips">${exps.map((e) => `<button class="chip ${e === E.expiry ? "on" : ""}" data-e="${e}">${fmt.date(e)}</button>`)}</div>
      <select id="wSeries">${list.map((x) => `<option value="${x.id}" ${x.id === E.seriesId ? "selected" : ""}>${seriesLabel(x)}</option>`)}</select>
      ${body}`;

    on(el, ".tab", "click", (_, b) => { S.stock = D.stocks.find((x) => x.address === b.dataset.a); E.seriesId = null; renderWrite(); });
    on(el, ".product", "click", (_, b) => { E.kind = Number(b.dataset.k); E.seriesId = null; renderWrite(); });
    on(el, ".chip", "click", (_, b) => { E.expiry = Number(b.dataset.e); E.seriesId = null; renderWrite(); });
    $("#wSeries", el).onchange = (e) => { E.seriesId = Number(e.target.value); E.price = null; renderWrite(); };
    if (!s) return;
    $("#wAmt", el).onchange = (e) => { E.amount = Math.max(1, Number(e.target.value)); renderWrite(); };
    $("#wPx", el).onchange = (e) => (E.price = Number(e.target.value));

    const depositCalls = async () => {
      const col = collateral(s, E.amount);
      const amt = col.isStock ? sh(col.amount) : usd(col.amount * 1.000001 + 0.000001);
      const free = await C.protocol().freeBalance(W.address, col.token);
      if (free >= amt) return [];
      const need = amt - free;
      return [...(await approvals(col.token, D.protocol, need)), call(D.protocol, "OptionsProtocol", "deposit", [col.token, need])];
    };
    $("#hit", el).onclick = async () => {
      if (!W.address) return openConnect();
      const [gross] = await C.protocol().quoteSell(s.id, sh(E.amount));
      const minNet = (gross * 99n) / 100n; // allow for repricing between now and inclusion
      await act("Writing and selling", async () => {
        await sendCalls([...(await depositCalls()), call(D.protocol, "OptionsProtocol", "sell", [s.id, sh(E.amount), minNet, true])]);
      }, refreshAll);
    };
    $("#post", el).onclick = async () => {
      if (!W.address) return openConnect();
      await act("Posting ask", async () => {
        await sendCalls([...(await depositCalls()), call(D.protocol, "OptionsProtocol", "postQuote", [s.id, usd(E.price), sh(E.amount)])]);
      }, refreshAll);
    };
  }

  async function renderMine() {
    if (!W.address) return;
    const p = C.protocol();
    const ids = await p.quotesOf(W.address);
    const qs = await Promise.all(ids.map((i) => p.getQuote(i)));
    const live = qs.map((q, i) => ({ q, id: ids[i] })).filter((x) => x.q.size > 0n);
    $("#myQuotes", root).innerHTML = live.length ? html`<table><thead><tr><th>Series</th><th>Side</th><th class="r">Price</th><th class="r">Size</th><th></th></tr></thead><tbody>
      ${live.map(({ q, id }) => { const s = seriesById(Number(q.seriesId)); return `<tr><td>${s ? seriesLabel(s) : q.seriesId}</td><td>${q.isBid ? "Bid" : "Ask"}</td>
        <td class="r mono">${fmt.usd(fromUsd(q.price), 3)}</td><td class="r mono">${fmt.sh(fromSh(q.size))}</td><td class="r"><button class="sm" data-cancel="${id}">Cancel</button></td></tr>`; })}
      </tbody></table>` : `<div class="empty">No open quotes.</div>`;
    root.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () =>
      act("Cancelling", () => sendCalls([call(D.protocol, "OptionsProtocol", "cancelQuote", [BigInt(b.dataset.cancel)])]), refreshAll)));

    const rows = [];
    const ws = await Promise.all(S.series.map((s) => p.written(s.id, W.address)));
    S.series.forEach((s, i) => { if (ws[i] > 0n) rows.push({ s, w: fromSh(ws[i]) }); });
    $("#myWritten", root).innerHTML = rows.length ? html`<table><thead><tr><th>Series</th><th class="r">Written</th><th>Expiry</th><th></th></tr></thead><tbody>
      ${rows.map(({ s, w }) => `<tr><td>${seriesLabel(s)}</td><td class="r mono">${fmt.sh(w)}</td><td>${s.expiry > S.now ? fmt.left(s.expiry - S.now) : s.settled ? "settled" : "settling"}</td>
        <td class="r">${s.expiry <= S.now ? `<button class="sm" data-claim="${s.id}">Claim</button>` : ""}</td></tr>`)}</tbody></table>
      <div class="note">After expiry the keeper credits your share automatically. Claim does it now.</div>` : `<div class="empty">Nothing written yet.</div>`;
    root.querySelectorAll("[data-claim]").forEach((b) => (b.onclick = () =>
      act("Claiming", () => sendCalls([call(D.protocol, "OptionsProtocol", "claim", [Number(b.dataset.claim)])]), refreshAll)));

    const tokens = [{ a: D.usdc, sym: "USDC", usd: true }, ...D.stocks.map((s) => ({ a: s.address, sym: s.symbol }))];
    const free = await Promise.all(tokens.map((t) => p.freeBalance(W.address, t.a)));
    const nonzero = tokens.map((t, i) => ({ ...t, v: free[i] })).filter((t) => t.v > 0n);
    $("#free", root).innerHTML = nonzero.length ? html`<table><tbody>${nonzero.map((t) => `<tr><td>${t.sym}</td><td class="r mono">${t.usd ? fmt.usd(fromUsd(t.v)) : fmt.sh(fromSh(t.v), 4)}</td>
      <td class="r"><button class="sm" data-w="${t.a}" data-v="${t.v}">Withdraw</button></td></tr>`)}</tbody></table>
      <div class="note">Free collateral, unlocked quotes and claimed payouts. Not earning until you quote with it.</div>` : `<div class="empty">Nothing idle in the protocol.</div>`;
    root.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () =>
      act("Withdrawing", () => sendCalls([call(D.protocol, "OptionsProtocol", "withdraw", [b.dataset.w, BigInt(b.dataset.v)])]), refreshAll)));
  }

  async function renderVaults() {
    const cards = await Promise.all(D.stocks.map(async (st) => {
      const v = C.vault(st.vault);
      const [active, [a, cash], supply, rounds, mine, sid] = await Promise.all([v.active(), v.totalAssets(), v.totalSupply(), v.roundsCompleted(), W.address ? v.balanceOf(W.address) : 0n, v.activeSeries()]);
      const s = active ? seriesById(Number(sid)) : null;
      const share = supply > 0n ? Number(mine) / Number(supply) : 0;
      return html`<div class="stat" style="margin-bottom:10px">
        <div class="between"><b>${st.symbol} Auto-Commit</b><span class="tag">${active ? "writing" : "open for deposits"}</span></div>
        <div class="grid2" style="margin-top:8px">
          <div><div class="k">Vault holds</div><div class="v">${fmt.sh(fromSh(a), 2)} ${st.symbol}${cash > 0n ? ` + ${fmt.usd(fromUsd(cash))}` : ""}</div></div>
          <div><div class="k">Your share</div><div class="v">${fmt.pct(share)}</div></div>
        </div>
        <div class="note">${s ? `Selling ${seriesLabel(s)} until ${fmt.date(s.expiry)}.` : "Rules: at least 3% out of the money, max 8 days, minimum premium. Keeper starts the next round."} ${Number(rounds)} rounds done.</div>
        <div class="row" style="margin-top:8px">
          <input type="number" min="0" placeholder="${st.symbol}" data-va="${st.address}" style="flex:1" ${active ? "disabled" : ""} />
          <button class="sm primary" data-dep="${st.address}" ${active ? "disabled" : ""}>Deposit</button>
          <button class="sm" data-wd="${st.address}" ${active || mine === 0n ? "disabled" : ""} data-sh="${mine}">Withdraw all</button>
        </div></div>`;
    }));
    $("#vaults", root).innerHTML = cards.join("") + `<div class="note">Deposits and withdrawals open between rounds. Anyone can end a round after expiry, so funds never depend on the keeper.</div>`;
    root.querySelectorAll("[data-dep]").forEach((b) => (b.onclick = async () => {
      if (!W.address) return openConnect();
      const st = D.stocks.find((x) => x.address === b.dataset.dep);
      const n = Number(root.querySelector(`[data-va="${st.address}"]`).value);
      if (!(n > 0)) return;
      await act("Depositing", async () => {
        await sendCalls([...(await approvals(st.address, st.vault, sh(n))), call(st.vault, "CommitVault", "deposit", [sh(n)])]);
      }, refreshAll);
    }));
    root.querySelectorAll("[data-wd]").forEach((b) => (b.onclick = async () => {
      const st = D.stocks.find((x) => x.address === b.dataset.wd);
      await act("Withdrawing", () => sendCalls([call(st.vault, "CommitVault", "withdraw", [BigInt(b.dataset.sh)])]), refreshAll);
    }));
  }

  const render = async () => { await renderWrite(); await Promise.all([renderMine(), renderVaults()]); };
  return {
    render,
    tick: async () => {},
    slow: async () => { if (!$("#write", root).contains(document.activeElement)) await renderWrite(); await Promise.all([renderMine(), renderVaults()]); },
  };
}

