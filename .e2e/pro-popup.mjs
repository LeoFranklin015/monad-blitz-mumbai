// Trade-placed popup in Pro: buy from the ticket, the popup shows the receipt and "What you might get on Monday".
// Uses a fake injected wallet: reads go to the real chain (so quotes and balances are real), writes are NOT sent;
// the wallet answers eth_sendTransaction with a made-up hash and a successful receipt. Nothing is spent.
//   WEB_URL=http://localhost:5173 RPC_URL=https://monad-testnet.drpc.org node .e2e/pro-popup.mjs
import { chromium } from "playwright";
import { ethers } from "ethers";

const WEB = process.env.WEB_URL || "http://localhost:5173";
const RPC = process.env.RPC_URL || "https://monad-testnet.drpc.org";
const ACCOUNT = process.env.ACCOUNT || "0xd25fF8Fb969AE5a4eA7084C5b7e410dF560ae57D"; // a wallet holding Kuru USDC (read only)
const provider = new ethers.JsonRpcProvider(RPC, 10143, { staticNetwork: true, batchMaxCount: 1 });
const log = (...a) => console.log("[pro-popup]", ...a);
let failed = 0;
const check = (ok, msg) => { log(ok ? "ok  " : "FAIL", msg); if (!ok) failed++; };

const sent = [];
const batches = []; // EIP-5792 wallet_sendCalls requests
const BATCH = process.env.BATCH !== "0"; // BATCH=0: a wallet without atomic batching (falls back to one tx per call)
let fakeNonce = 0;
async function wallet(method, params = []) {
  switch (method) {
    case "eth_requestAccounts": case "eth_accounts": return [ACCOUNT];
    case "eth_chainId": return "0x279f";
    case "net_version": return "10143";
    case "wallet_switchEthereumChain": return null;
    case "wallet_getCapabilities":
      if (!BATCH) throw { code: -32601, message: "Method not supported" };
      return { "0x279f": { atomic: { status: "ready" } } }; // MetaMask: EIP-7702 upgrade offered in the same prompt
    case "wallet_sendCalls": {
      if (!BATCH) throw { code: -32601, message: "Method not supported" };
      const id = "0x" + (batches.length + 1).toString(16).padStart(64, "0");
      batches.push({ id, ...params[0] });
      return { id };
    }
    case "wallet_getCallsStatus": {
      const b = batches.find((x) => x.id === params[0]);
      const head = await provider.getBlockNumber();
      return { version: "2.0.0", id: b.id, chainId: "0x279f", atomic: true, status: 200, receipts: [{ transactionHash: ethers.keccak256(ethers.toUtf8Bytes(b.id)), status: "0x1", blockNumber: ethers.toQuantity(head), logs: [], gasUsed: "0x30000" }] };
    }
    case "eth_sendTransaction": {
      const hash = ethers.keccak256(ethers.toUtf8Bytes(`fake-${Date.now()}-${sent.length}`));
      sent.push({ hash, ...params[0] });
      return hash;
    }
    case "eth_getTransactionByHash": {
      const t = sent.find((x) => x.hash === params[0]);
      if (!t) return provider.send(method, params);
      const head = await provider.getBlockNumber();
      return { hash: t.hash, from: ACCOUNT, to: t.to, input: t.data || "0x", value: t.value || "0x0", nonce: ethers.toQuantity(fakeNonce++), gas: "0x100000", gasPrice: "0x3b9aca00", chainId: "0x279f", type: "0x0", blockNumber: ethers.toQuantity(head), blockHash: ethers.ZeroHash, transactionIndex: "0x0", v: "0x1b", r: "0x" + "1".repeat(64), s: "0x" + "2".repeat(64) };
    }
    case "eth_getTransactionReceipt": {
      const t = sent.find((x) => x.hash === params[0]);
      if (!t) return provider.send(method, params);
      const head = await provider.getBlockNumber();
      return { transactionHash: t.hash, from: ACCOUNT, to: t.to, status: "0x1", blockNumber: ethers.toQuantity(head), blockHash: ethers.ZeroHash, transactionIndex: "0x0", logs: [], logsBloom: "0x" + "0".repeat(512), gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", contractAddress: null, type: "0x0" };
    }
    default: return provider.send(method, params);
  }
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.exposeFunction("__wallet", async (method, params) => {
    try { return { result: await wallet(method, params) }; } catch (e) { return { error: { code: e.code ?? -32603, message: e.shortMessage || e.message } }; }
  });
  await page.addInitScript(() => {
    window.ethereum = {
      isMetaMask: true,
      async request({ method, params }) { const r = await window.__wallet(method, params || []); if (r.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; } return r.result; },
      on() {}, removeListener() {},
    };
  });

  await page.goto(`${WEB}/#pro`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#pro-sim .pro-sim__head", { timeout: 60000 });
  await page.click("#pro-action-btn"); // "Connect to buy"
  await page.click("#cInj");
  await page.waitForFunction(() => /^Buy /.test(document.querySelector("#pro-action-btn")?.textContent || ""), null, { timeout: 60000 });
  const btn = (await page.textContent("#pro-action-btn")).trim();
  log("ticket:", btn);
  await page.click("#pro-action-btn");

  await page.waitForSelector("#modal .pro-receipt", { timeout: 90000 }).catch(async (e) => { log("toast:", await page.textContent("#toast").catch(() => "-"), "| sent:", sent.length, "| btn:", await page.textContent("#pro-action-btn")); throw e; });
  const rc = await page.$eval("#modal .pro-receipt", (e) => e.innerText);
  log("popup:", rc.replace(/\s+/g, " ").slice(0, 260));
  check(/Trade placed/i.test(rc), "popup says Trade placed");
  check(/Bought 0\.1/.test(rc), "popup shows the size bought (0.1)");
  check(/Liquidation\s*None/i.test(rc), "popup shows Liquidation: None");
  check(/What you might get on Monday/i.test(rc), "popup has the Monday simulator");
  check(/View transaction/.test(rc), "popup links to the transaction on the explorer");
  if (BATCH) {
    const calls = batches[0]?.calls || [];
    check(batches.length === 1 && sent.length === 0, `one batched confirmation: ${batches.length} wallet_sendCalls, ${sent.length} separate tx`);
    check(calls.length >= 1 && batches[0].atomicRequired === true, `batch is atomic with ${calls.length} call(s): ${calls.map((c) => c.data.slice(0, 10)).join(" + ")} (approve 0x095ea7b3 + buy)`);
  } else {
    check(batches.length === 0 && sent.length >= 1, `no batching support: fell back to ${sent.length} separate tx`);
  }

  // The simulator inside the popup reacts to the price.
  const worth = async () => page.$eval("#pro-receipt-sim", (e) => [...e.querySelectorAll(".pro-form__stat-row")].find((r) => r.querySelector(".k").textContent.trim() === "Worth").querySelector(".v").textContent);
  const w0 = await worth();
  await page.click("#pro-receipt-sim .pro-sim__chip:nth-child(5)"); // +10%
  await page.waitForTimeout(300);
  const w1 = await worth();
  check(w0 !== w1, `popup simulator updates: worth ${w0} -> ${w1} at +10%`);

  await page.mouse.click(8, 8); // a stray click outside the card
  await page.waitForTimeout(300);
  check(!(await page.$eval("#modal", (m) => m.hidden)), "a click outside does not close the popup");
  await page.screenshot({ path: process.env.SHOT || "/tmp/pro-popup.png" });
  await page.click("#pro-receipt-done");
  check(await page.$eval("#modal", (m) => m.hidden), "Done closes the popup");
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
} finally {
  await browser.close();
}
log(failed ? `${failed} FAILED` : "all checks passed");
process.exitCode = failed ? 1 : 0;
