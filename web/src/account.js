import { D, isLocal, call, usd, sh } from "./chain.js";
import { W, connectLocal, connectJaw, connectInjected, disconnect, jawAvailable, jawChainSupported, sendCalls } from "./wallet.js";
import { JAW_API_KEY } from "./config.js";
import { $, html, fmt, act, toast, errMsg } from "./ui.js";

let refresh = async () => {};
export const setRefresh = (fn) => (refresh = fn);

export function renderAccount() {
  const el = $("#account");
  if (!W.address) {
    el.innerHTML = `<button class="primary" id="connectBtn">Connect</button>`;
    $("#connectBtn").onclick = openConnect;
    return;
  }
  const label = W.kind === "jaw" ? "Passkey" : W.kind === "local" ? "Demo" : "Wallet";
  el.innerHTML = html`
    ${W.kind === "local"
      ? `<select id="acctSel">${W.localAccounts.map((a, i) => `<option value="${i + 5}" ${a === W.address ? "selected" : ""}>Demo ${i + 1} · ${fmt.addr(a)}</option>`).join("")}</select>`
      : `<span class="pill mono">${label} · ${fmt.addr(W.address)}</span>`}
    ${D.mocks ? `<button id="faucetBtn" class="sm">Test funds</button>` : ""}
    <button id="discBtn" class="sm ghost">Disconnect</button>`;
  if ($("#acctSel")) $("#acctSel").onchange = async (e) => { await connectLocal(Number(e.target.value)); await refresh(); };
  if ($("#faucetBtn")) $("#faucetBtn").onclick = faucet;
  $("#discBtn").onclick = async () => { await disconnect(); await refresh(); };
}

export function openConnect() {
  const m = $("#modal");
  const jawOk = jawAvailable();
  const jawNote = !jawChainSupported()
    ? `Passkey accounts run on JAW chains such as Monad and Base Sepolia. This deployment is on chain ${D.chainId}.`
    : !JAW_API_KEY ? "Set VITE_JAW_API_KEY to enable passkey accounts." : "One tap with Face ID or a security key. No seed phrase, gas can be sponsored.";
  m.innerHTML = html`<div class="card">
    <div class="between"><h2>Connect</h2><button class="ghost sm" id="mClose">Close</button></div>
    <button class="connect-opt" id="cJaw" ${jawOk ? "" : "disabled"}><b>Passkey account</b> <span class="tag">JAW</span><small>${jawNote}</small></button>
    ${isLocal() ? `<button class="connect-opt" id="cLocal"><b>Demo account</b><small>Funded account on the local chain. Instant, no prompts.</small></button>` : ""}
    <button class="connect-opt" id="cInj"><b>Browser wallet</b><small>MetaMask, Rabby or any injected wallet.</small></button>
  </div>`;
  m.hidden = false;
  const close = () => (m.hidden = true);
  $("#mClose").onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };
  const go = (fn) => async () => {
    try {
      close();
      await fn();
      await refresh();
    } catch (e) {
      toast(errMsg(e), 6000);
    }
  };
  $("#cJaw").onclick = go(connectJaw);
  if ($("#cLocal")) $("#cLocal").onclick = go(() => connectLocal(5));
  $("#cInj").onclick = go(connectInjected);
}

async function faucet() {
  await act("Minting test funds", async () => {
    const calls = [call(D.usdc, "MockERC20", "mint", [W.address, usd(100_000)])];
    for (const s of D.stocks) calls.push(call(s.address, "MockXStock", "mint", [W.address, sh(100)]));
    await sendCalls(calls);
  }, refresh);
}

