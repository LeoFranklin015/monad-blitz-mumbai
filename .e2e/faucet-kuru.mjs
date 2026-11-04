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
  p.on("request", (r) => { if (r.url().includes("/faucet")) calls.push(r.method()); });
  await p.goto(`${WEB}/#pro`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("#connectBtn", { timeout: 60000 }); await p.click("#connectBtn"); await p.click("#cInj");
  await p.waitForSelector("#faucetBtn", { timeout: 30000 });
  check(true, `Test funds button shown on the Kuru deployment`);
  await p.click("#faucetBtn");
  await p.waitForTimeout(8000);
  const toast = (await p.textContent("#toast").catch(() => "")) || "";
  check(calls.includes("POST"), `button POSTs to the backend faucet (${calls.join(",")})`);
  check(/Sent:|faucet|test funds/i.test(toast), `user sees the result: "${toast.trim()}"`);
} finally { await b.close(); }
log(failed ? `${failed} FAILED` : "all checks passed"); process.exitCode = failed ? 1 : 0;
