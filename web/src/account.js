import { ethers } from "ethers";
import { D, isLocal, call, usd, sh, nativeBalance, nativeSymbol } from "./chain.js";
import { W, connectLocal, connectJaw, connectInjected, connectMera, meraKnown, exportRecoveryPhrase, fundGasLocal, disconnect, jawAvailable, jawChainSupported, sendCalls } from "./wallet.js";
import { isRetryable, isMeraError } from "./mera.js";
import { JAW_API_KEY } from "./config.js";
import { $, html, fmt, act, toast, errMsg } from "./ui.js";

let refresh = async () => {};
export const setRefresh = (fn) => (refresh = fn);

const FAUCET_URL = "https://faucet.monad.xyz";
const CHAIN_NAME = { 31337: "the local chain", 10143: "Monad testnet", 143: "Monad" };
const chainName = () => CHAIN_NAME[D.chainId] || `chain ${D.chainId}`;

// ---- icons (authored, 1.5 stroke) ----------------------------------------------------
const ICON = {
  passkey: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M7.5 10.5a4.5 4.5 0 0 1 9 0v1.2"/><path d="M12 10.5v4.2c0 2-1 3.6-2.6 4.8"/><path d="M9.2 10.8v3.4c0 1.4-.5 2.6-1.4 3.5"/><path d="M14.8 12.9c0 2.5-.7 4.6-2 6.3"/><path d="M4.8 9.4A7.5 7.5 0 0 1 19.4 9"/><path d="M19.5 12.4c0 1.9-.3 3.6-.9 5.2"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11"/><path d="M15.5 8.5v-4h-11v11h4"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17v.5"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M19 12H6M11 6l-6 6 6 6"/></svg>`,
  out: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>`,
  key: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5L19 4M16 7l2.5 2.5M14 9l2 2"/></svg>`,
};

