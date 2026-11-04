# Weekend Options — CLAUDE.md

Fully onchain options on tokenized stocks, built for Monad. Options solve the weekend/overnight gap problem: xStocks trade 24/7 but Wall Street only 32.5 h/week, so perps and stock-backed loans get wiped on Monday opens. Options let traders cap downside (pay premium, worst case is losing that premium — nothing to liquidate).

---

## Project Structure

```
contracts/   Hardhat — protocol, products, oracles, integrations, tests, deploy
backend/     Node (ESM) — maker bots, hedged-maker, RFQ API, price reporter, keeper
web/         Vite (vanilla JS, no framework) — Trade, Earn, Protect, Portfolio, Pro views
deployments/ Written by deploy script — addresses + ABI bundle per network
docker/      Dockerfiles for backend, web (nginx), dev chain; nginx.conf
.e2e/        Playwright end-to-end tests (run against live stack)
```

### Contracts (`contracts/src/`)

| Path | Role |
|------|------|
| `core/OptionsProtocol.sol` | Core protocol — collateral, book, RFQ fills, exercise, settlement |
| `core/OptionToken.sol` | ERC-20 option tokens, one per series |
| `products/CommitVault.sol` | Auto-commit vault — deposit stock, vault writes weekly calls |
| `products/GapMarket.sol` | Weekend Gap market — up/down bet on Monday open vs reference |
| `oracle/SettlementOracle.sol` | Simple price reporter oracle |
| `oracle/PythSettlementOracle.sol` | Pyth-backed oracle for mainnet |
| `integrations/HedgedMaker.sol` | Maker contract that hedges fills on spot in the same tx via fill hook |
| `integrations/ShieldedLender.sol` | Lender integration — stock-backed loan that auto-buys a put |

**Series kinds:** `CALL` (Upside), `PUT` (Floor), `CALL_SPREAD` (Capped Upside), `PUT_SPREAD` (Budget Floor).

**Units:** stock and option amounts 18 decimals. Strikes and prices are USDC (6 decimals) per 1e18 units. Use `usd()` and `sh()` helpers in tests.

**Safety invariants:** every quote and every open option is fully backed. Nothing is ever liquidated. Oracle only read once at settlement (not during exercise for CALL/PUT).

### Backend (`backend/src/`)

| File | Role |
|------|------|
| `config.js` | All env vars, deployment addresses, ABI loading |
| `index.js` | Service runner — starts selected services by CLI arg |
| `lib/chain.js` | Provider, signers, contract instances, `send()` helper |
| `lib/market.js` | Market state loop — loads quotes from chain, computes mid/delta/vol |
| `lib/pricing.js` | Black-Scholes pricing for maker quotes |
| `lib/indexer.js` | Event indexer — tracks fills, positions, P&L |
| `lib/obs.js` | Logging and Prometheus metrics |
| `services/api.js` | HTTP API — `/health`, `/status`, `/markets`, `/rfq`, `/metrics` |
| `services/makers.js` | Maker bots — post/update quotes on chain |
| `services/hedger.js` | Hedged maker operator — manages HedgedMaker contract delta |
| `services/keeper.js` | Keeper — triggers settlement after expiry |
| `services/reporter.js` | Price reporter — pushes prices to SettlementOracle (local/testnet) |

**Critical Monad constraint:** drpc caps `eth_call` concurrency. Batches ≤5 only (`batchMaxCount: 5` in provider). Larger batches overflow the RPC thread pool. Never change this without re-testing on Monad testnet.

### Web (`web/src/`)

| File | Role |
|------|------|
| `main.js` | App shell — view routing, header status, polling loop |
| `chain.js` | Chain state loader — series, market data, balances |
| `wallet.js` | JAW passkey wallet + browser wallet adapter |
| `account.js` | Account panel — balances, positions |
| `ui.js` | DOM helpers, toast, error ABI decoding |
| `config.js` | Frontend config — network, API URL, feature flags |
| `views/trade.js` | Buy options flow |
| `views/earn.js` | Write/commit flow |
| `views/protect.js` | Shielded lender (Protect) flow |
| `views/portfolio.js` | Portfolio — open positions, P&L |
| `views/pro.js` | Pro trading panel (21/21 E2E passing) |
| `views/demo.js` | Demo mode panel |

**No React, no TypeScript.** Vanilla JS with Vite. Keep it that way unless there is a strong reason.

---

## Development

### Quick Start (local)

```bash
npm install
npm test                  # 38 contract tests

npm run chain             # terminal 1: Hardhat node on :8545
npm run deploy:local      # terminal 2: 3 stocks, 108 series, 2 expiries, vaults, lenders
npm run backend           # terminal 2: API on :8787, makers, reporter, keeper
npm run web               # terminal 3: http://localhost:5173
```

Full Docker stack (chain + deploy + backend + web on :8080):
```bash
docker compose --profile local up --build
```

### Key Scripts

| Command | What it does |
|---------|-------------|
| `npm test` | 38 Hardhat contract tests |
| `npm run smoke` | Boot chain+deploy+backend, verify API reports live quotes (CI gate) |
| `npm run backend:check` | Node syntax check all `.js`/`.mjs` in backend |
| `npm run deploy:monad-testnet` | Deploy to Monad testnet |
| `npm run verify` | Etherscan-style contract verification |

### Environment Variables (backend)

Place in `backend/.env`. Real env vars always win over `.env`.

