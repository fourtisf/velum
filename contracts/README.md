# Velum contracts (Phase 3: public, no privacy yet)

Foundry project for the on-chain core described in `docs/04-contracts-and-privacy.md` §1.
All code is original. OpenZeppelin 5.4.0 is used only for `IERC20`, `SafeERC20` and
`ReentrancyGuard` (vendored, unmodified, in `lib/openzeppelin-contracts`). forge-std 1.17.0 is
vendored for tests only.

**Testnet only.** `script/Deploy.s.sol` refuses Robinhood Chain mainnet (4663): mainnet needs the
Phase 5 external audit of contracts and circuits.

The November 2026 internal audit (`docs/audit/2026-11-internal.md`) findings F-01 to F-08, F-10 to F-13
and I-1 are fixed or mitigated here; see [Audit hardening](#audit-hardening-2026-11). Each fix has a
`test_Fxx_fixed_*` regression in `test/audit/AuditPoC.t.sol` that runs the original exploit.

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
| `VelumVault` | `src/VelumVault.sol` | Holds all tokens. `deposit` (fee-on-transfer safe) / `withdraw` from your own balance. A deposit may not be credited to a module (it would be stranded). Modules may only debit themselves or accounts that approved them. Tokens and modules fixed by a one-time `setup`, then locked: no owner, no pause, no upgrade. |
| `OracleAdapter` | `src/OracleAdapter.sol` | One source per token: Chainlink AggregatorV3 (decimals scaled to 1e18, answer > 0) guarded by the L2 sequencer-uptime feed, or a testnet price-relay address. Every reported price is **banded**: at most ±10% from a reference that moves at most once per 10 minutes. `price()` reverts if older than 60 s or outside fixed bounds; `read()` also records the reading (band, `lastValidAt`). A failed or out-of-bounds read is stale; `isDead()` only after 14 days without any valid price. Relay updates: at most one per token per second. |
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
- **Close:** at oracle ∓ the maker's committed close spread, with a 0.06% fee on exit notional, at a price up to 60 s old that is not lagging. The taker gets `max(0, claim − fee)`, capped by the pool, and the maker gets the rest. If the position is liquidatable at that moment (and the sequencer allows liquidations), the close settles as a liquidation instead, with the taker as liquidator, so an insolvent counterparty's shortfall becomes a cover claim instead of being forfeited.
- **Funding:** `rate = 0.01%/h × (longOI − shortOI) / (longOI + shortOI)`, using taker open interest. It accrues per second and is updated on every action and by anyone via `advanceFunding`.
- **Liquidation:** anyone can liquidate when either side's claim is below the 10% maintenance margin (0.5/maxL) at a price up to 60 s old (a lagging banded price is fine). The side with the smaller claim pays a penalty of 1% of notional, split 50/50 between the liquidator and insurance. If the loser cannot pay the full penalty, insurance tops the liquidator up to half the full penalty, at most 1 USDG. A shortfall is paid later as a deferred cover claim (below).
- **Shortfall cover (`PerpsCover`):** the winner of an insolvent liquidation gets the whole pool at once; the shortfall is filed as a claim in the current hourly epoch. After the epoch ends anyone may call `settleCoverEpoch` / `claimCover`: the epoch budget is `min(claims, 10% × insurance)`, each claimant gets `claim × budget / claims`, and the rest is a haircut to the winner. Rounding dust returns to the fund with the last claim.
- **Forced exit:** taker or maker posts a 0.001 ETH bond. After 7 days anyone settles at the oracle price with no spread, fee or penalty, or at the entry price if the oracle is dead. A position that is liquidatable at settlement is liquidated instead (penalty applies, the settler gets the liquidator reward). The bond is refunded whenever the position closes; a failed refund can be claimed later with `claimBond`.

### Events (for the indexer)

| Contract | Events |
|---|---|
| `VelumVault` | `Deposited`, `Withdrawn`, `ModuleApproval`, `InternalTransfer` |
| `SpotPools` | `PoolChanged` (after every reserve change), `LiquidityAdded`, `LiquidityRemoved`, `Swapped` |
| `MakerBook` | `OfferPosted`, `OfferFilled`, `OfferWithdrawn` |
| `PerpsMarkets` | `PositionChanged` (`Action`: Open, Close, AddMargin, RemoveMargin, Liquidate, ForcedExit), `PositionSettled` (`fee` = close fee, or the penalty on liquidation), `Liquidated` (`shortfall` = amount claimed), `FundingAdvanced` (only when the index is current), `InsuranceFunded`, `ForcedExitRequested`, `ForcedExitSettled`, `BondRefundDeferred`, `BondClaimed`, `CloseOnlySet`, `CoverClaimFiled`, `CoverEpochSettled`, `CoverPaid` |
| `OracleAdapter` | `PriceRelayed` (pushed and banded price) |

## Invariants (tested in `test/invariant/`)

1. Tokens leave the vault only through `withdraw`: vault holdings always equal net deposits.
2. The internal balances of all accounts (users, pools, offers, margins, insurance, reserved cover) sum to the vault's holdings, and each module's vault balance matches its own books (perps: `totalMargin + insurance + coverReserved`).
3. A liquidation never pays more than the posted margins plus the insurance fund; shortfall cover is never paid at liquidation (only the ≤ 1 USDG keeper top-up), and no epoch's cover budget exceeds 10% of the fund.
4. Closing the whole book returns every unit. After all positions close, every cover claim is paid, offers are withdrawn and liquidity is removed, only insurance and the locked pool dust remain outside user balances.
5. Reserved cover equals the unpaid budgets of settled epochs, outstanding claims equal the claims recorded, and guardian actions never move funds.

Each run also checks that open interest equals the sum of open positions. The handler opens, closes, liquidates and force-exits positions, moves prices (within and across band windows), simulates keeper-free gaps of 15-40% (shortfall claims), pays cover claims, toggles close-only as the guardian, jumps time, swaps and adds or removes liquidity.

## Commands

Foundry 1.5.1 and solc 0.8.28 are required. Use `--offline` if `binaries.soliditylang.org` is blocked and solc 0.8.28 is in `~/.svm`.

```bash
cd contracts
forge build
forge test                      # 110 tests: unit, fuzz (512 runs), invariants (64 × 128)
FOUNDRY_PROFILE=ci forge test   # fuzz 4096 runs, invariants 256 × 256
forge coverage --report summary --no-match-path "test/invariant/*"
forge fmt --check
forge snapshot                  # writes .gas-snapshot
```

`forge build --sizes` leaves out the five production contracts: Foundry treats any contract with a
`setup()` function as a test contract. Measure them with
`forge inspect <Contract> deployedBytecode` (PerpsMarkets is about 16.2 KB of the 24 KB limit).

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
and `USDG_ADDRESS` + `STOCK_ADDRESSES` + `STOCK_SYMBOLS` to override the token list. Every contract locks
itself during the script; apart from the optional guardian's close-only switch there is nothing to
administer afterwards.

## Intentional simplifications vs docs/04 (Phase 3)

- **Matching is atomic.** A taker opens directly against a chosen standing offer. There is no lock-then-fill step, so the 15-minute maker fill window and refund (a Phase 4 coordinator flow) don't apply yet.
- **Maker margin per fill is S/maxL** (initial margin). Taker profit on a single position is therefore capped by that margin; beyond about a 10% move the maker side becomes liquidatable and the taker realises the profit through liquidation.
- **Shortfall cover is per hourly epoch, pro rata and capped at 10% of the fund** (docs/04 says "pro rata after next funding"; the epoch is the hour, and the cap is new).
- **Fees go to the insurance fund.** There is no treasury and no admin.
- **Funding runs within the hour by construction.** "Funding must have run within the last hour" holds because every open accrues funding first; there is no separate staleness gate.
- **Forced exit is available to both sides,** so a maker can't be stuck if the taker never closes.
- **Testnet prices are relay-sourced.** The Chainlink testnet feed addresses haven't been verified, so the deploy script configures every stock as relay-sourced, bounded and rate-limited.

## Audit hardening (2026-11)

| Finding | Change | Where |
|---|---|---|
| F-01 | Pull-only forced-exit bond refunds (`claimBond`) | `PerpsBase._refundBond`, `PerpsForcedExit.claimBond` |
| F-02 | Shortfalls become deferred cover claims: per hourly epoch, pro rata, budget ≤ 10% of the fund, remainder a haircut. With the price band (F-04) a gap alone can't create a shortfall; the self-paired straddle now loses money | `PerpsCover`, `PerpsLiquidation._liquidateAt` |
| F-03 | `lastValidAt` per token, recorded by `read` (every perps accrual), `poke` (anyone) and `pushPrices`. Failed/out-of-bounds reads are stale; dead only 14 days after `max(lastValidAt, setupAt)` | `OracleAdapter` |
| F-04 | Price band on every source: ±10% from a reference that rolls at most once per 10 min to the last recorded price; the first price after a silence is capped. Deploy refuses testnet without a dedicated `PRICE_RELAYER` | `OracleAdapter._record/_clamp`, `Deploy.checkRelayer` |
| F-05 | Sequencer-uptime feed (setup parameter, required with Chainlink feeds; zero = relay only). Down or < 1 h since back up: opens, liquidations and margin removal blocked; close and add margin allowed | `OracleAdapter.sequencerReady`, `PerpsMarkets` |
| F-06 | Opens need a price ≤ 10 s old (closes/liquidations 60 s); maker open spread ≥ 2 bps | `PerpsBase.OPEN_MAX_AGE`, `MakerBook.MIN_OPEN_SPREAD_BPS` |
| F-07, F-13 | Optional guardian (fixed at setup) can only switch a market into or out of close-only | `PerpsMarkets.setCloseOnly` |
| F-08 | Forced exit of a liquidatable position settles as a liquidation (penalty applies) | `PerpsForcedExit.settleForcedExit` |
| F-10 | Minimum position size 10 USDG (residual: OI-cap filling costs 40% of the capped notional in margin) | `PerpsMarkets.open` |
| F-11 | Keeper top-up from insurance when the loser can't pay the full penalty: up to half the full penalty, ≤ 1 USDG | `PerpsLiquidation._liquidateAt` |
| F-12 | Closing a liquidatable position settles it as a liquidation, so cover is never forfeited | `PerpsMarkets.close` |
| I-1 | `deposit(..., to = module)` refused | `VelumVault.deposit` |
| nits | `PositionSettled.fee` = penalty on liquidation; no `FundingAdvanced` from a dead-oracle settlement; `removeMargin` oversize → `ExceedsMargin` | |
| F-09 | Not changed (accepted Low, see limitations) | `test_F09_washTradeStillMovesFundingWithinCap` |

### New parameters (constants; not in CLAUDE.md §5, which is unchanged)

| Parameter | Value | Contract |
|---|---|---|
| Price band | ±10% (`MAX_MOVE_BPS`) per reference window | `OracleAdapter` |
| Band window | 10 minutes (`MOVE_WINDOW`) | `OracleAdapter` |
| Sequencer grace | 1 hour (`SEQUENCER_GRACE`) | `OracleAdapter` |
| Open price age | 10 s (`OPEN_MAX_AGE`); closes, liquidations, funding 60 s (`MAX_PRICE_AGE`) | `PerpsBase` |
| Cover epoch | 1 hour (`COVER_EPOCH`) | `PerpsBase` |
| Cover cap per epoch | 10% of the insurance fund (`COVER_CAP_BPS`) | `PerpsBase` |
| Minimum position | 10 USDG (`minPositionSize`) | `PerpsBase` |
| Keeper top-up cap | 1 USDG (`keeperRewardCap`) | `PerpsBase` |
| Minimum open spread | 2 bps (`MIN_OPEN_SPREAD_BPS`) | `MakerBook` |

### Why these choices

- **Band on both sources.** A claim moves by `qty × Δprice`, and maintenance is 10% of notional. So if a position is not liquidatable at the band reference, no price inside the band (±10% of it) can push either side below zero (up to funding accrued within the window): a shortfall needs keepers to miss a whole 10-minute window in which the position offers a 0.5% liquidation reward (`testFuzz_F02_fixed_bandKeepsPairsSolventWithinWindow`). That closes F-02 at the root, and bounds a compromised relay key (F-04) to 10% per 10 minutes. Applying it to Chainlink too means production gaps (e.g. earnings) are walked in steps instead of jumped; see limitations.
- **Lagging prices.** While a source is outside the band, the reported price is a known-wrong, catching-up value. Opens, plain closes, forced exits and margin removal at it are refused (they would be free options against the counterparty); liquidations and funding go on, because they reduce risk and a liquidation at the banded price favours the loser only slightly versus the real price.
- **10 s opens, 2 bps floor (F-06).** Two-step (commit/fill) opens would remove the option entirely but need a coordinator flow (Phase 4). With opens limited to 10 s old prices, the remaining option is worth less than the minimum taker round trip (≥ 2 bps open spread + 6 bps fee in, 6 bps fee out). Closes keep 60 s: a close only removes risk, and a stricter close freshness would trap traders.
- **Cover cap 10% per hour.** A single event can take at most a tenth of the fund, shared pro rata with every honest claimant of the same hour; claims never carry over, so the fund cannot be queued out.

## Emergency controls

`PerpsMarkets.setup(markets, oiCaps, guardian)` takes an optional **guardian** (zero = none, which is
what the deploy script does unless `GUARDIAN` is set). The guardian can call exactly one function,
`setCloseOnly(market, on)`: in close-only, `open` reverts; close, add/remove margin, liquidation, forced
exit, funding and cover claims work as usual. The guardian cannot move, freeze or redirect funds, change
prices, parameters or the guardian itself. Setting a guardian is an emergency control the project owner
must sign off on; leaving it zero keeps the contracts fully admin-free.

**Corporate actions procedure (splits, reverse splits, dividends).** The perps engine settles on the
oracle price only; it has no split factor or dividend adjustment, and the oracle's absolute price
bounds are immutable.

1. Before the event (ex-date or split effective date), the guardian sets the market to close-only, and
   makers withdraw offers.
2. Positions are settled before the event: takers close; anyone can liquidate; makers use forced exit
   (7 days, so request it at least 7 days ahead) for takers that do not close.
3. After the event, confirm the token mechanics (does the stock token rebase, airdrop or change price?)
   and that the new price is within the market's immutable oracle bounds and that the band has caught up.
   Then the guardian lifts close-only.

A split that moves the price outside the oracle bounds makes that market's price permanently stale
(dead after 14 days): settle it fully first and redeploy the market. Deploy with wide bounds (default
1 to 100,000 USDG) to keep normal splits inside them.

## Known limitations and risks (review before any audit)

- **Relayer trust (testnet).** A compromised relay key can still move a price, but only by 10% per 10 minutes (doubling takes 70 minutes), which gives makers and keepers time to react. Production must use verified Chainlink feeds with the sequencer-uptime feed (implemented) or a low-latency verified oracle.
- **Production oracle choice is open.** Opens need a price at most 10 s old. Chainlink push feeds for stocks update on deviation or heartbeat, so with them opens would revert most of the time; production needs a low-latency verified source (for example a pull oracle verified at open), which changes the adapter. Choose before the external audit.
- **Band lag after real gaps.** With the band on Chainlink too, a 30% opening gap is reported over about 4 windows (about 30 minutes); opens and plain closes wait, liquidations proceed at the banded price (losers keep a little more than at the true price). An owner may prefer raw feed prices plus a market-hours close-only policy instead; that reopens the F-02 straddle around gaps (bounded by the 10% epoch cap).
- **Worst-case cover (F-02 residual).** If keepers stay away for a whole band window, a self-paired straddle can still end insolvent and claim cover: at most its pro-rata share of 10% of the fund per hour, and only by forgoing a 0.5% liquidation reward that any keeper can take. Run at least one keeper (Phase 4 risk workers) per market.
- **Funding wash trading (F-09, accepted).** Funding follows global taker skew, so a self-paired position can move (even flip) the rate. It stays within the 0.01%/h cap and costs the attacker fees plus 40% of the wash size in locked margin; any genuinely large one-sided trader moves it the same way. A clean fix needs identity or a different funding model (Phase 4 coordinator).
- **Open-interest caps (F-10 residual).** Self-paired positions can fill a side's cap. The minimum size stops dust; filling a cap still costs 40% of the capped notional in margin plus fees. Size caps so that cost is prohibitive.
- **60-second freshness vs stock feeds.** Outside market hours prices go stale, so opens, closes, liquidations and funding revert with `StalePrice`. That is deliberate (no trading on stale prices), but liquidations pause too; the band then walks the first prices after the reopen.
- **Sequencer downtime.** While the sequencer is down or in its grace hour, liquidations wait; closes still work as plain closes (a liquidatable position closed then pays the close spread and fee, not the penalty, and an insolvent counterparty's cover is forfeited in that window).
- **Dead-oracle forced exits.** These settle without accruing funding. The market's rate is then reset from the new open interest and applied to the whole gap at the next accrual, a small inaccuracy that only arises in a market with no price for 14 days.
- **Spot pools are public AMMs in Phase 3.** Trades can be sandwiched; `minOut` and the deadline are the protection. The first LP sets the starting price.
- **One-time approvals.** Users must call `vault.setApproval(module, true)` once per module before trading. The UI should batch this with the first deposit.
- **`startBlock` in the deployments JSON** is the block the script simulated against. The indexer should start from the deployment receipts in `broadcast/` if exact.
- **License and EVM target.** The license is left as `UNLICENSED`; the project owner should choose one before verifying on an explorer. `evm_version = cancun`: Robinhood Chain runs a recent Arbitrum Nitro (v3.11 per the docs), but confirm with a first testnet deployment.
