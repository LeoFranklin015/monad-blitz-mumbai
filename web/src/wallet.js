// One wallet interface for three kinds of accounts:
//  - JAW passkey smart accounts (Monad mainnet, Base Sepolia and other JAW chains):
//    every action is one atomic wallet_sendCalls batch, approvals included, one passkey prompt,
//    gas optionally sponsored by a paymaster.
//  - Local demo accounts on the dev chain (unlocked Hardhat accounts).
//  - Mera passkey accounts on any chain: the passkey derives a plain EOA (see mera.js);
//    the key stays inside a Mera signing session held while signed in.
//  - Any injected wallet (MetaMask, Rabby).
import { ethers } from "ethers";
import { D, read, isLocal, call, localRpc, nativeBalance } from "./chain.js";
import { MeraSigner, isMeraError, openSession, createPasskey, usePasskey, storedCredential, saveCredential, recoveryPhrase } from "./mera.js";
import { JAW_API_KEY, PAYMASTER_URL } from "./config.js";

export const W = { kind: null, address: null, signer: null, jaw: null, listeners: [] };

// Chains come from the SDK itself, so this stays right as JAW adds networks.
const jawChains = { all: new Set(), testnets: new Set() };
export async function initJaw() {
  try {
    const { SUPPORTED_CHAINS, TESTNET_CHAINS } = await import("@jaw.id/core");
    SUPPORTED_CHAINS.forEach((c) => jawChains.all.add(c.id));
    TESTNET_CHAINS.forEach((c) => jawChains.testnets.add(c.id));
  } catch (e) {
    console.warn("JAW SDK unavailable", e);
  }
}
export const jawChainSupported = () => jawChains.all.has(D.chainId);
export const jawAvailable = () => jawChainSupported() && !!JAW_API_KEY;
export const onChange = (fn) => W.listeners.push(fn);
const emit = () => W.listeners.forEach((fn) => fn());

const hex = (n) => "0x" + n.toString(16);

export async function connectLocal(index = 5) {
  const p = new ethers.JsonRpcProvider(localRpc(), 31337, { staticNetwork: true });
  const accts = await p.send("eth_accounts", []);
  W.kind = "local";
  W.address = accts[index];
  W.signer = await p.getSigner(accts[index]);
  W.localAccounts = accts.slice(5, 10);
  emit();
}

export async function connectJaw() {
  if (!jawAvailable()) throw new Error("Passkey accounts need a JAW API key and a JAW-supported chain");
  const { JAW } = await import("@jaw.id/core");
  W.jaw = JAW.create({
    apiKey: JAW_API_KEY,
    appName: "Weekend Options",
    defaultChainId: D.chainId,
    preference: { showTestnets: jawChains.testnets.has(D.chainId) },
    ...(PAYMASTER_URL ? { paymasters: { [D.chainId]: { url: PAYMASTER_URL } } } : {}),
  });
  const accounts = await W.jaw.provider.request({ method: "eth_requestAccounts" });
  const chainId = await W.jaw.provider.request({ method: "eth_chainId" });
  if (Number(chainId) !== D.chainId) {
    await W.jaw.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex(D.chainId) }] });
  }
  W.kind = "jaw";
  W.address = ethers.getAddress(accounts[0]);
  W.jaw.provider.on("accountsChanged", (a) => {
    W.address = a[0] ? ethers.getAddress(a[0]) : null;
    if (!W.address) W.kind = null;
    emit();
  });
  emit();
}

