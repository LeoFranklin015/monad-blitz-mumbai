import { D, S, C, call, fromUsd, fromSh, seriesLabel, payoff } from "../chain.js";
import { W, sendCalls, approvals } from "../wallet.js";
import { $, html, fmt, act } from "../ui.js";
import { openConnect } from "../account.js";

export function portfolio(root, refreshAll) {
  root.innerHTML = html`
    <div class="hero"><h2>Portfolio</h2><p>Every option you hold, what it's worth, and every way out: sell to a bid, exercise, or collect after expiry. The keeper pays out expired options automatically.</p></div>
    <div class="layout">
      <div class="stack">
        <section class="card"><h3>Options</h3><div id="pos" class="empty">Connect to see positions.</div></section>
        <section class="card"><h3>Weekend gap bets</h3><div id="bets" class="empty">-</div></section>
      </div>
      <section class="card"><h3>Wallet</h3><div id="wallet" class="empty">-</div></section>
    </div>`;

  async function render() {
    if (!W.address) {
      $("#pos", root).innerHTML = `<button class="primary" id="pc">Connect</button>`;
      $("#pc", root).onclick = openConnect;
      return;
    }
    const p = C.protocol();
    const bals = await Promise.all(S.series.map((s) => C.token(s.token).balanceOf(W.address)));
    const held = S.series.map((s, i) => ({ s, bal: bals[i] })).filter((x) => x.bal > 0n);
    const rows = await Promise.all(held.map(async ({ s, bal }) => {
      const n = fromSh(bal);
      const live = s.expiry > S.now;
      let bid = 0, bidFill = 0n, settlePx = null;
      if (live) [bid, bidFill] = await p.quoteSell(s.id, bal).then(([g, f]) => [fromUsd(g), f]).catch(() => [0, 0n]);
      else if (s.settled) settlePx = fromUsd((await p.getSeries(s.id)).settlePrice);
      const ref = settlePx ?? S.spots[s.stock.address];
      const intrinsic = payoff(s, ref) * n;
      const canSell = live && bidFill >= bal && bid > 0;
      const exercisable = live && s.kind <= 1 && intrinsic > 0;
      return html`<tr>
        <td>${seriesLabel(s)}<div class="note" style="margin:0">${live ? `expires in ${fmt.left(s.expiry - S.now)}` : s.settled ? `settled at ${fmt.usd(settlePx)}` : "expired, settling"}</div></td>
        <td class="r mono">${fmt.sh(n)}</td>
        <td class="r mono ${intrinsic > 0 ? "pos" : "dim"}">${fmt.usd(intrinsic)}</td>
        <td class="r mono">${canSell ? fmt.usd(bid * 0.999) : "-"}</td>
        <td class="r"><div class="row" style="justify-content:flex-end">
          ${live ? `<button class="sm" data-sell="${s.id}" data-n="${bal}" ${canSell ? "" : "disabled"}>Sell</button>` : ""}
          ${s.kind <= 1 && live ? `<button class="sm" data-ex="${s.id}" data-n="${bal}" ${exercisable ? "" : "disabled"}>Exercise</button>` : ""}
          ${!live ? `<button class="sm primary" data-col="${s.id}" data-n="${bal}">Collect</button>` : ""}
        </div></td></tr>`;
    }));
    $("#pos", root).innerHTML = rows.length ? html`<table><thead><tr><th>Position</th><th class="r">Shares</th><th class="r">Worth now</th><th class="r">Bid now</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="note">Exercise never uses a price feed: Upside pays the strike and takes the stock, Floor hands over the stock and takes the strike. Capped Upside and Budget Floor settle in USDC at expiry.</div>`
      : `<div class="empty">No open options. Expired ones are paid out automatically.</div>`;

    const seriesOf = (id) => S.series.find((s) => s.id === Number(id));
    root.querySelectorAll("[data-sell]").forEach((b) => (b.onclick = async () => {
      const id = Number(b.dataset.sell), n = BigInt(b.dataset.n);
      const [gross] = await p.quoteSell(id, n);
      const minNet = (gross * 98n) / 100n;
      await act("Selling", () => sendCalls([call(D.protocol, "OptionsProtocol", "sell", [id, n, minNet, false])]), refreshAll);
    }));
    root.querySelectorAll("[data-ex]").forEach((b) => (b.onclick = async () => {
      const s = seriesOf(b.dataset.ex), n = BigInt(b.dataset.n);
      await act("Exercising", async () => {
        const pre = s.kind === 0
          ? await approvals(D.usdc, D.protocol, (n * BigInt(Math.round(s.strike * 1e6))) / 10n ** 18n + 1n)
          : await approvals(s.stock.address, D.protocol, n);
        await sendCalls([...pre, call(D.protocol, "OptionsProtocol", "exercise", [s.id, n])]);
      }, refreshAll);
    }));
    root.querySelectorAll("[data-col]").forEach((b) => (b.onclick = () =>
      act("Collecting", () => sendCalls([call(D.protocol, "OptionsProtocol", "redeem", [Number(b.dataset.col), BigInt(b.dataset.n)])]), refreshAll)));

    // gap bets
    const g = C.gap();
    const n = Number(await g.roundCount());
    const bets = [];
    for (let i = 0; i < n; i++) {
      const [u, d] = await Promise.all([g.upStake(i, W.address), g.downStake(i, W.address)]);
      if (u === 0n && d === 0n) continue;
      const r = await g.rounds(i);
      const st = D.stocks.find((x) => x.address.toLowerCase() === r.asset.toLowerCase());
      const locked = S.now >= Number(r.lockTime);
      const result = r.settled ? ["", "opened up", "opened down", "refunded"][Number(r.outcome)] : locked ? "waiting for the open price" : "open";
      bets.push(html`<tr><td>${st?.symbol} · ${fmt.date(Number(r.lockTime))}</td><td class="mono">${fmt.usd(fromUsd(u), 0)} up / ${fmt.usd(fromUsd(d), 0)} down</td><td>${result}</td>
        <td class="r">${locked ? `<button class="sm primary" data-claim="${i}">Claim</button>` : ""}</td></tr>`);
    }
    $("#bets", root).innerHTML = bets.length ? `<table><tbody>${bets.join("")}</tbody></table>` : `<div class="empty">No bets.</div>`;
    root.querySelectorAll("[data-claim]").forEach((b) => (b.onclick = () =>
      act("Claiming", () => sendCalls([call(D.gap, "GapMarket", "claim", [Number(b.dataset.claim)])]), refreshAll)));

    // wallet
    const toks = [{ a: D.usdc, sym: "USDC", usd: true }, ...D.stocks.map((s) => ({ a: s.address, sym: s.symbol, px: S.spots[s.address] }))];
    const wb = await Promise.all(toks.map((t) => C.erc20(t.a).balanceOf(W.address)));
    $("#wallet", root).innerHTML = html`<table><tbody>${toks.map((t, i) => {
      const v = t.usd ? fromUsd(wb[i]) : fromSh(wb[i]);
      return `<tr><td>${t.sym}</td><td class="r mono">${t.usd ? fmt.usd(v) : fmt.sh(v, 4)}</td><td class="r mono dim">${t.usd ? "" : fmt.usd(v * t.px)}</td></tr>`;
    })}</tbody></table><div class="note mono">${W.address}</div>`;
  }

  return { render, tick: async () => {}, slow: render };
}

