# Velum contracts (Phase 3: public, no privacy yet)

Foundry project for the on-chain core described in `docs/04-contracts-and-privacy.md` §1.
All code is original and proprietary (`SPDX-License-Identifier: UNLICENSED`, the SPDX marker for
code that is not open source). OpenZeppelin 5.4.0 (MIT) is used only for `IERC20`, `SafeERC20` and
`ReentrancyGuard`, and forge-std 1.17.0 (MIT/Apache-2.0) for tests only; both are vendored unmodified,
with their licenses, in `lib/` (see `lib/VENDORED.md`: versions, upstream commits, byte-identity check).

**Testnet, or mainnet as the guarded beta only.** Not externally audited. `script/Deploy.s.sol` deploys to Robinhood
Chain testnet (46630) and anvil (31337), and to mainnet (4663) only as the guarded beta the owner decided on (November
2026): the launch guard on with every cap, a dedicated price relayer, exactly the verified mainnet tokens, sane oracle
bounds, and two steps (a simulation that writes a plan, then a broadcast that needs the plan and a confirmation phrase
naming the chain, the guard admin and the relayer); see [Mainnet: the guarded beta](#mainnet-the-guarded-beta) and the
runbook `docs/07-mainnet-guarded-beta.md`. Opening to everyone still waits for the Phase 5 external audit.

The November 2026 internal audit (`docs/audit/2026-11-internal.md`) findings F-01 to F-08, F-10 to F-13
and I-1 are fixed or mitigated here, and so are the second-round findings R2-01 to R2-07, the
independent third-round findings IA-01 to IA-08, IA-10 and RC-02, the final internal audit's FA-01 to FA-07, the
contract side of M-1 of the independent audit of the on-chain workers (relay pushes expire), and the independent audit
of the launch guard's G-01, G-02, D-01, I-01, I-02 and I-05; see [Audit hardening](#audit-hardening-2026-11).
Each fix has a regression that runs the original exploit: `test_Fxx_fixed_*` in `test/audit/AuditPoC.t.sol`,
`test_R2_xx*_fixed*` in `test/audit/Round2PoC.t.sol`, `test_IAxx_*_fixed` in
`test/audit/Round3IndependentPoC.t.sol`, `test_FAxx_*_fixed` in `test/audit/FinalAuditPoC.t.sol`, `test_M1_*_fixed` in
`test/audit/OnchainWorkersAuditPoC.t.sol`, `test_G0x_*_fixed` in `test/audit/GuardAuditPoC.t.sol` and `test_D01_*` /
`test_I0x_*_fixed` in `test/audit/GuardDeployPoC.t.sol` (plus the
extended invariants in `test/audit/Round3ExtInvariants.t.sol`, the auditors' fuzz tests in
`test/audit/FinalAuditFuzz.t.sol` and `test/audit/GuardCapsFuzz.t.sol`, the guard auditor's differential invariants in
`test/audit/GuardDiffInvariant.t.sol` and the config check in `test/ConfigConstants.t.sol`).

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
| `VelumVault` | `src/VelumVault.sol` | Holds all tokens. `deposit` (fee-on-transfer safe) / `withdraw` from your own balance. Neither a deposit nor a withdrawal (FA-06) may go to an address that can never use it: a module, the vault itself, a listed token, or a protocol address fixed at setup (the oracle). Modules may only debit themselves or accounts that approved them. Tokens, modules, blocked recipients and the optional launch guard fixed by a one-time `setup`, then locked: no owner, no pause, no upgrade. The launch guard (off unless a guard admin is given) limits deposits to allowlisted addresses and caps them until its admin switches it off for good; every allowlisted address always has its full account cap (the global cap covers them all, G-01), and it never blocks a withdrawal ([Guarded launch](#guarded-launch)). |
| `OracleAdapter` | `src/OracleAdapter.sol` | One source per token: Chainlink AggregatorV3 (decimals scaled to 1e18, answer > 0) guarded by the L2 sequencer-uptime feed, or a testnet price-relay address. Every source price is **clamped** to the token's fixed bounds and then **rate-limited** against the last recorded price: at most 5% × dt / 5 min per recording (dt capped at 5 minutes), so 1/6000 per second, 1% per minute, and never more than 5% at once. dt is measured on the rate-limit clock, which only moves when a recording brings a new source value or changes the price (FA-01, [below](#the-rate-limit-clock-fa-01)). `price()` reverts if older than 60 s or missing; `read()` and `poke()` also record the reading (new last price, `lastValidAt`). The price is "lagging" when the reported price differs from the source (outside the rate limit or outside the bounds); `atBound()` says the source is outside the bounds and the reported price has reached the bound. Any positive answer is a valid reading, inside the bounds or not (IA-06); a failed or zero read is stale; `isDead()` only after 14 days without any valid price. `liveClock()` is the clock funding runs on: block time minus every gap of more than 14 days between valid prices (FA-02, FA-03). `sequencerStatus()` returns (up, ready = up for more than the 1 h grace). Feeds are read with a length-checked staticcall: a feed without code or with malformed data reads as stale (sequencer: down) and `poke` never reverts; `setup` refuses such a feed, and a sequencer feed whose answer is not 0 or 1 (FA-07). Relay updates: at most one per token per second, any positive price up to `uint128`, each carrying the time the relay observed it (`observedAt`), which must be at most `MAX_PUSH_DELAY` (10 s) before the push's block and newer than the token's last pushed observation; that observation time is the source timestamp (freshness, rate-limit clock, liveness), so a signed push held back by an RPC expires instead of landing later as a fresh price ([M-1](#on-chain-workers-audit-2026-11-testauditonchainworkersauditpoctsol)). |
| `SpotPools` | `src/SpotPools.sol` | Constant-product Stock/USDG pools. A 30 bps fee stays in the pool, and a stock→stock swap routes through USDG in one call, paying two fees. LP shares are tracked internally. The first deposit locks 1,000 shares against inflation attacks. Reserves are state variables, so donations can't skew them. `minOut`, `minShares`, `minStock` and `minUsdg` must be non-zero (FA-05). |
| `MakerBook` | `src/MakerBook.sol` | Standing offers: backing (USDG), largest single fill (≤ backing), open spread (2 bps to 5%) and close spread (≤ 5%), expiry. The maker can withdraw unused backing at any time. Only `PerpsMarkets` can allocate backing to a fill. Backing caps the maker's **margin**, not its exposure (see [Maker offers](#maker-offers)). |
| `PerpsMarkets` | `src/PerpsMarkets.sol` + `src/perps/*` | Pairs between a taker and the maker of the chosen offer. Open, close (any time, no maker signature), add/remove margin, funding, liquidation, forced exit, an insurance fund with deferred pro-rata shortfall cover (`PerpsCover`), and an optional close-only switch held by a guardian. |

### Perps model

- **Units:** prices are USDG per token × 1e18 and `qty` is tokens × 1e18. Margins, fees and payouts are USDG base units (6 decimals). `valueScale = 10^(36 − usdgDecimals)`.
- **Open** (size `S`, leverage `L` from 1x to 5x in 0.5 steps, passed as `leverageHalf = 2L`):
  - entry = oracle × (1 ± open spread), always worse for the taker;
  - takerMargin = S/L, which is at least the initial margin of 20% = 1/maxL;
  - makerMargin = S/maxL, taken from the offer;
  - fee = 0.06% × S, paid to insurance;
  - qty = S/entry, at most 100 tokens; each side of a market has its own open-interest cap; S ≥ 10 USDG;
  - needs a price at most **10 s** old that is not lagging, the sequencer up past its grace period, the
    market not in close-only, and a **non-zero** `priceLimit` (worst acceptable entry; IA-10).
- **Claims:** the taker's claim is `takerMargin + pnl(P) − funding`, and the maker's claim is the rest of the pool. Claims always sum to the pool, so value is conserved and payouts are capped by posted margins.
- **Close:** needs a price up to 60 s old that is **not lagging** (on every route) and a non-zero `priceLimit` (IA-10). A plain close settles at oracle ∓ the maker's committed close spread, with a 0.06% fee on exit notional: the taker gets `max(0, claim − fee)`, capped by the pool, and the maker gets the rest. If the position is liquidatable at that moment and the sequencer rule allows a liquidation (below), the close settles as a liquidation instead, with the taker as liquidator, so an insolvent counterparty's shortfall becomes a cover claim instead of being forfeited. That route uses the oracle price with no close spread and no fee; a losing taker pays the 1% liquidation penalty and gets the liquidator half (0.5% of notional) back. `priceLimit` is checked against the spread-adjusted exit before either route and does not account for the penalty.
- **Margin:** anyone on the pair adds margin at any time. The taker removes margin down to the initial margin (20% of notional) at a non-lagging price at most **10 s** old, like an open (IA-03), with the sequencer past its grace period.
- **Funding:** `rate = 0.01%/h × (longOI − shortOI) / (longOI + shortOI)`, using taker open interest. It accrues per second of the oracle's **live clock** and is updated on every action and by anyone via `advanceFunding`. The live clock leaves out every gap of more than 14 days (the oracle's `DEAD_AFTER`) between two valid prices (FA-02, FA-03): such a silence is never charged, whether the position leaves by a dead-oracle forced exit (which accrues at the rate in force up to the token's last valid time, at the last recorded price, IA-02) or stays open until prices return, also after a dead exit. A shorter gap is charged at the next accrual as before, at most 14 days × 0.01%/h = 3.36% of the price.
- **Liquidation:** anyone can liquidate when either side's claim is below the 10% maintenance margin (0.5/maxL) at a price up to 60 s old. A lagging price is accepted: the loser is then settled at the effective price, and since it is liquidatable its claim there is under 10% of notional, so relative to the source price it keeps less than 9% of notional (claim minus the 1% penalty), and the winner's cover claim is smaller by the same amount. The side with the smaller claim pays a penalty of 1% of notional, split 50/50 between the liquidator and insurance. If the loser cannot pay the full penalty, insurance tops the liquidator up to half the full penalty, at most 1 USDG, drawn against the epoch's cover cap (below). A shortfall is paid later as a deferred cover claim.
- **Sequencer rule for liquidations (F-05, IA-07):** none while the L2 sequencer is down. During the 1-hour grace period after it comes back, only a position whose liquidated side is below **half** the maintenance margin (MM / 2, 5% of notional at 5x, derived from the existing parameters) may be liquidated; positions between MM / 2 and MM stay protected for the whole hour. After the grace hour the normal rule applies. Closes and forced exits that would settle as liquidations follow the same rule (a plain close stays available when the rule forbids the liquidation).
- **Shortfall cover (`PerpsCover`):** the winner of an insolvent liquidation gets the whole pool at once; the shortfall is filed as a claim in the current hourly epoch. Each epoch has a cap of 10% of the insurance fund as it stood at the epoch's first draw. Keeper top-ups (paid at once) and cover for filed claims (reserved in `coverReserved` at once, paid later) both draw on that cap, in the order they happen. After the epoch ends anyone may call `settleCoverEpoch` / `claimCover`: each claimant gets `claim × budget / claims`, where the budget is the cover reserved during the epoch, and the rest is a haircut to the winner. Rounding dust returns to the fund with the last claim.
- **Forced exit:** taker or maker posts a 0.001 ETH bond. After 7 days anyone settles it.
  - Price: the oracle price, **≤ 10 s old** (`OPEN_MAX_AGE`, FA-04: the settler chooses the moment); the entry price if the oracle is dead (no valid price for 14 days; the oracle is poked first, so a feed round nobody recorded counts); the bound, if the source is outside the oracle bounds and the reported price has reached it (IA-06). Any other lagging price is refused. A liquidatable position can still be liquidated at a 60 s old price through `liquidate`.
  - A position that is liquidatable at settlement is liquidated instead (penalty applies, the settler gets the liquidator reward; the sequencer rule above applies).
  - **Taker's request (IA-01):** exactly what a plain close costs: exit = price ∓ the committed close spread, and the 0.06% close fee on exit notional, both capped at the taker's claim (a small margin never makes it revert), whoever calls settle. At the entry price (dead oracle) the spread and fee are losses for the taker, never gains.
  - **Maker's request:** at the price with no spread and no fee (unchanged). The maker gives up its own close spread, the taker pays nothing extra, so the maker gains nothing over a close (`test_IA01_makerForcedExitGainsMakerNothingOverAPlainClose_fixed`).
  - The bond is refunded whenever the position closes; a failed refund can be claimed later with `claimBond`.

### Events (for the indexer)

| Contract | Events |
|---|---|
| `VelumVault` | `Deposited`, `Withdrawn`, `ModuleApproval`, `InternalTransfer`; launch guard: `GuardSetup` (admin zero = unguarded; caps in `Setup.tokens` order), `Allowlisted`, `CapsRaised`, `OpenedToPublic`, `CapsLifted`, `GuardAdminTransferStarted`, `GuardAdminTransferred` (also with the new admin zero when the guard retires) |
| `SpotPools` | `PoolChanged` (after every reserve change), `LiquidityAdded`, `LiquidityRemoved`, `Swapped` |
| `MakerBook` | `OfferPosted`, `OfferFilled`, `OfferWithdrawn` |
| `PerpsMarkets` | `PositionChanged` (`Action`: Open, Close, AddMargin, RemoveMargin, Liquidate, ForcedExit), `PositionSettled` (`exitPrice` = spread-adjusted exit on a close and on a taker-requested forced exit; `fee` = close fee on both, 0 on a maker-requested forced exit, the penalty on liquidation), `Liquidated` (`shortfall` = amount claimed), `FundingAdvanced` (only when the index is current; since IA-02 also after a dead-oracle forced exit, with the index frozen over the dead period), `InsuranceFunded`, `ForcedExitRequested`, `ForcedExitSettled` (`price` = oracle, entry or bound), `BondRefundDeferred`, `BondClaimed`, `CloseOnlySet`, `CoverClaimFiled`, `CoverEpochSettled` (the budget fixed while the epoch ran), `CoverPaid` |
| `OracleAdapter` | `PriceRelayed` (pushed price as pushed, the clamped, rate-limited price, the observation time the push carried and its block time) |

## Invariants (tested in `test/invariant/`)

1. Tokens leave the vault only through `withdraw`: vault holdings always equal net deposits.
2. The internal balances of all accounts (users, pools, offers, margins, insurance, reserved cover) sum to the vault's holdings, and each module's vault balance matches its own books (perps: `totalMargin + insurance + coverReserved`).
3. A liquidation never pays more than the posted margins plus the insurance fund; shortfall cover is never paid at liquidation (only the ≤ 1 USDG keeper top-up), and no epoch's top-ups plus cover exceed 10% of the fund as it stood at the epoch's first draw.
4. Closing the whole book returns every unit. After all positions close, every cover claim is paid, offers are withdrawn and liquidity is removed, only insurance and the locked pool dust remain outside user balances.
5. Reserved cover equals the unpaid budgets of epochs with unpaid claims, outstanding claims equal the claims recorded, settling never changes a budget, and guardian actions never move funds.
6. Launch guard: no deposit or module approval gets past an active allowlist; while caps are active, every account's net deposits (checked against an independent ghost copy) stay within its cap and the vault's holdings within the global cap; G-01: caps are only active with the allowlist, every global cap covers account cap × allowlisted addresses, holdings never exceed the sum of net deposits (only allowlisted accounts have any), the global cap never refuses a deposit, and an allowlisting or cap raise that would break the rule is refused; no valid withdrawal reverts and no exit (close, forced exit, liquidity removal) reverts with a guard error; guard-admin actions never change any balance, reserve, margin, the fund or offer backing; a guard admin exists exactly while part of the guard is active. After the wind-down every account withdraws everything and only module balances (insurance, locked pool dust) remain.

Each run also checks that open interest equals the sum of open positions. The handler opens, closes, liquidates and force-exits positions, moves prices (mostly slowly enough for the rate limit, a quarter of the time in one second so the price lags), simulates keeper-free gaps of 15-40% (shortfall claims), pays cover claims, toggles close-only as the guardian, jumps time, swaps and adds or removes liquidity. Since the final audit the oracle has an L2 sequencer-uptime feed that the handler moves between down, grace and up; invariant 3 is checked for every settlement that can liquidate (`liquidate`, `close`, `settleForcedExit`, and the wind-down closes), and a dedicated action has takers close liquidatable positions.

The extended suite (`test/audit/Round3ExtInvariants.t.sol`, from the independent audit) runs the same invariants with a handler that also removes taker margin, donates to insurance, pokes the oracle, advances funding, lets the relay go quiet for 15 days so requested forced exits settle at the entry price, and pushes prices outside the oracle bounds (clamped and lagging, with keepers liquidating on the way). It adds two invariants: margin removal never leaves a taker below the initial margin at the price used, and the recorded effective price always stays within the bounds.

Both suites run with the launch guard on (actors 0-3 allowlisted, actor 4 and the keeper not; account caps that bind now and then, global caps covering five account caps), deposits credited to other accounts, and one action that allowlists (raising the global caps first half the time, otherwise expecting the G-01 refusal), raises caps (likewise), hands the admin role over, has an actor re-grant an approval, lifts the caps, or opens to the public (refused while caps are active). Since the guard audit (I-05) `InvariantsUnguardedTest` in `test/invariant/Invariants.t.sol` runs the main suite again on an unguarded vault, the testnet default, and checks that it stays unguarded with no refusal. `test/invariant/GuardInvariants.t.sol` focuses on the guard: tight account caps that bind often, every guard action as its own selector, trading, liquidity, liquidations and forced exits in between, invariant 6 plus the vault accounting, and the final withdraw-everything check. `test/audit/GuardDiffInvariant.t.sol` (from the guard auditor) drives a guarded system and an unguarded mirror with the same calls and requires identical state and outcomes for everything but filtered deposits and approvals, against an independent ghost model of the guard (G-01 included). `test/LaunchGuard.t.sol` has the unit tests (every function and revert), the deploy-script checks and two fuzz tests: a random 40-step sequence of deposits (to self and to others), withdrawals, cap raises, allowlisting and the one-way switches by allowlisted and other accounts, and admin actions against a snapshot of every balance. `test/audit/GuardCapsFuzz.t.sol` (from the guard auditor) fuzzes 60-step sequences of deposits, withdrawals to anyone, value moved between accounts, cap raises and allowlisting a new address, checking the caps, holdings ≤ the sum of net deposits and that every refusal is the account cap's.

## Commands

Foundry 1.5.1 and solc 0.8.28 are required. Use `--offline` if `binaries.soliditylang.org` is blocked and solc 0.8.28 is in `~/.svm`.

```bash
cd contracts
forge build
forge test                      # 267 tests: unit, fuzz (512 runs), invariants (64 × 128)
FOUNDRY_PROFILE=ci forge test   # fuzz 4096 runs, invariants 256 × 256
forge lint src script           # test/ is excluded in foundry.toml
forge coverage --report summary --no-match-path "test/invariant/*"
forge fmt --check
forge snapshot                  # writes .gas-snapshot
```

`forge build --sizes` leaves out the five production contracts: Foundry treats any contract with a
`setup()` function as a test contract. Measure them with
`forge inspect <Contract> deployedBytecode` or from `out/<Contract>.sol/<Contract>.json` after `forge build --force`
(`forge inspect` can leave abi-only artifacts in `out/`; run `forge build --force` before `forge script` afterwards)
(runtime sizes: PerpsMarkets 17,640 bytes, about 17.2 KB of the 24 KB limit; VelumVault 9,112 with the launch guard
and its G-01 room check, 8,633 before that check, 4,291 without the guard; OracleAdapter 8,358; SpotPools 5,711;
MakerBook 3,918).

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
`deployments/46630.json` with the chain ID, contract addresses, tokens, relayer, guardian, guard admin and start
block. Optional settings: `GUARDIAN` (close-only switch, default none; see [Emergency controls](#emergency-controls)),
`OI_CAP_TOKENS` (default 10,000 per side), `PRICE_MIN_USD` and `PRICE_MAX_USD` (default 1 and 100,000),
`USDG_ADDRESS` + `STOCK_ADDRESSES` + `STOCK_SYMBOLS` to override the token list, and the launch guard:
`GUARD_ADMIN` plus `GUARD_ACCOUNT_CAP_<SYMBOL>` / `GUARD_GLOBAL_CAP_<SYMBOL>` for USDG and every stock (see
[Guarded launch](#guarded-launch); off by default). Every variable is read strictly (guard audit D-01): unset or empty
means the default, anything else must parse or the script stops before broadcasting, and an address written in mixed
case must carry a correct EIP-55 checksum. Without `GUARDIAN`
the script prints a warning, before deploying and again as its last line, that no market can be put in
close-only and the split/dividend procedure is therefore unavailable for that deployment; it also prints the launch
guard configuration (off, or the admin and every cap) before deploying and after the addresses. Every contract
locks itself during the script; apart from the optional guardian's close-only switch and the optional launch-guard
admin (until it switches the guard off) there is nothing to administer afterwards.

### Mainnet: the guarded beta

Chain 4663 is accepted only when **all** of these hold (otherwise the script stops before anything is broadcast, each
refusal tested in `test/MainnetGuardedDeploy.t.sol`):

- `GUARD_ADMIN` is set and every cap is given (USDG and the ten stocks): the launch guard is on;
- `PRICE_RELAYER` is set and is neither the deployer nor `GUARD_ADMIN`; `GUARD_ADMIN` is not the deployer; `GUARDIAN`,
  if set, is neither the price relayer nor the deployer;
- the tokens are exactly the verified mainnet list hard-coded in the script (`mainnetTokens`): no `USDG_ADDRESS` /
  `STOCK_ADDRESSES` / `STOCK_SYMBOLS`, `packages/config/robinhood-mainnet.json` lists the same 11 addresses, and each
  token on chain has code, the expected `decimals()` (6 / 18) and `symbol()`;
- `MAINNET_REF_PRICE_<SYMBOL>` (the token's current price in USDG) is given for every stock and the oracle bounds
  (`PRICE_MIN_USD` / `PRICE_MAX_USD`) leave at least 5x on both sides of it (`MAINNET_BOUND_FACTOR`);
- **two steps.** The simulation (`forge script` *without* `--broadcast`, detected with `vm.isContext`) prints the full
  summary (deployer, nonce and balance; relayer; guard admin and whether it has code; guardian; tokens; bounds per token;
  open-interest cap; caps; the plan hash; the confirmation phrase) and writes `deployments/4663.plan.json`: a hash of
  every input, the creation code of the five contracts and the deployer's nonce, with the simulation time. The
  broadcast (`--broadcast`) is accepted only with a plan for 4663 whose hash matches and that is at most one hour old
  (`MAINNET_PLAN_MAX_AGE`), and with `VELUM_MAINNET_GUARDED_CONFIRM` equal to `mainnetPhrase(chain, admin, relayer)`:
  `deploy unaudited Velum guarded beta to chain 4663 with guard admin <admin> and price relayer <relayer>`
  (checksummed), so a phrase copied from documentation never matches. The plan is removed once a broadcast run has
  accepted it (and the nonce in it moves anyway), so a second broadcast needs a new simulation. The deployments file is
  written only by the broadcast run.

```bash
# from contracts/, every setting exported (GUARD_ADMIN, all caps, PRICE_RELAYER, MAINNET_REF_PRICE_<SYMBOL>, ...)
forge script script/Deploy.s.sol --rpc-url $RPC --account velum-deployer --sender $DEPLOYER            # 1. simulate
VELUM_MAINNET_GUARDED_CONFIRM='<the phrase printed by step 1>' \
forge script script/Deploy.s.sol --rpc-url $RPC --account velum-deployer --sender $DEPLOYER --broadcast --slow   # 2.
```

On the server `deploy/deploy-contracts.sh` runs both steps (pinned Foundry and solc, an encrypted keystore, the relay
address derived from the signer's key, reference prices from Robinhood's quote API) and installs the deployment file;
`docs/07-mainnet-guarded-beta.md` is the runbook. `forge script` writes `deployments/<chain>.json` during its local
run, before the transactions are sent: check that every transaction succeeded before using the file
(`deploy-contracts.sh` checks the receipts, the code at every address and the roles on chain first).

## Intentional simplifications vs docs/04 (Phase 3)

- **Matching is atomic.** A taker opens directly against a chosen standing offer. There is no lock-then-fill step, so the 15-minute maker fill window and refund (a Phase 4 coordinator flow) don't apply yet.
- **Maker margin per fill is S/maxL** (initial margin). Taker profit on a single position is therefore capped by that margin; beyond about a 10% move the maker side becomes liquidatable and the taker realises the profit through liquidation.
- **Shortfall cover is per hourly epoch, pro rata and capped** at 10% of the fund at the epoch's first draw, shared with keeper top-ups (docs/04 says "pro rata after next funding"; the epoch is the hour, and the cap is new).
- **Fees go to the insurance fund.** There is no treasury and no admin over funds (the optional launch-guard admin only decides who may deposit and how much, until it switches the guard off).
- **Funding runs within the hour by construction.** "Funding must have run within the last hour" holds because every open accrues funding first; there is no separate staleness gate.
- **Forced exit is available to both sides,** so a maker can't be stuck if the taker never closes.
- **Testnet prices are relay-sourced.** The Chainlink testnet feed addresses haven't been verified, so the deploy script configures every stock as relay-sourced, bounded and rate-limited.

## Maker offers

An offer's `backing` is the USDG the maker puts up as **margin**, not a cap on its exposure (independent audit
IA-05, documented, no code change). Each fill takes `S / maxL` (20% of the fill's notional) out of the backing,
so one offer with backing `B` can back up to `B × maxL = 5B` of notional, and all of it on the same side: offers
have no side, and takers choose long or short. `largestFill` caps one fill's notional, not the total.
(`test_IA05_offerBackingCapsMarginNotNotional_fixed`: 5 fills of 1,000 USDG at 5x on a 1,000 USDG offer, 5,000
USDG of one-sided exposure.)

What that means for a maker:

- Exposure: the maker's P&L moves like a position of up to 5 × backing in notional. To cap exposure at `N`, post
  backing `N / 5` (and withdraw and re-post to adjust); keep `largestFill` small to spread fills.
- Loss per position: capped by that position's margin (plus any margin the maker adds). Its side is liquidated
  below the 10% maintenance margin; if a fast move takes it below zero first, the taker's shortfall is a cover claim
  on insurance, not a debt of the maker.
- The UI should show "exposure up to 5 × backing" next to the backing field. A per-offer side or notional cap can
  come with the Phase 4 coordinator.

## Token requirements

The vault keeps an internal ledger per (account, token) and never reads token balances after a deposit, so it
cannot follow balance changes that happen without a transfer through it (independent audit IA-08, documented).

- **Only non-rebasing tokens may be listed.** Tokens that reach the vault without `deposit` (airdrops, a positive
  rebase, direct transfers) belong to nobody and are stranded: there is deliberately no sweep, because a sweep is an
  admin power over the vault. A negative rebase, burn or issuer wipe of the vault's balance leaves the vault short,
  and the last users to withdraw that token cannot (`test_IA08_rebaseAndAirdropToVaultStrandedOrShort_fixed`).
  Spot pool reserves are state variables and ignore such changes too.
- **No fee-on-transfer tokens:** `deposit` credits what arrived, but a withdrawal of `amount` would then deliver less
  than `amount` to the user.
- **Evidence so far** (from another reviewer, to be re-confirmed): the Robinhood Chain stock tokens are beacon proxies
  that implement `uiMultiplier()`; a split changes that multiplier and holder balances do not rebase. USDG has
  6 decimals (the deploy script reads `decimals()`) and its issuer has a freeze power.
- **Confirm with the issuers before listing a token (and again before mainnet):**
  1. Stock tokens: splits, reverse splits and stock dividends only change `uiMultiplier()`, never balances; and
     whether the price feed quotes per token unit or per share (if per share, a split changes what the oracle price
     means for a token: run the corporate-actions procedure below).
  2. Cash dividends: how they are delivered. An airdrop to holders would land on the vault and be stranded.
  3. Upgradeability: who controls the beacon / proxy admin of each token, and with what notice. An upgrade can
     change any of the above (rebasing, fees, hooks).
  4. Freeze, blocklist, pause and wipe powers (stock tokens and USDG): a frozen vault address freezes every user's
     withdrawals of that token; a wipe of the vault's balance is the negative-rebase case above. Ask whether
     protocol contracts can be exempted and what the procedure is.
  5. No transfer fees now, and no switch to turn them on.
  6. Testnet and mainnet token contracts may differ: re-check on the mainnet contracts.

## Audit hardening (2026-11)

| Finding | Change | Where |
|---|---|---|
| F-01 | Pull-only forced-exit bond refunds (`claimBond`) | `PerpsBase._refundBond`, `PerpsForcedExit.claimBond` |
| F-02 | Shortfalls become deferred cover claims: per hourly epoch, pro rata, capped at 10% of the fund (shared with keeper top-ups since R2-02), remainder a haircut. With the rate limit (R2-01) a gap alone can't create a shortfall, and the self-paired straddle loses money | `PerpsCover`, `PerpsLiquidation._liquidateAt` |
| F-03 | `lastValidAt` per token, recorded by `read` (every perps accrual), `poke` (anyone) and `pushPrices`. Failed reads are stale; dead only 14 days after `max(lastValidAt, setupAt)` (since IA-06 an out-of-bounds answer is a live, clamped reading, not a stale one) | `OracleAdapter` |
| F-04 | Every source is rate-limited: 1/6000 per second from the last recorded price, at most 5% per recording (R2-01 replaced the first-round ±10% band). Deploy refuses testnet without a dedicated `PRICE_RELAYER` | `OracleAdapter._record/_limit`, `Deploy.checkRelayer` |
| F-05 | Sequencer-uptime feed (setup parameter, required with Chainlink feeds; zero = relay only). Down or < 1 h since back up: opens, liquidations and margin removal blocked; close and add margin allowed (since IA-07, positions below MM / 2 can be liquidated during the grace hour) | `OracleAdapter.sequencerReady`, `PerpsMarkets` |
| F-06 | Opens need a price ≤ 10 s old (closes/liquidations 60 s); maker open spread ≥ 2 bps | `PerpsBase.OPEN_MAX_AGE`, `MakerBook.MIN_OPEN_SPREAD_BPS` |
| F-07, F-13 | Optional guardian (fixed at setup) can only switch a market into or out of close-only. Off by default; the deploy script warns loudly when `GUARDIAN` is unset (round 2) | `PerpsMarkets.setCloseOnly`, `Deploy.guardianNotice` |
| F-08 | Forced exit of a liquidatable position settles as a liquidation (penalty applies) | `PerpsForcedExit.settleForcedExit` |
| F-10 | Minimum position size 10 USDG (residual: OI-cap filling costs 40% of the capped notional in margin) | `PerpsMarkets.open` |
| F-11 | Keeper top-up from insurance when the loser can't pay the full penalty: up to half the full penalty, ≤ 1 USDG, within the epoch's cover cap | `PerpsLiquidation._liquidateAt` |
| F-12 | Closing a liquidatable position settles it as a liquidation, so cover is never forfeited (at a lagging price the winner uses `liquidate`) | `PerpsMarkets.close` |
| I-1 | `deposit(..., to = module)` refused | `VelumVault.deposit` |
| nits | `PositionSettled.fee` = penalty on liquidation; no `FundingAdvanced` from a dead-oracle settlement (superseded by IA-02: the dead exit now settles the index up to now and emits it); `removeMargin` oversize → `ExceedsMargin` | |
| F-09 | Not changed (accepted Low, see limitations) | `test_F09_washTradeStillMovesFundingWithinCap` |

### Second round (2026-11, `test/audit/Round2PoC.t.sol`)

| Finding | Change | Regressions |
|---|---|---|
| R2-01 (Medium) | The ±10% band around a reference fixed for 10 minutes (one push could move +22%, two records around an attacker-timed roll +21%) is replaced by a rate limit against the last recorded price: `maxMove = last × 5% × min(dt, 5 min) / 5 min`. `poke` is a recording like any other (since FA-01 the clock that dt is measured on moves only for a new source value or a price change) | `testFuzz_R2_01_fixed_noSideInsolventWithin12MinOfAnyNonLaggingOpen`, `test_R2_01_fixed_extremePathsKeepFiveXSolventFor12Min`, `test_R2_01_fixed_worstCaseInsolvencyTime`, `testFuzz_R2_01_fixed_notLiquidatableSurvivesAnyNextRecording`, `test_R2_01_fixed_relayerExtractionPerMinuteBounded`, `test_R2_01a_fixed_relayerOscillationCannotDrainHonestMaker`, `testFuzz_R2_01_fixed_openAnywhereThenOppositeExtremeStaysSolvent`, `test_R2_01b_fixed_gapNearOldWindowRollStraddleUnprofitable`, `testFuzz_limit_everyRecordingWithinLimit` |
| R2-02 (Low) | Keeper top-ups draw on the epoch's cover cap, ahead of the cover reserved for that liquidation's shortfall | `test_R2_02_fixed_keeperTopUpsCountAgainstEpochCap` |
| R2-03 (Info) | The cap is fixed at the epoch's first draw and draws leave the fund at once, so the budget no longer depends on who settles or when. Real bound: 10% per epoch, 19% for an event spanning two epochs, 1 − 0.9^k over k epochs | `test_R2_03_fixed_capFixedAtFirstDrawAndTwoEpochsAtMost19Percent` |
| R2-04 (Low) | `close()` refuses a lagging price before routing to liquidation; third-party keepers still liquidate. Bound for any liquidation at a lagging price documented (< 9% of notional) | `test_R2_04_fixed_closeRefusedAtLaggingPriceKeepersStillLiquidate`, `test_R2_04_fixed_winnerAtLaggingPriceKeepsCoverThroughLiquidate` |
| R2-05 (Info) | `deposit` refuses the vault itself, listed tokens and a deny-list fixed at setup (the deploy script passes the oracle); `withdraw` refuses the vault as recipient | `test_R2_05_fixed_depositToProtocolContractsRefused` |
| R2-06 (Info) | README corrected: a close is not risk-free for the maker (see "Why these choices") | — |
| R2-07 (Info) | README and NatSpec corrected: penalty on a losing taker's close-as-liquidation, and `priceLimit` covers the spread-adjusted exit only | `test_R2_07_closeAsLiquidationPaysPenaltyNotSpread` |
| F-07 (incomplete) | Deploy keeps the guardian off by default but reads `GUARDIAN` and warns loudly when it is unset | `test_F07_fixed_deployWarnsWithoutGuardian` |

### Third round: independent audit (2026-11, `test/audit/Round3IndependentPoC.t.sol`)

Each proof of concept keeps its scenario and numbers and now asserts the fixed behaviour (`test_IAxx_*_fixed`).

| Finding | Change | Regressions (before → after) |
|---|---|---|
| IA-01 (Medium) | A forced exit the **taker** requested settles exactly like a plain close, whoever calls settle: the committed close spread and the 0.06% close fee, capped at the taker's claim; at a dead oracle the same at the entry price. A forced exit the **maker** requested keeps the no-spread, no-fee settlement | `test_IA01_takerForcedExitCostsExactlyAPlainClose_fixed` (1,000 USDG, 5% spread: forced exit 983.00 vs close 932.44 → both 932.44), `test_IA01_makerForcedExitGainsMakerNothingOverAPlainClose_fixed`, `testFuzz_IA01_takerForcedExitAtDeadOracleCappedNeverAGain_fixed` |
| IA-02 (Low) | A dead-oracle exit accrues funding at the old rate up to the token's last valid time (at the last recorded price), nothing over the dead period, and moves the funding clock to now before the rate reset | `test_IA02_deadOracleExitChargesNoRetroactiveFunding_fixed` (35.99 → 0.000028 USDG, one second), `test_IA02_deadExitAccruesOldRateOnlyToLastValidTime_fixed`, `test_nit_IA02_fixed_deadOracleSettlementReportsIndexFrozenOverDeadPeriod` |
| IA-03 (Low) | `removeMargin` needs the open freshness (`OPEN_MAX_AGE`, 10 s) | `test_IA03_removeMarginNeedsOpenFreshness_fixed` (55 s old price: re-levered 1x → 5x → refused) |
| IA-04 (Info) | `FixedMath.sqrt` takes the exact first Newton step `ceil(x / 2)`: a true floor sqrt for every input | `test_IA04_sqrtOfTwo_fixed` (sqrt(2): 2 → 1), `testFuzz_IA04_sqrtIsFloor_fixed` (whole uint256 range) |
| IA-05 (Info) | Documented ([Maker offers](#maker-offers)): backing caps maker margin, not notional | `test_IA05_offerBackingCapsMarginNotNotional_fixed` |
| IA-06 (Low) | A source price outside the bounds is clamped to the bound, then rate-limited (reads as lagging) instead of reverting; any positive answer is a live reading for `isDead`; a forced exit settles at the bound once the effective price has reached it (`atBound`). The relay accepts out-of-bounds pushes (zero and > `uint128` still refused) | `test_IA06_outOfBoundsCrashLiquidatedNotRefundedAtEntry_fixed` (5x long, source −76%: refunded 200.00 at entry → liquidated solvent, gets 56.47), `test_IA06_forcedExitSettlesAtTheBound_fixed`, `test_IA06_relayOutOfBoundsPushClampedNotRefused_fixed`, `test_F03_fixed_invalidAnswerIsStaleNotDead` |
| IA-07 (Low) | During the sequencer grace hour, a position whose liquidated side is below MM / 2 can be liquidated (also via close and forced exit); MM / 2 to MM stays protected; nothing while the sequencer is down | `test_IA07_graceLiquidatesBelowHalfMaintenance_fixed` (maker shortfall 60.52 → 0, liquidated solvent 18 min into grace), `test_IA07_sequencerDownStillBlocksDeepLiquidation_fixed`, `test_F05_fixed_sequencerDownBlocksOpensAndLiquidations` |
| IA-08 (Low) | Documented ([Token requirements](#token-requirements)); no sweep (it would be an admin power) | `test_IA08_rebaseAndAirdropToVaultStrandedOrShort_fixed` |
| IA-10 (Info) | `open` and `close` refuse `priceLimit = 0` (`NoPriceLimit`) | `test_IA10_zeroPriceLimitRefused_fixed` |
| RC-02 (Low) | A forge test reads `packages/config/robinhood-testnet.json` and asserts every shared constant; every `protocol` key must be checked or listed as off-chain | `test/ConfigConstants.t.sol` |
| Licensing | First-party code stays proprietary (`UNLICENSED`). OpenZeppelin's MIT `LICENSE` added; `lib/VENDORED.md` lists versions, commits and the byte-identity check | — |

ABI changes (indexer and web, Phase 3 wiring): additive only, storage layouts unchanged.

- `OracleAdapter` / `IOracleAdapter`: new views `sequencerStatus() → (bool up, bool ready)`, `atBound(address) → bool`,
  `lastRecorded(address) → (uint256 p, uint256 validAt)`. Behaviour: reads no longer revert `PriceOutOfBounds`
  (clamped instead); `pushPrices` reverts `PriceOutOfBounds` only for 0 or > `uint128`; `poke` returns true for an
  out-of-bounds answer; `isDead` counts any positive answer as live.
- `PerpsMarkets`: new error `NoPriceLimit()` (`open` / `close` with `priceLimit = 0`). Same functions and events;
  `PositionSettled` of a taker-requested forced exit now carries the spread-adjusted `exitPrice` and the close `fee`;
  a dead-oracle forced exit now emits `FundingAdvanced`; `ForcedExitSettled.price` can be the bound. `liquidate`
  checks liquidatability before the sequencer: `NotLiquidatable` (or `StalePrice`) can now come first where
  `SequencerDown` did; `SequencerDown` also means "grace hour, above MM / 2".

Design choices:

- **IA-01, whose request decides.** The forced exit is the taker's escape hatch when the services go quiet; it
  should not be a cheaper way out than the exit the taker always has. So a taker's request pays the plain-close
  costs, capped like a plain close, and the dead-oracle (entry price) case applies the same spread and fee: they
  can only lower the taker's payout. A maker's request is compared with that same plain close: the maker forgoes
  its own close spread and the taker pays nothing, so there is no bypass in the other direction. The close fee is not
  charged to a taker who did not ask to leave (residual in the limitations).
- **IA-02, accrue to the last valid time, then skip.** Funding up to the last valid price is owed at the rate that
  was in force (the rate only changes with open interest, which only changes on actions that accrue first). After
  that there is no price and no way to trade, so nothing is charged; zeroing the whole gap would also drop funding
  that was earned while prices were valid. The dead exit then emits `FundingAdvanced`, because the index is settled
  up to now.
- **IA-06, clamp then rate-limit, settle at the bound.** Liquidations keep working all the way to the bound, and a
  feed that is alive is never dead. A market whose source stays outside the bounds would otherwise be stuck (closes
  and forced exits refuse lagging prices), so a matured forced exit may settle at the bound once the effective price
  is there. Choosing bounds remains important: settlement at the bound favours the loser relative to the true price.
- **IA-07, MM / 2 during grace.** A position that deep is closer to insolvency than to safety (5% of notional left at
  5x, about five minutes of the 1%-per-minute rate limit); liquidating it costs the loser the same 1% penalty it would
  pay an hour later, while waiting risks a shortfall for the winner. Shallower positions keep the full grace hour.

### Final round: final internal audit (2026-11-15, `test/audit/FinalAuditPoC.t.sol`)

The auditor's proofs of concept are kept with their scenarios and assert the fixed behaviour (`test_FAxx_*_fixed`);
the auditor's fuzz tests are kept in `test/audit/FinalAuditFuzz.t.sol` (only reformatted by `forge fmt`).

| Finding | Change | Regressions (before → after) |
|---|---|---|
| FA-01 (Medium) | The rate-limit clock no longer restarts at every recording ([The rate-limit clock](#the-rate-limit-clock-fa-01)). A recording that sees the same source value at an unchanged price writes nothing; one that moves the price advances the clock from the start of the allowance it used by the whole seconds the move needed, never past now; a new source value sets it to at least that value's timestamp. The limit per recording is unchanged | `test_FA01_pokeOneSecondBeforePushNoLongerMakesInLimitMoveLagging_fixed` (in-limit push after a poke: lagging → not lagging), `test_FA01_sustainedPokingNoLongerMakesPricesLag_fixed` (the auditor's simulation, seconds lagging of 1,800: recordings only at pushes 64 → 64; a poke every second 905 → 94; a poke one second before each push 905 → 94, where the auditor's tried fix gives 489), `test_FA01_laggingShareByPushInterval`, `testFuzz_limit_everyRecordingWithinLimit`, `test_R2_01_fixed_worstCaseInsolvencyTimeOpenTenSecondsAfterThePush` (777 s and 1,083 s), `test_R2_01_fixed_relayerLiquidatableTimeOpenTenSecondsAfterThePush` (516 s) |
| FA-02 (Low), FA-03 (Low) | Funding runs on the oracle's live clock (`liveClock`): every gap of more than `DEAD_AFTER` (14 days) between two recorded valid prices is dead time, booked by the oracle when it records the first price after the gap (`deadTime`), and never charged. A dead-oracle exit pokes the oracle first and accrues up to the last valid time at the last recorded price; if the token stays dead and revives later, the time after the exit is dead time too | `test_FA02_longSilenceFundingNoLongerSkipsKeeperWindow_fixed` (30-day silence, the long's claim at the first accrual: −6.74 → +54.81 USDG, liquidated solvent, no cover claim), `testFuzz_FA02_firstAccrualAfterAnySilenceKeepsTheSideSolvent_fixed` (any silence up to 60 days, the paying side on either side of the book), `test_FA02_liveClockChargesOnlyLiveTime` (a 10-day gap charged in full; two 15-day gaps around one live day charge that day), `test_FA03_deadPeriodAfterADeadExitNotCharged_fixed` (35.99 → 0.000000 USDG) |
| FA-04 (Info) | Forced-exit settlement needs a price at most `OPEN_MAX_AGE` (10 s) old, on either side's request (liquidations keep 60 s through `liquidate`) | `test_FA04_forcedExitSettlementNeedsOpenFreshness_fixed` (an 11 s old price: accepted → `StalePrice`) |
| FA-05 (Info) | `swap`, `addLiquidity` and `removeLiquidity` refuse a zero `minOut`, `minShares`, `minStock` or `minUsdg` (`NoMinimum`), as perps refuses `priceLimit = 0` (IA-10) | `test_FA05_zeroMinimumsRefused_fixed` |
| FA-06 (Info) | `withdraw` applies the deposit's recipient checks: no module, vault, listed token or blocked protocol address | `test_FA06_withdrawRefusesProtocolRecipients_fixed` |
| FA-07 (Info) | Feeds are read with a staticcall that copies back at most five words and checks the length, so a feed without code or with malformed data reads as failed (`sequencerStatus()` = (false, false), price stale) and `poke` never reverts. `setup` refuses a price or sequencer feed that does not answer `latestRoundData` with five words, and a sequencer feed whose answer is not 0 or 1 (`BadFeed`) | `test_FA07_codelessSequencerFeedRefusedAtSetup_fixed`, `test_FA07_feedBrokenAfterSetupReadsAsDownNeverReverts_fixed` |
| Test gaps | The invariant handlers move an L2 sequencer feed between down, grace and up; invariant 3 also covers liquidations reached through `close` and `settleForcedExit` (and the wind-down closes), with an action that has takers close liquidatable positions; IA-01 regressions with a moving price and with a taker's request settling at the bound; `ConfigConstants.t.sol` fails with a clear message when `../packages/config` is missing | `Invariants.t.sol`, `Round3ExtInvariants.t.sol`, `test_IA01_takerForcedExitEqualsPlainCloseAtAMovingPrice_fixed`, `test_IA01_takerForcedExitAtTheBoundPaysSpreadAndFee_fixed`, `test/ConfigConstants.t.sol` |

Assertions that pinned the old timing, changed with the reason written next to them:
`test_F04_fixed_relayerCannotDoublePriceQuickly` (+0.13% after the 8 pushes → +0.15%: the open's read no longer restarts
the clock, which started at the setUp push one second earlier, so the pushes have 9 s of allowance, not 8) and
`testFuzz_limit_everyRecordingWithinLimit` (`lastAt == now` after every recording → the exact new clock rule, plus the
run-wide bound checked against the clock). For the same reason the measured R2-01 numbers move by one second (786 s,
1,092 s and 525 s instead of 787 s, 1,093 s and 526 s). Tests and handlers that passed zero spot minimums now pass 1.

ABI changes (indexer and web, Phase 3 wiring): additive only.

- `OracleAdapter`: new views `liveClock(address) → uint256` (also in `IOracleAdapter`) and `deadTime(address) → uint256`,
  new error `BadFeed(address)` (setup). `bands(token).lastAt` is now the rate-limit clock: after a catch-up it can be
  earlier than the block of the last recording, and a recording that changes nothing leaves the band untouched.
  `sequencerStatus()` and `poke()` no longer revert on a broken feed.
- `SpotPools`: new error `NoMinimum()`.
- `VelumVault`: no ABI change; `withdraw` now reverts `ModuleRecipient` / `ProtocolRecipient` for the refused recipients.
- `PerpsMarkets`: no ABI change; `settleForcedExit` reverts `StalePrice` for a price older than 10 s; funding over a
  dead gap is no longer charged (`markets(m).lastFundingUpdate` is still the block time of the last accrual).
- Storage: `OracleAdapter` and `PerpsMarkets` each append one mapping (contracts are immutable; this is a redeploy).

Design choices:

- **FA-01, a clock that only spends the time a move used.** The auditor's tried fix (store nothing when nothing changed,
  otherwise restart at now) is not enough: a poke one second before each push, after the price has caught up, stores
  the caught-up price and restarts the clock, so the push gets one second of allowance, lags, and the cycle repeats
  (489 of 1,800 s lagging in the auditor's simulation). Advancing the clock by the time the move used removes that
  lever. Time is never credited twice: each move of `u` whole seconds' worth (u ≥ 1) advances the clock by at least `u`,
  and `1 + u/6000 ≤ (1 + 1/6000)^u`, so over any run the price stays within `(1 + 1/6000)^c` of the price at the clock's
  start `c` seconds earlier, and one recording still moves it at most 5%: exactly the R2-01 bound. Whole seconds, not
  fractions: fractional credits would let pieces of a second compound slightly faster than `(1 + 1/6000)^t`. A new
  source value sets the clock to at least its timestamp, so at any successful read the clock started at most that
  read's maxAge earlier (10 s for opens); guarantees measured from an open move by at most 10 s (the 12-minute
  open-to-insolvency bound: 787 s → 777 s worst case; the relay-key bound: 526 s → 516 s). Not storing catch-ups at
  all (a two-phase move computed at the next push, with the old target kept in storage) was simulated: within about
  15% of this clock either way (a little better at TSLA-like volatility, worse at twice that), so not worth the extra
  state. In both, what remains is mostly not lost time but the price path continuing from the price that was observed,
  which is the protection a keeper's recording gives (see [The rate-limit clock](#the-rate-limit-clock-fa-01)).
- **FA-02 and FA-03, one rule with the dead threshold.** A gap counts as dead when it is longer than the oracle's
  `DEAD_AFTER` (14 days), the threshold that already makes a token dead, so the dead-exit rule (IA-02) and the revival
  rule are the same rule and FA-03 cannot recur. `MAX_AGE` (60 s) was rejected: every night, weekend and any minute
  without a recording would go unpaid, and on a Chainlink market the receiving side would have to record a price every
  minute to keep earning; funding through ordinary market closures is part of the model. With 14 days the largest
  one-shot charge is 14 days × 0.01%/h = 3.36% of the price; with the 5% cap on one price recording that is at most
  8.53% of notional, under the 10% maintenance margin, so a side above maintenance at the last valid price (funding
  accrued) is still solvent at the first accrual after any silence. A cap on funding per accrual was considered and
  not added: the threshold already bounds the one-shot charge, and a cap would forgive owed funding with a new
  hard-coded number. The gap is booked by the oracle and not computed by perps from "the previous price", because the
  relay's own push records the new price before any accrual and several gaps can pass between two accruals.
- **FA-04, done.** Settlement is never time-critical (it is matured), the relay pushes every 8-10 s and opens already
  need 10 s, so a 10 s price is available whenever the relay runs; liquidations keep 60 s through `liquidate`, and the
  dead-oracle path needs no price. No new liveness problem; with heartbeat-only Chainlink feeds a keeper settles right
  after a round, as for opens (see the production-oracle limitation).

### On-chain workers audit (2026-11, `test/audit/OnchainWorkersAuditPoC.t.sol`)

The independent audit of the Phase 3 on-chain workers found one issue with a contract side; its other findings are
worker fixes (docs/02-architecture.md, "Phase 3 on-chain workers").

| Finding | Change | Regressions (before → after) |
|---|---|---|
| M-1 (Medium) | `pushPrices(tokens, prices, observedAt)`: every push carries the time the relay observed its prices (chain time, one per batch). It reverts `ObservedInFuture` when `observedAt > block.timestamp`, `PushExpired` when `block.timestamp > observedAt + MAX_PUSH_DELAY` (10 s), and `StaleObservation` when `observedAt` is not newer than a token's last pushed observation (the whole batch reverts). `observedAt` is the prices' source timestamp: `relayed(token).updatedAt`, the freshness of `read` and `price` (10 s for opens, 60 s otherwise), `lastValidAt`, the live clock and the clock rule "a new source value sets the clock to at least its timestamp". The one-push-per-token-per-second limit stays on the block time (`relayed(token).pushedAt`); bounds, rate limit and sequencer rules are unchanged | `test_M1_withheldPushLandedMinutesLaterIsRefused_fixed` (the auditor's R1 run: 392.00 signed, held back 206 s while the market fell to 380.00: landed as a fresh, non-lagging price and a short could open at it → `PushExpired`, the price stays stale, no open), `test_M1_pushHeldForTheMaxDelayLeavesNoExtraOpenWindow_fixed` (held exactly 10 s: lands, stamped with its observation, so the open window still ends 10 s after the observation), `test_M1_withheldOlderPushCannotOverrideANewerOne_fixed`, `test_M1_pushExpiresAfterMaxPushDelay`, `test_M1_observationMustBeNewerAndOnePushPerSecond`, `test_M1_freshnessAndClockCountFromTheObservation`, `testFuzz_M1_everyRecordingWithinLimitWithObservationDelays` |

- **Why 10 s.** `MAX_PUSH_DELAY` equals `OPEN_MAX_AGE`: a push lands while its prices are still fresh enough for an open,
  or not at all. Whoever holds back a signed push (a withholding RPC, a stuck mempool) can at most choose which of the
  relay's own observations of the last 10 s lands, which is the option any open already has on a price up to 10 s old,
  and never an older one over a newer one. A longer validity would only add pushes that land too old for opens and are
  written as current for closes, liquidations and funding; a shorter one would make honest pushes fail: the relay
  stamps `observedAt` with its chain-clock estimate minus the snapshot's age (at most 6 s) and one second of margin, so an
  honest push lands 1 to 8 s after its observation.
- **Every oracle property is kept.** `observedAt ≤ block.timestamp`, so a new source value still moves the clock to at
  most now; the clock still only moves forward and every move still advances it by the whole seconds it used, so one
  recording moves the price at most 5% and over any run the price stays within `(1 + 1/6000)^t` of the price at the
  clock's start (`testFuzz_M1_everyRecordingWithinLimitWithObservationDelays`, the FA-01 fuzz test with pushes landing
  0 to 10 s after their observation). A push observed d seconds before its block restarts the clock d seconds earlier
  than before, so the next push has up to d more seconds of allowance: the time that really passed since the
  observation, which is what the limit measures. "At any successful read the clock started at most maxAge earlier"
  holds as before, because the read's freshness and the clock count from the same observation time. Every earlier test
  pushes with `observedAt = block.timestamp`, the old behaviour, and passes unchanged; the 12-minute, keeper-window and
  relay-key bounds are therefore unchanged.

ABI changes (contracts are immutable: this is a redeploy, and the price-relay worker of the same release must be used):

- `OracleAdapter.pushPrices(address[] tokens, uint256[] prices)` → `pushPrices(address[] tokens, uint256[] prices, uint256 observedAt)` (new selector).
- `OracleAdapter.relayed(address)` → `(uint128 price, uint64 updatedAt, uint64 pushedAt)`: `updatedAt` is now the observation
  time, `pushedAt` the block time of the push (same storage slot).
- `event PriceRelayed(address indexed token, uint256 price, uint256 effectivePrice, uint256 observedAt, uint256 timestamp)`
  (was without `observedAt`: new topic0).
- New constant `MAX_PUSH_DELAY() → 10`; new errors `ObservedInFuture(uint256)`, `PushExpired(uint256)`,
  `StaleObservation(address, uint256)`. `IOracleAdapter` and every other contract: no ABI change.

### Launch guard audit (2026-11, `test/audit/GuardAuditPoC.t.sol`, `test/audit/GuardDeployPoC.t.sol`)

An independent audit of the launch guard ([Guarded launch](#guarded-launch)). The auditor's differential invariant suite
(`GuardDiffInvariant.t.sol` + `GuardDiffHandler.sol`), caps fuzz (`GuardCapsFuzz.t.sol`) and gas test (`GuardGas.t.sol`)
are kept in `test/audit/`, adapted to the fix. No §5 number changes; the deploy script still refuses chain 4663.

| Finding | Change | Regressions |
|---|---|---|
| G-01 (Medium): the global cap was one room all accounts shared; once full (organically, front-run by a counterparty right before a victim's margin top-up, or filled by the admin's own allowlisted addresses) nobody could add margin | While caps are active, `globalCap[t] >= accountCap[t] × allowlistedCount` for every token, enforced in `addToAllowlist` and `raiseCaps` (`Oversubscribed`); holdings ≤ Σ `netDeposited` ≤ that, so the global check (now after the account check, kept as a backstop) never refuses a deposit within the account's own room. `openToPublic` requires `liftCaps` first (`CapsStillActive`), so caps never apply without the allowlist. The auditor's prototype checked `acc × count` (can overflow on a huge cap; now `acc > glob / count`) and still allowed caps after `openToPublic` | `test_G01_oversubscribedConfigurationRefused_fixed` (the auditor's 3,000 / 6,000 for four addresses is refused), `test_G01_frontRunCannotBlockMarginTopUp_fixed` (bob fills all his room before alice's top-up: it goes through and saves the position), `test_G01b_fullBetaCannotBlockTopUp_fixed`, `test_G01c_adminSybilCannotFillOthersRoom_fixed`, `testFuzz_G01_accountRoomAlwaysAvailable_fixed`, `test_G01_openToPublicNeedsCapsLifted_fixed`; `test/LaunchGuard.t.sol` (`test_addToAllowlist_needsGlobalRoomForEveryAccount_G01`, `test_caps_globalCoversEveryAccount_G01`, overflow-safe `raiseCaps`); the room rule in invariant 6, the diff suite and the caps fuzz |
| G-02 (Low): room tracks lifetime net deposits, so losses never restore it, while a winner who withdraws gets full room back | Documented, no code change (deliberate: the cap bounds new money per address); guidance: account caps ≥ 2× expected margin, the UI shows `depositLimit` ([Used-amount accounting](#guarded-launch)) | `test_G02_lossesNeverRestoreRoomWinnersResetToZero_fixed` |
| D-01 (Low): `vm.envOr("GUARD_ADMIN", 0)` read a malformed address as unset: a silent unguarded deploy announced as "GUARD_ADMIN not set" | Every variable the script reads goes through `vm.envExists` + `vm.envAddress` / `vm.envUint` / `vm.envBool`: unset or empty is "not given", anything else must parse (`GUARD_ADMIN`, `GUARDIAN`, `PRICE_RELAYER`, `USDG_ADDRESS`, `PRICE_MIN_USD`, `PRICE_MAX_USD`, `OI_CAP_TOKENS`, `GUARD_ALLOW_SMALL_USDG_CAP`); a mixed-case address needs a correct EIP-55 checksum (also in `STOCK_ADDRESSES`) | `test_D01_malformedAddressRefused_fixed`, `test_D01_malformedNumberAndFlagRefused_fixed`; end to end on anvil: a truncated `GUARD_ADMIN` stops `forge script` before anything is broadcast |
| I-01: the admin could be the deployer key, or a plain key | `checkGuard` refuses `GUARD_ADMIN` = deployer outside anvil (31337); `guardNotice` prints a loud warning when the admin address has no code on the chain | `test_I01_checkGuardRefusesDeployerAsAdminOutsideAnvil_fixed`, `test_I01_guardNoticeWarnsWhenAdminHasNoCode_fixed` |
| I-02: zero caps printed as "0 / 0 tokens"; caps were whole tokens only; a zero or tiny USDG cap made the protocol unusable | `guardNotice` prints `BLOCKED` for a zero account cap and the allowlist room; caps are token amounts with up to the token's decimals (`250.5`), parsed strictly; a USDG account cap below 10 USDG (the minimum position size) needs `GUARD_ALLOW_SMALL_USDG_CAP=true` | `test_I02_guardNoticeBlockedAndDecimals_fixed`, `test_I02_parseUnits_fixed`, `test_I02_checkGuardRefusesUnusableUsdgCap_fixed` |
| I-05: both invariant suites ran guarded, so the unguarded default lost its own invariant coverage | `InvariantsUnguardedTest` runs the main suite on an unguarded vault (plus `invariant_staysUnguarded`) | `test/invariant/Invariants.t.sol` |

ABI changes (`VelumVault` is immutable: this is a redeploy; the web app reads only views that are unchanged):

- New view `allowlistedCount() → uint256`.
- New errors `Oversubscribed(address token, uint256 accountCap, uint256 globalCap, uint256 allowlisted)` (from
  `addToAllowlist`, `raiseCaps`) and `CapsStillActive()` (from `openToPublic`).
- Behaviour: `openToPublic` reverts while caps are active and, when it succeeds, always retires the guard; a deposit
  over both caps now reports `AccountCapExceeded` (the account check runs first). Events, storage of the existing
  variables and every other function are unchanged. `Deploy.s.sol`: `checkGuard(Guard, chainId, deployer, relayer)` and
  `guardNotice(Guard)` take the guard struct; new helpers `envAddressStrict`, `envUintStrict`, `envBoolStrict`,
  `checksumOk`, `parseUnits`, `formatUnits` (scripts only).

### New parameters (constants; not in CLAUDE.md §5, which is unchanged)

| Parameter | Value | Contract |
|---|---|---|
| Price rate limit | 5% per recording at most (`MAX_MOVE_BPS` = 500) | `OracleAdapter` |
| Rate-limit window | 5 minutes (`MOVE_WINDOW`): the move allowed grows linearly with time on the rate-limit clock up to this, so 1/6000 per second, 1% per minute; the clock only moves for a new source value or a price change, by the time the move used (FA-01) | `OracleAdapter` |
| Sequencer grace | 1 hour (`SEQUENCER_GRACE`) | `OracleAdapter` |
| Relay push validity | 10 s (`MAX_PUSH_DELAY`) from the observation time a push carries to its block, equal to `OPEN_MAX_AGE` (M-1) | `OracleAdapter` |
| Open price age | 10 s (`OPEN_MAX_AGE`), also for margin removal (IA-03) and forced-exit settlement (FA-04); closes, liquidations, funding 60 s (`MAX_PRICE_AGE`) | `PerpsBase` |
| Funding dead-gap threshold | A gap between valid prices longer than `DEAD_AFTER` (14 days) is not charged: the oracle's existing dead threshold, not a new constant (FA-02, FA-03) | `OracleAdapter.liveClock` |
| Grace-period liquidation threshold | MM / 2, derived (`MM_BPS / 2` = 5% of notional at 5x), not a new constant (IA-07) | `PerpsBase._liquidationSide` |
| Cover epoch | 1 hour (`COVER_EPOCH`) | `PerpsBase` |
| Cover cap per epoch | 10% of the insurance fund at the epoch's first draw, top-ups included (`COVER_CAP_BPS`) | `PerpsBase` |
| Minimum position | 10 USDG (`minPositionSize`) | `PerpsBase` |
| Keeper top-up cap | 1 USDG (`keeperRewardCap`) | `PerpsBase` |
| Minimum open spread | 2 bps (`MIN_OPEN_SPREAD_BPS`) | `MakerBook` |

### Why these choices

- **Rate limit on both sources, relative to the last recorded price (R2-01).** A claim moves by `qty × Δprice`; a 5x side starts with a 20% margin and is liquidated below 10% of notional. The limit gives these guarantees (tests in `test/audit/Round2PoC.t.sol`):
  - **Open to insolvency ≥ 12 minutes.** No side of a pair opened at any non-lagging price (after any history, at any leverage, side, size and open spread the book allows) can fall below zero within 12 minutes of the open, whatever the source reports. The tight worst case is a 5x short at the 5% maximum open spread, 13.1 minutes (787 s) of a recording every second at the limit, counted from the start of the rate-limit clock; at the 2 bps minimum spread it is 18.2 minutes (1,093 s). Since FA-01 an open's read that changes nothing does not restart the clock, which can then have started up to 10 s (`OPEN_MAX_AGE`) before the open: from the open the worst case is 777 s and 1,083 s (`test_R2_01_fixed_worstCaseInsolvencyTimeOpenTenSecondsAfterThePush`).
  - **Keeper window.** A side that is not liquidatable at a recorded price needs a 10% adverse move to reach zero: never in one recording (≤ 5%), and at least 9.5 minutes of recordings (10% up takes ln 1.1 / ln(1 + 1/6000) = 572 s). It follows (`testFuzz_R2_01_fixed_notLiquidatableSurvivesAnyNextRecording` checks the one-step bound) that between its last non-liquidatable recording and its first insolvent one there are always at least 60 s of fresh prices at which it is liquidatable and solvent: the recording just before insolvency is one, and if recordings come faster than once a minute the 10% takes at least 9.5 minutes of fresh prices. The R2-01b regression measures 572 s. In that window the position offers a 0.5% of notional liquidation reward.
  - **Compromised relay key.** Prices move at most 1.005% per minute, so an honest 5x maker's claim falls by at most 5.5% of its margin per minute while it is above maintenance. It cannot be made liquidatable sooner than 8.6 minutes after the open (measured 516 s with the open 10 s after the relay's last push, 525 s right after it; 526 s before FA-01) or insolvent sooner than 18 minutes. Doubling a price takes at least 69 minutes. Opens and closes at a jumped price are refused as lagging, so the in-window oscillation of R2-01 is gone.
  - **Parameters.** 5% per recording is half the 10% maintenance cushion. 1% per minute keeps the first round's average speed (10% per 10 minutes), so honest gaps catch up as before: a 30% gap takes about 20-35 minutes. A slower limit would halve the relay-key bound but refuse most opens in normal markets (see limitations).
- **Lagging prices.** While a source is outside the limit (or outside the bounds, IA-06), the reported price is a known-wrong, catching-up value. Opens, closes (on both routes, R2-04), forced exits that are not liquidations and margin removal at it are refused: they would be free options against the counterparty. The one exception is a matured forced exit once the reported price has reached the bound the source is beyond: it settles at the bound, so a market is never stuck. Liquidations and funding go on, because they reduce risk. A loser liquidated at a lagging price keeps less than 9% of notional relative to the source price. Anyone can call `liquidate`, the loser included, but it then gains only the 0.5% keeper half a third party would get.
- **10 s opens, 2 bps floor (F-06).** Two-step (commit/fill) opens would remove the option entirely but need a coordinator flow (Phase 4). With opens limited to 10 s old prices, the remaining option is worth less than the minimum taker round trip (≥ 2 bps open spread + 6 bps fee in, 6 bps fee out). Closes keep 60 s. That is not risk-free for the maker (R2-06): at a price up to 60 s old the taker holds an exit option worth the market's move since that price, minus the close spread and the 6 bps fee. It is bounded because a pushed jump beyond the rate limit makes the price lagging, and lagging closes are refused. 60 s is kept so closes don't fail whenever the relay is a few seconds late. Makers price the option into their close spread.
- **Cover cap (R2-02, R2-03).** One epoch's keeper top-ups plus cover draw at most 10% of the fund as it stood at the epoch's first draw. That 10% is shared pro rata with every honest claimant of the same hour, and claims never carry over, so the fund cannot be queued out. Draws leave the fund at once. So an event spanning two epochs takes at most 19% (10% + 10% of the remaining 90%), and k consecutive epochs at most 1 − 0.9^k of the fund. Fees earned in between add to the base.

### The rate-limit clock (FA-01)

The limit is `maxMove = last × 5% × dt / 5 min` with `dt = min(now − lastAt, 5 min)`. Before the final audit every
recording (a push, but also anyone's `poke` or `read`, so every trade, keeper and indexer call) set `lastAt = now`,
throwing away the allowance the next pushed value would have had: with a poke every second, 36-50% of seconds saw
a lagging price at TSLA-like volatility with pushes every 5-8 s (the table below; 50% in the auditor's simulation), and
opens, closes, margin removal and forced exits reverted. The quiet column is the same before and after. Now:

- a recording that sees the same source value at an unchanged price writes nothing;
- a recording that moves the price sets `lastAt` to the start of the allowance it used (`lastAt`, or `now − 5 min` if
  later) plus the whole seconds the move needed at 1/6000 of the price per second, rounded up, never past now. A move
  clamped at the limit therefore uses everything up to now, as before; a catch-up that needed less leaves the rest;
- a new source value sets `lastAt` to at least its timestamp (for the relay: the observation time the push carries, at
  most 10 s before its block, M-1; before, the push's block time).

What a third party can still do: a recording rounds the time a catch-up used up to the next whole second, so a poke
costs at most one second of allowance per pushed value that lagged; and a recorded price pins the path, so the next
pushed value moves on from the price that was observed (that is the protection a keeper's recording gives, and the
reason a busy market lags somewhat more than a quiet one at high volatility). Recordings that change nothing, which
are most of them, have no effect at all.

Measured share of seconds at which an open or close would see a lagging price (`test_FA01_laggingShareByPushInterval`;
the source follows a per-second random walk, the relay pushes its latest value every k seconds, 30 minutes per cell;
"busy" = a poke every second, standing in for trades, keepers and indexers):

| Volatility | Push every | Quiet (recordings only at pushes) | Busy, before FA-01 | Busy, after FA-01 |
|---|---|---|---|---|
| 0.19%/min (TSLA-like) | 1 s | 62.4% | 62.4% | 62.4% |
| | 2 s | 30.6% | 52.6% | 42.3% |
| | 5 s | 5.2% | 39.2% | 6.5% |
| | 6 s | 2.8% | 38.2% | 4.5% |
| | 8 s | 1.2% | 35.8% | 1.6% |
| | 10 s | 0.2% | 30.4% | 0.2% |
| 0.38%/min | 1 s | 86.6% | 86.6% | 86.6% |
| | 2 s | 67.6% | 80.6% | 77.3% |
| | 5 s | 37.5% | 69.7% | 53.0% |
| | 6 s | 31.3% | 69.0% | 50.0% |
| | 8 s | 20.0% | 64.0% | 31.3% |
| | 10 s | 13.2% | 58.5% | 21.2% |

Pushing more often does not help: every pushed value restarts the clock at its own (observation) time (needed so that
the clock is never more than 10 s behind an open), so frequent small pushes each get little allowance. With pushes every 8-10 s at
TSLA-like volatility, at most 1-2% of seconds lag, busy or not; pushes must stay at most 10 s apart for opens.

## Guarded launch

An optional launch guard in `VelumVault` lets the owner run a beta limited to approved wallets and small amounts
before the external audit opens the protocol to everyone. It is fixed at deploy and **off by default** (the testnet
deployment is unguarded). On mainnet it is required: `script/Deploy.s.sol` refuses chain 4663 without it (see
[Mainnet: the guarded beta](#mainnet-the-guarded-beta)).

**Where it sits.** `VelumVault.deposit` is the only way tokens enter the protocol: the spot pools, the maker book and
perps never transfer ERC-20s, they only move internal vault balances (`transferInternal`), and the forced-exit bond is
ETH held by perps. So the guard checks `deposit` (and `setApproval`, below) and nothing else; `PerpsMarkets`,
`SpotPools`, `MakerBook` and `OracleAdapter` are unchanged.

| Part | While active | Switched off by |
|---|---|---|
| Allowlist | `deposit` needs both the payer (`msg.sender`) and the credited account (`to`) on the allowlist, and only an allowlisted address can **grant** a module approval (revoking always works). Without an approval no module can debit an account, so an address outside the allowlist cannot open, post offers, add liquidity, swap, add margin or fund insurance. | `openToPublic()`, one-way, only after `liftCaps()` |
| Caps (per token, base units: USDG 6 decimals, stock tokens 18) | After a deposit, the credited account's `netDeposited` must be at most `accountCap[token]` and the vault's holdings `totalInternal[token]` at most `globalCap[token]`. A cap of zero blocks that token until it is raised. The global cap always covers the account cap of every allowlisted address: `globalCap >= accountCap × allowlistedCount`, enforced by `addToAllowlist` and `raiseCaps` (G-01, below). | `liftCaps()`, one-way |

**Every allowlisted address always has its own full room (G-01).** Before the guard audit the global cap was one room
all accounts shared: once it was full (organically, or filled on purpose by a counterparty right before a victim's
margin top-up, or by the admin's own allowlisted addresses), nobody could deposit to add margin, and a position could be
liquidated that a top-up would have saved. Now:

- `addToAllowlist` refuses (`Oversubscribed(token, accountCap, globalCap, allowlisted)`, the whole batch) when any
  token's global cap would not cover one account cap per allowlisted address, the new ones included, and `raiseCaps`
  refuses a raise that would leave it uncovered. Raise the global caps first, then allowlist. A zero account cap needs
  no room. The allowlist starts empty at setup, so the rule holds from the start.
- The vault's holdings never exceed the sum of `netDeposited` (a deposit adds the same to both; a withdrawal lowers
  holdings by the amount and the withdrawer's count by at most that; trading moves neither), and only allowlisted
  accounts have any. So holdings ≤ account cap × allowlisted ≤ global cap at all times, and a deposit within the
  credited account's own room is always within the global cap: the global check (kept as a backstop, after the account
  check) never refuses one. `depositLimit(account, token)` is therefore the account's own room. Nobody, the admin
  included, can use up another account's room.
- What is at risk is bounded by account cap × allowlisted addresses (≤ the global cap); the global cap is the
  ceiling the admin commits to, and limits how many addresses can be allowlisted at the current account cap.
- **Caps never apply without the allowlist.** `openToPublic()` reverts with `CapsStillActive()` while caps are active:
  lift the caps first. Open to everyone, the per-address cap means nothing (anyone can make more addresses) and the
  global cap would again be room anyone could fill, which is G-01 with sybils. Of the two ways to rule that state out
  (require `liftCaps` first, or lift the caps inside `openToPublic`), requiring it is the safer: every irreversible step
  stays its own explicit call that does exactly what its name says, an operator script written for the old order
  fails loudly instead of silently removing the caps, and the intermediate state (allowlisted addresses only, no caps)
  is strictly less exposed than the final one. `openToPublic` therefore always retires the guard.

**Withdrawals are never checked.** `withdraw` has no allowlist or cap check (while caps are active it only lowers the
caller's `netDeposited`, saturating, so it cannot revert), and nothing a module does goes through the guard: closes,
liquidations (by anyone, allowlisted or not), forced exits, offer withdrawals, liquidity removal, cover and bond claims
work for everyone, always. There is no removal from the allowlist (below), so nobody who could deposit can later be
stopped from adding funds by the allowlist; caps can only go up, and no other account's deposits can take an account's
room (G-01). What can stop a deposit is the account's own cap: its net deposits, which losses do not lower (G-02,
below).

**Used-amount accounting: net of withdrawals, never below zero.**

- Per account: `netDeposited[account][token]` = deposits credited to the account minus its withdrawals, floored at
  zero. A deposit adds what arrived, a withdrawal subtracts what left. Cycling deposit, withdraw, deposit never takes an
  account above its cap: at every moment the count is at most the cap.
- It counts deposits, not the free balance: funds locked in offers, margin or liquidity still count, so an account
  cannot deposit, lock and deposit again.
- Profits or keeper rewards withdrawn beyond what was deposited set the count to zero, never below: an account can
  never bring in more than its cap of new money at once, even after taking out winnings. Value moved between accounts
  by trading is not a deposit; allowlisted accounts acting together hold at most the sum of their caps of their own new
  money, and the global cap bounds everything.
- **Room tracks lifetime net deposits; losses do not restore it (guard audit G-02, documented).** A trading loss
  moves value to the counterparty without a withdrawal, so the loser's count stays where it was: an account that
  deposited its whole cap and lost more than half of it cannot deposit a single unit, although it now holds under
  half its cap, and after it withdraws what is left its room stays cut by the loss. The winner withdraws its gains and
  its count goes to zero (full room again). This is deliberate: the cap measures how much new money an address has
  brought in, so a loss followed by a new deposit cannot take an address's total contribution above its cap
  (`test_G02_lossesNeverRestoreRoomWinnersResetToZero_fixed`). Operational guidance: set account caps at least **2×**
  the margin a tester is expected to need (positions plus a top-up buffer), raise the account cap for everyone (with
  the global room it needs) when testers run out, and have the UI show `depositLimit(account, token)` (the web app
  does) so testers see their remaining room before they need it.
- Global: the vault's holdings `totalInternal[token]`, which is exactly all deposits minus all withdrawals; no
  separate counter. Since G-01 it never limits an account before its own cap does.
- Not chosen: gross counting (deposits only, never decreasing). It would stop a tester who withdraws from ever coming
  back, and a global gross cap measures history, not what is at risk.
- Once caps are lifted nothing is tracked any more (`netDeposited` stays frozen and unused).

**The guard admin** (one address fixed at setup: the owner's wallet or multisig) can only:

| Function | Effect |
|---|---|
| `addToAllowlist(address[] accounts)` | Add addresses (batch; already listed ones are skipped, the zero address reverts the batch). While caps are active every token's global cap must cover one account cap per allowlisted address, the new ones included, or the batch reverts with `Oversubscribed` (G-01). |
| `raiseCaps(token, accountCap, globalCap)` | New caps in base units; neither may go down, the account cap may not exceed the global cap, and the global cap must cover the account cap of every allowlisted address (`Oversubscribed` otherwise, G-01). |
| `liftCaps()` | Remove the caps forever. The allowlist keeps applying until `openToPublic()`. |
| `openToPublic()` | Remove the allowlist forever. Only once the caps are lifted (`CapsStillActive` otherwise, G-01); it then also retires the guard. |
| `transferGuardAdmin(newAdmin)`, then `acceptGuardAdmin()` from `newAdmin` | Two-step handover; proposing zero cancels a pending one. |

Once both switches are off the role is cleared (`guardAdmin` becomes zero, `GuardAdminTransferred(admin, 0)`) and the
vault behaves exactly like an unguarded deployment.

**What the guard admin cannot do:** move, freeze or redirect funds (no function of it touches a balance); block or
delay any withdrawal, close, forced exit, liquidation or claim; remove an address; lower a cap; use up anyone's deposit
room (each address it allowlists brings its own room in the global cap, G-01: allowlisting its own addresses and filling
them takes nothing from anyone else's); switch the allowlist or the caps back on; pause anything; change prices,
parameters, tokens, modules or any other contract. So it has no power over any user's ability to add margin. A stolen
admin key can at most allowlist anyone and raise caps without limit, which is the state the protocol is meant to reach
anyway (`liftCaps` + `openToPublic`), not a loss of funds. Keep the key cold (a multisig); the deploy script refuses the
price-relay key as admin, refuses the deployer key outside anvil, and warns loudly when the admin has no code (a plain
key rather than a multisig).

**Why there is no removal.** Removing an address cannot take anything back (withdrawals stay open), so it could only
stop that user's future deposits, including a deposit they need to add margin and save a position from liquidation: a
selective power over one user's positions. Filling a shared global cap would have been the same power over every user
at once, which is why the global cap must cover every allowlisted address's account cap (G-01). The allowlist is
therefore add-only: to keep someone out, do not add them. Sanctions screening stays a frontend measure (docs/04 §4); an
on-chain blocklist would need an owner decision and a new review.

**Deploying with the guard** (token amounts, decimals allowed up to the token's `decimals()`, e.g. `250.5`; the script
converts them to base units):

```bash
GUARD_ADMIN=<owner multisig> \
GUARD_ACCOUNT_CAP_USDG=1000 GUARD_GLOBAL_CAP_USDG=50000 \
GUARD_ACCOUNT_CAP_TSLA=2 GUARD_GLOBAL_CAP_TSLA=100 \
...one pair per listed stock symbol... \
PRICE_RELAYER=<relay key address> forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key <key>
```

With `GUARD_ADMIN` set every listed token needs both caps. Refused: caps without `GUARD_ADMIN`; an account cap above its
global cap; a cap that is not a plain token amount (`1,000`, `1e6`, `-1`, hex, more decimals than the token has); the
price-relay key as admin; the deployer key as admin outside anvil (I-01); a USDG account cap below 10 USDG, the minimum
position size (0 blocks USDG, the margin and quote asset, so nobody could trade), unless
`GUARD_ALLOW_SMALL_USDG_CAP=true` says it is intended (I-02); and a malformed `GUARD_ADMIN`, which `vm.envOr` used to
read as unset, deploying an unguarded vault (D-01). Unset or empty `GUARD_ADMIN` means unguarded. The script prints the
guard configuration before deploying and again after the addresses: admin and powers, a loud warning when the admin
address has no code on the chain (not a multisig, I-01), every cap as a token amount and in base units (`BLOCKED` for a
zero account cap, I-02), and the allowlist room, min(global / account) over the tokens: how many addresses can be
allowlisted before the global caps must be raised (the example above: 50). It writes `guardAdmin` to the deployments
JSON. Without `GUARD_ADMIN` it prints that the guard is off.

**Operating it** (from the guard admin; caps in base units):

```bash
# room first: each allowlisted address needs one account cap of every token's global cap (G-01)
cast send $VAULT "raiseCaps(address,uint256,uint256)" $USDG 5000000000 200000000000   # 5,000 / 200,000 USDG: 40 addresses
cast send $VAULT "addToAllowlist(address[])" "[0xAlice,0xBob]"
cast call $VAULT "allowlistedCount()(uint256)"
cast send $VAULT "liftCaps()"        # irreversible: no caps (the allowlist stays)
cast send $VAULT "openToPublic()"    # irreversible, only after liftCaps: everyone may deposit; the admin role is cleared
cast send $VAULT "transferGuardAdmin(address)" $NEW_ADMIN   # then, from $NEW_ADMIN: acceptGuardAdmin()
```

Lift the caps and then open to the public after the external audit (the caps can go first and the allowlist later).

**Views for the UI, keepers and monitoring:** `guarded()`, `allowlistActive()`, `capsActive()`, `guardAdmin()`,
`pendingGuardAdmin()`, `isAllowlisted(account)`, `allowlistedCount()`, `isAllowed(account)` (true once public),
`accountCap(token)`, `globalCap(token)`, `netDeposited(account, token)`, `totalInternal(token)` (the global amount used)
and `depositLimit(account, token)`: the most `account` can deposit for itself right now (zero when not allowed,
`type(uint256).max` once caps are lifted; while caps are active, since G-01, the account's own room). A deposit
credited to someone else needs both addresses allowlisted and counts against the recipient's cap. Refusals:
`NotAllowlisted(account)`, `AccountCapExceeded(account, token, netDepositedAfter, cap)`, `GlobalCapExceeded(token,
totalAfter, cap)` (a backstop that no longer triggers), and for the admin `Oversubscribed(token, accountCap, globalCap,
allowlisted)` and `CapsStillActive()`.

**Gas.** An unguarded or switched-off guard costs about 0.4k gas per deposit (the guard flags share the storage slot
of `locked`, which `deposit` already reads), 2.1k per withdrawal and per approval (one cold read of that slot); module
calls (`transferInternal`) are unchanged. While caps are active a first deposit costs about 36k more (the
`netDeposited` write and the cap reads). The G-01 room check runs only in `addToAllowlist` and `raiseCaps` (one read
of each token's caps per batch): deposit gas is unchanged (`test/audit/GuardGas.t.sol`, run with `--isolate`).

**Limitations.**

- Caps are per address: one person with several allowlisted addresses has several caps. What is at risk is bounded
  by the account cap times the allowlisted addresses, which the global cap covers.
- An account at its own cap cannot deposit more to add margin (since G-01 the global cap never stops it first), and a
  loss does not give room back (G-02). Funds already in the vault still can be moved (withdraw an offer, remove
  liquidity, close another position), and the admin can raise caps; size account caps at least 2× the expected margin
  and show `depositLimit` in the UI.
- The global cap must grow with the allowlist (one account cap per address): plan it before allowlisting, or raise it
  first; an allowlisting without room reverts and changes nothing.
- Keepers outside the allowlist can liquidate and settle forced exits and receive the rewards. They can withdraw them
  but, without an approval, not use them in a module while the allowlist is active.
- The guard is fixed at setup: turning it on for an existing deployment means redeploying (like the guardian).

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

A split that moves the price outside the oracle bounds leaves that market's price lagging for good at the
bound (IA-06): opens, closes and margin removal are refused, positions liquidatable at the bound are
liquidated there, and the rest leave by forced exit at the bound 7 days after a request. The market never
counts as dead while its feed publishes. Settle it fully first and redeploy the market. Deploy with wide bounds
(default 1 to 100,000 USDG) to keep normal splits inside them. A split inside the bounds is walked by the rate
limit at 1% per minute (a 2-for-1 split takes about 70 minutes to catch up), which is why the market
must be empty first.

## Known limitations and risks (review before any audit)

- **Relayer trust (testnet).** A signed push is valid for 10 s after the observation it carries (M-1), so a withholding RPC cannot land it later as a fresh price; the price-relay worker can broadcast through a second, trusted endpoint (`RPC_URL_SEND`). A compromised relay key can still move a price, but only at 1% per minute (5.5% of a 5x maker's margin per minute, doubling in ≥ 69 minutes). Makers cannot close a filled position themselves, so committed margin stays exposed at that rate until the taker closes, a keeper liquidates, or a forced exit matures. Production must use verified Chainlink feeds with the sequencer-uptime feed (implemented) or a low-latency verified oracle.
- **Production oracle choice is open.** Opens and forced-exit settlement need a price at most 10 s old. Chainlink push feeds for stocks update on deviation or heartbeat, so with them opens would revert most of the time; production needs a low-latency verified source (for example a pull oracle verified at open), which changes the adapter. Choose before the external audit.
- **Lagging in normal markets (owner decision).** Because "lagging" means the effective price differs from the source at all, ordinary volatility faster than the limit over the push interval makes opens, closes, margin removal and forced exits revert until the price catches up. Since FA-01, recordings by other users no longer make this worse beyond the rounding described in [The rate-limit clock](#the-rate-limit-clock-fa-01); its table has the measured numbers. At TSLA-like volatility (0.19% per minute) about 1.6% of seconds lag with 8-s pushes and 0.2% with 10-s pushes in a busy market (5-s pushes: 6.5%; the earlier "push every 5-8 s, about 14% lagging" estimate is replaced by these measurements, and pushing more often makes it worse: 42% with 2-s pushes). At twice that volatility it is 31% with 8-s pushes and 21% with 10-s pushes. Refusing then is protective (the on-chain price is behind the market, so opening at it would be a free option), but users see retries. The price-relay worker should push every 8-10 s (opens and forced-exit settlement need ≤ 10 s), and the UI should retry after a fresh push. Alternatives for the owner (same model, busy market, 8-s pushes): a faster limit (2% per minute: 0% lagging at TSLA-like volatility, 1.8% at twice that, but twice the relay-key bound and keeper windows half as long); or a small lag tolerance for opens executed at the worse of the two prices for the taker (changes the lagging rule). A slower limit (0.5% per minute) is safer but leaves 33% (TSLA-like) to 76% of seconds lagging.
- **Lag after real gaps.** With the limit on Chainlink too, a 30% opening gap is reported over about 20-35 minutes (the first recording moves 5%, then 1% per minute); opens and closes wait, liquidations proceed at the effective price (a loser keeps under 9% of notional more than at the true price). An owner may prefer raw feed prices plus a market-hours close-only policy instead; that reopens the F-02 straddle around gaps (bounded by the epoch cap).
- **Worst-case cover (F-02 residual).** If keepers stay away for more than 9 minutes of liquidatable, solvent prices (at least 60 s of them fresh), a self-paired straddle can still end insolvent and claim cover. It gets at most its pro-rata share of 10% of the fund per epoch, minus its fees, and only by forgoing a 0.5% liquidation reward that any keeper can take (`test_R2_02_fixed_keeperTopUpsCountAgainstEpochCap`: +6.76 USDG on a 103.6 USDG fund). Run at least one keeper (Phase 4 risk workers) per market. Once an epoch's cap is used up, keepers of further insolvent positions get no top-up in that epoch; the winning side still gains the pool by liquidating.
- **Funding wash trading (F-09, accepted).** Funding follows global taker skew, so a self-paired position can move (even flip) the rate. It stays within the 0.01%/h cap and costs the attacker fees plus 40% of the wash size in locked margin; any genuinely large one-sided trader moves it the same way. A clean fix needs identity or a different funding model (Phase 4 coordinator).
- **Open-interest caps (F-10 residual).** Self-paired positions can fill a side's cap. The minimum size stops dust; filling a cap still costs 40% of the capped notional in margin plus fees. Size caps so that cost is prohibitive.
- **60-second freshness vs stock feeds.** Outside market hours prices go stale, so opens, closes, liquidations and funding revert with `StalePrice`. That is deliberate (no trading on stale prices), but liquidations pause too; the rate limit then walks the first prices after the reopen.
- **Sequencer downtime.** While the sequencer is down, liquidations wait; during its grace hour only positions below half the maintenance margin can be liquidated (IA-07). Closes at a non-lagging price still work as plain closes whenever the liquidation is not allowed (a liquidatable position closed then pays the close spread and fee, not the penalty, and an insolvent counterparty's cover is forfeited in that window).
- **Funding over price gaps.** A gap of more than 14 days between valid prices is never charged (FA-02, FA-03), however the position ends. A shorter silence (a night, a weekend, a relay outage of days) is still charged at the rate in force and the new price at the next accrual, as before: at most 3.36% of the price, which keeps a side that was above maintenance solvent at that accrual but can make it liquidatable at once. The live clock measures gaps between *recorded* prices: the relay records every push, but on a Chainlink market a feed nobody records for more than 14 days looks like a dead gap even if rounds kept arriving, so a market with open positions needs a keeper that calls `poke` or `advanceFunding` at least every few days (Phase 4 risk workers do so constantly).
- **Out-of-bounds answers are followed (IA-06).** An answer outside the bounds now moves the reported price toward the bound at the rate limit, and liquidations follow it; before, it froze the market (and, after 14 days, settled forced exits at the entry price). So a feed stuck at a wrong extreme (for example a circuit-breaker floor) is treated like any wrong price: at most 1% per minute, refusing opens and closes while it lags. When the source stays outside the bounds, a matured forced exit settles at the bound. Relative to the true price that favours the losing side (the winner's gain stops at the bound). It is the price of never leaving a market stuck; choose bounds wide enough that only a broken feed or an unhandled corporate action can leave them.
- **Close fee on maker-requested forced exits (IA-01 residual).** A maker's request charges no close fee. A self-paired position (one owner on both sides, where the close spread is irrelevant) can therefore skip the 0.06% close fee by having its maker address request a forced exit, at the cost of keeping 40% of the notional locked for 7 days, the bond and funding; the open fee is paid regardless. Accepted: an honest taker forced out by its maker should not pay an exit fee it did not choose.
- **Spot pools are public AMMs in Phase 3.** Trades can be sandwiched; `minOut` and the deadline are the protection. The first LP sets the starting price.
- **One-time approvals.** Users must call `vault.setApproval(module, true)` once per module before trading. The UI should batch this with the first deposit.
- **`startBlock` in the deployments JSON** is the block the script simulated against. The indexer should start from the deployment receipts in `broadcast/` if exact.
- **License and EVM target.** Owner decision: first-party code is proprietary, marked `SPDX-License-Identifier: UNLICENSED` (the SPDX marker for code that is not open source; select "No License (None)" when verifying on an explorer). The vendored OpenZeppelin (MIT) and forge-std (MIT/Apache-2.0) keep their licenses in `lib/`. `evm_version = cancun`: Robinhood Chain runs a recent Arbitrum Nitro (v3.11 per the docs), but confirm with a first testnet deployment.
- **Token mechanics.** See [Token requirements](#token-requirements): only non-rebasing tokens, no sweep, issuer powers (freeze, upgrade) to confirm before listing.
- **Launch guard.** When enabled, an account at its own cap cannot deposit more to save a position (no other account and not the admin can use up its room, G-01, but losses do not restore it, G-02), caps are per address, the global cap must grow with the allowlist, and keepers outside the allowlist can earn (and withdraw, not reuse) rewards. See [Guarded launch](#guarded-launch).
