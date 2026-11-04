# Weekend Options

**Fully onchain options on tokenized stocks, built for Monad.**

Tokenized stocks trade 24/7. Wall Street trades 32.5 hours of it. While the market is closed, stock tokens wick on thin liquidity, perps get liquidated, and stock-backed loans get wiped out by the Monday gap. Weekend Options sells the weekend — pay a known premium, cap your downside, and never get liquidated.

---

> **Example:** It's Friday. You hold $10,000 of tokenized Tesla (TSLAx). Over the weekend, bad earnings break and Monday the stock gaps down 12%. On a 10x perp you'd be liquidated — wiped out. But on Friday you bought a **Floor** for a small premium. Monday you sell at your strike. You lost the premium, nothing else. No liquidation.

---

## The Problem

When US markets reopen after a weekend or overnight, prices **gap** — jumping sharply the moment trading resumes. On DeFi this cascades into failure:

- **Perps get liquidated.** High leverage makes them attractive, but a normal 5–10% weekend gap crosses the liquidation threshold instantly. The trader can't react — the market is closed.
- **Stock-backed loans get wiped.** Collateral value drops below the health factor before the borrower can repay.
- **xStocks wick on thin liquidity.** Over the weekend there are no buyers, so price overshoots.

This is structural. It isn't fixed by better liquidation engines — only by **capping downside before the gap happens**. That's what options do, and what DeFi was missing.

## The Solution

Buy an option instead of taking leveraged exposure. Pay a known premium upfront. Worst case: you lose the premium. There is **nothing to liquidate**, because every option is fully collateralized on both sides before it is ever sold.

Spot (Kuru), perps (Perpl) and lending (Aave) are already onchain on Monad. Options are the missing piece — and because this book is onchain, any Monad contract can buy protection in a single call.

## Products

| Product | What you get | Writer locks |
|---|---|---|
| **Upside** (call) | Leverage with the worst case fixed at the premium. Nothing to liquidate. | the stock |
| **Floor** (put) | Sell at a fixed price any time, including Saturday | strike in USDC |
| **Capped Upside** (call spread) | Cheaper Upside with a ceiling | only the width in USDC |
| **Budget Floor** (put spread) | Cheaper protection for a range | only the width in USDC |
| **Commit** | Write any of the above and earn premium | collateral |
| **Auto-Commit vaults** | Deposit stock once, the vault writes weekly calls inside fixed rules | the stock |
| **Weekend Gap** | Binary up/down market on Monday's open vs the reference | pool stake |
| **Protect** | A stock-backed loan that buys a Floor from inside the lender | collateral |

See **[OVERVIEW.md](OVERVIEW.md)** for a full walk-through of each product and the mechanics.

## What makes it special

- **No liquidations, ever.** A quote can't exist without collateral behind it. No margin, nothing to liquidate.
- **Exercise needs no oracle.** Calls and puts settle physically — the holder pays the strike or hands over the stock. The oracle is read once, after expiry, only for what nobody exercised.
- **Capital-efficient spreads.** A $205/$215 Capped Upside locks $10 per option instead of a $200 share — 5–20x less capital, max loss still known up front.
- **Atomic hedging.** `HedgedMaker` hedges every fill on spot inside the buyer's transaction, so it quotes tighter. If the hedge can't run, the fill still goes through.
- **Composable protection.** Any Monad contract can buy a Floor in one call. The Protect lender embeds one inside a loan.
- **Only possible on Monad.** Repricing 100+ series continuously and hedging fills atomically needs high throughput and sub-second blocks.
- **Passkey-native.** JAW smart accounts — no seed phrase, one biometric prompt per action, approvals and fills batched into a single transaction, optional gas sponsorship.

## Quick start (local)

```bash
npm install
npm test                 # 38 contract tests

npm run chain            # terminal 1: local chain on :8545
npm run deploy:local     # terminal 2: 3 stocks, 108 series over 2 weekly expiries, vaults, lenders, gap rounds
npm run backend          # terminal 2: makers, hedged maker, API on :8787, reporter, keeper
npm run web              # terminal 3: http://localhost:5173
```

Or the whole stack in Docker (chain, deploy, backend, web on :8080):

```bash
docker compose --profile local up --build
```

`npm run smoke` boots chain, deploy and backend and checks the API reports live quotes (what CI runs).

### Try the demo

In the app: **Connect → Demo account**, then **Test funds**. The yellow **Demo controls** panel (local chain only) runs the pitch:

1. Buy an Upside on the Trade tab, attach a Floor to a loan on Protect.
2. **Wick:** drop the feed 30%. The 10x perp card shows liquidation; the Upside is untouched; the floored loan stays healthy.
3. **Jump to expiry and settle:** moves the chain clock past expiry and posts settlement prices.
4. Within seconds the keeper settles every series, pays holders, credits writers, restarts vault rounds, opens next week's gap rounds, and rolls a new weekly expiry. Portfolio shows the payouts with no clicks.

## How it works

