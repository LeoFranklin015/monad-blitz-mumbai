// E2E test: "Get test funds" faucet button on the Pro page.
//
// Verifies:
//   1. Page loads at /#pro with injected wallet
//   2. Connect wallet via #connectBtn → #cInj
//   3. Balances tab loads
//   4. #pro-faucet-btn exists and has text "Get test funds"
//   5. Click faucet button
//   6. "Minting test funds" toast fires, then "Depositing USDC" toast, then done
//   7. On-chain freeBalance(deployer, USDC) increased
//
// Run: node .e2e/faucet.mjs
import { chromium } from "playwright";
import { ethers } from "ethers";
import fs from "node:fs";

const WEB = process.env.WEB_URL || "http://localhost:5173";
const RPC = process.env.RPC_URL || "https://monad-testnet.drpc.org";
const PK = process.env.PRIVATE_KEY;
if (!PK) throw new Error("Set PRIVATE_KEY to a dedicated funded testnet account before running this test");
const CHAIN = 10143;

const dep = JSON.parse(fs.readFileSync(new URL("../deployments/monadTestnet.json", import.meta.url)));

// batchMaxCount:1 — Monad RPC drops batches above 5; use 1 to be safe in tests.
const provider = new ethers.JsonRpcProvider(RPC, CHAIN, { staticNetwork: true, batchMaxCount: 1 });
const wallet = new ethers.Wallet(PK, provider);

const log = (...a) => console.log("[faucet-e2e]", ...a);

const results = [];
function pass(test, detail = "") {
  log(`PASS: ${test}` + (detail ? ` — ${detail}` : ""));
  results.push({ test, pass: true, detail });
}
function fail(test, detail = "") {
  log(`FAIL: ${test}` + (detail ? ` — ${detail}` : ""));
  results.push({ test, pass: false, detail });
}

// ── Serialized RPC queue (Monad "queue size exceeded" protection) ─────────────
const pendingQueue = [];
let draining = false;
async function drainQueue() {
  if (draining) return;
  draining = true;
  while (pendingQueue.length > 0) {
    const { rpcReq, resolve } = pendingQueue.shift();
    try {
      const result = await provider.send(rpcReq.method, rpcReq.params || []);
      resolve({ result });
    } catch (e) {
      const msg = e.info?.error?.message || e.shortMessage || e.message || "rpc error";
      const code = e.info?.error?.code || -32000;
      resolve({ error: { code, message: msg } });
    }
    await new Promise((r) => setTimeout(r, 8));
  }
  draining = false;
}
async function executeRpc(rpcReq) {
  return new Promise((resolve) => {
    pendingQueue.push({ rpcReq, resolve });
    drainQueue();
  });
}

// EIP-1193 bridge for the injected wallet
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
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
      });
      log("  tx sent:", sent.hash);
      const rc = await sent.wait();
      log("  tx mined block", rc.blockNumber, "status", rc.status);
      return sent.hash;
    }
    default:
      return executeRpc({ method, params }).then((r) => {
        if (r.error) {
          const e = new Error(r.error.message);
          e.code = r.error.code;
          throw e;
        }
        return r.result;
      });
  }
}