/// 5x5 mirrored identicon from the address bytes. Square cells, two tones of one hue.
export function identicon(addr, size = 20) {
  const b = ethers.getBytes(ethers.keccak256(ethers.getBytes(addr)));
  const hue = Math.round((b[0] / 255) * 360);
  const fg = `hsl(${hue} 70% 66%)`, fg2 = `hsl(${(hue + 40) % 360} 60% 46%)`;
  let cells = "";
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++) {
      const v = b[1 + y * 3 + x];
      if (v % 3 === 0) continue;
      const c = v % 3 === 1 ? fg : fg2;
      cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="${c}"/>`;
      if (x < 2) cells += `<rect x="${4 - x}" y="${y}" width="1" height="1" fill="${c}"/>`;
    }
  return `<svg class="identicon" viewBox="-0.5 -0.5 6 6" width="${size}" height="${size}" shape-rendering="crispEdges" aria-hidden="true"><rect x="-0.5" y="-0.5" width="6" height="6" fill="hsl(${hue} 30% 12%)"/>${cells}</svg>`;
}

// ---- account area ---------------------------------------------------------------------
let menuOpen = false;
let bal = { addr: null, wei: null };

const balText = () => (bal.addr === W.address && bal.wei != null ? `${Number(ethers.formatEther(bal.wei)).toFixed(bal.wei > 0n && bal.wei < 10n ** 16n ? 4 : 2)} ${nativeSymbol()}` : `… ${nativeSymbol()}`);
const needsGas = () => W.kind === "mera" && !isLocal() && bal.addr === W.address && bal.wei === 0n;

export function renderAccount() {
  const el = $("#account");
  if (W.idleEnded) {
    W.idleEnded = false;
    toast("Signed out after 30 minutes idle. Your passkey signs you back in.", 6000);
  }
  if (!W.address) {
    menuOpen = false;
    el.innerHTML = `<button class="primary" id="connectBtn">Connect</button>`;
    $("#connectBtn").onclick = openConnect;
    return;
  }
  if (W.kind === "mera") return renderMeraAccount(el);
  const label = W.kind === "jaw" ? "JAW" : W.kind === "local" ? "Demo" : "Wallet";
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

// One set of document listeners closes the account menu on outside click or Escape.
const closeMenu = () => {
  if (!menuOpen) return;
  menuOpen = false;
  const menu = $("#acctMenu");
  if (menu) menu.hidden = true;
  $("#acctBtn")?.setAttribute("aria-expanded", "false");
};
document.addEventListener("click", closeMenu);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());

function renderMeraAccount(el) {
  const sym = nativeSymbol();
  el.innerHTML = html`
    ${needsGas() ? `<button class="gas-chip" id="gasBtn" aria-haspopup="true">${ICON.alert}<span>Needs ${sym} for gas</span></button>` : ""}
    <div class="acct">
      <button class="acct-pill" id="acctBtn" aria-haspopup="true" aria-expanded="${menuOpen}" title="${W.address}">
        ${identicon(W.address)}
        <span class="acct-pill__addr mono" id="acctAddr">${fmt.addr(W.address)}</span>
        <span class="badge-passkey">${ICON.passkey}Passkey</span>
        <span class="acct-pill__bal mono" id="acctBal">${balText()}</span>
      </button>
      <div class="acct-menu" id="acctMenu" role="menu" ${menuOpen ? "" : "hidden"}>
        <div class="acct-menu__id">
          ${identicon(W.address, 36)}
          <div class="acct-menu__who"><b>Passkey account</b><span class="mono">${fmt.addr(W.address)}</span></div>
        </div>
        <button class="acct-menu__addr mono" id="copyAddr" title="Copy address">${W.address}<span class="acct-menu__copy">${ICON.copy}<em>Copy</em></span></button>
        <div class="acct-menu__row"><span>Gas balance</span><span class="mono" id="menuBal">${balText()}</span></div>
        ${needsGas() ? html`<div class="acct-menu__gas">
            <p><b>Needs ${sym} for gas.</b> A new passkey account starts empty. Send a little ${sym} to the address above, or get some from the faucet.</p>
            <a class="acct-menu__link" href="${FAUCET_URL}" target="_blank" rel="noopener">Open Monad faucet ${ICON.out}</a>
          </div>` : ""}
        <button class="acct-menu__item" id="exportBtn" role="menuitem">${ICON.key}<span>Export recovery phrase</span></button>
        <button class="acct-menu__item acct-menu__item--out" id="menuDisc" role="menuitem">${ICON.back}<span>Sign out</span></button>
      </div>
    </div>
    ${D.mocks ? `<button id="faucetBtn" class="sm">Test funds</button>` : ""}
    <button id="discBtn" class="sm ghost">Disconnect</button>`;

  // Open toward whichever side has room: the header wraps the account to the left on narrow screens.
  const place = () => $("#acctMenu").classList.toggle("acct-menu--left", $("#acctBtn").getBoundingClientRect().left + 320 < innerWidth);
  if (menuOpen) place();
  const toggle = (open = !menuOpen) => {
    menuOpen = open;
    place();
    $("#acctMenu").hidden = !open;
    $("#acctBtn").setAttribute("aria-expanded", String(open));
  };
  $("#acctBtn").onclick = (e) => { e.stopPropagation(); toggle(); };
  if ($("#gasBtn")) $("#gasBtn").onclick = (e) => { e.stopPropagation(); toggle(true); };
  $("#acctMenu").onclick = (e) => e.stopPropagation();
  $("#copyAddr").onclick = async () => {
    try {
      await navigator.clipboard.writeText(W.address);
      const c = $("#copyAddr .acct-menu__copy");
      c.innerHTML = `${ICON.check}<em>Copied</em>`;
      c.classList.add("on");
    } catch {
      toast("Copy failed. Select the address and copy it by hand.");
    }
  };
  $("#exportBtn").onclick = () => { toggle(false); openExport(); };
  const out = async () => { menuOpen = false; await disconnect(); await refresh(); };
  $("#menuDisc").onclick = out;
  $("#discBtn").onclick = out;
  if ($("#faucetBtn")) $("#faucetBtn").onclick = faucet;

  const addr = W.address;
  nativeBalance(addr).then((wei) => {
    if (W.address !== addr) return;
    const gasChanged = needsGas() !== (W.kind === "mera" && !isLocal() && wei === 0n);
    const first = bal.addr !== addr;
    bal = { addr, wei };
    if (first || gasChanged) return renderAccount();
    if ($("#acctBal")) $("#acctBal").textContent = balText();
    if ($("#menuBal")) $("#menuBal").textContent = balText();
  }).catch(() => {});
}

// ---- connect modal ----------------------------------------------------------------------
const STEPS = [["waiting", "Passkey"], ["deriving", "Derive account"], ["ready", "Ready"]];

function modalShell(body, { back = false } = {}) {
  return html`<div class="card connect-modal" role="dialog" aria-modal="true" aria-labelledby="mTitle">
    <div class="connect-modal__head">
      ${back ? `<button class="ghost sm icon-btn" id="mBack" aria-label="Back">${ICON.back}<span>Back</span></button>` : `<img class="connect-modal__logo" src="/logo.png" alt="Weekend Options" />`}
      <button class="ghost sm" id="mClose">Close</button>
    </div>
    ${body}
  </div>`;
}

export function openConnect() {
  const m = $("#modal");
  const known = meraKnown();
  const close = () => { m.hidden = true; m.innerHTML = ""; };
  let busy = false;

  const home = () => {
    const showJaw = jawChainSupported();
    const jawNote = !JAW_API_KEY ? "Set VITE_JAW_API_KEY to enable JAW smart accounts." : "Smart account with batched calls; gas can be sponsored.";
    m.innerHTML = modalShell(html`
      <div class="connect-modal__intro"><h2 id="mTitle">Sign in to trade</h2><p>Your passkey is your account. No extension, no seed phrase to write down.</p></div>
      <button class="passkey-hero" id="cPasskey">
        <span class="passkey-hero__icon">${ICON.passkey}</span>
        <span class="passkey-hero__copy">
          <b>Passkey <span class="tag tag--accent">Recommended</span></b>
          <small>${known?.address
            ? `Continue as <span class="mono">${fmt.addr(known.address)}</span> with Face ID, Touch ID or your security key.`
            : "Face ID, Touch ID or a security key. A regular address on " + chainName() + " that you can export to any wallet."}</small>
        </span>
        ${known?.address ? identicon(known.address, 28) : `<span class="passkey-hero__arrow">${ICON.arrow}</span>`}
      </button>
      <div class="connect-sep"><span>or connect</span></div>
      ${showJaw ? html`<button class="connect-opt" id="cJaw" ${jawAvailable() ? "" : "disabled"}>
        <span class="connect-icon connect-icon--brand"><img src="/favicon.png" alt="" /></span>
        <span class="connect-copy"><b>JAW smart account</b><small>${jawNote}</small></span>
        <span class="connect-arrow">${ICON.arrow}</span></button>` : ""}
      ${isLocal() ? html`<button class="connect-opt" id="cLocal"><span class="connect-icon connect-icon--demo">${ICON.key}</span><span class="connect-copy"><b>Demo account</b><small>Funded local account. Instant, no prompts.</small></span><span class="connect-arrow">${ICON.arrow}</span></button>` : ""}
      <button class="connect-opt" id="cInj">
        <span class="connect-icon connect-icon--wallets"><img src="/metamask.svg" alt="MetaMask" /><img src="/rabby.svg" alt="Rabby" /></span>
        <span class="connect-copy"><b>Browser wallet</b><small>MetaMask, Rabby, or another injected wallet.</small></span>
        <span class="connect-arrow">${ICON.arrow}</span>
      </button>`);
    wire();
    $("#cPasskey").onclick = () => (known ? ceremony("known") : choose());
    if ($("#cJaw")) $("#cJaw").onclick = go(connectJaw);
    if ($("#cLocal")) $("#cLocal").onclick = go(() => connectLocal(5));
    $("#cInj").onclick = go(connectInjected);
  };

  const choose = () => {
    m.innerHTML = modalShell(html`
      <div class="connect-modal__intro"><h2 id="mTitle">Passkey account</h2><p>Create a new account, or sign in with a passkey you already saved for ${location.hostname}.</p></div>
      <div class="pk-choice">
        <button class="primary wide pk-choice__main" id="mCreate">${ICON.passkey}<span>Create account</span></button>
        <button class="wide" id="mExisting">Use existing passkey</button>
      </div>
      <p class="pk-fine">The passkey derives a standard address (BIP-44, m/44'/60'/0'/0/0). Only the passkey can recreate it, so keep it in a synced manager like iCloud Keychain, Google Password Manager or 1Password.</p>`, { back: true });
    wire(home);
    $("#mCreate").onclick = () => ceremony("create");
    $("#mExisting").onclick = () => ceremony("existing");
  };

  const progress = (phase, title, sub, extra = "") => {
    const idx = STEPS.findIndex(([k]) => k === phase);
    m.innerHTML = modalShell(html`
      <div class="pk-stage pk-stage--${phase}" aria-live="polite">
        <div class="pk-orb">${phase === "ready" ? ICON.check : ICON.passkey}</div>
        <h2 id="mTitle">${title}</h2>
        <p>${sub}</p>
        ${extra}
      </div>
      <ol class="pk-steps">${STEPS.map(([k, label], i) => `<li class="${i < idx ? "done" : i === idx ? "now" : ""}"><i></i>${label}</li>`).join("")}</ol>`);
    wire();
  };

  const ceremony = async (mode) => {
    busy = true;
    const say = (phase) => phase === "waiting"
      ? progress("waiting", mode === "create" ? "Create your passkey" : "Waiting for Face ID / Touch ID", mode === "create" ? `Confirm in your browser's prompt to save a passkey for ${location.hostname}.` : "Confirm with your passkey in the browser prompt.")
      : progress("deriving", "Deriving your account", `Turning your passkey into a key for ${chainName()}. It never leaves this tab.`);
    try {
      const addr = await connectMera(mode, say);
      progress("ready", "You're in", "Signed in with your passkey.", `<div class="pk-addr">${identicon(addr, 28)}<span class="mono">${addr}</span></div>`);
      await refresh();
      setTimeout(() => { if (!m.hidden && $(".pk-stage--ready", m)) close(); }, 1100);
    } catch (e) {
      console.error(e);
      failed(e, mode);
    } finally {
      busy = false;
    }
  };

  const failed = (e, mode) => {
    const code = isMeraError(e) ? e.code : null;
    const title = code === "PRF_UNAVAILABLE" ? "This passkey can't make an account" : code === "CRYPTO_UNAVAILABLE" ? "Passkeys need a secure page" : isRetryable(e) ? "Passkey prompt closed" : "Couldn't sign in";
    m.innerHTML = modalShell(html`
      <div class="pk-stage pk-stage--error" role="alert">
        <div class="pk-orb">${ICON.alert}</div>
        <h2 id="mTitle">${title}</h2>
        <p>${errMsg(e)}</p>
      </div>
      <div class="pk-choice">
        <button class="primary wide" id="mRetry">Retry</button>
        ${mode === "known" ? `<button class="wide" id="mOther">Use a different passkey</button>` : ""}
        ${mode !== "create" ? `<button class="wide ghost" id="mNew">Create a new account</button>` : ""}
      </div>`, { back: true });
    wire(home);
    $("#mRetry").onclick = () => ceremony(mode);
    if ($("#mOther")) $("#mOther").onclick = () => ceremony("existing");
    if ($("#mNew")) $("#mNew").onclick = () => ceremony("create");
  };

  const wire = (back) => {
    $("#mClose").onclick = close;
    if (back && $("#mBack")) $("#mBack").onclick = back;
    m.onclick = (e) => { if (e.target === m && !busy) close(); };
  };

  const go = (fn) => async () => {
    try {
      close();
      await fn();
      await refresh();
    } catch (e) {
      toast(errMsg(e), 6000);
    }
  };

  home();
  m.hidden = false;
}

