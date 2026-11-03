// Delta hedger for the bot makers (the HedgedMaker contract hedges itself inside each fill).
//
// Every tick it measures the bots' combined option delta per stock from chain state, compares it
// with the stock the hedge wallet already holds for hedging, and trades the difference once it
// exceeds HEDGE_THRESHOLD shares.
//
//   HEDGE_MODE=mockdex  local and testnets: swaps through the deployment's MockDex
//   HEDGE_MODE=kuru     Monad mainnet: Kuru Flow API (quote, then send the returned calldata)
//   HEDGE_MODE=off      no hedging
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { D, NETWORK, config, requireKey } from "../config.js";
import { contracts, signer, send, usdTo, shTo, shFrom, usdFrom, log } from "../lib/chain.js";
import { state, liveSeries } from "../lib/market.js";
import { metrics } from "../lib/obs.js";
import { netDelta } from "./makers.js";

const baselineFile = () => path.join(config.dataDir, `hedger-${NETWORK}-${D.protocol.toLowerCase()}.json`);

class KuruFlow {
  constructor(wallet) {
    this.wallet = wallet;
    this.jwt = null;
    this.jwtAt = 0;
  }
  async token() {
    if (this.jwt && Date.now() - this.jwtAt < 10 * 60_000) return this.jwt;
    const r = await fetch(`${config.kuruApi}/generate-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_address: await this.wallet.getAddress() }),
    });
    if (!r.ok) throw new Error(`kuru token ${r.status}`);
    const j = await r.json();
    this.jwt = j.token || j.jwt || j.access_token;
    this.jwtAt = Date.now();
    return this.jwt;
  }
  async swap(tokenIn, tokenOut, amountRaw, decimals) {
    const amount = process.env.KURU_AMOUNT_FORMAT === "raw" ? amountRaw.toString() : ethers.formatUnits(amountRaw, decimals);
    const r = await fetch(`${config.kuruApi}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await this.token()}` },
      body: JSON.stringify({
        userAddress: await this.wallet.getAddress(),
        tokenIn,
        tokenOut,
        amount,
        slippageTolerance: config.hedgeMaxSlippageBps / 100,
      }),
    });
    if (!r.ok) throw new Error(`kuru quote ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const q = await r.json();
    const t = q.transaction;
    if (!t?.to || !t?.calldata) throw new Error("kuru quote missing transaction");
    const erc = new ethers.Contract(tokenIn, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], this.wallet);
    if ((await erc.allowance(await this.wallet.getAddress(), t.to)) < amountRaw) {
      await send(this.wallet, "kuru approve", () => erc.approve(t.to, ethers.MaxUint256));
    }
    const data = t.calldata.startsWith("0x") ? t.calldata : "0x" + t.calldata;
    return send(this.wallet, "kuru swap", () => this.wallet.sendTransaction({ to: t.to, data, value: BigInt(t.value || 0) }));
  }
}

class MockDexVenue {
  constructor(wallet) {
    this.wallet = wallet;
    this.dex = contracts(wallet).dex;
    this.approved = new Set();
  }
  async swap(tokenIn, tokenOut, amountRaw) {
    if (!this.approved.has(tokenIn)) {
      const erc = contracts(this.wallet).stock(tokenIn);
      await send(this.wallet, "dex approve", () => erc.approve(D.dex, ethers.MaxUint256));
      this.approved.add(tokenIn);
    }
    const to = await this.wallet.getAddress();
    return send(this.wallet, "dex swap", () => this.dex.swapExactIn(tokenIn, tokenOut, amountRaw, 0, to));
  }
}

export async function startHedger(makers) {
  if (config.hedgeMode === "off") {
    log("hedger: off");
    return { tick: async () => {} };
  }
  if (config.hedgeMode === "mockdex" && !D.dex) {
    log("hedger: no mock DEX in this deployment, off");
    return { tick: async () => {} };
  }
  const s = signer(requireKey("HEDGER_KEY", config.hedgerKey));
  const addr = await s.getAddress();
  const venue = config.hedgeMode === "kuru" ? new KuruFlow(s) : new MockDexVenue(s);
  const c = contracts();

  // Baseline: the stock the hedge wallet held before it started hedging. Persisted across restarts.
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselineFile(), "utf8"));
  } catch {
    baseline = {};
    for (const st of D.stocks) baseline[st.address] = (await c.stock(st.address).balanceOf(addr)).toString();
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(baselineFile(), JSON.stringify(baseline));
  }
  const makerAddrs = makers.map((m) => m.addr);
  log(`hedger: ${config.hedgeMode} · wallet ${addr} · hedging ${makerAddrs.length} makers`);

  async function tick() {
    if (!state.updatedAt) return;
    const series = liveSeries();
    const total = {};
    for (const m of makerAddrs) {
      const d = await netDelta(m, series);
      for (const [a, v] of Object.entries(d)) total[a] = (total[a] || 0) + v;
    }
    for (const st of D.stocks) {
      const a = st.address;
      const px = state.spots[a];
      if (!px || state.halt[a]) continue;
      const held = shFrom((await c.stock(a).balanceOf(addr)) - BigInt(baseline[a] || 0));
      const target = -(total[a] || 0); // short options delta is offset by holding stock
      const diff = target - held;
      metrics.set("hedge_target", { stock: st.symbol }, target.toFixed(3));
      metrics.set("hedge_held", { stock: st.symbol }, held.toFixed(3));
      if (Math.abs(diff) < config.hedgeThreshold) continue;
      let rc;
      if (diff > 0) {
        const usdcIn = usdTo(diff * px);
        if ((await c.usdc.balanceOf(addr)) < usdcIn) {
          log(`! hedger: not enough USDC to buy ${diff.toFixed(2)} ${st.symbol}`);
          continue;
        }
        rc = await venue.swap(D.usdc, a, usdcIn, 6);
      } else {
        const qty = shTo(Math.min(-diff, Math.max(held + shFrom(BigInt(baseline[a] || 0)), 0)).toFixed(6));
        if (qty === 0n) continue;
        rc = await venue.swap(a, D.usdc, qty, 18);
      }
      if (rc) {
        metrics.inc("hedge_trades_total", { stock: st.symbol });
        log(`hedger: ${diff > 0 ? "bought" : "sold"} ${Math.abs(diff).toFixed(2)} ${st.symbol} at ~$${px.toFixed(2)} (target ${target.toFixed(2)})`);
      }
    }
    metrics.set("hedger_usdc", null, usdFrom(await c.usdc.balanceOf(addr)).toFixed(2));
    metrics.beat("hedger");
  }
  return { tick };
}
