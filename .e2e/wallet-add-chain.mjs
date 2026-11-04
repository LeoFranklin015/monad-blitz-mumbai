// Browser wallet connect when the wallet doesn't know the app's chain yet (MetaMask's error 4902).
// A fake EIP-1193 wallet starts on Ethereum mainnet and only learns the app's chain through
// wallet_addEthereumChain, the way MetaMask behaves for a local chain or a first visit to Monad testnet.
//
// Run against the running app; CHAIN is the deployment's chain (default Monad testnet), RPC serves the reads:
//   WEB_URL=http://localhost:5173 node .e2e/wallet-add-chain.mjs
//   WEB_URL=http://localhost:5173 CHAIN=0x7a69 RPC_URL=http://127.0.0.1:8545 node .e2e/wallet-add-chain.mjs   (local chain)
import { chromium } from "playwright";
import { ethers } from "ethers";

const WEB = process.env.WEB_URL || "http://localhost:5173";
const RPC = process.env.RPC_URL || "https://monad-testnet.drpc.org";
const CHAIN = (process.env.CHAIN || "0x279f").toLowerCase();
const ACCOUNT = process.env.ACCOUNT || "0xd25fF8Fb969AE5a4eA7084C5b7e410dF560ae57D"; // read only, nothing is signed
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });

const log = (...a) => console.log("[e2e]", ...a);
let failed = false;
const check = (ok, msg) => { log(ok ? "ok  " : "FAIL", msg); if (!ok) failed = true; };

// Wallet state lives in Node so the test can assert on what the app asked for.
const wallet = { chainId: "0x1", known: new Set(["0x1"]), added: [], prompts: 0 };

async function handle(method, params = []) {
  switch (method) {
    case "eth_requestAccounts":
      wallet.prompts++;
      return [ACCOUNT];
    case "eth_accounts":
      return [ACCOUNT];
    case "eth_chainId":
      return wallet.chainId;
    case "net_version":
      return String(Number(wallet.chainId));
    case "wallet_switchEthereumChain": {
      const id = params[0].chainId.toLowerCase();
      if (!wallet.known.has(id)) throw { code: 4902, message: `Unrecognized chain ID "${id}". Try adding the chain using wallet_addEthereumChain first.` };
      wallet.chainId = id;
      return null;
    }
    case "wallet_addEthereumChain": {
      const p = params[0];
      wallet.added.push(p);
      wallet.known.add(p.chainId.toLowerCase());
      wallet.chainId = p.chainId.toLowerCase(); // MetaMask switches to a chain right after adding it
      return null;
    }
    default:
      if (wallet.chainId !== CHAIN) throw { code: -32603, message: `fake wallet is on ${wallet.chainId}` };
      return provider.send(method, params);
  }
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.exposeFunction("__wallet", async (method, params) => {
    try { return { result: await handle(method, params) }; } catch (e) { return { error: { code: e.code, message: e.message } }; }
  });
  await page.addInitScript(() => {
    const listeners = {};
    window.ethereum = {
      isMetaMask: true,
      async request({ method, params }) {
        const r = await window.__wallet(method, params || []);
        if (r.error) { const err = new Error(r.error.message); err.code = r.error.code; throw err; }
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") (listeners.chainChanged || []).forEach((f) => f(params[0].chainId));
        return r.result;
      },
      on(ev, f) { (listeners[ev] ||= []).push(f); },
      removeListener(ev, f) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); },
    };
  });

  await page.goto(`${WEB}/#pro`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#connectBtn", { timeout: 60000 });
  await page.click("#connectBtn");
  await page.click("#cInj");
  await page.waitForTimeout(3000);

  await page.waitForTimeout(2000);
  const pill = await page.locator("#account").textContent().catch(() => null);
  const toast = await page.locator("#toast").textContent().catch(() => "");
  check(!!pill && pill.toLowerCase().includes(ACCOUNT.slice(2, 6).toLowerCase()), `connected: account pill shows ${pill ?? "nothing"}${toast ? ` (toast: ${toast.trim()})` : ""}`);
  const added = wallet.added[0];
  check(!!added && added.chainId.toLowerCase() === CHAIN, `app added the chain it runs on: ${added ? `${added.chainId} "${added.chainName}"` : "never asked"}`);
  check(!!added && added.rpcUrls?.length > 0 && added.nativeCurrency?.symbol, `added chain has an RPC and a currency: ${added ? `${added.rpcUrls} ${added.nativeCurrency?.symbol}` : "-"}`);
  check(wallet.chainId === CHAIN, `wallet ends on chain ${wallet.chainId}`);

  // Reload: the app must reconnect by itself (eth_accounts, no prompt) instead of asking to Connect again.
  const prompts = { before: wallet.prompts };
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  const connectBtn = await page.$("#connectBtn");
  const acct = (await page.locator("#account").textContent().catch(() => "")) || "";
  check(!connectBtn && acct.toLowerCase().includes(ACCOUNT.slice(2, 6).toLowerCase()), `after reload still connected without a prompt: ${acct.replace(/\s+/g, " ").trim().slice(0, 60)}`);
  check(wallet.prompts === prompts.before, `no new wallet prompt on reload (eth_requestAccounts calls: ${wallet.prompts})`);
  await page.goto(`${WEB}/#home`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.goto(`${WEB}/#pro`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  check(!(await page.$("#connectBtn")), "still connected after moving between pages");
} finally {
  await browser.close();
}
if (failed) { log("FAILED"); process.exitCode = 1; } else log("PASSED");
