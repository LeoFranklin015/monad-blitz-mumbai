# Deploy runbook

How to take Weekend Options from a fresh checkout to a running deployment on Monad mainnet (or Base Sepolia / Monad testnet). Read [SECURITY.md](SECURITY.md) first.

## 0. Prerequisites

- Node 22, Docker with compose v2.
- An RPC for the target chain (a private one for the backend).
- Six keys, each funded with native gas:

| Role | Key lives in | Needs | Granted at deploy by |
|---|---|---|---|
| Owner / deployer | hardware wallet, then a multisig | gas for deploy | `PRIVATE_KEY` (contracts/.env) |
| Guardian | ops bot or on-call | gas | `GUARDIAN_ADDRESS` |
| Keeper | backend | gas, USDC for liquidations | `KEEPER_ADDRESS` |
| Reporter | backend | gas, Pyth update fees | `REPORTER_ADDRESS` |
| Hedger | backend | gas, USDC + stock float | `HEDGER_ADDRESS` |
| HedgedMaker operator | backend | gas | `MAKER_OPERATOR` |
| Makers (1..n) | backend | gas, collateral (stock + USDC) | none, permissionless |

Never put the owner key in `backend/.env`.

## 1. Deploy contracts

```bash
cp contracts/.env.example contracts/.env    # fill PRIVATE_KEY, role addresses, tokens, Pyth
npm ci && npm test
npm run deploy:monad                         # or deploy:base-sepolia / deploy:monad-testnet
```

For live networks set:

- `USE_REAL_TOKENS=USDC=0x..,NVDAx=0x..,...`: real USDC and **wrapped, non-rebasing** xStocks.
- `MULTIPLIER_SOURCES=NVDAx=0x..`: the contract exposing the share multiplier for each stock.
- `PYTH_ADDRESS` and `PYTH_IDS`: use `PythSettlementOracle` instead of the reporter oracle.
- `DEX_ROUTER`: only once an `IDexRouter` adapter for your spot venue exists; otherwise leave it empty and run `HEDGE_MODE=kuru` off-contract.

The script writes `deployments/<network>.json` (addresses, roles, deploy block) and copies it with the ABI bundle to `web/public/deployments/`. Commit neither file; ship them with the release.

## 2. Verify

```bash
ETHERSCAN_API_KEY=... npm run verify -- --network monad
VERIFY_TOKENS=1 npm run verify -- --network monad     # also every option token
```

Sourcify is on by default.

## 3. Hand over ownership

Every admin contract is `Ownable2Step`. From the deployer, call `transferOwnership(multisig)` on OptionsProtocol, the settlement oracle, GapMarket, each CommitVault, HedgedMaker and each ShieldedLender, then `acceptOwnership()` from the multisig. Check `owner()` on each afterwards.

## 4. Configure and run the backend

```bash
cp backend/.env.example backend/.env
# NETWORK=monad, RPC_URL, one key per role, CORS_ORIGINS=https://your.app, risk params, HEDGE_MODE, PYTH_IDS
```

Fund makers with collateral or leave `MAKER_AUTO_DEPOSIT=1` so they deposit what they hold.

```bash
NETWORK=monad VITE_JAW_API_KEY=... docker compose up -d --build
docker compose logs -f backend
```

This runs `backend` (makers, hedger, API, keeper, reporter) and `web` (nginx serving the app and proxying `/api` to the backend) on `WEB_PORT` (default 8080). Put TLS in front (a load balancer or Caddy). The backend's state (indexer cursor, hedger baseline) lives in the `backend-data` volume.

To split services across hosts, run one backend container per role with a command override, e.g. `node backend/src/index.js keeper`.

## 5. Check it's live

```bash
curl https://your.app/healthz
curl https://your.app/api/health
curl -s internal-host:8080/api/status | jq '{liveQuotes, halts, serviceTickAgeSec, indexerBlock}'
```

`liveQuotes` should be above zero while the market is open and not halted. Every `serviceTickAgeSec` value should be a few ticks old at most.

## 6. Monitor

Scrape `/api/metrics` (private networks only) and alert on:

| Signal | Alert when |
|---|---|
| `wo_service_last_tick_seconds{service=...}` | any service > 5 × its interval |
| `wo_maker_live_quotes` | 0 for 5 min while the market is open and the protocol isn't paused |
| `wo_quoting_halted` | 1 for > 10 min |
| `wo_tx_failed_total` | rising faster than `wo_tx_sent_total` would explain |
| `wo_maker_net_delta` | beyond `MAX_SHORT_DELTA` |
| `wo_hedger_usdc` | below what the hedger needs to rebalance |
| keeper, reporter, hedger native balance | below a week of gas |
| keeper USDC | below the largest loan you expect to liquidate |

## 7. Pause procedure

Pause blocks new risk only: new series, new quotes, buys, sell-to-open, gap bets. Cancels, closes, exercise, settlement, redeem and claims keep working, so users can always exit.

1. Guardian calls `pause()` on OptionsProtocol (and GapMarket if needed).
2. Makers see `paused` on their next tick and cancel their quotes; check that `/api/status` shows `liveQuotes: 0`.
3. Investigate. Settlement continues; the keeper keeps paying out.
4. The owner (multisig) calls `unpause()`. Makers requote on the next tick.

Practise it locally with the drill: `node backend/scripts/ops-drill.mjs <backend-pid-file>` against a host-run local stack (chain, deploy:local, backend).

## 8. Rotate a key

1. Generate the new key and fund it.
2. Grant the role to the new address (owner): `setKeeper` on each vault, `setReporter(new, true)` on the oracle, `setOpener` on GapMarket, `setOperator` on HedgedMaker, `setGuardian` on the protocol and GapMarket.
3. Update `backend/.env` and `docker compose up -d backend` (SIGTERM cancels the old makers' quotes first).
4. Revoke the old address (`setReporter(old, false)` etc.) and sweep its funds.

For a maker key: stop the backend, `claim` the maker's free balance from the protocol, then start with the new key.

## 9. Upgrade the backend

`docker compose up -d --build backend`. Shutdown cancels all quotes and the new process resumes from the saved indexer block. Contracts aren't upgradeable: a new protocol version is a new deployment, and you migrate by stopping new series on the old one and letting it expire.

## Local rehearsal

```bash
docker compose --profile local up --build     # chain + deploy + backend + web on :8080
npm run smoke                                 # host-run chain, deploy, backend, checks live quotes
```
