// Pro view demo checks: the ticket defaults to 0.1, the auto-picked strike has asks, the "What you might get"
// simulator matches the contract's settlement math, and the chart hover shows the payout at the cursor's price.
// No wallet needed. Run against a running stack (web + backend):
//   WEB_URL=http://localhost:5173 node .e2e/pro-sim.mjs
import { chromium } from "playwright";

const WEB = process.env.WEB_URL || "http://localhost:5173";
const log = (...a) => console.log("[pro-sim]", ...a);
let failed = 0;
const check = (ok, msg) => { log(ok ? "ok  " : "FAIL", msg); if (!ok) failed++; };
const num = (t) => Number(String(t).replace(/[^0-9.\-−]/g, "").replace("−", "-"));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${WEB}/#pro`, { waitUntil: "domcontentloaded" });
  check((await page.inputValue("#pro-amt")) === "0.1", `ticket amount defaults to ${await page.inputValue("#pro-amt")}`);

  // The simple ticket: Upside / Floor, 2-3 strikes that have sellers, a few sizes, no expiry picker.
  await page.waitForSelector(".pro-pick__strike", { timeout: 60000 });
  const kinds = await page.$$eval(".pro-pick__kind b", (e) => e.map((x) => x.textContent.trim()));
  check(kinds.join(",") === "Upside,Floor", `only two products to pick: ${kinds.join(", ")}`);
  const strikes = await page.$$eval(".pro-pick__strike b", (e) => e.map((x) => x.textContent.trim()));
  check(strikes.length >= 1 && strikes.length <= 3, `2-3 strikes with sellers: ${strikes.join(" ")}`);
  check(await page.$eval("#pro-series-btn", (b) => b.hidden), "no expiry / series dropdown shown");
  const sizes = await page.$$eval(".pro-pick__size", (e) => e.map((x) => x.textContent.trim() + (x.disabled ? "(off)" : "")));
  check(sizes.length === 3, `size chips: ${sizes.join(" ")}`);
  await page.click(".pro-pick__kind[data-kind='1']");
  await page.waitForFunction(() => document.querySelector(".pro-pick__kind.on b")?.textContent.trim() === "Floor");
  await page.waitForTimeout(1500);
  const floorStrikes = await page.$$eval(".pro-pick__strike b", (e) => e.map((x) => x.textContent.trim()));
  check(true, `Floor strikes: ${floorStrikes.join(" ") || "(none with sellers)"}`);
  await page.click(".pro-pick__kind[data-kind='0']");
  await page.waitForTimeout(1500);

  // A series is auto-selected; the simulator card fills in once the quote is read.
  await page.waitForSelector("#pro-sim .pro-sim__head", { timeout: 60000 });
  const label = (await page.textContent(".pro-pick__strike.on b"))?.trim(); // e.g. "$205"
  const kind = (await page.textContent(".pro-pick__kind.on b"))?.trim();
  log(`selected: ${kind} ${label}`);
  check((await page.textContent("#pro-sim .pro-sim__head")).includes("What you might get"), "simulator card is shown");

  // Pick a Monday-open price 10% above the strike and check the payout against the contract's formula.
  const strike = num(label.match(/\$[\d.]+/)[0]);
  const P = Math.round(strike * 1.1 * 100) / 100;
  await page.fill("#pro-sim .pro-sim-px", String(P));
  await page.dispatchEvent("#pro-sim .pro-sim-px", "change");
  await page.waitForFunction((p) => Number(document.querySelector("#pro-sim .pro-sim-px")?.value) === p, P);
  const rows = await page.$$eval("#pro-sim .pro-form__stat-row", (els) => Object.fromEntries(els.map((e) => [e.querySelector(".k").textContent.trim(), e.querySelector(".v").textContent.trim()])));
  log("sim rows at", P, JSON.stringify(rows));
  const isUp = /upside/i.test(kind);
  const expectUsd = isUp ? (P - strike) * 0.1 : Math.max(0, strike - P) * 0.1;
  check(Math.abs(num(rows["Worth"]) - expectUsd) < 0.011, `worth ${rows["Worth"]} = 0.1 × ${isUp ? "(P − K)" : "max(0, K − P)"} = $${expectUsd.toFixed(2)}`);
  if (isUp) check(Math.abs(num(rows["You receive"]) - expectUsd / P) < 0.0002, `receive ${rows["You receive"]} = 0.1 × (P − K) / P = ${(expectUsd / P).toFixed(4)} shares`);
  check(rows["Break-even"] && num(rows["Break-even"]) > 0, `break-even ${rows["Break-even"]}`);
  const premKey = Object.keys(rows).find((k) => k.startsWith("Premium"));
  check(premKey && num(rows[premKey]) > 0, `${premKey}: ${rows[premKey]} (a real number, not —)`);
  check(rows["Profit / loss"] && rows["Profit / loss"] !== "—", `profit / loss ${rows["Profit / loss"]}`);
  check(num(rows["Break-even"]) !== strike, `break-even ${rows["Break-even"]} includes the premium (strike $${strike})`);
  const book = await page.textContent("#pro-asks");
  check(!/no asks/i.test(book), `auto-picked strike has asks on the book: ${book.replace(/\s+/g, " ").trim().slice(0, 60)}`);

  // Quick chips: "+5%" moves the price and redraws.
  await page.click(".pro-sim__chip:nth-child(4)");
  await page.waitForTimeout(400);
  check((await page.$$eval(".pro-sim__chip.on", (e) => e.length)) === 1, "a quick chip is selected after clicking +5%");

  // Chart hover shows the payout at the cursor's price.
  const box = await (await page.$("#pro-chart-mount")).boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35);
  await page.waitForTimeout(500);
  const hover = await page.$eval("#pro-hover", (e) => ({ hidden: e.hidden, text: e.innerText }));
  check(!hover.hidden && /settles Monday at/.test(hover.text), `chart hover: ${hover.text.replace(/\s+/g, " ").slice(0, 120)}`);

  // Clicking the chart sets the simulated price.
  const before = await page.inputValue("#pro-sim .pro-sim-px");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.2);
  await page.waitForTimeout(600);
  const after = await page.inputValue("#pro-sim .pro-sim-px");
  check(after !== before && Number(after) > 0, `clicking the chart set the price ${before} -> ${after}`);

  await page.screenshot({ path: process.env.SHOT || "/tmp/pro-sim.png" });
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
} finally {
  await browser.close();
}
log(failed ? `${failed} FAILED` : "all checks passed");
process.exitCode = failed ? 1 : 0;
