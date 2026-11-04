// What an option pays at expiry if it settles at price P: the same math as OptionsProtocol._settle.
//   Upside (CALL)        pays the stock: (P - K) / P shares per option, worth P - K
//   Floor (PUT)          pays USDC: K - P per option
//   Capped Upside        pays USDC: min(P - K, K2 - K)
//   Budget Floor         pays USDC: min(K - P, K - K2)
// No chain reads here, so the Pro view can call it on every keystroke and every chart hover.

const perOptionUsd = (s, P) => {
  if (s.kind === 0) return Math.max(0, P - s.strike);
  if (s.kind === 1) return Math.max(0, s.strike - P);
  if (s.kind === 2) return Math.min(Math.max(0, P - s.strike), s.strike2 - s.strike);
  return Math.min(Math.max(0, s.strike - P), s.strike - s.strike2);
};

/// What `amount` options of series `s` pay if they settle at `P`: { token, amount, usd }.
export function settle(s, P, amount) {
  const usd = perOptionUsd(s, P) * amount;
  if (s.kind === 0) return { token: s.stock.symbol, amount: P > 0 ? usd / P : 0, usd };
  return { token: "USDC", amount: usd, usd };
}

/// A ticket before you buy: payout at P, profit after the premium, break-even, best case.
export function simulate(s, P, amount, premium) {
  const receive = settle(s, P, amount);
  const perOption = amount > 0 ? premium / amount : 0;
  const up = s.kind === 0 || s.kind === 2;
  return {
    receive,
    pnl: receive.usd - premium,
    breakEven: up ? s.strike + perOption : s.strike - perOption,
    maxPayout: s.kind === 2 ? (s.strike2 - s.strike) * amount : s.kind === 3 ? (s.strike - s.strike2) * amount : null,
  };
}

/// Every held position at one settlement price: [{ series, amount, cost }] -> { usd, pnl, rows }.
export function positionsAt(held, P) {
  const rows = held.map((h) => ({ ...h, receive: settle(h.series, P, h.amount) }));
  const usd = rows.reduce((a, r) => a + r.receive.usd, 0);
  const cost = held.reduce((a, h) => a + (h.cost || 0), 0);
  return { usd, pnl: usd - cost, rows };
}
