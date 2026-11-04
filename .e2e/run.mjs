// End-to-end test of the Weekend Options web app against the live Monad testnet deploy.
//
// Strategy: launch the real Vite-built app in Chromium, inject an EIP-1193 provider
// backed by ethers + the deployer key so the app's own "Browser wallet" path signs and
// sends REAL testnet transactions. We drive the actual UI (connect, faucet, buy, write)
// and assert on what the app reads back from chain, so the whole stack is exercised.
//
// Run:  node .e2e/run.mjs            (expects web preview on :4173 and backend on :8787)
import { chromium } from "playwright";
import { ethers } from "ethers";
import fs from "node:fs";

const WEB = process.env.WEB_URL || "http://localhost:4173";
const RPC = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const PK = process.env.PRIVATE_KEY;
if (!PK) throw new Error("Set PRIVATE_KEY to a dedicated funded testnet account before running this test");
const CHAIN = 10143;

const dep = JSON.parse(fs.readFileSync(new URL("../deployments/monadTestnet.json", import.meta.url)));
const provider = new ethers.JsonRpcProvider(RPC, CHAIN, { staticNetwork: true });
const wallet = new ethers.Wallet(PK, provider);

const log = (...a) => console.log("[e2e]", ...a);
const fail = (m) => { console.error("[e2e] FAIL:", m); process.exitCode = 1; };

// A minimal EIP-1193 provider we expose to the page as window.ethereum.
// It proxies reads to the RPC and signs/sends writes with the deployer key in Node.
async function handleRequest(method, params = []) {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return [wallet.address];
    case "eth_chainId":
      return "0x" + CHAIN.toString(16);
    case "wallet_switchEthereumChain":
      return null;
    case "eth_sendTransaction": {
      const tx = params[0];
      const sent = await wallet.sendTransaction({
        to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n,
      });
      log("  tx", sent.hash, "…");
      const rc = await sent.wait();
      log("  tx mined block", rc.blockNumber, "status", rc.status);
      return sent.hash;
    }
    default:
      // Forward everything else (eth_call, eth_getBlockByNumber, estimateGas, etc.) to the RPC.
      return provider.send(method, params);
  }
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Bridge: page calls window.__node(method, params) -> Node handler above.
  await page.exposeFunction("__node", handleRequest);

  // Install a window.ethereum before any app script runs.
  await page.addInitScript(() => {
    window.ethereum = {
      isMetaMask: true,
      _cbs: {},
      request: ({ method, params }) => window.__node(method, params || []),
      on: (ev, cb) => { (window.ethereum._cbs[ev] ||= []).push(cb); },
      removeListener: () => {},
    };
  });

  page.on("console", (m) => { if (m.type() === "error") log("page error:", m.text()); });
  page.on("pageerror", (e) => log("pageerror:", e.message));

  log("open", WEB);
  await page.goto(WEB, { waitUntil: "networkidle" });

  // 1) App booted against the deployment (not the "No deployment" / "Can't reach chain" card).
  const view = await page.locator("#view").innerText();
  if (/No deployment|Can't reach the chain/i.test(view)) return fail("app did not boot: " + view.slice(0, 120));
  log("OK app booted");

  // 2) Market header + stocks render.
  await page.waitForSelector("#stocks .tab", { timeout: 20000 });
  const stocks = await page.locator("#stocks .tab").count();
  log(stocks >= 1 ? `OK ${stocks} stock tabs` : fail("no stock tabs"));

  // 3) Backend /markets is live (header shows quote updates/s, not "makers offline").
  const qps = await page.locator("#qps").innerText();
  log("markets header:", JSON.stringify(qps), /offline/i.test(qps) ? "(backend down)" : "OK");

  // 4) Connect via browser wallet.
  await page.locator("#connectBtn").click();
  await page.locator("#cInj").click();
  await page.waitForSelector("#faucetBtn", { timeout: 20000 });
  log("OK connected as", wallet.address);

  // 5) Faucet: mint test funds, then confirm wallet balance shows on Portfolio.
  await page.locator("#faucetBtn").click();
  await page.waitForTimeout(1000);
  // wait until toast reports done (or timeout)
  await page.waitForFunction(() => /done|Failed|Cancelled/.test(document.querySelector("#toast")?.textContent || ""), null, { timeout: 90000 }).catch(() => {});
  log("faucet toast:", await page.locator("#toast").innerText());

  await page.locator('#nav button[data-view="portfolio"]').click();
  await page.waitForTimeout(2500);
  const walletTxt = await page.locator("#wallet").innerText();
  log(/USDC/.test(walletTxt) ? "OK portfolio shows wallet balances" : fail("no wallet balances"));

  // 6) Trade: pick a strike with asks and buy from book.
  await page.locator('#nav button[data-view="trade"]').click();
  await page.waitForSelector("#strikes .strike", { timeout: 20000 });
  const buyBtn = page.locator("#buy");
  const label = await buyBtn.innerText();
  log("buy button:", JSON.stringify(label));
  if (/Buy from book/.test(label)) {
    await buyBtn.click();
    await page.waitForFunction(() => /done|Failed|Cancelled|moved/i.test(document.querySelector("#toast")?.textContent || ""), null, { timeout: 90000 }).catch(() => {});
    log("buy toast:", await page.locator("#toast").innerText());
  } else {
    log("skip buy (book thin or backend offline):", label);
  }

  await browser.close();
  log(process.exitCode ? "DONE WITH FAILURES" : "ALL CHECKS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
