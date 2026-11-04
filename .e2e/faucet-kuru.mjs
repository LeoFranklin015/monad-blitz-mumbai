// "Test funds" on a real-token (Kuru) deployment: the button asks the backend faucet to send tokens.
// Fake injected wallet for connecting; the faucet call itself is real.
//   WEB_URL=http://localhost:5173 node .e2e/faucet-kuru.mjs
import { chromium } from "playwright";
const WEB = process.env.WEB_URL || "http://localhost:5173";
const ACCOUNT = process.env.ACCOUNT || "0x000000000000000000000000000000000000dEaD";
const log = (...a) => console.log("[faucet]", ...a);
let failed = 0; const check = (ok, m) => { log(ok ? "ok  " : "FAIL", m); if (!ok) failed++; };
const b = await chromium.launch();
try {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript((acct) => {
    window.ethereum = { isMetaMask: true, async request({ method }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [acct];
      if (method === "eth_chainId") return "0x279f";
      if (method === "wallet_switchEthereumChain") return null;
      throw Object.assign(new Error("not supported in this test"), { code: 4200 });
    }, on() {}, removeListener() {} };
  }, ACCOUNT);
  const calls = [];
  let sentTo = null;
  p.on("request", (r) => { if (r.url().includes("/faucet")) { calls.push(r.method()); try { sentTo = JSON.parse(r.postData() || "{}").address; } catch {} } });
  await p.goto(`${WEB}/#pro`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("#connectBtn", { timeout: 60000 }); await p.click("#connectBtn"); await p.click("#cInj");
  // Header: no market / quote pills, one account button with a menu (address, Test funds, Disconnect).
  check(!(await p.$("#mkt")) && !(await p.$("#qps")), "header has no market / live-quotes pills");
  await p.waitForSelector("#acctBtn", { timeout: 30000 });
  const btn = (await p.textContent("#acctBtn")).replace(/\s+/g, " ").trim();
  check(/0x0000…dEaD|0x0000\.\.\.dead/i.test(btn) || btn.toLowerCase().includes("dead"), `account button shows the address: ${btn}`);
  check(!(await p.$("#discBtn")), "no loose Disconnect button in the header");
  await p.click("#acctBtn");
  const items = await p.$$eval("#acctMenu .acct-menu__item span, #acctMenu .acct-menu__addr", (e) => e.map((x) => x.textContent.trim().slice(0, 20)));
  check(items.some((t) => /^0x/.test(t)) && items.includes("Test funds") && items.includes("Disconnect"), `menu: ${items.join(" | ")}`);
  await p.click("#faucetBtn");
  await p.waitForTimeout(8000);
  const toast = (await p.textContent("#toast").catch(() => "")) || "";
  check(calls.includes("POST"), `button POSTs to the backend faucet (${calls.join(",")})`);
  check(sentTo && sentTo.toLowerCase() === ACCOUNT.toLowerCase(), `funds go to the connected wallet: ${sentTo}`);
  check(/Sent:|faucet|test funds/i.test(toast), `user sees the result: "${toast.trim()}"`);
} finally { await b.close(); }
log(failed ? `${failed} FAILED` : "all checks passed"); process.exitCode = failed ? 1 : 0;
