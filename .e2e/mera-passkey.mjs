// E2E: Mera passkey accounts on the local chain, with a Chrome virtual authenticator that does PRF.
//
// connect → Passkey → Create account → address shown → Test funds → buy 1 Upside in Pro
// → export recovery phrase (same address) → disconnect → connect → Passkey signs straight back in → same address.
//
// Needs a full local stack: chain + deploy (deployments/localhost.json) + backend + web.
// Run: WEB_URL=http://localhost:5273 node .e2e/mera-passkey.mjs
//      (SHOTS=<dir> saves screenshots)
import { chromium } from "playwright";
import { ethers } from "ethers";
import fs from "node:fs";

const WEB = process.env.WEB_URL || "http://localhost:5173";
const SHOTS = process.env.SHOTS || "";
const dep = JSON.parse(fs.readFileSync(new URL("../deployments/localhost.json", import.meta.url)));
const provider = new ethers.JsonRpcProvider(dep.rpc, 31337, { staticNetwork: true });
const erc20 = (a) => new ethers.Contract(a, ["function balanceOf(address) view returns (uint256)"], provider);
const proto = new ethers.Contract(dep.protocol, ["function seriesCount() view returns (uint256)", "function getSeries(uint256) view returns (address underlying, uint256 expiry, uint8 kind, uint256 strike, uint256 strike2, address token, bool settled)"], provider);