| Variable | Default | Notes |
|----------|---------|-------|
| `NETWORK` | `localhost` | Which deployment to load from `deployments/` |
| `RPC_URL` | deployment default | Override RPC endpoint |
| `REPORTER_KEY` | Hardhat dev key 12 | Price reporter private key |
| `KEEPER_KEY` | Hardhat dev key 10 | Keeper private key |
| `HEDGER_KEY` | Hardhat dev key 11 | Hedger private key |
| `MAKER_KEYS` | Hardhat dev keys 1,2,3 | Comma-separated maker private keys |
| `OPERATOR_KEY` | Hardhat dev key 4 | HedgedMaker operator key |
| `TICK_MS` | 2000 (local) / 1000 | Market loop interval |
| `HEDGE_MODE` | `mockdex` (local) / `off` | `off` \| `mockdex` \| `kuru` |
| `SIMULATE` | auto | `1` = simulate settlement oracle (local only) |
| `PORT` | 8787 | API port |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `RATE_LIMIT_PER_MIN` | 120 | RFQ rate limit per IP |
| `RFQ_SPREAD` | 0.03 | Maker spread on RFQ quotes |
| `MAX_STALE_SEC` | 120 | Oracle staleness halt threshold |
| `JUMP_PCT` | 0.06 | Spot jump halt threshold (6%) |
| `MAX_SHORT_DELTA` | 5000 | Per-stock short delta cap (shares) |

---

## Architecture & Data Flow

```
User browser
  └─ Vite app (web/)
       ├─ JAW passkey wallet / browser wallet
       ├─ Reads: GET /markets, GET /rfq from backend API
       └─ Writes: fillRFQ, exercise, withdraw → OptionsProtocol (onchain)

Backend (Node, ESM)
  ├─ makers.js    → postQuote / updateQuote on OptionsProtocol
  ├─ hedger.js    → HedgedMaker contract delta management
  ├─ reporter.js  → pushes price to SettlementOracle (local/testnet)
  ├─ keeper.js    → calls settle() after expiry
  └─ api.js       → HTTP :8787, serves /markets + EIP-712 signed /rfq

Contracts (Monad)
  ├─ OptionsProtocol   core collateral/book/fills/settlement
  ├─ OptionToken       ERC-20 per series
  ├─ CommitVault       auto-writing vault (stock → weekly calls)
  ├─ GapMarket         weekend gap product
  ├─ HedgedMaker       spot hedge on fill via IFillHook
  └─ ShieldedLender    lending + embedded put protection
```

---

## Coding Rules

### Contracts
- All positions fully collateralized. Never add margin/leverage mechanics.
- Oracle read only at settlement, not exercise (CALL/PUT). Do not change this.
- Fee-on-transfer tokens are blocked by design (inbound transfers measured). Do not break this.
- Guardian pause stops new risk only — withdraw/cancel/exercise/close/settle/redeem always work.
- Fill hooks run with fixed gas budget in try/catch — they cannot block fills.

### Backend
- **Never increase `batchMaxCount` above 5** on the Monad RPC provider. drpc thread pool overflow is silent data loss.
- All signers go through `signer()` in `chain.js` — nonce-managed, serialized queue. Never create raw `Wallet` directly for tx sending.
- Use `send()` for all transactions — handles nonce reset on failure, metrics, logging.
- Services are stateless modules; state lives in `lib/market.js` (`state` object) and `lib/indexer.js`.
- Risk halts (`jumpPct`, `maxShortDelta`, `maxStaleSec`) are in config — never hardcode thresholds.

### Web
- Vanilla JS only — no React, no Vue, no TypeScript.
- All chain reads go through `chain.js` (uses the shared provider/series cache).
- Views export a single object `{ render, ... }` — routed by `main.js`.
- Use `toast()` from `ui.js` for user-facing errors. Decode revert reasons via `setErrorAbis`.

### Tests
- Contract tests: Hardhat + Chai + `hardhat-network-helpers`. Use `loadFixture` for setup.
- E2E: Playwright in `.e2e/`. Always run against a full local stack (chain + deploy + backend + web).
- **Never conclude a feature complete without Playwright proof** (per project RULES).
- `npm run smoke` is the CI gate for backend correctness. Keep it green.

---

## Deployments

`deployments/` is written by `contracts/scripts/deploy.js`. Do not hand-edit.

- `deployments/abi.json` — full ABI bundle (all contracts)
- `deployments/<network>.json` — addresses, chainId, rpc, oracleKind, stock list

Current live deployment: **Monad testnet** (`deployments/monadTestnet.json`).

Monad testnet RPC: check `project_monad_testnet_rpc.md` in memory for the working endpoint and batch/concurrency limits.

---

## Key Concepts

**Weekend gap problem:** xStocks trade 24/7, but US stock prices gap Monday morning when markets reopen after the weekend (or after close). This gap causes violent wick moves that liquidate perps and stock-backed loans. Options let holders pay a known premium to cap their downside — worst case is losing the premium, not getting liquidated.

**Series lifecycle:**
1. Admin creates series (kind, stock, strike, expiry).
2. Makers deposit collateral + post quotes on the book.
3. Takers fill via book or RFQ (EIP-712 signed by maker).
4. Holder exercises before expiry (CALL/PUT: physical, spreads: cash).
5. After expiry, keeper calls `settle()` to handle remaining open options using oracle price.

**RFQ flow:** taker calls `GET /rfq?seriesId=&amount=` → backend returns EIP-712 quote → taker calls `fillRFQ()` onchain with the signature → maker's fill hook (if HedgedMaker) hedges on spot in same tx.

**HedgedMaker delta hedge:** fills accumulate delta. When net delta exceeds `hedgeThreshold`, hedger.js calls `HedgedMaker.hedge()` which trades on spot (MockDex locally, Kuru on mainnet) to flatten.
