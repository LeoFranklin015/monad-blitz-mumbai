# Weekend Options

> **Example:** It's Friday afternoon. You hold $10,000 of tokenized Tesla (TSLAx). Over the weekend, bad earnings news breaks. Monday morning the stock gaps down 12%. On a perp, you'd be liquidated — wiped out. With Weekend Options, you bought a **Floor** for a small premium on Friday. Monday you sell at your strike price. You lost the premium. Nothing else. No liquidation.

---

## What is my project?

**Weekend Options** is a fully onchain options protocol for tokenized stocks, built on **Monad**.

Tokenized stocks (xStocks) trade 24/7, but real US stock markets are only open 32.5 hours a week. When the market reopens after a weekend or overnight, prices **gap** — jumping violently. That gap liquidates leveraged perp traders and stock-backed loans before anyone can react.

Weekend Options sells protection against that gap. Traders pay a known premium to cap their downside. Their worst case is losing the premium — there is nothing to liquidate.

## What does it do?

It lets anyone buy or write options on tokenized stocks, fully onchain:

- **Upside (call)** — leveraged upside exposure, worst case fixed at the premium. Nothing to liquidate.
- **Floor (put)** — the right to sell at a fixed price any time, even on a Saturday.
- **Capped Upside / Budget Floor (spreads)** — cheaper protection that locks only the price width, not the full stock. 5–20x less capital.
- **Commit & Auto-Commit vaults** — write options and earn premium, manually or through a vault that writes weekly covered calls automatically.
- **Weekend Gap market** — a binary up/down bet on Monday's open.
- **Protect** — a stock-backed loan with a Floor built in, so it exits at the strike instead of being liquidated.

Behind the scenes: a two-sided onchain order book per series, signed EIP-712 RFQ quotes, automated maker bots that reprice every second, atomic delta hedging on spot, and a keeper that settles every position and pays everyone out automatically after expiry.

## What makes it special?

- **No liquidations, ever.** Every option is fully collateralized on both sides *before* it can be sold. The worst-case payout is already locked in the contract. There is no margin and nothing to liquidate.
- **Exercise needs no oracle.** For calls and puts, the holder physically pays the strike or hands over the stock. The oracle is only touched once, after expiry, to settle whatever nobody exercised — removing the single biggest trust assumption in onchain options.
- **Built for the gap specifically.** This isn't a generic options clone. Settlement, vol pricing, and risk halts are all designed around the weekend/overnight gap that breaks tokenized-stock DeFi.
- **Capital-efficient spreads.** A $205/$215 Capped Upside locks $10 instead of a $200 share — writers risk a fraction of the capital with the same known max loss.
- **Composable protection.** Because the book is onchain, any other Monad contract can buy a Floor in a single call. The Protect lender does exactly this — embedding downside protection inside a loan.
- **Only possible on Monad.** Continuously repricing 100+ series and hedging fills atomically needs high throughput and sub-second blocks. This scale of fully onchain market-making isn't feasible on slower chains.
- **Passkey-native UX.** JAW smart accounts mean no seed phrase and one biometric prompt per action — approvals and fills batched into a single transaction, with optional gas sponsorship.
