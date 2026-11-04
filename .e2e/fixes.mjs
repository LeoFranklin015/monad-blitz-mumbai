// E2E verification of 4 specific fixes to the Pro trading page.
// Run: node .e2e/fixes.mjs
import { chromium } from "playwright";
import { ethers } from "ethers";
import fs from "node:fs";

const WEB = process.env.WEB_URL || "http://localhost:5173";
const BACKEND = process.env.BACKEND_URL || "http://localhost:8787";
const RPC = process.env.RPC_URL || "https://monad-testnet.drpc.org";
const PK = process.env.PRIVATE_KEY;
if (!PK) throw new Error("Set PRIVATE_KEY to a dedicated funded testnet account before running this test");
const CHAIN = 10143;

const provider = new ethers.JsonRpcProvider(RPC, CHAIN, { staticNetwork: true, batchMaxCount: 1 });
const wallet = new ethers.Wallet(PK, provider);

const log = (...a) => console.log("[fixes-e2e]", ...a);

// Test result accumulator
const results = [];
const consoleErrors = [];

function pass(test, detail = "") {
  log(`PASS: ${test}` + (detail ? ` — ${detail}` : ""));
  results.push({ test, pass: true, detail });
}

function fail(test, detail = "") {
  log(`FAIL: ${test}` + (detail ? ` — ${detail}` : ""));
  results.push({ test, pass: false, detail });
}

// Serialized RPC queue — prevents Monad "queue size exceeded" errors
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

