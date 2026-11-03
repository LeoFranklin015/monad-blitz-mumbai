// Keeper: everything that should happen without anyone clicking.
//  - settle expired series once the settlement price is final
//  - pay out every holder (redeemFor) and credit every writer (claimFor)
//  - end Auto-Commit rounds after expiry and start the next one inside the vault's rules
//  - settle gap rounds and open the next week's round
//  - roll a new weekly expiry with a fresh strike grid before the last one runs out
//  - liquidate unhealthy ShieldedLender loans
import { ethers } from "ethers";
import { D, config, KIND } from "../config.js";
import { contracts, signer, send, usdTo, provider, log } from "../lib/chain.js";
import { state, refreshSeries, latestGapRounds } from "../lib/market.js";

const STRIKE_STEPS = [-0.1, -0.05, -0.025, 0, 0.025, 0.05, 0.1];
const SPREAD_LEGS = [[0.025, 0.075], [0.05, 0.1]];
const WEEK = 7 * 24 * 3600;
const roundStrike = (px) => {
  const step = px >= 500 ? 5 : px >= 100 ? 2.5 : 1;
  return Math.round(px / step) * step;
};

export async function startKeeper() {
  if (!config.deployerKey) {
    log("keeper: no DEPLOYER_KEY, skipping");
    return { tick: async () => {} };
  }
  const s = signer(config.deployerKey);
  const c = contracts(s);
  const r = contracts();
  const done = new Set(); // series fully paid out
  let busy = false;
  log("keeper: settle, pay out, roll vaults, gap rounds, weekly expiries, liquidations");

  async function participants(series) {
    // holders: anyone who ever received the option token; writers: anyone who ever sold one
    const tok = r.token(series.token);
    const logs = await tok.queryFilter(tok.filters.Transfer(), 0, "latest");
    const holders = new Set(logs.map((l) => l.args.to).filter((a) => a !== ethers.ZeroAddress));
    const fills = await r.protocol.queryFilter(r.protocol.filters.Filled(series.id), 0, "latest");
    const rfqs = await r.protocol.queryFilter(r.protocol.filters.RFQFilled(series.id), 0, "latest");
    const writers = new Set([...fills.map((l) => l.args.seller), ...rfqs.map((l) => l.args.maker)]);
    return { holders, writers };
  }

  async function settleAndPay() {
    for (const x of state.series) {
      if (done.has(x.id) || state.now < x.expiry + D.settlementWindow + 1) continue;
      const info = await r.protocol.getSeries(x.id);
      if (!info.settled) {
        const [, ok] = await r.oracle.settlementPrice(x.stock.address, x.expiry);
        if (!ok) continue;
        await send(s, `settle ${x.id}`, () => c.protocol.settle(x.id));
      }
      const { holders, writers } = await participants(x);
      for (const h of holders) {
        if ((await r.token(x.token).balanceOf(h)) > 0n) await send(s, `redeemFor ${x.id}`, () => c.protocol.redeemFor(x.id, h));
      }
      for (const w of writers) {
        if ((await r.protocol.written(x.id, w)) > 0n) await send(s, `claimFor ${x.id}`, () => c.protocol.claimFor(x.id, w));
      }
      done.add(x.id);
      log(`keeper: series ${x.id} settled and paid out (${holders.size} holders, ${writers.size} writers)`);
    }
  }

  async function vaults() {
    for (const st of D.stocks) {
      const v = c.vault(st.vault);
      const active = await v.active();
      if (active) {
        const sid = Number(await v.activeSeries());
        const x = state.series.find((y) => y.id === sid);
        if (x && state.now >= x.expiry + D.settlementWindow + 1) {
          const info = await r.protocol.getSeries(sid);
          if (info.settled || (await r.oracle.settlementPrice(x.stock.address, x.expiry))[1]) {
            if (await send(s, "endRound", () => v.endRound())) log(`keeper: ${st.symbol} vault round ended`);
          }
        }
        continue;
      }
      const assetBal = await r.stock(st.address).balanceOf(st.vault);
      if (assetBal === 0n) continue;
      // next round: nearest expiry within the vault's tenor, first call at least 5% out of the money
      const spot = state.spots[st.address];
      const maxTenor = Number(await v.maxTenor());
      const cands = state.series
        .filter((x) => x.stock.address === st.address && x.kind === KIND.CALL && x.expiry > state.now + 60 && x.expiry <= state.now + maxTenor && x.strike >= spot * 1.05)
        .sort((a, b) => a.expiry - b.expiry || a.strike - b.strike);
      const pick = cands[0];
      if (!pick) continue;
      const fair = state.fair.get(pick.id)?.price || 0;
      const floor = spot * Number(await v.minPremiumBps()) / 10_000;
      const px = Math.max(fair * 1.05, floor * 1.01);
      if (await send(s, "startRound", () => v.startRound(pick.id, usdTo(px)))) {
        log(`keeper: ${st.symbol} vault writing $${pick.strike} Upside at $${px.toFixed(2)}`);
      }
    }
  }

  async function gapRounds() {
    const latest = await latestGapRounds();
    const expiries = [...new Set(state.series.map((x) => x.expiry))].sort((a, b) => a - b);
    for (const st of D.stocks) {
      const g = latest[st.address.toLowerCase()];
      if (!g) continue;
      if (state.now >= g.lockTime && !g.settled && (await r.oracle.settlementPrice(st.address, g.lockTime))[1]) {
        await send(s, "gap settle", () => c.gap.settle(g.id));
      }
      if (state.now >= g.lockTime) {
        const next = expiries.find((e) => e > state.now + 3600);
        if (next) {
          if (await send(s, "gap open", () => c.gap.openRound(st.address, state.now, next, usdTo(state.spots[st.address])))) {
            log(`keeper: ${st.symbol} gap round opened for ${new Date(next * 1000).toUTCString()}`);
          }
        }
      }
    }
  }

  async function roll() {
    const last = Math.max(...state.series.map((x) => x.expiry));
    if (last > state.now + WEEK + 3600) return;
    const expiry = last + WEEK;
    for (const st of D.stocks) {
      const spot = state.spots[st.address];
      const mk = (kind, k, k2) => send(s, "createSeries", () => c.protocol.createSeries(st.address, expiry, kind, usdTo(k), k2 ? usdTo(k2) : 0));
      for (const step of STRIKE_STEPS) {
        const k = roundStrike(spot * (1 + step));
        await mk(KIND.CALL, k);
        await mk(KIND.PUT, k);
      }
      for (const [a, b] of SPREAD_LEGS) {
        await mk(KIND.CALL_SPREAD, roundStrike(spot * (1 + a)), roundStrike(spot * (1 + b)));
        await mk(KIND.PUT_SPREAD, roundStrike(spot * (1 - a)), roundStrike(spot * (1 - b)));
      }
    }
    await refreshSeries(true);
    log(`keeper: rolled a new weekly expiry ${new Date(expiry * 1000).toUTCString()}`);
  }

  async function liquidations() {
    for (const st of D.stocks) {
      const l = c.lender(st.lender);
      const evs = await r.lender(st.lender).queryFilter(r.lender(st.lender).filters.CollateralIn(), 0, "latest");
      for (const who of new Set(evs.map((e) => e.args.user))) {
        if (!(await l.isLiquidatable(who))) continue;
        const debt = (await l.accounts(who)).debt;
        if ((await r.usdc.balanceOf(await s.getAddress())) < debt) continue;
        await send(s, "approve", () => c.usdc.approve(st.lender, ethers.MaxUint256));
        if (await send(s, "liquidate", () => l.liquidate(who))) log(`keeper: liquidated ${who} on ${st.symbol} lender`);
      }
    }
  }

  async function tick() {
    if (busy || !state.now) return;
    busy = true;
    try {
      await settleAndPay();
      await vaults();
      await gapRounds();
      await roll();
      await liquidations();
    } catch (e) {
      log(`keeper: ${e.message}`);
      s.reset();
    } finally {
      busy = false;
    }
  }
  return { tick };
}

export { provider };