// Chains a browser wallet may not know yet, so Connect can add them instead of failing with error 4902.
function chainParams() {
  if (D.chainId === 10143) return { chainId: hex(10143), chainName: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: ["https://testnet-rpc.monad.xyz"], blockExplorerUrls: ["https://testnet.monadvision.com"] };
  if (D.chainId === 143) return { chainId: hex(143), chainName: "Monad", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: ["https://rpc.monad.xyz"], blockExplorerUrls: ["https://monadvision.com"] };
  if (D.chainId === 31337) return { chainId: hex(31337), chainName: "Weekend Options local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [localRpc()] };
  return { chainId: hex(D.chainId), chainName: `Chain ${D.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [D.rpc] };
}

const wantsUnknownChain = (e) => e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized chain|wallet_addEthereumChain/i.test(e?.message || "");

/// Put the browser wallet on the deployment's chain, adding the chain first if the wallet doesn't know it.
async function ensureChain(eth) {
  if (Number(await eth.request({ method: "eth_chainId" })) === D.chainId) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex(D.chainId) }] });
  } catch (e) {
    if (!wantsUnknownChain(e)) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [chainParams()] });
    if (Number(await eth.request({ method: "eth_chainId" })) !== D.chainId) {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex(D.chainId) }] });
    }
  }
}

const REMEMBER = "wkend.wallet"; // "injected" while a browser wallet is connected, so a reload doesn't ask again
let watching = false;

async function attachInjected(address) {
  W.kind = "injected";
  W.signer = await new ethers.BrowserProvider(window.ethereum).getSigner(address);
  W.address = ethers.getAddress(address);
  try { localStorage.setItem(REMEMBER, "injected"); } catch {}
  if (!watching && window.ethereum.on) {
    watching = true;
    // Follow the wallet: a switched account becomes the app's account, a disconnect signs the app out.
    window.ethereum.on("accountsChanged", async (accts) => {
      if (W.kind !== "injected") return;
      if (accts?.length) await attachInjected(accts[0]).catch(() => {});
      else { Object.assign(W, { kind: null, address: null, signer: null }); try { localStorage.removeItem(REMEMBER); } catch {} }
      emit();
    });
  }
  emit();
}

/// Connect MetaMask/Rabby. Talks to the wallet directly (ethers turns wallet errors into "could not coalesce error").
export async function connectInjected() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask or Rabby, then reload.");
  let accts;
  try {
    accts = await eth.request({ method: "eth_requestAccounts" });
    await ensureChain(eth);
  } catch (e) {
    if (e?.code === 4001) throw new Error("You declined the request in your wallet.");
    if (e?.code === -32002) throw new Error("Your wallet already has a request open. Open MetaMask to finish it.");
    throw new Error(e?.message || "Your wallet refused to connect");
  }
  if (!accts?.length) throw new Error("Your wallet didn't share an account");
  await attachInjected(accts[0]);
}

/// On page load: if a browser wallet was connected before and still shares an account, reconnect without a prompt.
export async function restoreSession() {
  let last = null;
  try { last = localStorage.getItem(REMEMBER); } catch {}
  if (last !== "injected" || !window.ethereum || W.address) return false;
  try {
    const accts = await window.ethereum.request({ method: "eth_accounts" }); // never prompts
    if (!accts?.length) return false;
    if (Number(await window.ethereum.request({ method: "eth_chainId" })) !== D.chainId) return false; // wrong chain: let Connect fix it
    await attachInjected(accts[0]);
    return true;
  } catch {
    return false;
  }
}


// ---- Mera passkey accounts -----------------------------------------------------------
const IDLE_MS = 30 * 60 * 1000;
let meraSession = null;
let lastActive = Date.now();
let idleTimer = null;
export const meraKnown = () => storedCredential();

/// Sign in with a passkey. mode: "known" (this browser's stored passkey), "create", or "existing" (pick any).
/// onPhase("waiting" | "deriving") lets the UI show where the ceremony is.
export async function connectMera(mode, onPhase = () => {}) {
  const rpId = location.hostname;
  onPhase("waiting");
  const known = storedCredential();
  const got = mode === "create" ? await createPasskey(rpId) : await usePasskey(rpId, mode === "known" ? known : undefined);
  onPhase("deriving");
  let opened;
  try {
    opened = openSession(got.prfOutput);
  } finally {
    got.prfOutput.fill(0);
  }
  if (W.kind) await disconnect(false);
  meraSession = opened.session;
  saveCredential({ ...got.credential, address: opened.account.address });
  W.kind = "mera";
  W.address = opened.account.address;
  W.signer = new MeraSigner(opened.account, read);
  watchIdle();
  emit();
  return W.address;
}

/// Fresh passkey prompt for the 24 words; the PRF output is wiped before returning.
export async function exportRecoveryPhrase() {
  if (W.kind !== "mera") throw new Error("Only passkey accounts have a recovery phrase here");
  const known = storedCredential();
  const got = await usePasskey(location.hostname, known?.address === W.address ? known : undefined);
  try {
    const { session, account } = openSession(got.prfOutput);
    session.end();
    if (account.address !== W.address) throw new Error("That passkey belongs to a different account");
    return recoveryPhrase(got.prfOutput);
  } finally {
    got.prfOutput.fill(0);
  }
}

function watchIdle() {
  lastActive = Date.now();
  if (idleTimer) return;
  const bump = () => (lastActive = Date.now());
  ["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, bump, { capture: true, passive: true }));
  idleTimer = setInterval(() => {
    if (W.kind === "mera" && Date.now() - lastActive > IDLE_MS) {
      disconnect(false).then(() => {
        W.idleEnded = true;
        emit();
      }, console.error);
    }
  }, 30_000);
}

/// Dev chain only: send the account 1 ETH of gas from the deployer.
export async function fundGasLocal(address) {
  if (!isLocal()) return false;
  const { signer } = await devSigner();
  await (await signer.sendTransaction({ to: address, value: ethers.parseEther("1") })).wait();
  return true;
}

export async function disconnect(notify = true) {
  if (W.jaw) await W.jaw.disconnect().catch(() => {});
  try { localStorage.removeItem(REMEMBER); } catch {}
  if (meraSession) meraSession.end();
  meraSession = null;
  Object.assign(W, { kind: null, address: null, signer: null, jaw: null, idleEnded: false });
  if (notify) emit();
}

/// Send a list of calls. Passkey accounts send them as one atomic batch; other wallets send them in order.
export async function sendCalls(calls) {
  if (!W.address) throw new Error("Connect an account first");
  if (W.kind === "jaw") {
    const res = await W.jaw.provider.request({
      method: "wallet_sendCalls",
      params: [{ chainId: hex(D.chainId), calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ? hex(c.value) : "0x0" })) }],
    });
    const id = typeof res === "string" ? res : res.id;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await W.jaw.provider.request({ method: "wallet_getCallsStatus", params: [id] });
      const code = typeof st.status === "number" ? st.status : { PENDING: 100, CONFIRMED: 200 }[st.status] ?? 100;
      if (code === 200) return st;
      if (code >= 400) throw new Error(code === 500 ? "Transaction reverted onchain" : "Transaction failed");
    }
    throw new Error("Timed out waiting for confirmation");
  }
  if (W.kind === "injected" && (await atomicBatching())) return sendBatched(calls);
  let last;
  try {
    for (const c of calls) {
      const tx = await W.signer.sendTransaction({ to: c.to, data: c.data, value: c.value || 0n });
      last = await tx.wait();
    }
  } catch (e) {
    if (isMeraError(e) && e.code === "SESSION_ENDED") await disconnect(); // back to Connect; the toast says sign in again
    throw e;
  }
  return last;
}

// EIP-5792 batching for browser wallets: approval + action in one confirmation, atomically. MetaMask does this
// through EIP-7702 (its delegator is deployed on Monad testnet) and offers the account upgrade in the same prompt.
// Wallets without it keep the one-transaction-per-call path above.
const atomicCache = new Map(); // `${address}:${chainId}` -> boolean
export async function atomicBatching() {
  if (W.kind !== "injected" || !window.ethereum) return false;
  const key = `${W.address}:${D.chainId}`;
  if (!atomicCache.has(key)) {
    let ok = false;
    try {
      const caps = await window.ethereum.request({ method: "wallet_getCapabilities", params: [W.address, [hex(D.chainId)]] });
      const st = (caps?.[hex(D.chainId)] || caps?.[String(D.chainId)])?.atomic?.status;
      ok = st === "supported" || st === "ready";
    } catch {}
    atomicCache.set(key, ok);
  }
  return atomicCache.get(key);
}

async function sendBatched(calls) {
  let res;
  try {
    res = await window.ethereum.request({
      method: "wallet_sendCalls",
      params: [{ version: "2.0.0", chainId: hex(D.chainId), from: W.address, atomicRequired: true,
        calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ? hex(c.value) : "0x0" })) }],
    });
  } catch (e) {
    // The wallet turned batching down after advertising it (e.g. the user declined the account upgrade): send one by one.
    if (e?.code === 4001) throw e;
    atomicCache.set(`${W.address}:${D.chainId}`, false);
    return sendCalls(calls);
  }
  const id = typeof res === "string" ? res : res.id;
  for (let i = 0; i < 180; i++) {
    const st = await window.ethereum.request({ method: "wallet_getCallsStatus", params: [id] });
    const code = typeof st.status === "number" ? st.status : { PENDING: 100, CONFIRMED: 200 }[st.status] ?? 100;
    if (code === 200) return { ...st, hash: st.receipts?.[st.receipts.length - 1]?.transactionHash };
    if (code >= 400) throw new Error(code === 500 ? "Transaction reverted onchain" : "Transaction failed");
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for confirmation");
}

/// Approval calls needed before `spender` can pull `amount` of `token` (empty if already approved).
export async function approvals(token, spender, amount) {
  const t = new ethers.Contract(token, ["function allowance(address,address) view returns (uint256)"], read);
  const cur = await t.allowance(W.address, spender);
  if (cur >= amount) return [];
  return [call(token, "MockERC20", "approve", [spender, ethers.MaxUint256])];
}

/// Dev chain only: unlocked deployer account for the demo controls.
export async function devSigner() {
  if (!isLocal()) throw new Error("Demo controls only run on the local chain");
  const p = new ethers.JsonRpcProvider(localRpc(), 31337, { staticNetwork: true });
  return { provider: p, signer: await p.getSigner(0) };
}