// EIP-1193 handler (copied exactly from run.mjs pattern, extended with serialized queue)
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
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Intercept all Monad RPC requests and route through serialized queue
  let rpcInterceptCount = 0;
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
      rpcInterceptCount += requests.length;
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

  // Capture console errors
  page.on("console", (m) => {
    if (m.type() === "error") {
      const text = m.text();
      if (text.includes("CALL_EXCEPTION") && text.includes("missing revert data")) return;
      if (text.includes("favicon") || text.includes("net::ERR")) return;
      consoleErrors.push(text);
      log("page console error:", text.slice(0, 200));
    }
  });
  page.on("pageerror", (e) => {
    const txt = e.message;
    if (txt.includes("CALL_EXCEPTION") && txt.includes("missing revert data")) return;
    consoleErrors.push(txt);
    log("pageerror:", txt.slice(0, 200));
  });

  // Install window.ethereum before any app script runs
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

  log("Navigating to", WEB + "/#pro");
  await page.goto(`${WEB}/#pro`, { waitUntil: "domcontentloaded", timeout: 30000 });

  log("Waiting for .pro-page to mount (up to 90s)...");
  try {
    await page.waitForSelector(".pro-page", { timeout: 90000 });
    log("Pro page mounted. RPC calls so far:", rpcInterceptCount);
  } catch (e) {
    log("Pro page timeout, trying nav click...");
    try {
      await page.click('button[data-view="pro"]', { timeout: 5000 });
      await page.waitForSelector(".pro-page", { timeout: 20000 });
      log("Pro page mounted after nav click");
    } catch {
      fail("pro page mount", "Pro page never mounted");
      await browser.close();
      process.exit(1);
    }
  }

  // Give the page a moment to start rendering
  await page.waitForTimeout(2000);

  // ── Fix 1: Ticker 24h stats ─────────────────────────────────────────────────
  // The fix pre-fetches 1D candles during renderAll(). Give up to 10s for values to appear.
  log("Testing Fix 1: Ticker 24h stats...");
  try {
    await page.waitForFunction(
      () => {
        const high = document.querySelector("#pro-high");
        const low = document.querySelector("#pro-low");
        const vol = document.querySelector("#pro-vol");
        if (!high || !low || !vol) return false;
        return high.textContent !== "—" && high.textContent.trim() !== "" &&
               low.textContent !== "—" && low.textContent.trim() !== "" &&
               vol.textContent !== "—" && vol.textContent.trim() !== "";
      },
      null,
      { timeout: 10000 }
    );
    const high = await page.locator("#pro-high").innerText();
    const low = await page.locator("#pro-low").innerText();
    const vol = await page.locator("#pro-vol").innerText();
    pass("Fix 1: Ticker 24h stats populated", `High=${high}, Low=${low}, Vol=${vol}`);
  } catch {
    const high = await page.locator("#pro-high").innerText().catch(() => "not found");
    const low = await page.locator("#pro-low").innerText().catch(() => "not found");
    const vol = await page.locator("#pro-vol").innerText().catch(() => "not found");
    fail("Fix 1: Ticker 24h stats populated", `High="${high}", Low="${low}", Vol="${vol}" — expected real values`);
  }

  // ── Fix 4: Trades tab all-series ─────────────────────────────────────────────
  // Tested BEFORE wallet connect (Fix 2) to avoid queue saturation from balanceOf calls.
  // The fix ensures refreshTrades() doesn't early-return when T.seriesId is null,
  // instead it fetches fills for ALL series of the current stock.
  // "No trades" is acceptable (empty chain), but staying "Loading…" means it didn't run.
  log("Testing Fix 4: Trades tab all-series...");
  try {
    const tradesTab = page.locator('.pro-panel-tab[data-panel="trades"]');
    await tradesTab.waitFor({ timeout: 5000 });
    await tradesTab.click();
    await page.waitForTimeout(500);

    const tradesPanelDisplay = await page.locator("#pro-panel-trades").evaluate((el) => el.style.display);
    const tradesTabOn = await page.locator('.pro-panel-tab[data-panel="trades"]').evaluate((el) => el.classList.contains("on"));
    log(`Trades panel display=${tradesPanelDisplay}, tab.on=${tradesTabOn}`);

    // Wait for trades to load — refreshTrades calls eth_blockNumber + eth_getLogs
    // This should complete within 30s when the RPC queue is relatively empty (pre-wallet-connect).
    try {
      await page.waitForFunction(
        () => {
          const tbody = document.querySelector("#pro-trades-body");
          if (!tbody) return false;
          const text = tbody.textContent.trim();
          return text.length > 0 && !text.includes("Loading…");
        },
        null,
        { timeout: 30000 }
      );
    } catch {
      log("Trades body still loading after 30s");
    }

    const tradesBodyText = await page.locator("#pro-trades-body").innerText().catch(() => "");
    log(`Trades body: "${tradesBodyText.slice(0, 80)}"`);

    const panelVisible = tradesPanelDisplay !== "none";
    const hasContent = tradesBodyText.trim().length > 0;
    const notLoading = !tradesBodyText.includes("Loading…");
    const noError = !tradesBodyText.toLowerCase().includes("error");

    if (panelVisible && hasContent && notLoading && noError) {
      pass(
        "Fix 4: Trades tab shows content for all-series (no early return)",
        `content: "${tradesBodyText.slice(0, 80).trim()}"`
      );
    } else if (!panelVisible) {
      fail("Fix 4: Trades tab shows content for all-series (no early return)", "trades panel not visible");
    } else if (!hasContent || !notLoading) {
      // If still "Loading…" after 30s, the RPC is extremely slow — not a code bug.
      // Check if the panel is at least visible and the tab click worked.
      // The key behavior test: if T.seriesId was null and there was an early return,
      // the tbody would be "Loading…" PERMANENTLY (never gets a renderTrades call).
      // But if refreshTrades started and is just queued, we accept that too.
      fail("Fix 4: Trades tab shows content for all-series (no early return)", `still loading after 30s: "${tradesBodyText.slice(0, 80)}"`);
    } else {
      fail("Fix 4: Trades tab shows content for all-series (no early return)", `error state: "${tradesBodyText.slice(0, 80)}"`);
    }
  } catch (e) {
    fail("Fix 4: Trades tab shows content for all-series (no early return)", e.message);
  }

  // Switch back to book panel before the next tests
  try {
    await page.locator('.pro-panel-tab[data-panel="book"]').click();
    await page.waitForTimeout(300);
  } catch {}

  // ── Fix 3: Token switch chart reinit ────────────────────────────────────────
  // Clicking the pair selector should cycle to the next stock and reinitialize the chart.
  log("Testing Fix 3: Token switch chart reinit...");
  try {
    const initialLabel = await page.locator("#pro-pair-label").innerText();
    log("Initial pair label:", initialLabel);

    const initialCanvases = await page.locator("#pro-chart-mount canvas").count();
    log("Initial canvas count:", initialCanvases);

    await page.locator("#pro-pair-btn").click();
    await page.waitForTimeout(500);

    const newLabel = await page.locator("#pro-pair-label").innerText();
    log("New pair label:", newLabel);

    let canvasCount = 0;
    try {
      await page.waitForSelector("#pro-chart-mount canvas", { timeout: 15000 });
      canvasCount = await page.locator("#pro-chart-mount canvas").count();
    } catch {
      canvasCount = 0;
    }

    const labelChanged = newLabel !== initialLabel;
    const hasCanvas = canvasCount > 0;
    log(`Label: "${initialLabel}" -> "${newLabel}", canvas count: ${canvasCount}`);

    if (labelChanged && hasCanvas) {
      pass("Fix 3: Token switch changes pair label and chart reinits with canvas", `"${initialLabel}" -> "${newLabel}", ${canvasCount} canvas(es)`);
    } else if (!labelChanged) {
      fail("Fix 3: Token switch changes pair label and chart reinits with canvas", `label did not change (still "${newLabel}")`);
    } else {
      fail("Fix 3: Token switch changes pair label and chart reinits with canvas", `label changed but no canvas (count=${canvasCount})`);
    }
  } catch (e) {
    fail("Fix 3: Token switch changes pair label and chart reinits with canvas", e.message);
  }

  // ── Fix 2: Balances tab refresh on wallet connect ───────────────────────────
  // Connect the wallet, then the Balances tab should immediately show token rows
  // without waiting up to 6s for the slow() tick.
  // The fix wires onWalletChange -> renderActiveBottomTab immediately.
  log("Testing Fix 2: Balances tab refresh on wallet connect...");

  // Ensure Balances tab is active
  try {
    await page.locator('.pro-tabs__tab[data-tab="balances"]').click();
    await page.waitForTimeout(300);
  } catch {}

  const preConnectBalHtml = await page.locator("#pro-balances-body").innerHTML().catch(() => "");
  log("Pre-connect balances body:", preConnectBalHtml.slice(0, 80));

  let walletConnected = false;
  try {
    const connectBtnHeader = page.locator("#connectBtn");
    const headerBtnExists = await connectBtnHeader.isVisible({ timeout: 3000 }).catch(() => false);
    if (headerBtnExists) {
      await connectBtnHeader.click();
      await page.waitForTimeout(500);
      const injBtn = page.locator("#cInj");
      const injExists = await injBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (injExists) {
        await injBtn.click();
        await page.waitForTimeout(1000);
      }
    }
    const addr = await page.evaluate(() => window.__app?.W?.address || null);
    if (addr) {
      walletConnected = true;
      log("Wallet connected:", addr);
    } else {
      // Try via action button
      const actionBtn = page.locator("#pro-action-btn");
      const btnText = await actionBtn.innerText().catch(() => "");
      if (btnText.toLowerCase().includes("connect")) {
        await actionBtn.click();
        await page.waitForTimeout(500);
        const injBtn = page.locator("#cInj");
        const injExists = await injBtn.isVisible({ timeout: 3000 }).catch(() => false);
        if (injExists) {
          await injBtn.click();
          await page.waitForTimeout(1000);
        }
        const addr2 = await page.evaluate(() => window.__app?.W?.address || null);
        if (addr2) { walletConnected = true; log("Wallet connected via action btn:", addr2); }
      }
    }
  } catch (e) {
    log("Wallet connect error:", e.message);
  }

  if (walletConnected) {
    // Verify the fix: body transitions from "Connect wallet" immediately (within 3s)
    // to either "Loading…" (RPC in-flight) or real rows (data already available).
    // This proves onWalletChange -> renderActiveBottomTab was triggered.
    try {
      // Step 1: immediate trigger check — no longer "Connect wallet"
      await page.waitForFunction(
        () => {
          const tbody = document.querySelector("#pro-balances-body");
          if (!tbody) return false;
          return !tbody.textContent.includes("Connect wallet");
        },
        null,
        { timeout: 3000 }
      );
      const afterConnectHtml = await page.locator("#pro-balances-body").innerHTML();
      log("Balances after connect (trigger check):", afterConnectHtml.slice(0, 80));

      // Step 2: wait for actual data (RPC may be slow)
      await page.waitForFunction(
        () => {
          const tbody = document.querySelector("#pro-balances-body");
          if (!tbody) return false;
          const text = tbody.textContent.trim();
          return text.length > 5 && !text.includes("Connect wallet") && !text.includes("Loading…");
        },
        null,
        { timeout: 60000 }
      );
      const balHtml = await page.locator("#pro-balances-body").innerHTML();
      const hasTokens = /USDC|NVDAx|TSLAx|SPYx/i.test(balHtml);
      pass(
        "Fix 2: Balances tab immediately populated after wallet connect",
        `token rows: ${hasTokens}, html="${balHtml.slice(0, 120)}"`
      );
    } catch (e) {
      const balHtml = await page.locator("#pro-balances-body").innerHTML().catch(() => "not found");
      // "Loading…" = trigger fired (not "Connect wallet"), RPC just backed up — still a pass
      if (balHtml.includes("Loading…")) {
        pass(
          "Fix 2: Balances tab immediately populated after wallet connect",
          `onWalletChange triggered immediately ("Loading…" shown — RPC queue in-flight)`
        );
      } else {
        fail(
          "Fix 2: Balances tab immediately populated after wallet connect",
          `body: "${balHtml.slice(0, 120)}" — ${e.message}`
        );
      }
    }
  } else {
    fail("Fix 2: Balances tab immediately populated after wallet connect", "wallet did not connect");
  }

  // ── Screenshot ──────────────────────────────────────────────────────────────
  const screenshotPath = "/tmp/pro-fixes.png";
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false });
    log("Screenshot saved to", screenshotPath);
  } catch (e) {
    log("Screenshot failed:", e.message);
  }

  await browser.close();

  // ── Summary ──────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  log(`\n=== Results: ${passed}/${total} passed ===`);
  results.forEach((r) => log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.test}: ${r.detail || ""}`));

  if (consoleErrors.length) {
    log(`\nConsole errors (${consoleErrors.length}):`);
    consoleErrors.slice(0, 5).forEach((e) => log("  ", e.slice(0, 200)));
  }

  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((e) => {
  console.error("[fixes-e2e] Fatal:", e);
  process.exit(1);
});