const log = (...a) => console.log("[mera-e2e]", ...a);
let passed = 0, total = 0;
function check(label, ok, detail = "") {
  total++;
  if (ok) { passed++; log(`  ✓ ${label}${detail ? " — " + detail : ""}`); }
  else { log(`  ✗ FAIL ${label}${detail ? " — " + detail : ""}`); process.exitCode = 1; }
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const toastSays = (page, re, timeout = 90_000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#toast")?.textContent || ""), re.source, { timeout })
  .catch(async (e) => { throw new Error(`toast never said ${re}; last toast: "${await page.textContent("#toast")}"`, { cause: e }); });

async function optionBalances(addr) {
  const n = Number(await proto.seriesCount());
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = await proto.getSeries(i);
    const b = await erc20(s.token).balanceOf(addr);
    if (b > 0n) out.push({ id: i, kind: Number(s.kind), bal: b });
  }
  return out;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("  pageerror:", e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && log("  console:", m.text().slice(0, 300)));
  const failed = new Set();
  page.on("requestfailed", (r) => failed.add(new URL(r.url()).origin));

  // Virtual authenticator with PRF, user-verified, resident keys.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  log("virtual authenticator", authenticatorId, "· browser", browser.version());

  await page.goto(`${WEB}/#pro`);
  await page.waitForSelector("#connectBtn", { timeout: 30_000 });
  await page.waitForFunction(() => window.__app, null, { timeout: 30_000 }); // app finished booting

  // 1. connect → Passkey (hero) → Create account
  await page.click("#connectBtn");
  await page.waitForSelector("#cPasskey");
  check("Passkey is the hero option on chain 31337", (await page.locator(".connect-modal .passkey-hero").count()) === 1);
  check("JAW option hidden on a non-JAW chain", (await page.locator("#cJaw").count()) === 0);
  await shot(page, "1-connect");
  await page.click("#cPasskey");
  await page.waitForSelector("#mCreate");
  await shot(page, "2-choose");
  await page.click("#mCreate");
  await page.waitForSelector(".pk-stage--ready", { timeout: 30_000 });
  await shot(page, "3-ready");
  const addr = await page.evaluate(() => window.__app.W.address);
  const kind = await page.evaluate(() => window.__app.W.kind);
  check("signed in as a Mera account", kind === "mera" && ethers.isAddress(addr), `${kind} ${addr}`);
  await page.waitForSelector("#modal", { state: "hidden", timeout: 5000 });
  const pill = await page.textContent("#acctBtn");
  check("account pill shows address, Passkey badge and balance", pill.includes(addr.slice(0, 6)) && /passkey/i.test(pill) && /ETH/.test(pill), pill.replace(/\s+/g, " ").trim());
  check("pill has an identicon", (await page.locator("#acctBtn svg.identicon").count()) === 1);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("wknd.mera.credential")));
  check("localStorage holds credential metadata only", Object.keys(stored).every((k) => ["credentialId", "transports", "address"].includes(k)) && stored.address === addr, Object.keys(stored).join(","));
  const creds = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
  check("one resident passkey on the authenticator", creds.length === 1 && creds[0].isResidentCredential, `rpId ${creds[0]?.rpId}`);
  check("fresh account starts with 0 gas", (await provider.getBalance(addr)) === 0n);

  // 2. Test funds: 1 ETH gas from the deployer + mints, signed by the passkey account
  await page.click("#acctBtn"); await page.click("#faucetBtn"); // Test funds lives in the account menu
  await toastSays(page, /Minting test funds done/);
  const eth = await provider.getBalance(addr);
  const usdc = await erc20(dep.usdc).balanceOf(addr);
  check("Test funds sent gas", eth > ethers.parseEther("0.9"), `${ethers.formatEther(eth)} ETH`);
  check("Test funds minted USDC via a Mera-signed tx", usdc === 100_000n * 10n ** 6n, `${ethers.formatUnits(usdc, 6)} USDC`);
  await shot(page, "4-funded");

  // 3. Buy 1 Upside in Pro (the simple ticket: Upside, size 1)
  await page.waitForSelector(".pro-pick__kind[data-kind='0']", { timeout: 60_000 });
  await page.click(".pro-pick__kind[data-kind='0']");
  await page.waitForSelector(".pro-pick__size[data-n='1']:not([disabled])", { timeout: 60_000 });
  await page.click(".pro-pick__size[data-n='1']");
  await page.waitForFunction(() => /^Buy 1 /.test(document.querySelector("#pro-action-btn")?.textContent || "") && !document.querySelector("#pro-action-btn").disabled, null, { timeout: 60_000 });
  await page.click("#pro-action-btn");
  await page.waitForSelector("#modal .pro-receipt", { timeout: 90_000 }); // the "Trade placed" popup
  await page.click("#pro-receipt-done");
  const opts = await optionBalances(addr);
  check("holds exactly 1 Upside option", opts.length === 1 && opts[0].kind === 0 && opts[0].bal === 10n ** 18n, JSON.stringify(opts.map((o) => ({ id: o.id, kind: o.kind, bal: ethers.formatEther(o.bal) }))));
  const usdcAfter = await erc20(dep.usdc).balanceOf(addr);
  check("premium paid in USDC", usdcAfter < usdc, `paid ${ethers.formatUnits(usdc - usdcAfter, 6)} USDC`);
  await shot(page, "5-bought");

  // 4. Export recovery phrase → same address in any BIP-44 wallet
  await page.click("#acctBtn");
  await page.waitForSelector("#acctMenu:not([hidden])");
  await page.waitForTimeout(300); // let the menu finish its entrance before the screenshot
  await shot(page, "6-menu");
  await page.click("#exportBtn");
  await page.waitForSelector("#xConfirm");
  await page.click("#xConfirm");
  await page.waitForSelector("#phrase li", { timeout: 30_000 });
  const words = await page.$$eval("#phrase li", (lis) => lis.map((l) => l.textContent.trim()));
  await shot(page, "7-phrase");
  const imported = ethers.HDNodeWallet.fromPhrase(words.join(" "), undefined, "m/44'/60'/0'/0/0").address;
  check("recovery phrase is 24 words and imports as the same address", words.length === 24 && imported === addr, imported);
  await page.click("#xDone");

  // 5. disconnect → connect → Passkey signs straight back in
  await page.click("#acctBtn"); await page.click("#menuDisc"); // Disconnect lives in the account menu
  await page.waitForSelector("#connectBtn");
  check("disconnected", (await page.evaluate(() => window.__app.W.address)) === null);
  await page.click("#connectBtn");
  await page.waitForSelector("#cPasskey");
  const hero = await page.textContent("#cPasskey");
  check("connect modal offers to continue as the stored account", hero.includes(addr.slice(0, 6)), hero.replace(/\s+/g, " ").trim());
  await shot(page, "8-return");
  await page.click("#cPasskey");
  await page.waitForSelector(".pk-stage--ready", { timeout: 30_000 });
  check("no Create/Use-existing choice on return (went straight to the prompt)", (await page.locator("#mCreate").count()) === 0);
  const addr2 = await page.evaluate(() => window.__app.W.address);
  check("same address after signing back in", addr2 === addr, addr2);
  check("still holds the Upside after sign-in", (await optionBalances(addr2)).length === 1);

  // 6. A passkey manager without PRF gets plain copy and a Retry, not a stack trace.
  await page.click("#acctBtn"); await page.click("#menuDisc"); // Disconnect lives in the account menu
  await page.evaluate(() => localStorage.removeItem("wknd.mera.credential"));
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: false, automaticPresenceSimulation: true },
  });
  await page.click("#connectBtn");
  await page.click("#cPasskey");
  await page.click("#mCreate");
  await page.waitForSelector(".pk-stage--error", { timeout: 30_000 });
  const errText = await page.textContent(".pk-stage--error");
  check("no-PRF authenticator shows the PRF_UNAVAILABLE copy with Retry", /Google Password Manager/.test(errText) && (await page.locator("#mRetry").count()) === 1, errText.replace(/\s+/g, " ").trim().slice(0, 90));
  check("still signed out after the failed ceremony", (await page.evaluate(() => window.__app.W.address)) === null);
  await shot(page, "9-error");
  await page.click("#mClose");

  // Mobile layout of the modal, for the record.
  if (SHOTS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click("#connectBtn");
    await page.waitForSelector("#cPasskey");
    await shot(page, "10-mobile-connect");
  }

  await browser.close();
  if (failed.size) log("  (failed request origins:", [...failed].join(", ") + ")");
  log(`${passed}/${total} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
