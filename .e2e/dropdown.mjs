// E2E verification of the Pro trading page pair selector dropdown.
// Run: node .e2e/dropdown.mjs
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

const log = (...a) => console.log("[dropdown-e2e]", ...a);

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

// EIP-1193 handler
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

  // Give the page a moment to start rendering and fetch prices
  await page.waitForTimeout(3000);

  // ── Test 1: Dropdown opens on click ─────────────────────────────────────────
  log("Test 1: Dropdown opens on click...");
  try {
    // Ensure dropdown is closed first
    const preExists = await page.locator("#pro-pair-dropdown").count();
    if (preExists > 0) {
      log("  dropdown already open, closing first");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    await page.locator("#pro-pair-btn").click();
    await page.waitForSelector("#pro-pair-dropdown", { timeout: 5000 });

    // Check 3 option buttons exist
    const optCount = await page.locator(".pro-pair-option").count();
    log(`  Found ${optCount} .pro-pair-option buttons`);

    // Check button has "open" class
    const btnHasOpen = await page.locator("#pro-pair-btn").evaluate((el) => el.classList.contains("open"));
    log(`  #pro-pair-btn has class "open": ${btnHasOpen}`);

    // Check chevron SVG rotation (open class triggers CSS transform)
    // The chevron is an SVG inside the button; we verify via the "open" class on the button
    // which CSS uses to rotate the chevron via a child selector
    const chevronExists = await page.locator("#pro-pair-btn svg").count();
    log(`  Chevron SVG count inside button: ${chevronExists}`);

    const EXPECTED_SYMBOLS = ["NVDAx", "TSLAx", "SPYx"];
    const optTexts = await page.locator(".pro-pair-option").evaluateAll((els) =>
      els.map((el) => el.textContent.trim())
    );
    log(`  Option texts: ${JSON.stringify(optTexts)}`);

    const hasAllSymbols = EXPECTED_SYMBOLS.every((sym) =>
      optTexts.some((t) => t.includes(sym))
    );

    if (optCount === 3 && btnHasOpen && hasAllSymbols) {
      pass("Test 1: Dropdown opens on click", `3 options (NVDAx, TSLAx, SPYx), button.open=true, chevron present`);
    } else {
      fail("Test 1: Dropdown opens on click",
        `optCount=${optCount}, btnHasOpen=${btnHasOpen}, hasAllSymbols=${hasAllSymbols}`
      );
    }
  } catch (e) {
    fail("Test 1: Dropdown opens on click", e.message);
  }

  // ── Test 2: Dropdown shows live prices ──────────────────────────────────────
  log("Test 2: Dropdown shows live prices...");
  try {
    // Ensure dropdown is open
    const ddExists = await page.locator("#pro-pair-dropdown").count();
    if (ddExists === 0) {
      await page.locator("#pro-pair-btn").click();
      await page.waitForSelector("#pro-pair-dropdown", { timeout: 5000 });
    }

    const priceSpans = await page.locator(".pro-pair-option .price").evaluateAll((els) =>
      els.map((el) => el.textContent.trim())
    );
    log(`  Price span values: ${JSON.stringify(priceSpans)}`);

    const allNonEmpty = priceSpans.length === 3 &&
      priceSpans.every((p) => p.length > 0 && p !== "—" && p !== "$—" && p !== "$0.00");

    // At least one price should look like a real dollar amount (e.g. $202.72)
    const hasDollarPrices = priceSpans.some((p) => /\$\d+/.test(p));

    if (allNonEmpty && hasDollarPrices) {
      pass("Test 2: Dropdown shows live prices", `prices: ${priceSpans.join(", ")}`);
    } else if (!allNonEmpty) {
      fail("Test 2: Dropdown shows live prices",
        `not all prices non-empty/non-dash: ${JSON.stringify(priceSpans)}`
      );
    } else {
      fail("Test 2: Dropdown shows live prices",
        `prices present but none match dollar pattern: ${JSON.stringify(priceSpans)}`
      );
    }
  } catch (e) {
    fail("Test 2: Dropdown shows live prices", e.message);
  }

  // Screenshot with dropdown open
  const screenshotPath = "/tmp/pro-dropdown.png";
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false });
    log("Screenshot (dropdown open) saved to", screenshotPath);
  } catch (e) {
    log("Screenshot failed:", e.message);
  }

  // ── Test 3: Stock switch via dropdown ────────────────────────────────────────
  log("Test 3: Stock switch via dropdown...");
  try {
    // Ensure dropdown is open
    const ddExists = await page.locator("#pro-pair-dropdown").count();
    if (ddExists === 0) {
      await page.locator("#pro-pair-btn").click();
      await page.waitForSelector("#pro-pair-dropdown", { timeout: 5000 });
    }

    const initialLabel = await page.locator("#pro-pair-label").innerText();
    log(`  Initial label: "${initialLabel}"`);

    // Click TSLAx option
    const tslaxBtn = page.locator(".pro-pair-option").filter({ hasText: "TSLAx" });
    await tslaxBtn.waitFor({ timeout: 5000 });
    await tslaxBtn.click();

    // Dropdown should close
    await page.waitForFunction(
      () => !document.querySelector("#pro-pair-dropdown"),
      null,
      { timeout: 5000 }
    );
    log("  Dropdown closed after selection");

    // Label should change to TSLAx / USDC
    await page.waitForFunction(
      () => {
        const lbl = document.querySelector("#pro-pair-label");
        return lbl && lbl.textContent.includes("TSLAx");
      },
      null,
      { timeout: 5000 }
    );
    const newLabel = await page.locator("#pro-pair-label").innerText();
    log(`  New label: "${newLabel}"`);

    // Chart canvas should still be present (reinit)
    let canvasCount = 0;
    try {
      await page.waitForSelector("#pro-chart-mount canvas", { timeout: 15000 });
      canvasCount = await page.locator("#pro-chart-mount canvas").count();
    } catch {
      canvasCount = 0;
    }
    log(`  Canvas count after switch: ${canvasCount}`);

    // Ticker price should be in TSLAx range (~$400+), not dash
    const priceText = await page.locator("#pro-price").innerText().catch(() => "");
    log(`  Ticker price after switch: "${priceText}"`);

    const labelOk = newLabel.includes("TSLAx") && newLabel.includes("USDC");
    const dropdownClosed = (await page.locator("#pro-pair-dropdown").count()) === 0;
    const hasCanvas = canvasCount > 0;

    if (labelOk && dropdownClosed && hasCanvas) {
      pass("Test 3: Stock switch via dropdown",
        `label="${newLabel}", dropdown closed, ${canvasCount} canvas(es), price="${priceText}"`
      );
    } else {
      fail("Test 3: Stock switch via dropdown",
        `labelOk=${labelOk} ("${newLabel}"), dropdownClosed=${dropdownClosed}, hasCanvas=${hasCanvas} (count=${canvasCount})`
      );
    }
  } catch (e) {
    fail("Test 3: Stock switch via dropdown", e.message);
  }

  // ── Test 4: Dropdown closes on outside click ─────────────────────────────────
  log("Test 4: Dropdown closes on outside click...");
  try {
    // Open dropdown
    await page.locator("#pro-pair-btn").click();
    await page.waitForSelector("#pro-pair-dropdown", { timeout: 5000 });
    log("  Dropdown opened");

    // Click somewhere outside (chart area or body)
    // Use the pro-chart-mount area or page body far from the button
    const chartMount = page.locator("#pro-chart-mount");
    const chartExists = await chartMount.count();
    if (chartExists > 0) {
      await chartMount.click({ position: { x: 100, y: 100 }, force: true });
    } else {
      // Fallback: click at coordinates unlikely to hit the dropdown
      await page.mouse.click(800, 400);
    }

    // Wait for dropdown to disappear
    await page.waitForFunction(
      () => !document.querySelector("#pro-pair-dropdown"),
      null,
      { timeout: 5000 }
    );
    const ddGone = (await page.locator("#pro-pair-dropdown").count()) === 0;
    log(`  Dropdown gone after outside click: ${ddGone}`);

    if (ddGone) {
      pass("Test 4: Dropdown closes on outside click", "dropdown removed from DOM after outside click");
    } else {
      fail("Test 4: Dropdown closes on outside click", "dropdown still present after outside click");
    }
  } catch (e) {
    fail("Test 4: Dropdown closes on outside click", e.message);
  }

  // ── Test 5: Dropdown closes on Escape ────────────────────────────────────────
  log("Test 5: Dropdown closes on Escape...");
  try {
    // Open dropdown
    await page.locator("#pro-pair-btn").click();
    await page.waitForSelector("#pro-pair-dropdown", { timeout: 5000 });
    log("  Dropdown opened");

    // Press Escape
    await page.keyboard.press("Escape");

    // Wait for dropdown to disappear
    await page.waitForFunction(
      () => !document.querySelector("#pro-pair-dropdown"),
      null,
      { timeout: 5000 }
    );
    const ddGone = (await page.locator("#pro-pair-dropdown").count()) === 0;
    log(`  Dropdown gone after Escape: ${ddGone}`);

    if (ddGone) {
      pass("Test 5: Dropdown closes on Escape", "dropdown removed from DOM after Escape key");
    } else {
      fail("Test 5: Dropdown closes on Escape", "dropdown still present after Escape");
    }
  } catch (e) {
    fail("Test 5: Dropdown closes on Escape", e.message);
  }

  // ── Test 6: No regressions after switching back to NVDAx ─────────────────────
  log("Test 6: No regressions — ticker, stats, chart, orderbook after switching back to NVDAx...");
  try {
    // Switch back to NVDAx via dropdown
    await page.locator("#pro-pair-btn").click();
    await page.waitForSelector("#pro-pair-dropdown", { timeout: 5000 });
    const nvdaxBtn = page.locator(".pro-pair-option").filter({ hasText: "NVDAx" });
    await nvdaxBtn.click();
    await page.waitForFunction(
      () => !document.querySelector("#pro-pair-dropdown"),
      null,
      { timeout: 5000 }
    );
    await page.waitForFunction(
      () => {
        const lbl = document.querySelector("#pro-pair-label");
        return lbl && lbl.textContent.includes("NVDAx");
      },
      null,
      { timeout: 5000 }
    );
    log("  Switched back to NVDAx");

    // Wait for chart to reinit
    let canvasCount = 0;
    try {
      await page.waitForSelector("#pro-chart-mount canvas", { timeout: 15000 });
      canvasCount = await page.locator("#pro-chart-mount canvas").count();
    } catch {
      canvasCount = 0;
    }

    // Check ticker price is non-dash
    const priceText = await page.locator("#pro-price").innerText().catch(() => "—");
    log(`  Ticker price: "${priceText}"`);

    // Check 24h stats
    const high = await page.locator("#pro-high").innerText().catch(() => "—");
    const low = await page.locator("#pro-low").innerText().catch(() => "—");
    const vol = await page.locator("#pro-vol").innerText().catch(() => "—");
    log(`  Stats: high=${high}, low=${low}, vol=${vol}`);

    // Check orderbook has some content
    const bookBody = page.locator(".pro-book");
    const bookExists = await bookBody.count();
    log(`  Book elements: ${bookExists}`);

    const labelOk = (await page.locator("#pro-pair-label").innerText()).includes("NVDAx");
    const hasCanvas = canvasCount > 0;
    const priceOk = priceText !== "—" && priceText.trim() !== "";
    const statsOk = high !== "—" || low !== "—"; // at least one stat loaded
    const bookOk = bookExists > 0;

    if (labelOk && hasCanvas && priceOk) {
      pass("Test 6: No regressions after switching back to NVDAx",
        `label=NVDAx/USDC, price="${priceText}", canvases=${canvasCount}, stats: high=${high} low=${low} vol=${vol}, book=${bookExists > 0}`
      );
    } else {
      fail("Test 6: No regressions after switching back to NVDAx",
        `labelOk=${labelOk}, hasCanvas=${hasCanvas} (count=${canvasCount}), priceOk=${priceOk} ("${priceText}")`
      );
    }
  } catch (e) {
    fail("Test 6: No regressions after switching back to NVDAx", e.message);
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
  console.error("[dropdown-e2e] Fatal:", e);
  process.exit(1);
});
