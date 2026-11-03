import { D, S, C, call, usd, sh, fromUsd, fromSh, liveSeries, seriesById, seriesLabel } from "../chain.js";
import { W, sendCalls, approvals } from "../wallet.js";
import { $, html, fmt, act } from "../ui.js";
import { openConnect } from "../account.js";

const LTV = 0.5, LIQ = 0.65;
const P = { stock: null, floorId: null };

export function protect(root, refreshAll) {
  root.innerHTML = html`
    <div class="hero"><h2>Protect a stock-backed loan over the weekend</h2>
      <p>Borrow USDC against tokenized stock. When the market is closed, prices freeze and then gap, and plain loans get liquidated on Monday. Attach a Floor from inside the lender and the floored shares count at the strike, so a weekend crash can't wipe you out.</p></div>
    <div class="layout">
      <section class="card" id="loan"></section>
      <section class="card" id="how"></section>
    </div>`;

  async function render() {
    P.stock = P.stock || S.stock;
    const st = P.stock;
    const l = C.lender(st.lender);
    const spot = S.spots[st.address];
    const acct = W.address ? await l.accounts(W.address) : null;
    const coll = acct ? fromSh(acct.collateral) : 0;
    const debt = acct ? fromUsd(acct.debt) : 0;
    const floorAmt = acct ? fromSh(acct.floorAmount) : 0;
    const floorS = acct && floorAmt > 0 ? seriesById(Number(acct.floorSeries)) : null;
    const floorLive = floorS && floorS.expiry > S.now;
    const value = acct ? fromUsd(await l.collateralValue(W.address)) : 0;
    const liqable = acct && debt > 0 ? await l.isLiquidatable(W.address) : false;
    const health = debt > 0 ? (value * LIQ) / debt : Infinity;
    const plainLiqPx = coll > 0 ? debt / (coll * LIQ) : 0;
    const covered = floorLive ? Math.min(floorAmt, coll) : 0;
    const protectedFloor = floorLive ? covered * floorS.strike : 0;
    const safeAtZero = floorLive && protectedFloor * LIQ >= debt;
    const maxBorrow = Math.max(0, value * LTV - debt);
    const floors = liveSeries(st).filter((s) => s.kind === 1).sort((a, b) => a.expiry - b.expiry || b.strike - a.strike);
    if (!floors.find((s) => s.id === P.floorId)) P.floorId = floors.find((s) => s.strike <= spot && s.strike >= spot * 0.95)?.id ?? floors[0]?.id;
    const fs = seriesById(P.floorId);
    const floorQty = Math.max(coll - (floorLive && floorS.id === P.floorId ? floorAmt : 0), 0);
    const [fPrem, fFill] = fs && floorQty > 0 ? await C.protocol().quoteBuy(fs.id, sh(floorQty)).catch(() => [0n, 0n]) : [0n, 0n];
    const hpct = Number.isFinite(health) ? Math.min(health / 2, 1) : 1;
    const hcolor = health < 1 ? "var(--down)" : health < 1.3 ? "var(--warn)" : "var(--up)";

    $("#loan", root).innerHTML = html`
      <div class="tabs">${D.stocks.map((s) => `<button class="tab ${s === st ? "on" : ""}" data-a="${s.address}"><span class="muted">${s.symbol}</span><span class="px">${fmt.usd(S.spots[s.address])}</span></button>`)}</div>
      <div class="grid2" style="margin-top:14px">
        <div class="stat"><div class="k">Collateral</div><div class="v">${fmt.sh(coll, 4)} ${st.symbol}</div></div>
        <div class="stat"><div class="k">Debt</div><div class="v">${fmt.usd(debt)}</div></div>
        <div class="stat"><div class="k">Counted value</div><div class="v">${fmt.usd(value)}</div></div>
        <div class="stat"><div class="k">Floor attached</div><div class="v">${floorLive ? `${fmt.sh(floorAmt)} @ $${floorS.strike}` : "none"}</div></div>
      </div>
      <div style="margin-top:12px"><div class="between"><span class="muted">Health</span><span class="mono ${health < 1 ? "neg" : ""}">${Number.isFinite(health) ? health.toFixed(2) : "no debt"}${liqable ? " · liquidatable" : ""}</span></div>
        <div class="health"><i style="width:${hpct * 100}%;background:${hcolor}"></i></div>
        <div class="note">${debt === 0 ? "No loan yet." : safeAtZero ? `Protected: even if ${st.symbol} goes to zero before ${fmt.date(floorS.expiry)}, the floored shares keep this loan healthy.`
          : `Without a Floor this loan is liquidated if ${st.symbol} trades below ${fmt.usd(plainLiqPx)} (${fmt.pct(plainLiqPx / spot - 1)}).`}</div></div>

      <div class="grid2" style="margin-top:14px">
        <div><label><span>Deposit ${st.symbol}</span><input id="dep" type="number" min="0" placeholder="0" /></label><button class="wide" id="depBtn" style="margin-top:6px">Deposit</button></div>
        <div><label><span>Borrow USDC · up to ${fmt.usd(maxBorrow)}</span><input id="bor" type="number" min="0" placeholder="0" /></label><button class="wide" id="borBtn" style="margin-top:6px">Borrow</button></div>
      </div>

      <div class="stat" style="margin-top:14px">
        <div class="between"><b>Weekend Floor</b><span class="tag">bought from the onchain book, inside the lender</span></div>
        <select id="fSel" style="margin-top:8px">${floors.map((s) => `<option value="${s.id}" ${s.id === P.floorId ? "selected" : ""}>${seriesLabel(s)} · ${fmt.date(s.expiry)}</option>`)}</select>
        <div class="between" style="margin-top:8px"><span class="muted">Cover ${fmt.sh(floorQty)} shares</span><span class="mono">${fFill > 0n ? fmt.usd(fromUsd(fPrem)) : "-"}</span></div>
        <button class="primary wide" id="fBuy" style="margin-top:8px" ${floorQty > 0 && fFill >= sh(floorQty) ? "" : "disabled"}>Attach Floor</button>
        ${floorLive && spot < floorS.strike ? `<button class="down wide" id="fUse" style="margin-top:8px">Exit at $${floorS.strike}: exercise Floor and repay</button>` : ""}
      </div>

      <div class="grid2" style="margin-top:14px">
        <div><label><span>Repay USDC</span><input id="rep" type="number" min="0" placeholder="${debt.toFixed(2)}" /></label><button class="wide" id="repBtn" style="margin-top:6px">Repay</button></div>
        <div><label><span>Withdraw ${st.symbol}</span><input id="wd" type="number" min="0" placeholder="0" /></label><button class="wide" id="wdBtn" style="margin-top:6px">Withdraw</button></div>
      </div>`;

    $("#how", root).innerHTML = html`<h3>How it works</h3>
      <p>This lender is a small example of what any Monad lending market can do with the options book:</p>
      <p class="muted">1. Deposit ${st.symbol} and borrow up to ${LTV * 100}% of its value.</p>
      <p class="muted">2. Attach a Floor in one transaction. The lender buys it from the book and holds it for you.</p>
      <p class="muted">3. Floored shares count at max(price, strike). Liquidation only happens below ${LIQ * 100}% of counted value.</p>
      <p class="muted">4. If the price stays down, exit at the strike: the lender exercises your Floor and repays the loan with it.</p>
      <div class="stat" style="margin-top:12px"><div class="k">Example, 10 shares at $200, $1,000 borrowed</div>
        <div class="note" style="margin-top:4px">Saturday wick to $140. Plain loan: counted $1,400, liquidated. With a $195 Floor: counted $1,950, healthy.</div></div>`;

    const r = root;
    r.querySelectorAll(".tab").forEach((b) => (b.onclick = () => { P.stock = D.stocks.find((x) => x.address === b.dataset.a); P.floorId = null; render(); }));
    $("#fSel", r).onchange = (e) => { P.floorId = Number(e.target.value); render(); };
    const need = () => { if (!W.address) { openConnect(); return false; } return true; };
    const num = (id) => Number($(id, r).value);
    $("#depBtn", r).onclick = async () => { if (!need() || !(num("#dep") > 0)) return;
      const a = sh(num("#dep"));
      await act("Depositing", async () => sendCalls([...(await approvals(st.address, st.lender, a)), call(st.lender, "ShieldedLender", "depositCollateral", [a])]), refreshAll); };
    $("#borBtn", r).onclick = async () => { if (!need() || !(num("#bor") > 0)) return;
      await act("Borrowing", () => sendCalls([call(st.lender, "ShieldedLender", "borrow", [usd(num("#bor"))])]), refreshAll); };
    $("#repBtn", r).onclick = async () => { if (!need()) return;
      const a = usd(num("#rep") || debt);
      await act("Repaying", async () => sendCalls([...(await approvals(D.usdc, st.lender, a)), call(st.lender, "ShieldedLender", "repay", [a])]), refreshAll); };
    $("#wdBtn", r).onclick = async () => { if (!need() || !(num("#wd") > 0)) return;
      await act("Withdrawing", () => sendCalls([call(st.lender, "ShieldedLender", "withdrawCollateral", [sh(num("#wd"))])]), refreshAll); };
    $("#fBuy", r).onclick = async () => { if (!need()) return;
      const [prem] = await C.protocol().quoteBuy(fs.id, sh(floorQty));
      const max = (prem * 102n) / 100n + 1n;
      await act("Attaching Floor", async () => sendCalls([...(await approvals(D.usdc, st.lender, max)), call(st.lender, "ShieldedLender", "buyFloor", [fs.id, sh(floorQty), max])]), refreshAll); };
    if ($("#fUse", r)) $("#fUse", r).onclick = () => act("Exercising Floor", () => sendCalls([call(st.lender, "ShieldedLender", "useFloor", [sh(Math.min(floorAmt, coll))])]), refreshAll);
  }

  return {
    render,
    tick: async () => {},
    slow: async () => { if (!$("#loan", root).contains(document.activeElement)) await render(); },
  };
}
