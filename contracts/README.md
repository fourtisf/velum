# Velum contracts (Phase 3: public, no privacy yet)

Foundry project for the on-chain core described in `docs/04-contracts-and-privacy.md` §1.
All code is original. OpenZeppelin 5.4.0 is used only for `IERC20`, `SafeERC20` and
`ReentrancyGuard` (vendored, unmodified, in `lib/openzeppelin-contracts`). forge-std 1.17.0 is
vendored for tests only.

**Testnet only.** `script/Deploy.s.sol` refuses Robinhood Chain mainnet (4663): mainnet needs the
Phase 5 external audit of contracts and circuits.

The November 2026 internal audit (`docs/audit/2026-11-internal.md`) findings F-01 to F-08, F-10 to F-13
and I-1 are fixed or mitigated here, and so are the second-round findings R2-01 to R2-07; see
[Audit hardening](#audit-hardening-2026-11). Each fix has a regression that runs the original exploit:
`test_Fxx_fixed_*` in `test/audit/AuditPoC.t.sol`, `test_R2_xx*_fixed*` in `test/audit/Round2PoC.t.sol`.

## Architecture

```
            deposit / withdraw (public "shield" / "unshield")
 user ───────────────────────────────► VelumVault ◄──── holds every token
   │                                     ▲  internal balances per (account, token)
   │ setApproval(module)                 │  modules move balances, never tokens
   ▼                                     │
 SpotPools ──┐   MakerBook ──┐   PerpsMarkets (Funding · Liquidation · ForcedExit)
 x*y=k, 0.30%│   offers, USDG│   isolated-margin taker/maker pairs, insurance fund
             └───────────────┴──────────► OracleAdapter (Chainlink feed or testnet relay)
```

| Contract | File | Responsibility |
|---|---|---|
| `VelumVault` | `src/VelumVault.sol` | Holds all tokens. `deposit` (fee-on-transfer safe) / `withdraw` from your own balance. A deposit may not be credited to an address that can never withdraw: a module, the vault itself, a listed token, or a protocol address fixed at setup (the oracle). A withdrawal may not be sent to the vault itself. Modules may only debit themselves or accounts that approved them. Tokens, modules and blocked recipients fixed by a one-time `setup`, then locked: no owner, no pause, no upgrade. |
| `OracleAdapter` | `src/OracleAdapter.sol` | One source per token: Chainlink AggregatorV3 (decimals scaled to 1e18, answer > 0) guarded by the L2 sequencer-uptime feed, or a testnet price-relay address. Every reported price is **rate-limited** against the last recorded price: at most 5% × dt / 5 min per recording (dt capped at 5 minutes), so 1/6000 per second, 1% per minute, and never more than 5% at once. `price()` reverts if older than 60 s or outside fixed bounds; `read()` and `poke()` also record the reading (new last price, `lastValidAt`). A failed or out-of-bounds read is stale; `isDead()` only after 14 days without any valid price. Relay updates: at most one per token per second. |
| `SpotPools` | `src/SpotPools.sol` | Constant-product Stock/USDG pools. A 30 bps fee stays in the pool, and a stock→stock swap routes through USDG in one call, paying two fees. LP shares are tracked internally. The first deposit locks 1,000 shares against inflation attacks. Reserves are state variables, so donations can't skew them. |
| `MakerBook` | `src/MakerBook.sol` | Standing offers: backing (USDG), largest single fill (≤ backing), open spread (2 bps to 5%) and close spread (≤ 5%), expiry. The maker can withdraw unused backing at any time. Only `PerpsMarkets` can allocate backing to a fill. |
| `PerpsMarkets` | `src/PerpsMarkets.sol` + `src/perps/*` | Pairs between a taker and the maker of the chosen offer. Open, close (any time, no maker signature), add/remove margin, funding, liquidation, forced exit, an insurance fund with deferred pro-rata shortfall cover (`PerpsCover`), and an optional close-only switch held by a guardian. |

### Perps model

- **Units:** prices are USDG per token × 1e18 and `qty` is tokens × 1e18. Margins, fees and payouts are USDG base units (6 decimals). `valueScale = 10^(36 − usdgDecimals)`.
- **Open** (size `S`, leverage `L` from 1x to 5x in 0.5 steps, passed as `leverageHalf = 2L`):
  - entry = oracle × (1 ± open spread), always worse for the taker;
  - takerMargin = S/L, which is at least the initial margin of 20% = 1/maxL;
  - makerMargin = S/maxL, taken from the offer;
  - fee = 0.06% × S, paid to insurance;
  - qty = S/entry, at most 100 tokens; each side of a market has its own open-interest cap; S ≥ 10 USDG;
  - needs a price at most **10 s** old that is not lagging, the sequencer up past its grace period, and
    the market not in close-only.
- **Claims:** the taker's claim is `takerMargin + pnl(P) − funding`, and the maker's claim is the rest of the pool. Claims always sum to the pool, so value is conserved and payouts are capped by posted margins.
- **Close:** needs a price up to 60 s old that is **not lagging** (on every route). A plain close settles at oracle ∓ the maker's committed close spread, with a 0.06% fee on exit notional: the taker gets `max(0, claim − fee)`, capped by the pool, and the maker gets the rest. If the position is liquidatable at that moment (and the sequencer allows liquidations), the close settles as a liquidation instead, with the taker as liquidator, so an insolvent counterparty's shortfall becomes a cover claim instead of being forfeited. That route uses the oracle price with no close spread and no fee; a losing taker pays the 1% liquidation penalty and gets the liquidator half (0.5% of notional) back. `priceLimit` is checked against the spread-adjusted exit before either route and does not account for the penalty.
- **Funding:** `rate = 0.01%/h × (longOI − shortOI) / (longOI + shortOI)`, using taker open interest. It accrues per second and is updated on every action and by anyone via `advanceFunding`.
- **Liquidation:** anyone can liquidate when either side's claim is below the 10% maintenance margin (0.5/maxL) at a price up to 60 s old. A lagging price is accepted: the loser is then settled at the effective price, and since it is liquidatable its claim there is under 10% of notional, so relative to the source price it keeps less than 9% of notional (claim minus the 1% penalty), and the winner's cover claim is smaller by the same amount. The side with the smaller claim pays a penalty of 1% of notional, split 50/50 between the liquidator and insurance. If the loser cannot pay the full penalty, insurance tops the liquidator up to half the full penalty, at most 1 USDG, drawn against the epoch's cover cap (below). A shortfall is paid later as a deferred cover claim.
- **Shortfall cover (`PerpsCover`):** the winner of an insolvent liquidation gets the whole pool at once; the shortfall is filed as a claim in the current hourly epoch. Each epoch has a cap of 10% of the insurance fund as it stood at the epoch's first draw. Keeper top-ups (paid at once) and cover for filed claims (reserved in `coverReserved` at once, paid later) both draw on that cap, in the order they happen. After the epoch ends anyone may call `settleCoverEpoch` / `claimCover`: each claimant gets `claim × budget / claims`, where the budget is the cover reserved during the epoch, and the rest is a haircut to the winner. Rounding dust returns to the fund with the last claim.
- **Forced exit:** taker or maker posts a 0.001 ETH bond. After 7 days anyone settles at the oracle price with no spread, fee or penalty, or at the entry price if the oracle is dead. A position that is liquidatable at settlement is liquidated instead (penalty applies, the settler gets the liquidator reward); otherwise a lagging price is refused. The bond is refunded whenever the position closes; a failed refund can be claimed later with `claimBond`.

### Events (for the indexer)

| Contract | Events |
|---|---|
| `VelumVault` | `Deposited`, `Withdrawn`, `ModuleApproval`, `InternalTransfer` |
| `SpotPools` | `PoolChanged` (after every reserve change), `LiquidityAdded`, `LiquidityRemoved`, `Swapped` |
| `MakerBook` | `OfferPosted`, `OfferFilled`, `OfferWithdrawn` |
| `PerpsMarkets` | `PositionChanged` (`Action`: Open, Close, AddMargin, RemoveMargin, Liquidate, ForcedExit), `PositionSettled` (`fee` = close fee, or the penalty on liquidation), `Liquidated` (`shortfall` = amount claimed), `FundingAdvanced` (only when the index is current), `InsuranceFunded`, `ForcedExitRequested`, `ForcedExitSettled`, `BondRefundDeferred`, `BondClaimed`, `CloseOnlySet`, `CoverClaimFiled`, `CoverEpochSettled` (the budget fixed while the epoch ran), `CoverPaid` |
| `OracleAdapter` | `PriceRelayed` (pushed and rate-limited price) |

## Invariants (tested in `test/invariant/`)

1. Tokens leave the vault only through `withdraw`: vault holdings always equal net deposits.
2. The internal balances of all accounts (users, pools, offers, margins, insurance, reserved cover) sum to the vault's holdings, and each module's vault balance matches its own books (perps: `totalMargin + insurance + coverReserved`).
3. A liquidation never pays more than the posted margins plus the insurance fund; shortfall cover is never paid at liquidation (only the ≤ 1 USDG keeper top-up), and no epoch's top-ups plus cover exceed 10% of the fund as it stood at the epoch's first draw.
4. Closing the whole book returns every unit. After all positions close, every cover claim is paid, offers are withdrawn and liquidity is removed, only insurance and the locked pool dust remain outside user balances.
5. Reserved cover equals the unpaid budgets of epochs with unpaid claims, outstanding claims equal the claims recorded, settling never changes a budget, and guardian actions never move funds.

Each run also checks that open interest equals the sum of open positions. The handler opens, closes, liquidates and force-exits positions, moves prices (mostly slowly enough for the rate limit, a quarter of the time in one second so the price lags), simulates keeper-free gaps of 15-40% (shortfall claims), pays cover claims, toggles close-only as the guardian, jumps time, swaps and adds or removes liquidity.

## Commands

Foundry 1.5.1 and solc 0.8.28 are required. Use `--offline` if `binaries.soliditylang.org` is blocked and solc 0.8.28 is in `~/.svm`.

```bash
cd contracts
forge build
forge test                      # 126 tests: unit, fuzz (512 runs), invariants (64 × 128)
FOUNDRY_PROFILE=ci forge test   # fuzz 4096 runs, invariants 256 × 256
forge coverage --report summary --no-match-path "test/invariant/*"
forge fmt --check
forge snapshot                  # writes .gas-snapshot
```

`forge build --sizes` leaves out the five production contracts: Foundry treats any contract with a
`setup()` function as a test contract. Measure them with
`forge inspect <Contract> deployedBytecode` (PerpsMarkets is 16,383 bytes, about 16.0 KB of the 24 KB limit).

To deploy locally on anvil (mock USDG with 6 decimals, TSLA and AMZN with 18, starting prices pushed):

```bash
anvil &
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key>
cat deployments/31337.json
```

To deploy on Robinhood Chain testnet (46630), the token addresses come from `packages/config/robinhood-testnet.json`:

```bash
PRICE_RELAYER=<price-relay worker address> \
forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast --private-key <funded testnet key>
```

`PRICE_RELAYER` is required on testnet and must be a dedicated key, not the deployer: the script refuses
otherwise (audit F-04). The oracle is set up relay-only, with no sequencer feed. This writes
`deployments/46630.json` with the chain ID, contract addresses, tokens, relayer, guardian and start block.
Optional settings: `GUARDIAN` (close-only switch, default none; see [Emergency controls](#emergency-controls)),
`OI_CAP_TOKENS` (default 10,000 per side), `PRICE_MIN_USD` and `PRICE_MAX_USD` (default 1 and 100,000),
and `USDG_ADDRESS` + `STOCK_ADDRESSES` + `STOCK_SYMBOLS` to override the token list. Without `GUARDIAN`
the script prints a warning, before deploying and again as its last line, that no market can be put in
close-only and the split/dividend procedure is therefore unavailable for that deployment. Every contract
locks itself during the script; apart from the optional guardian's close-only switch there is nothing to
administer afterwards.

## Intentional simplifications vs docs/04 (Phase 3)

- **Matching is atomic.** A taker opens directly against a chosen standing offer. There is no lock-then-fill step, so the 15-minute maker fill window and refund (a Phase 4 coordinator flow) don't apply yet.
- **Maker margin per fill is S/maxL** (initial margin). Taker profit on a single position is therefore capped by that margin; beyond about a 10% move the maker side becomes liquidatable and the taker realises the profit through liquidation.
- **Shortfall cover is per hourly epoch, pro rata and capped** at 10% of the fund at the epoch's first draw, shared with keeper top-ups (docs/04 says "pro rata after next funding"; the epoch is the hour, and the cap is new).
- **Fees go to the insurance fund.** There is no treasury and no admin.
- **Funding runs within the hour by construction.** "Funding must have run within the last hour" holds because every open accrues funding first; there is no separate staleness gate.
- **Forced exit is available to both sides,** so a maker can't be stuck if the taker never closes.
- **Testnet prices are relay-sourced.** The Chainlink testnet feed addresses haven't been verified, so the deploy script configures every stock as relay-sourced, bounded and rate-limited.

## Audit hardening (2026-11)

| Finding | Change | Where |
|---|---|---|
| F-01 | Pull-only forced-exit bond refunds (`claimBond`) | `PerpsBase._refundBond`, `PerpsForcedExit.claimBond` |
| F-02 | Shortfalls become deferred cover claims: per hourly epoch, pro rata, capped at 10% of the fund (shared with keeper top-ups since R2-02), remainder a haircut. With the rate limit (R2-01) a gap alone can't create a shortfall, and the self-paired straddle loses money | `PerpsCover`, `PerpsLiquidation._liquidateAt` |
| F-03 | `lastValidAt` per token, recorded by `read` (every perps accrual), `poke` (anyone) and `pushPrices`. Failed/out-of-bounds reads are stale; dead only 14 days after `max(lastValidAt, setupAt)` | `OracleAdapter` |
| F-04 | Every source is rate-limited: 1/6000 per second from the last recorded price, at most 5% per recording (R2-01 replaced the first-round ±10% band). Deploy refuses testnet without a dedicated `PRICE_RELAYER` | `OracleAdapter._record/_limit`, `Deploy.checkRelayer` |
| F-05 | Sequencer-uptime feed (setup parameter, required with Chainlink feeds; zero = relay only). Down or < 1 h since back up: opens, liquidations and margin removal blocked; close and add margin allowed | `OracleAdapter.sequencerReady`, `PerpsMarkets` |
| F-06 | Opens need a price ≤ 10 s old (closes/liquidations 60 s); maker open spread ≥ 2 bps | `PerpsBase.OPEN_MAX_AGE`, `MakerBook.MIN_OPEN_SPREAD_BPS` |
| F-07, F-13 | Optional guardian (fixed at setup) can only switch a market into or out of close-only. Off by default; the deploy script warns loudly when `GUARDIAN` is unset (round 2) | `PerpsMarkets.setCloseOnly`, `Deploy.guardianNotice` |
| F-08 | Forced exit of a liquidatable position settles as a liquidation (penalty applies) | `PerpsForcedExit.settleForcedExit` |
| F-10 | Minimum position size 10 USDG (residual: OI-cap filling costs 40% of the capped notional in margin) | `PerpsMarkets.open` |
| F-11 | Keeper top-up from insurance when the loser can't pay the full penalty: up to half the full penalty, ≤ 1 USDG, within the epoch's cover cap | `PerpsLiquidation._liquidateAt` |
| F-12 | Closing a liquidatable position settles it as a liquidation, so cover is never forfeited (at a lagging price the winner uses `liquidate`) | `PerpsMarkets.close` |
| I-1 | `deposit(..., to = module)` refused | `VelumVault.deposit` |
| nits | `PositionSettled.fee` = penalty on liquidation; no `FundingAdvanced` from a dead-oracle settlement; `removeMargin` oversize → `ExceedsMargin` | |
| F-09 | Not changed (accepted Low, see limitations) | `test_F09_washTradeStillMovesFundingWithinCap` |

### Second round (2026-11, `test/audit/Round2PoC.t.sol`)

| Finding | Change | Regressions |
|---|---|---|
| R2-01 (Medium) | The ±10% band around a reference fixed for 10 minutes (one push could move +22%, two records around an attacker-timed roll +21%) is replaced by a rate limit against the last recorded price: `maxMove = last × 5% × min(dt, 5 min) / 5 min`. `poke` is a recording like any other | `testFuzz_R2_01_fixed_noSideInsolventWithin12MinOfAnyNonLaggingOpen`, `test_R2_01_fixed_extremePathsKeepFiveXSolventFor12Min`, `test_R2_01_fixed_worstCaseInsolvencyTime`, `testFuzz_R2_01_fixed_notLiquidatableSurvivesAnyNextRecording`, `test_R2_01_fixed_relayerExtractionPerMinuteBounded`, `test_R2_01a_fixed_relayerOscillationCannotDrainHonestMaker`, `testFuzz_R2_01_fixed_openAnywhereThenOppositeExtremeStaysSolvent`, `test_R2_01b_fixed_gapNearOldWindowRollStraddleUnprofitable`, `testFuzz_limit_everyRecordingWithinLimit` |
| R2-02 (Low) | Keeper top-ups draw on the epoch's cover cap, ahead of the cover reserved for that liquidation's shortfall | `test_R2_02_fixed_keeperTopUpsCountAgainstEpochCap` |
| R2-03 (Info) | The cap is fixed at the epoch's first draw and draws leave the fund at once, so the budget no longer depends on who settles or when. Real bound: 10% per epoch, 19% for an event spanning two epochs, 1 − 0.9^k over k epochs | `test_R2_03_fixed_capFixedAtFirstDrawAndTwoEpochsAtMost19Percent` |
| R2-04 (Low) | `close()` refuses a lagging price before routing to liquidation; third-party keepers still liquidate. Bound for any liquidation at a lagging price documented (< 9% of notional) | `test_R2_04_fixed_closeRefusedAtLaggingPriceKeepersStillLiquidate`, `test_R2_04_fixed_winnerAtLaggingPriceKeepsCoverThroughLiquidate` |
| R2-05 (Info) | `deposit` refuses the vault itself, listed tokens and a deny-list fixed at setup (the deploy script passes the oracle); `withdraw` refuses the vault as recipient | `test_R2_05_fixed_depositToProtocolContractsRefused` |
| R2-06 (Info) | README corrected: a close is not risk-free for the maker (see "Why these choices") | — |
| R2-07 (Info) | README and NatSpec corrected: penalty on a losing taker's close-as-liquidation, and `priceLimit` covers the spread-adjusted exit only | `test_R2_07_closeAsLiquidationPaysPenaltyNotSpread` |
| F-07 (incomplete) | Deploy keeps the guardian off by default but reads `GUARDIAN` and warns loudly when it is unset | `test_F07_fixed_deployWarnsWithoutGuardian` |

### New parameters (constants; not in CLAUDE.md §5, which is unchanged)

| Parameter | Value | Contract |
|---|---|---|
| Price rate limit | 5% per recording at most (`MAX_MOVE_BPS` = 500) | `OracleAdapter` |
| Rate-limit window | 5 minutes (`MOVE_WINDOW`): the move allowed grows linearly with time since the last recording up to this, so 1/6000 per second, 1% per minute | `OracleAdapter` |
| Sequencer grace | 1 hour (`SEQUENCER_GRACE`) | `OracleAdapter` |
| Open price age | 10 s (`OPEN_MAX_AGE`); closes, liquidations, funding 60 s (`MAX_PRICE_AGE`) | `PerpsBase` |
| Cover epoch | 1 hour (`COVER_EPOCH`) | `PerpsBase` |
| Cover cap per epoch | 10% of the insurance fund at the epoch's first draw, top-ups included (`COVER_CAP_BPS`) | `PerpsBase` |
| Minimum position | 10 USDG (`minPositionSize`) | `PerpsBase` |
| Keeper top-up cap | 1 USDG (`keeperRewardCap`) | `PerpsBase` |
| Minimum open spread | 2 bps (`MIN_OPEN_SPREAD_BPS`) | `MakerBook` |

### Why these choices

- **Rate limit on both sources, relative to the last recorded price (R2-01).** A claim moves by `qty × Δprice`; a 5x side starts with a 20% margin and is liquidated below 10% of notional. The limit gives these guarantees (tests in `test/audit/Round2PoC.t.sol`):
  - **Open to insolvency ≥ 12 minutes.** No side of a pair opened at any non-lagging price (after any history, at any leverage, side, size and open spread the book allows) can fall below zero within 12 minutes of the open, whatever the source reports. The tight worst case is a 5x short at the 5% maximum open spread, 13.1 minutes (787 s) of a recording every second at the limit; at the 2 bps minimum spread it is 18.2 minutes (1,093 s).
  - **Keeper window.** A side that is not liquidatable at a recorded price needs a 10% adverse move to reach zero: never in one recording (≤ 5%), and at least 9.5 minutes of recordings (10% up takes ln 1.1 / ln(1 + 1/6000) = 572 s). It follows (`testFuzz_R2_01_fixed_notLiquidatableSurvivesAnyNextRecording` checks the one-step bound) that between its last non-liquidatable recording and its first insolvent one there are always at least 60 s of fresh prices at which it is liquidatable and solvent: the recording just before insolvency is one, and if recordings come faster than once a minute the 10% takes at least 9.5 minutes of fresh prices. The R2-01b regression measures 572 s. In that window the position offers a 0.5% of notional liquidation reward.
  - **Compromised relay key.** Prices move at most 1.005% per minute, so an honest 5x maker's claim falls by at most 5.5% of its margin per minute while it is above maintenance. It cannot be made liquidatable sooner than 8.7 minutes after the open (measured 526 s) or insolvent sooner than 18 minutes. Doubling a price takes at least 69 minutes. Opens and closes at a jumped price are refused as lagging, so the in-window oscillation of R2-01 is gone.
  - **Parameters.** 5% per recording is half the 10% maintenance cushion. 1% per minute keeps the first round's average speed (10% per 10 minutes), so honest gaps catch up as before: a 30% gap takes about 20-35 minutes. A slower limit would halve the relay-key bound but refuse most opens in normal markets (see limitations).
- **Lagging prices.** While a source is outside the limit, the reported price is a known-wrong, catching-up value. Opens, closes (on both routes, R2-04), forced exits that are not liquidations and margin removal at it are refused: they would be free options against the counterparty. Liquidations and funding go on, because they reduce risk. A loser liquidated at a lagging price keeps less than 9% of notional relative to the source price. Anyone can call `liquidate`, the loser included, but it then gains only the 0.5% keeper half a third party would get.
- **10 s opens, 2 bps floor (F-06).** Two-step (commit/fill) opens would remove the option entirely but need a coordinator flow (Phase 4). With opens limited to 10 s old prices, the remaining option is worth less than the minimum taker round trip (≥ 2 bps open spread + 6 bps fee in, 6 bps fee out). Closes keep 60 s. That is not risk-free for the maker (R2-06): at a price up to 60 s old the taker holds an exit option worth the market's move since that price, minus the close spread and the 6 bps fee. It is bounded because a pushed jump beyond the rate limit makes the price lagging, and lagging closes are refused. 60 s is kept so closes don't fail whenever the relay is a few seconds late. Makers price the option into their close spread.
- **Cover cap (R2-02, R2-03).** One epoch's keeper top-ups plus cover draw at most 10% of the fund as it stood at the epoch's first draw. That 10% is shared pro rata with every honest claimant of the same hour, and claims never carry over, so the fund cannot be queued out. Draws leave the fund at once. So an event spanning two epochs takes at most 19% (10% + 10% of the remaining 90%), and k consecutive epochs at most 1 − 0.9^k of the fund. Fees earned in between add to the base.

## Emergency controls

`PerpsMarkets.setup(markets, oiCaps, guardian)` takes an optional **guardian** (zero = none, which is
what the deploy script does unless `GUARDIAN` is set). The guardian can call exactly one function,
`setCloseOnly(market, on)`: in close-only, `open` reverts; close, add/remove margin, liquidation, forced
exit, funding and cover claims work as usual. The guardian cannot move, freeze or redirect funds, change
prices, parameters or the guardian itself. Setting a guardian is an emergency control the project owner
must sign off on; leaving it zero keeps the contracts fully admin-free.

**Without a guardian the corporate-actions procedure below cannot run** (nothing can stop new opens
before a split or dividend). The deploy script therefore prints a warning, before deploying and again
as its last line, whenever `GUARDIAN` is unset. The guardian is fixed at setup, so enabling it later
means redeploying.

**Corporate actions procedure (splits, reverse splits, dividends).** The perps engine settles on the
oracle price only; it has no split factor or dividend adjustment, and the oracle's absolute price
bounds are immutable.

1. Before the event (ex-date or split effective date), the guardian sets the market to close-only, and
   makers withdraw offers.
2. Positions are settled before the event: takers close; anyone can liquidate; makers use forced exit
   (7 days, so request it at least 7 days ahead) for takers that do not close.
3. After the event, confirm the token mechanics (does the stock token rebase, airdrop or change price?)
   and that the new price is within the market's immutable oracle bounds and that the rate-limited price
   has caught up (not lagging). Then the guardian lifts close-only.

A split that moves the price outside the oracle bounds makes that market's price permanently stale
(dead after 14 days): settle it fully first and redeploy the market. Deploy with wide bounds (default
1 to 100,000 USDG) to keep normal splits inside them. A split inside the bounds is walked by the rate
limit at 1% per minute (a 2-for-1 split takes about 70 minutes to catch up), which is why the market
must be empty first.

## Known limitations and risks (review before any audit)

- **Relayer trust (testnet).** A compromised relay key can still move a price, but only at 1% per minute (5.5% of a 5x maker's margin per minute, doubling in ≥ 69 minutes). Makers cannot close a filled position themselves, so committed margin stays exposed at that rate until the taker closes, a keeper liquidates, or a forced exit matures. Production must use verified Chainlink feeds with the sequencer-uptime feed (implemented) or a low-latency verified oracle.
- **Production oracle choice is open.** Opens need a price at most 10 s old. Chainlink push feeds for stocks update on deviation or heartbeat, so with them opens would revert most of the time; production needs a low-latency verified source (for example a pull oracle verified at open), which changes the adapter. Choose before the external audit.
- **Lagging in normal markets (owner decision).** Because "lagging" means the effective price differs from the source at all, ordinary volatility faster than 1% per minute over the push interval makes opens and closes revert until the price catches up. A simulation at TSLA-like volatility (0.19% per minute) puts the share of reads that see a lagging price at 58% with 1-s pushes, 38% with 2 s, 14% with 5 s and 3% with 10 s. At double that volatility it is 86%, 76%, 54% and 35%. Refusing then is protective (the on-chain price is behind the market, so opening at it would be a free option), but users see retries. The price-relay worker should push about every 5-8 s (opens need ≤ 10 s), and the UI should retry an open after a fresh push. Alternatives for the owner: a faster limit (2% per minute: about 0.2% of reads lagging at 5-s pushes, but twice the relay-key bound and keeper windows half as long); or a small lag tolerance for opens executed at the worse of the two prices for the taker (changes the lagging rule). A slower limit (0.5% per minute) is safer but refuses 32-85% of opens in normal markets, depending on the push interval.
- **Lag after real gaps.** With the limit on Chainlink too, a 30% opening gap is reported over about 20-35 minutes (the first recording moves 5%, then 1% per minute); opens and closes wait, liquidations proceed at the effective price (a loser keeps under 9% of notional more than at the true price). An owner may prefer raw feed prices plus a market-hours close-only policy instead; that reopens the F-02 straddle around gaps (bounded by the epoch cap).
- **Worst-case cover (F-02 residual).** If keepers stay away for more than 9 minutes of liquidatable, solvent prices (at least 60 s of them fresh), a self-paired straddle can still end insolvent and claim cover. It gets at most its pro-rata share of 10% of the fund per epoch, minus its fees, and only by forgoing a 0.5% liquidation reward that any keeper can take (`test_R2_02_fixed_keeperTopUpsCountAgainstEpochCap`: +6.76 USDG on a 103.6 USDG fund). Run at least one keeper (Phase 4 risk workers) per market. Once an epoch's cap is used up, keepers of further insolvent positions get no top-up in that epoch; the winning side still gains the pool by liquidating.
- **Funding wash trading (F-09, accepted).** Funding follows global taker skew, so a self-paired position can move (even flip) the rate. It stays within the 0.01%/h cap and costs the attacker fees plus 40% of the wash size in locked margin; any genuinely large one-sided trader moves it the same way. A clean fix needs identity or a different funding model (Phase 4 coordinator).
- **Open-interest caps (F-10 residual).** Self-paired positions can fill a side's cap. The minimum size stops dust; filling a cap still costs 40% of the capped notional in margin plus fees. Size caps so that cost is prohibitive.
- **60-second freshness vs stock feeds.** Outside market hours prices go stale, so opens, closes, liquidations and funding revert with `StalePrice`. That is deliberate (no trading on stale prices), but liquidations pause too; the rate limit then walks the first prices after the reopen.
- **Sequencer downtime.** While the sequencer is down or in its grace hour, liquidations wait; closes at a non-lagging price still work as plain closes (a liquidatable position closed then pays the close spread and fee, not the penalty, and an insolvent counterparty's cover is forfeited in that window).
- **Dead-oracle forced exits.** These settle without accruing funding. The market's rate is then reset from the new open interest and applied to the whole gap at the next accrual, a small inaccuracy that only arises in a market with no price for 14 days.
- **Spot pools are public AMMs in Phase 3.** Trades can be sandwiched; `minOut` and the deadline are the protection. The first LP sets the starting price.
- **One-time approvals.** Users must call `vault.setApproval(module, true)` once per module before trading. The UI should batch this with the first deposit.
- **`startBlock` in the deployments JSON** is the block the script simulated against. The indexer should start from the deployment receipts in `broadcast/` if exact.
- **License and EVM target.** The license is left as `UNLICENSED`; the project owner should choose one before verifying on an explorer. `evm_version = cancun`: Robinhood Chain runs a recent Arbitrum Nitro (v3.11 per the docs), but confirm with a first testnet deployment.
