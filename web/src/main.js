import "./style.css";
import { load, loadSeries, refreshMarket, S, D } from "./chain.js";
import { W, onChange, initJaw } from "./wallet.js";
import { renderAccount, setRefresh } from "./account.js";
import { $, $$, toast, setErrorAbis } from "./ui.js";
import { ethers } from "ethers";
import { ABI } from "./chain.js";
import { trade } from "./views/trade.js";
import { earn } from "./views/earn.js";
import { protect } from "./views/protect.js";
import { portfolio } from "./views/portfolio.js";
import { pro } from "./views/pro.js";
import { demo } from "./views/demo.js";

const VIEWS = { trade, earn, protect, portfolio, pro };
let current = null;
let currentName = "trade";
let demoPanel = null;

function header() {
  const exp = S.series.length && S.series.every((s) => s.expiry <= S.now);
  const m = $("#mkt");
  m.textContent = exp ? "Expired · settling" : S.closed ? "Stocks closed · options open" : "Stocks open";
  m.className = "pill " + (exp ? "" : S.closed ? "closed" : "live");
  const qpsEl = $("#qps");
  if (!S.apiUp) {
    qpsEl.textContent = "makers offline";
    qpsEl.title = "Backend is not reachable. Start it with: npm run backend";
    qpsEl.className = "pill";
  } else if (S.quotesPerSec === 0) {
    qpsEl.textContent = S.closed ? "quoting paused" : "0 quotes/s";
    qpsEl.title = S.closed ? "Stocks are closed. Makers pause quoting outside market hours." : "No quote updates in the last tick.";
    qpsEl.className = "pill paused";
  } else {
    qpsEl.textContent = `${Math.round(S.quotesPerSec)} quotes/s`;
    qpsEl.title = `${Math.round(S.quotesPerSec)} quote updates per second from active makers`;
    qpsEl.className = "pill live";
  }
}

async function refreshAll() {
  await refreshMarket();
  await loadSeries();
  header();
  renderAccount();
  if (current) await current.render();
  if (demoPanel) demoPanel.draw();
}

async function show(name) {
  currentName = name;
  $$("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  current = VIEWS[name]($("#view"), refreshAll);
  location.hash = name;
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
  try {
    await refreshMarket();
    await loadSeries();
  } catch (e) {
    console.error(e);
    $("#view").innerHTML = `<div class="card"><h2>Can't reach the chain</h2><p class="muted">No response from ${D.chainId === 31337 ? "the local chain at :8545. Start it with <span class='mono'>npm run chain</span> and deploy." : `chain ${D.chainId}.`}</p></div>`;
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
  await show(VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : "trade");

  let n = 0;
  setInterval(async () => {
    try {
      await refreshMarket();
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