```
Makers / HedgedMaker ── collateral ──▶ OptionsProtocol ◀── premium ── Buyers (passkey, EOA, contracts)
                                        │ two-sided book: asks backed by collateral, bids by USDC
                                        │ signed RFQ for size (EOA or ERC-1271 smart accounts)
                                        │ fill hook → maker hedges on spot in the same tx
                                        ▼
               exercise any time before expiry (Upside, Floor): no oracle involved
                                        ▼
       after expiry: one time-weighted price settles what nobody exercised
       keeper calls redeemFor / claimFor so everyone is paid automatically
```

- **Fully collateralized.** Every quote and open option is backed by tokens held in the protocol. No margin, no liquidations.
- **Physical exercise needs no oracle.** The holder chooses to pay the strike (Upside) or hand over the stock (Floor).
- **Two-sided book.** Buy from asks, sell back into bids before expiry, or sell to open (write and sell in one step).
- **Settlement.** The time-weighted average of samples posted in a 10-minute window after expiry. With `PythSettlementOracle`, anyone can submit signed Pyth updates — no trusted reporter.
- **Corporate actions.** The Pyth oracle reports price per raw token (share price × multiplier), so dividends and splits don't break open positions.

## Repository layout

```
contracts/   Hardhat: protocol, oracles, products, integrations, mocks, tests, deploy script
backend/     Node services: maker bots, hedged maker operator, RFQ + market API, price reporter, keeper
web/         Vite app: Trade, Earn, Protect, Portfolio, Pro. JAW passkey, demo, browser wallets
deployments/ Written by the deploy script: addresses per network and the ABI bundle
docker/      Dockerfiles for backend, web (nginx), dev chain, plus nginx.conf
.e2e/        Playwright end-to-end tests
.github/     CI: contract tests, backend syntax check, web build, full-stack smoke test, Docker build
```

### Contracts (`contracts/src`)

| Path | |
|---|---|
| `core/OptionsProtocol.sol` | Series (4 kinds), balances, two-sided book, batch quoting, RFQ, fill hooks, exercise, close, settlement, keeper payouts |
| `core/OptionToken.sol` | ERC-20 per series, protocol mint/burn only |
| `oracle/SettlementOracle.sol` | Reporter-fed spot and time-weighted settlement window |
| `oracle/PythSettlementOracle.sol` | Permissionless Pyth samples, multiplier-aware per-token prices |
| `products/GapMarket.sol` | Pooled weekend up/down market |
| `products/CommitVault.sol` | Rule-bound weekly covered-call vault, anyone can end a round |
| `integrations/ShieldedLender.sol` | Stock-backed loan with Floors attached from inside the lender |
| `integrations/HedgedMaker.sol` | Maker contract that hedges every fill on spot atomically |

Units: stock and option amounts are 18 decimals (1e18 = one token). Strikes and prices are USDC (6 decimals) per 1e18.

### Backend (`backend/src`)

`npm run backend` runs everything; pass names to run a subset (`node src/index.js makers rfq`).

| Service | |
|---|---|
| `makers` | Maker bots quoting asks and bids on every live series with Black-Scholes, weekend vol bump and gap drift. Requotes past `REQUOTE_BPS`. Plus the hedged maker operator. |
| `rfq` | `GET /markets` fair values and deltas, `GET /rfq?seriesId=&amount=` signed EIP-712 quotes the app fills onchain |
| `reporter` | Local: simulated feed and settlement samples. Pyth mode: pulls Hermes updates and submits them |
| `keeper` | Settles, pays holders, credits writers, runs vault rounds, gap rounds, weekly rolls, lender liquidations |

Series are read from chain, so the keeper's weekly rolls appear in the bots and app without redeploying.

### Web (`web/src`)

- `wallet.js` — one interface over JAW passkey accounts, local demo accounts and injected wallets.
- `views/trade.js` — products, expiries, strikes, live book, payoff vs 10x perp or bare shares, book or RFQ fills, gap market.
- `views/earn.js` — write and sell now or post asks, open quotes, written positions, Auto-Commit vaults.
- `views/protect.js` — deposit, borrow, attach Floor, health, exit at the strike, repay.
- `views/portfolio.js` — sell back, exercise, collect, gap claims.
- `views/pro.js` — pro trading panel.

## Deployment

The backend runs unattended against a live deployment with one key per role, instant guardian pause, maker risk halts (stale feed, price jump, pre-expiry, short-delta cap), a persisted log indexer, graceful shutdown that cancels all quotes, and full observability (`/health`, `/status`, `/metrics`).

Current live deployment: **Monad testnet** (chainId `10143`), addresses in `deployments/monadTestnet.json`.

## Passkey accounts (JAW)

JAW smart accounts run on JAW-supported chains, including **Monad mainnet (143)** and **Base Sepolia (84532)**. The app reads the supported list from `@jaw.id/core` at runtime.

```bash
cp web/.env.example web/.env
# VITE_NETWORK=monad (or baseSepolia), VITE_JAW_API_KEY=..., optional VITE_PAYMASTER_URL=...
```

Add your app's domain to the API key's allowed domains in the JAW dashboard. Without a key, the Passkey option is shown disabled with the reason.

## Documentation

- **[OVERVIEW.md](OVERVIEW.md)** — the problem, every product, and how it all works in depth
- **[CLAUDE.md](CLAUDE.md)** — codebase guide for contributors
