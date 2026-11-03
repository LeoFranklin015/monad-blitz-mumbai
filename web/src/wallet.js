// One wallet interface for three kinds of accounts:
//  - JAW passkey smart accounts (Monad mainnet, Base Sepolia and other JAW chains):
//    every action is one atomic wallet_sendCalls batch, approvals included, one passkey prompt,
//    gas optionally sponsored by a paymaster.
//  - Local demo accounts on the dev chain (unlocked Hardhat accounts).
//  - Any injected wallet (MetaMask, Rabby).
import { ethers } from "ethers";
import { D, read, isLocal, call, LOCAL_RPC } from "./chain.js";
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
  const p = new ethers.JsonRpcProvider(`http://${location.hostname}:8545`, 31337, { staticNetwork: true });
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

export async function connectInjected() {
  if (!window.ethereum) throw new Error("No browser wallet found");
  const bp = new ethers.BrowserProvider(window.ethereum);
  await bp.send("eth_requestAccounts", []);
  const net = await bp.getNetwork();
  if (Number(net.chainId) !== D.chainId) {
    await bp.send("wallet_switchEthereumChain", [{ chainId: hex(D.chainId) }]);
  }
  W.kind = "injected";
  W.signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
  W.address = await W.signer.getAddress();
  emit();
}

export async function disconnect() {
  if (W.jaw) await W.jaw.disconnect().catch(() => {});
  Object.assign(W, { kind: null, address: null, signer: null, jaw: null });
  emit();
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
  let last;
  for (const c of calls) {
    const tx = await W.signer.sendTransaction({ to: c.to, data: c.data, value: c.value || 0n });
    last = await tx.wait();
  }
  return last;
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
  const p = new ethers.JsonRpcProvider(LOCAL_RPC.replace("127.0.0.1", location.hostname), 31337, { staticNetwork: true });
  return { provider: p, signer: await p.getSigner(0) };
}
