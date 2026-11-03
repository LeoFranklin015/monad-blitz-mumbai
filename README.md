# Weekend Options

Fully onchain options on tokenized stocks, built for Monad.

xStocks trade all week. Wall Street trades 32.5 hours of it. While the market is closed, stock tokens wick on thin liquidity, perps liquidate, and stock-backed loans get wiped out by the Monday gap. Weekend Options sells the weekend:

| Product | What you get | Writer locks |
|---|---|---|
| **Upside** (call) | Leverage with the worst case fixed at the premium. Nothing to liquidate. | the stock |
| **Floor** (put) | Sell at a fixed price any time, including Saturday | strike in USDC |
| **Capped Upside** (call spread) | Cheaper Upside with a ceiling | only the width in USDC |
| **Budget Floor** (put spread) | Cheaper protection for a range | only the width in USDC |
| **Commit** | Write any of the above and earn premium | |
| **Auto-Commit vaults** | Deposit stock once, the vault writes weekly calls inside fixed rules | |
| **Weekend Gap** | Up/down market on Monday's open vs the reference | |
| **Protect** | A stock-backed loan that buys a Floor from inside the lender | |

Spot (Kuru), perps (Perpl) and lending (Aave) are already onchain on Monad. Options are the missing piece, and because this book is onchain, any Monad contract can buy protection in one call.

## Repo

```
contracts/   Hardhat project: protocol, oracles, products, integrations, mocks, tests, deploy script
backend/     Node services: maker bots, hedged maker operator, RFQ + market API, price reporter, keeper
web/         Vite app: Trade, Earn, Protect, Portfolio. JAW passkey accounts, demo accounts, browser wallets
deployments/ Written by the deploy script: addresses per network and the ABI bundle
docker/      Dockerfiles for backend, web (nginx) and the dev chain, plus nginx.conf
.github/     CI: contract tests, backend syntax check, web build, full-stack smoke test, Docker build
```

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

In the app: **Connect → Demo account**, then **Test funds**. The yellow **Demo controls** panel (local chain only) runs the pitch:

1. Buy an Upside on the Trade tab, attach a Floor to a loan on Protect.
2. **Wick**: drop the feed 30%. The 10x perp card shows liquidation; the Upside is untouched; the floored loan stays healthy.
3. **Jump to expiry and settle**: moves the chain clock past expiry and posts settlement prices.
4. Within seconds the keeper settles every series, pays holders, credits writers, ends and restarts vault rounds, opens next week's gap rounds and rolls a new weekly expiry. Portfolio shows the payouts with no clicks.

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

- **Fully collateralized.** A quote cannot exist without collateral behind it. No margin, so no liquidations.
- **Physical exercise needs no oracle.** The holder chooses to pay the strike (Upside) or hand over the stock (Floor).
- **Spreads lock only the width.** A $205/$215 Capped Upside locks $10 per option instead of a $200 share: 5 to 20x less capital, max loss still known up front.
- **Two-sided book.** Buy from asks, sell back into bids before expiry, or sell to open (write and sell in one step).
- **Atomic hedging.** `HedgedMaker` registers a fill hook. When a buyer lifts its quote it buys or sells the stock on spot inside the buyer's transaction, so it quotes tighter. If the hedge can't run, the fill still goes through.
- **Settlement.** The average of every sample posted in a 10 minute window after expiry. With `PythSettlementOracle`, anyone can submit signed Pyth updates as samples, no trusted reporter. If no price arrives within 7 days, unexercised options settle worthless since holders always had the oracle-free route.
- **Corporate actions.** Options are written on raw xStock tokens. The Pyth oracle reports price per raw token (share price × multiplier), so dividends and splits don't break open positions. A test runs a 2:1 split mid-weekend.

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
| `interfaces/` | `IPriceOracle`, `IFillHook`, `IDexRouter`, `IPyth`, `IMultiplierToken` |
| `mocks/` | USDC, xStock with multiplier, Pyth, spot DEX |

Units: stock and option amounts are 18 decimals (1e18 = one token). Strikes and prices are USDC (6 decimals) per 1e18.

