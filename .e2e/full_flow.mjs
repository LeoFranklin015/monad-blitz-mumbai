// Comprehensive E2E test: Pro page UI audit + deposit→buy→withdraw full flow
// Tests 20 points across UI, balances, deposit/withdraw, market buy, and history tabs.
import { chromium } from "playwright";
import { ethers } from "ethers";
import fs from "node:fs";

const WEB = process.env.WEB_URL || "http://localhost:5173";
const RPC = "https://monad-testnet.drpc.org";
const PK = process.env.PRIVATE_KEY;
if (!PK) throw new Error("Set PRIVATE_KEY to a dedicated funded testnet account before running this test");
const CHAIN = 10143;

const dep = JSON.parse(fs.readFileSync(new URL("../deployments/monadTestnet.json", import.meta.url)));
const provider = new ethers.JsonRpcProvider(RPC, CHAIN, { staticNetwork: true, batchMaxCount: 5 });
const wallet = new ethers.Wallet(PK, provider);

const log = (...a) => console.log("[e2e]", ...a);
let passed = 0; let total = 0;
function check(label, ok, detail = "") {
  total++;
  if (ok) { passed++; log(`  ✓ ${label}${detail ? " — " + detail : ""}`); }
  else { log(`  ✗ FAIL ${label}${detail ? " — " + detail : ""}`); process.exitCode = 1; }
}

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
      log("    tx", sent.hash.slice(0, 12) + "…");
      const rc = await sent.wait();
      log("    mined block", rc.blockNumber, "status", rc.status);
      return sent.hash;
    }
    default:
      return provider.send(method, params);
  }
}

