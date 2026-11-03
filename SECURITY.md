# Security

**Weekend Options is not audited.** Don't put meaningful funds into it until it has been.

## Model

- **Fully collateralized.** Every ask is backed by locked stock or USDC, every bid by USDC. No margin, no protocol-level liquidations, no bad debt from option positions.
- **Oracle-free exercise.** Upside and Floor holders can always exercise physically before expiry. The oracle only decides what happens to options nobody exercised.
- **Settlement price** is the time-weighted average of samples in a 600s window after expiry. With `PythSettlementOracle` anyone can submit signed Pyth updates (confidence and staleness bounded). If no price arrives within 7 days, unexercised options settle worthless, which a holder could always have avoided by exercising.
- **Pause** is limited to new risk. Exits are never blocked.
- **Admin** is `Ownable2Step` everywhere. Hand ownership to a multisig after deploy (see DEPLOY.md).
- **Fill hooks** run in `try/catch` with a fixed gas budget and a `gasleft` guard. A failing or gas-griefing hook can't block a fill. Hooks can only be contracts.
- **Book bounds.** 64 quotes per side per series, a minimum size, and eviction of the worst quote keep matching gas bounded.
- **RFQ** is EIP-712 with nonces, deadlines and ERC-1271 support. The backend caps outstanding signed size.
- **Token handling.** Deposits credit the balance delta, so fee-on-transfer tokens can't inflate balances. Rebasing tokens are **not** supported: use wrapped, non-rebasing xStocks.

## Trust assumptions

| Who | Can | Can't |
|---|---|---|
| Owner | set guardian, hook gas, oracle reporters, vault rules within bounds; unpause | move user funds, change existing series, block exits |
| Guardian | pause new risk | unpause, move funds |
| Reporter (reporter oracle only) | post spot and settlement samples | anything else; use Pyth on live networks to remove this trust |
| Keeper | trigger settlement, payouts to their rightful owners, vault rounds, liquidations of unhealthy loans | redirect payouts |
| Makers | quote, cancel, withdraw free balance | touch others' collateral |

## Known limits before real money

- **Not audited.** Contracts have tests (`npm test`) but no external review.
- **Kuru Flow.** The hedger's Kuru integration follows the public API (generate-token, quote, then send the returned tx). The amount format (`KURU_AMOUNT_FORMAT`) and response fields haven't been checked against the live mainnet API. Run with `HEDGE_MODE=off` until they have.
- **xStocks multiplier.** `PythSettlementOracle` reads the multiplier through `IMultiplierToken.multiplier()`. Confirm the actual function on the wrapper you use before setting `MULTIPLIER_SOURCES`.
- **Corporate actions** are handled through the multiplier on raw tokens. Rebasing balances would break collateral accounting.
- **ShieldedLender** shows the integration pattern (a lender buying a Floor from inside the loan). It isn't a production money market: there are no interest rates and liquidation is simple.
- **GapMarket** refunds a round when one side is empty. It's a pooled market with no oracle manipulation protection beyond the settlement window.
- **Gas.** Matching against a full book has not been benchmarked on Monad under load.
- **Docker images** were validated in an environment where public registries were blocked, using equivalent locally built base images. Build once on a normal host and pin the base image digests.
- **Compliance.** Options on tokenized US equities need the same geographic restrictions as the underlying xStocks. The app ships no geofencing.

## Reporting

Email leofranklinjohn.25cs@licet.ac.in with details and a reproduction. Please don't open a public issue for a vulnerability.
