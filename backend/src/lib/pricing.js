// Black-Scholes with zero rates, plus helpers for the four series kinds.

function erf(x) {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const N = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

export function bs(S, K, T, vol, isCall) {
  if (T <= 0 || vol <= 0) {
    const intrinsic = Math.max(0, isCall ? S - K : K - S);
    return { price: intrinsic, delta: isCall ? (S > K ? 1 : 0) : S < K ? -1 : 0 };
  }
  const sq = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * vol * vol * T) / sq;
  const d2 = d1 - sq;
  return isCall
    ? { price: S * N(d1) - K * N(d2), delta: N(d1) }
    : { price: K * N(-d2) - S * N(-d1), delta: N(d1) - 1 };
}

/// Fair value and delta of one option of a series. kind: 0 call, 1 put, 2 call spread, 3 put spread.
export function priceSeries(s, S, T, vol) {
  if (s.kind === 0) return bs(S, s.strike, T, vol, true);
  if (s.kind === 1) return bs(S, s.strike, T, vol, false);
  if (s.kind === 2) {
    const a = bs(S, s.strike, T, vol, true), b = bs(S, s.strike2, T, vol, true);
    return { price: Math.max(0, a.price - b.price), delta: a.delta - b.delta };
  }
  const a = bs(S, s.strike, T, vol, false), b = bs(S, s.strike2, T, vol, false);
  return { price: Math.max(0, a.price - b.price), delta: a.delta - b.delta };
}

/// US cash session closed? Weekends, or outside 13:30-20:00 UTC on weekdays (ignores holidays).
export function marketClosed(ts) {
  const d = new Date(ts * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return true;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m < 13 * 60 + 30 || m >= 20 * 60;
}

export const YEAR = 365 * 24 * 3600;