async function main() {
  // ── Pre-flight: check onchain balances ─────────────────────────────────
  const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];
  const PROTO_ABI = [
    "function freeBalance(address,address) view returns (uint256)",
    "function seriesCount() view returns (uint256)",
    "function getSeries(uint256) view returns (address underlying, uint256 expiry, uint8 kind, uint256 strike, uint256 strike2, address token, bool settled)",
  ];
  const usdcContract = new ethers.Contract(dep.usdc, USDC_ABI, provider);
  const proto = new ethers.Contract(dep.protocol, PROTO_ABI, provider);

  const [walletUsdc, depositedUsdc] = await Promise.all([
    usdcContract.balanceOf(wallet.address),
    proto.freeBalance(wallet.address, dep.usdc),
  ]);
  log("Wallet USDC:", ethers.formatUnits(walletUsdc, 6));
  log("Deposited USDC:", ethers.formatUnits(depositedUsdc, 6));
  const hasUsdc = walletUsdc > 0n || depositedUsdc > 0n;

  // ── Launch browser ──────────────────────────────────────────────────────
  const browser = await chromium.launch();
  const page = await browser.newPage();

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

  page.on("pageerror", (e) => log("pageerror:", e.message));
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  log("\n=== Loading Pro page ===");
  await page.goto(WEB + "/#pro", { waitUntil: "networkidle", timeout: 30000 });

  // ── 1. UI AUDIT ─────────────────────────────────────────────────────────
  log("\n--- 1. UI Audit ---");

  // 1a. App booted (no error card)
  const viewText = await page.locator("#view").innerText({ timeout: 10000 }).catch(() => "");
  check("App booted", !/No deployment|Can't reach the chain/i.test(viewText));

  // 1b. Ticker bar visible with pair button
  const pairBtn = await page.locator("#pro-pair-btn").count();
  check("Ticker pair button", pairBtn > 0);

  // 1c. Chart canvas rendered
  await page.waitForTimeout(2000); // let chart mount
  const canvasCount = await page.locator(".pro-chart__mount canvas").count();
  check("Chart canvas rendered", canvasCount > 0, `${canvasCount} canvas elements`);

  // 1d. Orderbook present
  const askRows = await page.locator(".pro-ob-row--ask").count();
  const bidRows = await page.locator(".pro-ob-row--bid").count();
  check("Orderbook has rows", askRows > 0 || bidRows > 0, `${askRows} asks, ${bidRows} bids`);

  // 1e. Order form Buy/Sell tabs
  const buyTab = await page.locator(".pro-form__side-tab--buy").count();
  const sellTab = await page.locator(".pro-form__side-tab--sell").count();
  check("Order form Buy/Sell tabs", buyTab > 0 && sellTab > 0);

  // 1f. Bottom tabs bar (4 tabs)
  const bottomTabs = await page.locator(".pro-tabs__tab").count();
  check("Bottom tabs (4)", bottomTabs >= 4, `found ${bottomTabs}`);

  // 1g. Market/Limit type tabs
  const typeTabs = await page.locator(".pro-form__type-tab").count();
  check("Market/Limit type tabs", typeTabs >= 2, `found ${typeTabs}`);

  // 1h. Ticker shows a price
  const tickerPrice = await page.locator(".pro-ticker__price").innerText().catch(() => "");
  check("Ticker price visible", /\$\d/.test(tickerPrice), tickerPrice);

  // 1i. Pair dropdown opens on click
  await page.locator("#pro-pair-btn").click();
  await page.waitForTimeout(300);
  const ddVisible = await page.locator("#pro-pair-dropdown").count();
  check("Pair dropdown opens", ddVisible > 0);
  const ddOptions = await page.locator(".pro-pair-option").count();
  check("Pair dropdown has 3 stocks", ddOptions === 3, `found ${ddOptions}`);
  // close dropdown
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ── 2. CONNECT WALLET ───────────────────────────────────────────────────
  log("\n--- 2. Connect wallet ---");
  await page.locator("#connectBtn").click();
  await page.waitForTimeout(500);
  await page.locator("#cInj").click();
  await page.waitForTimeout(1500);

  const acctText = await page.locator("#account").innerText().catch(() => "");
  check("Wallet connected", /0x0b8c|0x0B8C/i.test(acctText), acctText.slice(0, 40));

  // ── 3. BALANCES TAB ─────────────────────────────────────────────────────
  log("\n--- 3. Balances Tab ---");

  // Click Balances tab (should already be active, but click to refresh)
  await page.locator('.pro-tabs__tab[data-tab="balances"]').click();
  // Wait for the loading state to clear (balances loaded from chain)
  await page.waitForFunction(
    () => !/Loading|Connect wallet/i.test(document.querySelector("#pro-balances-body")?.textContent || ""),
    { timeout: 20000 }
  ).catch(() => {});
  await page.waitForTimeout(500);

  // Check Dep/Wd buttons appear
  const depBtns = await page.locator(".pro-dep-btn").count();
  const wdBtns = await page.locator(".pro-wd-btn").count();
  check("Dep buttons in balances", depBtns > 0, `found ${depBtns}`);
  check("Wd buttons in balances", wdBtns > 0, `found ${wdBtns}`);

  // USDC row present
  const balancesText = await page.locator("#pro-balances-body").innerText().catch(() => "");
  check("USDC row in balances", /USDC/.test(balancesText));

  // ── 4. WITHDRAW first (to get wallet USDC for deposit/buy test) ──────────
  log("\n--- 4. Withdraw Flow ---");

  async function waitForToast(page, triggerPattern, donePattern, timeoutMs = 90000) {
    await page.waitForFunction(
      (pat) => new RegExp(pat, 'i').test(document.querySelector("#toast")?.textContent || ""),
      triggerPattern, { timeout: timeoutMs }
    ).catch(() => {});
    await page.waitForFunction(
      (pat) => !new RegExp(pat, 'i').test(document.querySelector("#toast")?.textContent || ""),
      donePattern, { timeout: timeoutMs }
    ).catch(() => {});
    return page.locator("#toast").innerText().catch(() => "");
  }

  const beforeWd = await proto.freeBalance(wallet.address, dep.usdc);
  const beforeWalletUsdc = await usdcContract.balanceOf(wallet.address);
  await page.evaluate(() => { window.prompt = () => "100"; }); // withdraw 100 USDC
  await page.locator(".pro-wd-btn").first().click();
  const wdToast = await waitForToast(page, "done|Withdrawing|error", "Withdrawing");
  log("  Withdraw toast:", wdToast);
  await page.waitForTimeout(3000);
  const afterWd = await proto.freeBalance(wallet.address, dep.usdc);
  check("Withdraw reduces protocol freeBalance", afterWd < beforeWd,
    `before=${ethers.formatUnits(beforeWd, 6)} after=${ethers.formatUnits(afterWd, 6)}`);
  const afterWdWallet = await usdcContract.balanceOf(wallet.address);
  check("Withdraw increases wallet USDC", afterWdWallet > beforeWalletUsdc,
    `wallet before=${ethers.formatUnits(beforeWalletUsdc, 6)} after=${ethers.formatUnits(afterWdWallet, 6)}`);

  // ── 5. DEPOSIT FLOW ─────────────────────────────────────────────────────
  log("\n--- 5. Deposit Flow ---");

  const beforeDep = await proto.freeBalance(wallet.address, dep.usdc);
  await page.evaluate(() => { window.prompt = () => "50"; }); // deposit 50 USDC back
  // Refresh balances tab first
  await page.locator('.pro-tabs__tab[data-tab="balances"]').click();
  await page.waitForTimeout(1500);
  await page.locator(".pro-dep-btn").first().click();
  const depToast = await waitForToast(page, "done|Depositing|error", "Depositing");
  log("  Deposit toast:", depToast);
  await page.waitForTimeout(3000);
  const afterDep = await proto.freeBalance(wallet.address, dep.usdc);
  check("Deposit increases protocol freeBalance", afterDep > beforeDep,
    `before=${ethers.formatUnits(beforeDep, 6)} after=${ethers.formatUnits(afterDep, 6)}`);

  // ── 6. MARKET BUY OPTION ────────────────────────────────────────────────
  log("\n--- 6. Market Buy Option ---");

  // Clear the prompt override so buy doesn't accidentally trigger deposit/withdraw
  await page.evaluate(() => { delete window.prompt; });

  // Check wallet USDC after withdraw
  const walletUsdcNow = await usdcContract.balanceOf(wallet.address);
  log("  Wallet USDC now:", ethers.formatUnits(walletUsdcNow, 6));

  // Open series selector panel
  await page.locator(".pro-form__series").click();
  // Wait for the panel to appear (has kind chips)
  await page.waitForSelector(".pro-series-panel", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);

  // Select "Upside" kind
  const upsideChip = page.locator('.pro-series-panel .chip').filter({ hasText: /Upside/i }).first();
  if (await upsideChip.count() > 0) { await upsideChip.click(); await page.waitForTimeout(300); }

  // Select first expiry
  const expChips = page.locator(".pro-series-panel__expiry-chips .chip");
  if (await expChips.count() > 0) { await expChips.first().click(); await page.waitForTimeout(300); }

  // Wait for strike rows to appear
  await page.waitForSelector(".pro-strike-row", { timeout: 5000 }).catch(() => {});

  // Select LAST strike (cheapest for Upside = highest strike above spot)
  const strikeRows = page.locator(".pro-strike-row");
  const strikeCount = await strikeRows.count();
  if (strikeCount > 0) { await strikeRows.last().click(); await page.waitForTimeout(300); }
  check("Series selected", strikeCount > 0, `${strikeCount} strikes available`);

  // Make sure Buy tab is active
  await page.locator(".pro-form__side-tab--buy").click();
  const amtInput = page.locator(".pro-form__inputs input").first();
  await amtInput.fill("1");
  await page.waitForTimeout(500);

  const actionBtn = page.locator(".pro-form__action");
  const actionLabel = await actionBtn.innerText().catch(() => "");
  log("  Action button:", actionLabel);

  if (/No series|Select/i.test(actionLabel)) {
    check("Buy option from orderbook", false, "no series selected in form");
  } else if (await actionBtn.isDisabled()) {
    check("Buy option from orderbook", false, "button disabled — " + actionLabel);
  } else {
    await actionBtn.click();
    const buyToast = await waitForToast(page, "done|Buying|error|Failed|Cancelled", "Buying");
    log("  Buy toast:", buyToast);
    check("Buy option from orderbook", !/error|Failed|revert/i.test(buyToast), buyToast.slice(0, 60));
  }

  // ── 7. VERIFY BALANCES AFTER BUY ────────────────────────────────────────
  log("\n--- 7. Balances after buy ---");
  await page.locator('.pro-tabs__tab[data-tab="balances"]').click();
  await page.waitForTimeout(3000);
  const balAfter = await page.locator("#pro-balances-body").innerText().catch(() => "");
  check("Balances tab shows content after buy", balAfter.length > 20 && !/Connect wallet/i.test(balAfter));

  // ── 8. NO JS ERRORS ─────────────────────────────────────────────────────
  log("\n--- 8. No JS errors ---");
  // Filter benign errors: favicon, ResizeObserver, and backend 400 (backend not running in test)
  const critErrors = consoleErrors.filter(e => !/favicon|ResizeObserver|400 \(Bad Request\)|status of 400/i.test(e));
  check("No critical JS errors", critErrors.length === 0,
    critErrors.length > 0 ? critErrors[0].slice(0, 100) : "");

  // ── SUMMARY ─────────────────────────────────────────────────────────────
  log(`\n=== RESULT: ${passed}/${total} passed ===`);
  await browser.close();
}

main().catch((e) => { console.error("[e2e] Fatal:", e.message); process.exitCode = 1; });