async function main() {
  // ── Read on-chain freeBalance BEFORE faucet ───────────────────────────────────
  const freeBalAbi = ["function freeBalance(address, address) view returns (uint256)"];
  const proto = new ethers.Contract(dep.protocol, freeBalAbi, provider);
  let freeBalBefore;
  try {
    freeBalBefore = await proto.freeBalance(wallet.address, dep.usdc);
    log(`freeBalance before: ${freeBalBefore.toString()} (${Number(freeBalBefore) / 1e6} USDC)`);
  } catch (e) {
    log(`Warning: could not read freeBalance before test: ${e.message}`);
    freeBalBefore = null;
  }

  // ── Launch browser ────────────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Intercept Monad RPC calls and route through serialized queue
  await page.route("https://monad-testnet.drpc.org/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
        body: "",
      });
      return;
    }
    if (req.method() !== "POST") return route.continue();
    try {
      const body = req.postData();
      const parsed = JSON.parse(body);
      const isArray = Array.isArray(parsed);
      const requests = isArray ? parsed : [parsed];
      const responses = await Promise.all(
        requests.map(async (rpcReq) => {
          const { result, error } = await executeRpc(rpcReq);
          if (error) return { jsonrpc: "2.0", id: rpcReq.id, error };
          return { jsonrpc: "2.0", id: rpcReq.id, result };
        })
      );
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(isArray ? responses : responses[0]),
      });
    } catch (e) {
      log("RPC intercept error:", e.message);
      return route.continue();
    }
  });

  page.on("console", (m) => {
    if (m.type() === "error") {
      const t = m.text();
      if (!t.includes("favicon") && !t.includes("net::ERR") && !t.includes("CALL_EXCEPTION"))
        log("page error:", t.slice(0, 150));
    }
  });
  page.on("pageerror", (e) => log("pageerror:", e.message.slice(0, 150)));

  // Install EIP-1193 wallet bridge before any app script runs
  await page.exposeFunction("__node", handleRequest);
  await page.addInitScript(() => {
    window.ethereum = {
      isMetaMask: true,
      _cbs: {},
      request: ({ method, params }) => window.__node(method, params || []),
      on: (ev, cb) => { (window.ethereum._cbs[ev] ||= []).push(cb); },
      removeListener: () => {},
    };
  });

  // ── Step 1: Load /#pro ────────────────────────────────────────────────────────
  log("Navigating to", `${WEB}/#pro`);
  await page.goto(`${WEB}/#pro`, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for pro page to mount (loads series from chain ~30s via serialized queue)
  log("Waiting for .pro-page to mount (up to 90s)...");
  let proMounted = false;
  try {
    await page.waitForSelector(".pro-page", { timeout: 90000 });
    proMounted = true;
    log("Pro page mounted");
  } catch {
    try {
      await page.click('button[data-view="pro"]', { timeout: 5000 });
      await page.waitForSelector(".pro-page", { timeout: 20000 });
      proMounted = true;
      log("Pro page mounted after nav click");
    } catch (e2) {
      log("Could not mount Pro page:", e2.message);
    }
  }

  if (proMounted) {
    pass("1. Page loads at /#pro", "pro-page element present");
  } else {
    fail("1. Page loads at /#pro", "pro-page never mounted");
    await browser.close();
    printSummary();
    process.exit(1);
  }

  // ── Step 2: Connect wallet ────────────────────────────────────────────────────
  try {
    const connectBtn = page.locator("#connectBtn");
    await connectBtn.waitFor({ timeout: 10000 });
    await connectBtn.click();
    await page.waitForSelector("#cInj", { timeout: 5000 });
    await page.locator("#cInj").click();
    // Wait for wallet address to be set in app state
    await page.waitForFunction(
      () => window.__app?.W?.address != null,
      null, { timeout: 15000 }
    );
    const addr = await page.evaluate(() => window.__app?.W?.address);
    pass("2. Connect wallet via #connectBtn → #cInj", `address: ${addr}`);
  } catch (e) {
    fail("2. Connect wallet via #connectBtn → #cInj", e.message);
    await browser.close();
    printSummary();
    process.exit(1);
  }

  // ── Step 3: Balances tab loads ────────────────────────────────────────────────
  try {
    // The balances tab should already be active by default on the pro page.
    // If not, click it.
    const balTab = page.locator('.pro-tabs__tab[data-tab="balances"]');
    const tabVisible = await balTab.isVisible({ timeout: 5000 }).catch(() => false);
    if (tabVisible) await balTab.click();

    // Wait for tbody to render something (not blank)
    await page.waitForFunction(
      () => {
        const tbody = document.querySelector("#pro-balances-body");
        return tbody && tbody.textContent.trim().length > 0 && !tbody.textContent.includes("Loading…");
      },
      null, { timeout: 60000 }
    );
    const balHtml = await page.locator("#pro-balances-body").innerHTML();
    pass("3. Balances tab loaded", `html snippet: ${balHtml.slice(0, 80).replace(/<[^>]+>/g, " ").trim()}`);
  } catch (e) {
    // Non-fatal — proceed even if balances are still loading
    const bodyText = await page.locator("#pro-balances-body").innerText().catch(() => "not found");
    fail("3. Balances tab loaded", `body: "${bodyText.slice(0, 80)}" — ${e.message}`);
  }

  // ── Step 4: Verify #pro-faucet-btn exists with correct text ──────────────────
  let faucetText = "";
  try {
    const faucetBtn = page.locator("#pro-faucet-btn");
    await faucetBtn.waitFor({ timeout: 10000 });
    faucetText = await faucetBtn.innerText();
    // Strip emoji and trim for text comparison
    const textOnly = faucetText.replace(/[^\w\s]/gu, "").trim().toLowerCase();
    if (textOnly.includes("get test funds")) {
      pass('4. #pro-faucet-btn exists with text "Get test funds"', `text: "${faucetText}"`);
    } else {
      fail('4. #pro-faucet-btn exists with text "Get test funds"', `actual text: "${faucetText}"`);
    }
  } catch (e) {
    fail('4. #pro-faucet-btn exists with text "Get test funds"', e.message);
    await browser.close();
    printSummary();
    process.exit(1);
  }

  // ── Step 5: Click faucet button ───────────────────────────────────────────────
  // Track which toast messages were observed
  const toastsSeen = [];
  // Poll toast text changes
  const toastPoller = setInterval(async () => {
    try {
      const t = await page.locator("#toast").innerText().catch(() => "");
      if (t && t.trim().length > 0) {
        const last = toastsSeen[toastsSeen.length - 1];
        if (t !== last) toastsSeen.push(t.trim());
      }
    } catch { /* page may be closing */ }
  }, 300);

  try {
    await page.locator("#pro-faucet-btn").click();
    log("Clicked #pro-faucet-btn");
    pass("5. Click faucet button", "clicked without error");
  } catch (e) {
    clearInterval(toastPoller);
    fail("5. Click faucet button", e.message);
    await browser.close();
    printSummary();
    process.exit(1);
  }

  // ── Step 6: Observe toasts: "Minting test funds" → "Depositing USDC" → done ──
  // The faucet runs two sequential act() calls so we expect to see both toasts.
  // Give it 3 minutes total (two on-chain txs on Monad testnet).
  try {
    // Wait for "Minting test funds" toast
    await page.waitForFunction(
      () => {
        const t = document.querySelector("#toast");
        return t && /mint.*test.*fund/i.test(t.textContent);
      },
      null, { timeout: 60000 }
    );
    const mintToast = await page.locator("#toast").innerText();
    pass('6a. "Minting test funds" toast appeared', `toast: "${mintToast}"`);
    log("Toast:", mintToast);
  } catch (e) {
    fail('6a. "Minting test funds" toast appeared', `timeout — toasts seen: ${JSON.stringify(toastsSeen)}`);
  }

  try {
    // Wait for mint tx to complete (done state) then for "Depositing USDC" toast
    await page.waitForFunction(
      () => {
        const t = document.querySelector("#toast");
        return t && /deposit.*USDC/i.test(t.textContent);
      },
      null, { timeout: 120000 }
    );
    const depositToast = await page.locator("#toast").innerText();
    pass('6b. "Depositing USDC" toast appeared', `toast: "${depositToast}"`);
    log("Toast:", depositToast);
  } catch (e) {
    fail('6b. "Depositing USDC" toast appeared', `timeout — toasts seen: ${JSON.stringify(toastsSeen)}`);
  }

  try {
    // Wait for the deposit operation to complete (done/error)
    await page.waitForFunction(
      () => {
        const t = document.querySelector("#toast");
        if (!t) return true;
        const txt = t.textContent.trim();
        return txt.length === 0 || /done|error|failed|Cancelled/i.test(txt);
      },
      null, { timeout: 120000 }
    );
    const finalToast = await page.locator("#toast").innerText().catch(() => "");
    if (/error|failed/i.test(finalToast)) {
      fail("6c. Faucet completes without error", `final toast: "${finalToast}"`);
    } else {
      pass("6c. Faucet completes without error", `final toast: "${finalToast || "(cleared)"}"`);
    }
    log("Final toast:", finalToast || "(cleared)");
  } catch (e) {
    fail("6c. Faucet completes without error", e.message);
  }

  clearInterval(toastPoller);
  log("All toasts seen:", toastsSeen);

  await browser.close();

  // ── Step 7: Read on-chain freeBalance(deployer, USDC) after faucet ───────────
  try {
    const freeBalAfter = await proto.freeBalance(wallet.address, dep.usdc);
    log(`freeBalance after: ${freeBalAfter.toString()} (${Number(freeBalAfter) / 1e6} USDC)`);

    if (freeBalBefore === null) {
      fail("7. freeBalance(deployer, USDC) increased on-chain", "could not read before value");
    } else if (freeBalAfter > freeBalBefore) {
      const delta = freeBalAfter - freeBalBefore;
      pass(
        "7. freeBalance(deployer, USDC) increased on-chain",
        `before=${Number(freeBalBefore) / 1e6} USDC, after=${Number(freeBalAfter) / 1e6} USDC, delta=+${Number(delta) / 1e6} USDC`
      );
    } else {
      fail(
        "7. freeBalance(deployer, USDC) increased on-chain",
        `before=${Number(freeBalBefore) / 1e6} USDC, after=${Number(freeBalAfter) / 1e6} USDC (no increase)`
      );
    }
  } catch (e) {
    fail("7. freeBalance(deployer, USDC) increased on-chain", e.message);
  }

  printSummary();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

function printSummary() {
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  log(`\n=== Results: ${passed}/${total} passed ===`);
  results.forEach((r) => log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.test}: ${r.detail || ""}`));
}

main().catch((e) => {
  console.error("[faucet-e2e] Fatal:", e);
  process.exit(1);
});
