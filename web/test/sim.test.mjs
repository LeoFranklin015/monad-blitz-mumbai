// What a position pays at expiry, matching OptionsProtocol._settle / _payoffCash.
//   node --test web/test/sim.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, simulate, positionsAt } from "../src/sim.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const stock = { symbol: "NVDAx" };
const upside = { kind: 0, strike: 205, strike2: 0, stock };
const floor = { kind: 1, strike: 200, strike2: 0, stock };
const capped = { kind: 2, strike: 205, strike2: 215, stock };
const budget = { kind: 3, strike: 200, strike2: 190, stock };

test("Upside pays in the stock: (P - K) / P shares per option, worth P - K", () => {
  const r = settle(upside, 215, 0.1); // 0.1 x 10 / 215 shares
  assert.equal(r.token, "NVDAx");
  close(r.amount, 0.1 * 10 / 215);
  close(r.usd, 1.0);
});

test("Upside at or below the strike pays nothing", () => {
  assert.equal(settle(upside, 205, 1).usd, 0);
  assert.equal(settle(upside, 180, 1).amount, 0);
});

test("Floor pays USDC: K - P per option", () => {
  const r = settle(floor, 190, 0.5);
  assert.equal(r.token, "USDC");
  close(r.amount, 5);
  close(r.usd, 5);
  assert.equal(settle(floor, 210, 1).usd, 0);
});

test("Capped Upside pays USDC, capped at strike2 - strike", () => {
  close(settle(capped, 210, 1).usd, 5);
  close(settle(capped, 260, 1).usd, 10);
  assert.equal(settle(capped, 200, 1).usd, 0);
});

test("Budget Floor pays USDC, capped at strike - strike2", () => {
  close(settle(budget, 195, 1).usd, 5);
  close(settle(budget, 100, 2).usd, 20);
  assert.equal(settle(budget, 205, 1).usd, 0);
});

test("simulate nets the premium and gives the break-even", () => {
  const r = simulate(upside, 215, 0.1, 0.896); // the owner's real trade: 0.1 Upside $205 for $0.896
  close(r.receive.usd, 1.0);
  close(r.pnl, 1.0 - 0.896);
  close(r.breakEven, 205 + 8.96);
  const f = simulate(floor, 190, 1, 2);
  close(f.pnl, 8);
  close(f.breakEven, 198);
  const c = simulate(capped, 260, 1, 3); // spreads break even at strike +/- premium too
  close(c.breakEven, 208);
  close(c.maxPayout, 10);
});

test("positionsAt sums every held position at one Monday price", () => {
  const held = [
    { series: upside, amount: 0.1, cost: 0.896 },
    { series: floor, amount: 1, cost: 2 },
  ];
  const at215 = positionsAt(held, 215);
  close(at215.usd, 1.0); // Upside pays $1, the Floor pays nothing
  close(at215.pnl, 1.0 - 2.896);
  const at190 = positionsAt(held, 190);
  close(at190.usd, 10);
  close(at190.pnl, 10 - 2.896);
  assert.equal(positionsAt([], 200).usd, 0);
});
