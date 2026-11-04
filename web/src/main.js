import "./style.css";
import { load, loadSeries, refreshMarket, S, D } from "./chain.js";
import { W, onChange, initJaw, restoreSession } from "./wallet.js";
import { renderAccount, setRefresh } from "./account.js";
import { $, $$, toast, setErrorAbis } from "./ui.js";
import { ethers } from "ethers";
import { ABI } from "./chain.js";
import { soon } from "./views/soon.js";
import { portfolio } from "./views/portfolio.js";
import { pro } from "./views/pro.js";
import { landing } from "./views/landing.js";
import { API_URL } from "./config.js";
import { demo } from "./views/demo.js";

// Earn and Protect aren't in the demo yet: their tabs show a coming-soon page. The demo runs in Pro.
const earn = soon({ name: "Earn", line: "Write Upside against your xStocks and collect the premium, or deposit once into Auto-Commit and it writes every week within fixed rules.", detail: "Your stock stays fully collateralized in the protocol. The worst case is giving up gains above the price you agreed to." });
const protect = soon({ name: "Protect", line: "A stock-backed loan with a Floor bought from inside the lender, so a weekend wick can't liquidate it.", detail: "The Floor guarantees a sale price for your collateral until Monday's open. The worst case is the loan interest plus the Floor premium." });
const VIEWS = { home: landing, pro, earn, protect, portfolio };
// Old links to the retired Trade view land in Pro; an empty hash is the landing.
const ALIASES = { trade: "pro", "": "home" };
const route = (hash) => {
  const h = hash.replace(/^#/, "");
  const name = ALIASES[h] ?? h;
  return VIEWS[name] ? name : "home";
};
let current = null;
let currentName = null;
let demoPanel = null;

function header() {
  if (!$("#mkt") || !$("#qps")) return; // the header bar no longer shows market / quote pills
  const exp = S.series.length && S.series.every((s) => s.expiry <= S.now);
  const m = $("#mkt");
  m.textContent = exp ? "Expired · settling" : S.closed ? "Stocks closed · options open" : "Stocks open";
  m.className = "pill " + (exp ? "" : S.closed ? "closed" : "live");
  const qpsEl = $("#qps");
  if (!S.apiUp) {
    qpsEl.textContent = "makers offline";
    qpsEl.title = "Backend is not reachable. Start it with: npm run backend";
    qpsEl.className = "pill";
  } else if (S.liveQuotes > 0) {
    // Makers keep quoting while stocks are closed; that's the product. Count resting quotes, not the repricing rate.
    const rate = Math.round(S.quotesPerSec || 0);
    qpsEl.textContent = `${S.liveQuotes} live quotes`;
    qpsEl.title = `${S.liveQuotes} maker quotes resting on the onchain book${rate ? `, ${rate} updates/s` : ""}`;
    qpsEl.className = "pill live";
  } else if (S.liveQuotes === 0) {
    qpsEl.textContent = "quoting paused";
    qpsEl.title = "No maker quotes are on the book right now.";
    qpsEl.className = "pill paused";
  } else {
    // /status unavailable: fall back to the repricing rate from /markets.
    const rate = Math.round(S.quotesPerSec || 0);
    qpsEl.textContent = `${rate} quotes/s`;
    qpsEl.title = "Quote updates per second from active makers";
    qpsEl.className = rate ? "pill live" : "pill paused";
  }
}

/// Resting quote count from the backend's /status (S.liveQuotes). Undefined when it can't be read.
async function refreshStatus() {
  try {
    const j = await (await fetch(`${API_URL}/status`)).json();
    S.liveQuotes = Number.isFinite(j.liveQuotes) ? j.liveQuotes : undefined;
  } catch {
    S.liveQuotes = undefined;
  }
}

async function refreshAll() {
  await Promise.all([refreshMarket(), refreshStatus()]);
  await loadSeries();
  header();
  renderAccount();
  if (current) await current.render();
  if (demoPanel) demoPanel.draw();
}

async function show(name) {
  currentName = name;
  $$("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  // A fresh <main> per view: a previous view's in-flight async render keeps writing into its own
  // detached root instead of hitting nulls in the new one. Views with a full-bleed shell set their own class.
  const root = document.createElement("main");
  root.id = "view";
  $("#view").replaceWith(root);
  document.body.dataset.view = name;
  current = VIEWS[name](root, refreshAll);
  if (location.hash.slice(1) !== name) location.hash = name;
  window.scrollTo(0, 0);
  await current.render();
}

async function boot() {
  try {
    await load();
  } catch (e) {
    $("#view").innerHTML = `<div class="card">${e.message}</div>`;
    return;
  }
  setErrorAbis(Object.values(ABI).map((a) => new ethers.Interface(a)));
  await initJaw();
  await restoreSession(); // a browser wallet connected before reconnects without asking again
  try {
    await Promise.all([refreshMarket(), refreshStatus()]);
    await loadSeries();
  } catch (e) {
    console.error(e);
    $("#view").innerHTML = `<div class="card"><h2>Can't reach the chain</h2><p class="muted">No response from ${D.chainId === 31337 ? `the local chain at ${D.rpc}. Start it with <span class='mono'>npm run chain</span> and deploy.` : `chain ${D.chainId}.`}</p></div>`;
    $("#mkt").textContent = "offline";
    setTimeout(() => location.reload(), 5000);
    return;
  }
  header();
  setRefresh(refreshAll);
  onChange(() => refreshAll());
  renderAccount();
  $$("#nav button").forEach((b) => (b.onclick = () => show(b.dataset.view)));
  demoPanel = demo($("#demo"), refreshAll);
  await show(route(location.hash)); // the landing at /; the demo itself runs in Pro
  // The logo and in-page links navigate by hash.
  window.addEventListener("hashchange", () => {
    const name = route(location.hash);
    if (name !== currentName) show(name);
  });

  let n = 0;
  setInterval(async () => {
    try {
      await Promise.all([refreshMarket(), refreshStatus()]);
      header();
      n++;
      if (n % 6 === 0) {
        await loadSeries();
        await current.slow();
        if (demoPanel) demoPanel.draw();
      } else await current.tick();
    } catch (e) {
      console.warn(e);
    }
  }, 4000);
  if (!S.apiUp) toast("Backend offline: start it for live quotes (npm run backend)", 6000);
  window.__app = { S, W, D, show: () => currentName };
}

boot();
