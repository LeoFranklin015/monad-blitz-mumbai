// Landing checks: `/` shows the landing (week strip, Kuru chart with three callouts, products, CTA),
// "Launch Pro" routes to #pro, there is no Trade nav button, old #trade links land in Pro,
// and the header pill counts live quotes. Full-page screenshots at desktop and mobile. No wallet needed.
//   WEB_URL=http://localhost:5173 SHOTS=/some/dir node .e2e/landing.mjs
import { chromium } from "playwright";

const WEB = process.env.WEB_URL || "http://localhost:5173";
const SHOTS = process.env.SHOTS || "/tmp";
const log = (...a) => console.log("[landing]", ...a);
let failed = 0;
const check = (ok, msg) => { log(ok ? "ok  " : "FAIL", msg); if (!ok) failed++; };

const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message + " @ " + (e.stack || "").split("\n").slice(1, 3).join(" ")));
  await page.goto(WEB + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".lp", { timeout: 30000 });
  check((await page.evaluate(() => location.hash)) === "#home", "lands on the landing (#home)");

  const h1 = (await page.textContent("#lp-h1")).replace(/\s+/g, " ").trim();
  check(h1 === "Nasdaq is open 32.5 hours a week. NVDAx trades all 168.", `headline: "${h1}"`);
  // Hero = live candlestick chart (lightweight-charts) with closed-market bands and the three callouts.
  await page.waitForFunction(() => document.querySelector("#lp-live")?.dataset.candles, null, { timeout: 30000 });
  const hero = await page.evaluate(() => {
    const live = document.querySelector("#lp-live"), r = live.getBoundingClientRect();
    return { candles: +live.dataset.candles, callouts: +live.dataset.callouts, canvases: live.querySelectorAll("#lp-mount canvas").length,
      bands: document.querySelectorAll("#lp-bands i").length, label: document.querySelector(".lp-live__label")?.textContent || "",
      top: r.top, bottom: r.bottom, vh: innerHeight };
  });
  check(hero.canvases > 0 && hero.candles >= 14, `hero chart drawn: ${hero.candles} real 1h candles on canvas`);
  check(hero.bands >= 4 && /Nasdaq closed/.test(hero.label) && /NVDAx still trades/.test(hero.label), `closed-market bands shaded: ${hero.bands}, labelled "${hero.label}"`);
  check(hero.callouts === 3, "three callout markers on the hero chart");
  check(hero.top < hero.vh && hero.bottom <= hero.vh + 1, `hero chart fully above the fold (${Math.round(hero.top)} to ${Math.round(hero.bottom)} of ${hero.vh}px)`);
  check((await page.$$(".lp-week, .lp-weekstats")).length === 0, "no week grid / stat tiles");

  const img = await page.waitForFunction(() => { const i = document.querySelector(".lp-chart img"); return i && i.complete && i.naturalWidth > 0 && i.getAttribute("src"); });
  check(!!(await img.jsonValue()), `chart image loaded (${await img.jsonValue()})`);
  check((await page.$$eval(".lp-mark", (e) => e.length)) === 3, "three callouts on the chart");
  const callouts = await page.$$eval(".lp-callouts li b", (e) => e.map((x) => x.textContent.trim()));
  check(callouts.join(" ") === "-1.4% ~12h -2.7%", `callout figures: ${callouts.join(", ")}`);
  check((await page.textContent(".lp-chart figcaption")).includes("NVDAx on Kuru, Oct 28 to Nov 1 2026"), "chart is labelled with its source and dates");

  check((await page.textContent(".lp-tbl")).includes("Liquidated"), "damage table shows the 40x liquidation");
  const products = await page.$$eval(".lp-prod a[data-product]", (e) => e.map((x) => x.dataset.product));
  check(products.join(",") === "Upside,Floor,Protect,Earn", `products: ${products.join(", ")}`);
  check((await page.$$eval(".lp-trace li", (e) => e.length)) === 5, "how-it-works trace has 5 steps");
  const tape = await page.textContent("#lp-tape");
  check(/NVDAx\s*\$\d/.test(tape), `live ticker shows NVDAx price (${tape.match(/NVDAx\s*\$[\d.,]+/)?.[0]})`);
  check((await page.textContent(".lp-foot")).includes("Built on Monad · Monad Blitz Mumbai"), "footer");
  const copy = await page.textContent(".lp");
  check(!copy.includes("—"), "no em dashes in landing copy");

  const nav = await page.$$eval("#nav button", (e) => e.map((b) => b.dataset.view));
  check(!nav.includes("trade") && nav[0] === "pro", `nav: ${nav.join(", ")} (no Trade, Pro first)`);
  await page.waitForFunction(() => /live quotes|paused|quotes\/s|offline/.test(document.querySelector("#qps")?.textContent || ""), null, { timeout: 15000 });
  log("header pill:", (await page.textContent("#qps")).trim());

  await page.screenshot({ path: `${SHOTS}/landing-1600.png`, fullPage: true });
  log("screenshot", `${SHOTS}/landing-1600.png`);

  await page.click('a[data-cta="launch"]');
  await page.waitForFunction(() => location.hash === "#pro", null, { timeout: 10000 });
  await page.waitForSelector(".pro-page", { timeout: 30000 });
  // Let Pro's first render finish: leaving mid-render makes pro.js write to nodes that are gone.
  await page.waitForFunction(() => !/Select a series/.test(document.querySelector("#pro-series-label")?.textContent || "Select a series"), null, { timeout: 60000 });
  check(true, "Launch Pro lands on #pro and Pro renders");

  await page.click(".brand");
  await page.waitForSelector(".lp", { timeout: 10000 });
  check((await page.evaluate(() => location.hash)) === "#home", "logo returns to the landing");

  await page.goto(WEB + "/#trade", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => location.hash === "#pro", null, { timeout: 30000 });
  check(true, "old #trade link lands on #pro");

  for (const v of ["earn", "protect", "portfolio"]) {
    await page.click(`#nav button[data-view="${v}"]`);
    await page.waitForTimeout(1500);
    if (v === "portfolio") check(!(await page.$("main.pro-shell")) && (await page.locator("#view .hero h2").count()) === 1, `${v} renders in the normal shell`);
    else check(!(await page.$("main.pro-shell")) && /Coming soon/i.test(await page.textContent("#view .soon__tag").catch(() => "")), `${v} shows its coming-soon page`);
  }

  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  m.on("pageerror", (e) => errors.push(e.message));
  await m.goto(WEB + "/", { waitUntil: "domcontentloaded" });
  await m.waitForSelector(".lp-chart img", { timeout: 30000 });
  await m.waitForFunction(() => document.querySelector(".lp-chart img").complete);
  await m.waitForTimeout(1200);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `mobile: no horizontal page scroll (overflow ${overflow}px)`);
  await m.screenshot({ path: `${SHOTS}/landing-390.png`, fullPage: true });
  log("screenshot", `${SHOTS}/landing-390.png`);
} finally {
  await browser.close();
}
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