### Backend (`backend/src`)

`npm run backend` runs everything; pass names to run a subset (`node src/index.js makers rfq`).

| Service | |
|---|---|
| `makers` | 3 maker bots quoting asks and bids on every live series with Black-Scholes, weekend vol bump and gap-market drift. Requotes when fair value moves past `REQUOTE_BPS`. Plus the hedged maker operator: tighter quotes on cash-collateralized series, hedge ratios from delta. |
| `rfq` | `GET /markets` fair values and deltas, `GET /rfq?seriesId=&amount=` signed EIP-712 quotes the app fills onchain |
| `reporter` | Local: simulated feed and settlement samples. Pyth mode: pulls Hermes updates and submits them |
| `keeper` | Settles, pays holders, credits writers, runs vault rounds, gap rounds, weekly rolls, lender liquidations |

Series are read from chain, so the keeper's weekly rolls appear in the bots and the app without redeploying.

### Web (`web/src`)

- `wallet.js`: one interface over JAW passkey accounts, local demo accounts and injected wallets. With a passkey account every action (approvals included) is one atomic `wallet_sendCalls` batch and one passkey prompt, polled with `wallet_getCallsStatus`, with optional full gas sponsorship through a paymaster.
- `views/trade.js`: products, expiries, strikes, live two-sided book, payoff vs 10x perp or vs bare shares, book or RFQ fills, gap market.
- `views/earn.js`: write and sell now or post asks, open quotes, written positions, Auto-Commit vaults, idle balances.
- `views/protect.js`: deposit, borrow, attach Floor, health, exit at the strike, repay.
- `views/portfolio.js`: sell back, exercise, collect, gap claims, wallet.

## Passkey accounts (JAW)

JAW smart accounts run on JAW-supported chains, which include **Monad mainnet (143)** and **Base Sepolia (84532)** but not Monad testnet. The app reads the supported list from `@jaw.id/core` at runtime.

```bash
cp web/.env.example web/.env
# VITE_NETWORK=monad (or baseSepolia), VITE_JAW_API_KEY=..., optional VITE_PAYMASTER_URL=...
```

Add your app's domain to the API key's allowed domains in the JAW dashboard. Without a key, the Passkey option is shown disabled with the reason.

## Production

The backend is built to run unattended against a live deployment:

- **One key per role.** Keeper, reporter, hedger, makers and HedgedMaker operator each have their own key and are granted their role at deploy. The owner key never touches the backend. A separate guardian can pause new risk instantly; exits (close, cancel, exercise, redeem, claim) are never blocked by pause.
- **Risk halts.** Makers pull quotes on a stale feed (only while the stock market is open), after a jump above `JUMP_PCT` (with cooldown), in the last `STOP_BEFORE_EXPIRY_SEC` before expiry, when the protocol is paused, and per side when net short delta passes `MAX_SHORT_DELTA`.
- **Hedging.** `HEDGE_MODE=kuru` hedges the bot makers' net delta through Kuru Flow (Monad mainnet only); `mockdex` locally; `off` otherwise.
- **Indexer.** Holders, writers, borrowers and bettors are indexed from logs in chunks, with confirmations, and the cursor is persisted in `DATA_DIR`, so restarts resume where they stopped.
- **Graceful shutdown.** On SIGTERM the backend waits for in-flight ticks, then cancels every quote and verifies the book is empty before exiting (compose gives it 90s).
- **Observability.** `/health`, `/status` (service tick ages, halts, live quotes, indexer block) and `/metrics` (Prometheus). nginx only exposes `/status` and `/metrics` to private networks. JSON logs with `LOG_FORMAT=json`.
- **API limits.** Per-IP rate limit, RFQ TTL, max RFQ size and an outstanding signed-quote budget so signed RFQs can't overcommit a maker.

Step-by-step deployment, roles, verification, monitoring and the pause procedure are in [DEPLOY.md](DEPLOY.md). The threat model and known limits are in [SECURITY.md](SECURITY.md).
