# Weekend Options

Fully onchain options on tokenized stocks, built for Monad.

xStocks trade all week. Wall Street trades 32.5 hours of it. When the market is closed, stock tokens wick on thin liquidity, perps liquidate, and stock-backed loans get wiped out by the Monday gap. Weekend Options sells the weekend:

- **Upside** (call): leverage on a stock with the worst case fixed at the premium. Nothing to liquidate.
- **Floor** (put): sell at a fixed price, any time, including Saturday.
- **Commit**: write either side and earn the premium.
- **Auto-Commit vaults**: deposit a stock token once, the vault writes weekly covered calls inside fixed rules and rolls.
- **Weekend Gap**: up/down market on Monday's open vs Friday's close. Its live split is a weekend price signal for makers.

Spot (Kuru), perps (Perpl) and lending (Aave) are already onchain on Monad. Options are the missing piece. Because the book is onchain, any Monad contract can buy protection in one call. `ShieldedLender` shows it: a stock-backed loan that buys a Floor from inside the lender survives a weekend crash that liquidates the unprotected loan.

## How it works

```
Makers ── lock collateral ──▶ OptionsProtocol ◀── premium ── Buyers
            (stock for Upside,     │  order book (reprice every block)
             USDC for Floor)       │  signed RFQ (EOA + ERC-1271)
                                   │  one ERC-20 per series
                                   ▼
                     exercise any time before expiry
                     (pay strike, get stock / give stock, get strike)
                     no oracle involved
                                   ▼
            after expiry: one time-weighted Monday-open price
            settles what nobody exercised, writers claim the rest
```

- **Fully collateralized.** A quote cannot exist without collateral behind it. No margin, no liquidations, ever.
- **Physical exercise needs no oracle.** The buyer chooses to pay the strike, so the price never matters onchain.
- **Net settlement uses one oracle read.** Unexercised options settle on the average of every sample posted in a 10 minute window after expiry (about 1,500 samples at Monad block times). If no price arrives within 7 days, unexercised options settle worthless, since holders always had the oracle-free route.
- **Pooled writers.** Every writer in a series shares the pool pro rata, the same model Opyn used, so assignment is fair and gas-light.
- **Three ways to trade.** Resting book quotes repriced in batches each block, signed RFQs for size (makers can be smart accounts or vaults via ERC-1271), and the option tokens themselves trade on any DEX.

## Contracts

| Contract | What it does |
|---|---|
| `OptionsProtocol` | Series, collateral balances, order book, RFQ, exercise, close, settlement, claims |
| `OptionToken` | ERC-20 per series, minted and burned only by the protocol |
| `SettlementOracle` | Spot for display/quoting, time-weighted settlement window per expiry |
| `GapMarket` | Pooled weekend up/down market, settles on the same Monday price |
| `CommitVault` | Rule-bound weekly covered-call vault (min 3% OTM, min premium, max 8 day tenor). Anyone can end a round |
| `examples/ShieldedLender` | Composability demo: stock-backed loan that buys and uses a Floor in one call |
| `mocks/MockERC20` | USDC and xStocks stand-ins with an open faucet |

Units: stock and option amounts are 18 decimals (1e18 = one share). Strikes and prices are USDC (6 decimals) per share.

## Run it locally

```bash
npm install
npm test                      # 23 tests, full lifecycle

npm run node                  # terminal 1: local chain
npm run deploy:local          # terminal 2: deploy stack, 3 stocks, 18 series, gap rounds
npm run makers                # terminal 2: 3 maker bots, Black-Scholes quotes repriced every 400ms, simulated feed
npm run app                   # terminal 3: http://localhost:5173
```

In the app: **Connect** picks a funded demo account, **Get test funds** mints USDC and stock tokens. The yellow **Demo controls** panel (local chain only) runs the pitch:

1. Buy an Upside on NVDAx.
2. **Saturday wick**: the feed drops by the wick slider. The 10x perp card shows liquidation, the Upside is untouched.
3. **Jump to Monday open and settle**: moves the chain clock past expiry, posts settlement samples at your Monday price.
4. **Collect**: the unexercised Upside pays its profit in stock.

The header shows live quote updates per second from the maker bots.

## Deploy to Monad testnet

```bash
PRIVATE_KEY=0x... npm run deploy:monad
# then the bots, with funded maker keys:
PRIVATE_KEY=0x... MAKER_KEYS=0xaaa,0xbbb,0xccc npx hardhat run scripts/maker-bot.js --network monadTestnet
```

`deploy.js` writes `deployments/<network>.json` and `app/deployment.js`. Serve `app/` anywhere; outside the local chain the app connects to an injected wallet and switches it to the deployment's chain. Default expiry is next Monday 13:30 UTC (9:30 ET); set `EXPIRY_MINUTES` for shorter demo cycles.

On a live network with real tokens:

```bash
USE_REAL_TOKENS="USDC=0x..,NVDAx=0x..,TSLAx=0x..,SPYx=0x.." PRIVATE_KEY=0x... npm run deploy:monad
```

Verify xStocks addresses on monadvision before using them.

## Before production

- **xStocks corporate actions.** xStocks keep raw balances fixed and move a multiplier for dividends and splits. Series should store raw units and adjust strikes by the multiplier, or settle in a wrapped non-rebasing token.
- **Oracle.** `SettlementOracle` is reporter-fed. Production should relay Pyth or Chainlink 24/7 equity feeds into the same interface, with several reporters.
- **Book size.** Each series caps at 64 resting quotes to bound matching gas. Fine on Monad, worth benchmarking under real load.
- **Parallel execution.** Series and maker quotes live in separate storage slots, so fills on different series do not contend. Keep it that way.
- **Atomic hedging.** Makers can hedge fills on Kuru in the same transaction through a router contract. Not built yet.
- **Audit.** None of this is audited. Do not use with real funds.
- **Access.** Options on tokenized US equities will need the same geographic restrictions as the underlying xStocks.