// ---- recovery phrase --------------------------------------------------------------------
function openExport() {
  const m = $("#modal");
  const close = () => { m.hidden = true; m.innerHTML = ""; };
  const wire = () => {
    $("#mClose").onclick = close;
    m.onclick = (e) => { if (e.target === m) close(); };
  };
  const confirm = (err) => {
    m.innerHTML = modalShell(html`
      <div class="connect-modal__intro"><h2 id="mTitle">Export recovery phrase</h2>
        <p>These 24 words are this account. Imported into MetaMask or Rabby they open the same address, <span class="mono">${fmt.addr(W.address)}</span>.</p></div>
      <div class="pk-warn">${ICON.alert}<p>Anyone who sees them can take everything in the account. Check nobody is watching your screen, and never paste them into a website.</p></div>
      ${err ? `<p class="pk-err" role="alert">${errMsg(err)}</p>` : ""}
      <div class="pk-choice">
        <button class="primary wide" id="xConfirm">${ICON.passkey}<span>${err ? "Retry with passkey" : "Show phrase with passkey"}</span></button>
        <button class="wide ghost" id="xCancel">Cancel</button>
      </div>`);
    wire();
    $("#xCancel").onclick = close;
    $("#xConfirm").onclick = reveal;
  };
  const reveal = async () => {
    m.innerHTML = modalShell(html`<div class="pk-stage pk-stage--waiting" aria-live="polite"><div class="pk-orb">${ICON.passkey}</div>
      <h2 id="mTitle">Waiting for Face ID / Touch ID</h2><p>Confirm with your passkey to show the phrase.</p></div>`);
    wire();
    let words;
    try {
      words = (await exportRecoveryPhrase()).split(" ");
    } catch (e) {
      console.error(e);
      return confirm(e);
    }
    m.innerHTML = modalShell(html`
      <div class="connect-modal__intro"><h2 id="mTitle">Your recovery phrase</h2><p>Write these down in order. Close this window when you're done.</p></div>
      <ol class="phrase mono" id="phrase">${words.map((w) => `<li>${w}</li>`).join("")}</ol>
      <div class="pk-choice pk-choice--row">
        <button class="wide" id="xCopy">${ICON.copy}<span>Copy</span></button>
        <button class="primary wide" id="xDone">Done</button>
      </div>`);
    wire();
    $("#xDone").onclick = close;
    $("#xCopy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(words.join(" "));
        $("#xCopy span").textContent = "Copied";
      } catch {
        toast("Copy failed. Write the words down instead.");
      }
    };
  };
  confirm();
  m.hidden = false;
}

async function faucet() {
  await act("Minting test funds", async () => {
    if (await fundGasLocal(W.address)) toast(`Sent 1 ${nativeSymbol()} for gas. Minting test funds…`, 120000);
    const calls = [call(D.usdc, "MockERC20", "mint", [W.address, usd(100_000)])];
    for (const s of D.stocks) calls.push(call(s.address, "MockXStock", "mint", [W.address, sh(100)]));
    await sendCalls(calls);
  }, refresh);
}
