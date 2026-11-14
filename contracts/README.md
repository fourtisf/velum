# Velum contracts (Phase 3: public, no privacy yet)

Foundry project for the on-chain core described in `docs/04-contracts-and-privacy.md` §1.
All code is original. OpenZeppelin 5.4.0 is used only for `IERC20`, `SafeERC20` and
`ReentrancyGuard` (vendored, unmodified, in `lib/openzeppelin-contracts`). forge-std 1.17.0 is
vendored for tests only.

**Testnet only.** `script/Deploy.s.sol` refuses Robinhood Chain mainnet (4663): mainnet needs the
Phase 5 external audit of contracts and circuits.

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
| `VelumVault` | `src/VelumVault.sol` | Holds all tokens. `deposit` (fee-on-transfer safe) / `withdraw` from your own balance. Modules may only debit themselves or accounts that approved them. Tokens and modules fixed by a one-time `setup`, then locked: no owner, no pause, no upgrade. |
| `OracleAdapter` | `src/OracleAdapter.sol` | One source per token: Chainlink AggregatorV3 (decimals scaled to 1e18, answer > 0) or a testnet price-relay address. `price()` reverts if older than 60 s or outside fixed bounds. Relay updates: at most one per token per second, at most ±10% from a price younger than 1 h. `isDead()` after 14 days without a valid price. |
| `SpotPools` | `src/SpotPools.sol` | Constant-product Stock/USDG pools. A 30 bps fee stays in the pool, and a stock→stock swap routes through USDG in one call, paying two fees. LP shares are tracked internally. The first deposit locks 1,000 shares against inflation attacks. Reserves are state variables, so donations can't skew them. |
| `MakerBook` | `src/MakerBook.sol` | Standing offers: backing (USDG), largest single fill (≤ backing), open and close spreads (≤ 5%), expiry. The maker can withdraw unused backing at any time. Only `PerpsMarkets` can allocate backing to a fill. |
| `PerpsMarkets` | `src/PerpsMarkets.sol` + `src/perps/*` | Pairs between a taker and the maker of the chosen offer. Open, close (any time, no maker signature), add/remove margin, funding, liquidation, forced exit and an insurance fund. |

### Perps model

- **Units:** prices are USDG per token × 1e18 and `qty` is tokens × 1e18. Margins, fees and payouts are USDG base units (6 decimals). `valueScale = 10^(36 − usdgDecimals)`.
- **Open** (size `S`, leverage `L` from 1x to 5x in 0.5 steps, passed as `leverageHalf = 2L`):
  - entry = oracle × (1 ± open spread), always worse for the taker;
  - takerMargin = S/L, which is at least the initial margin of 20% = 1/maxL;
  - makerMargin = S/maxL, taken from the offer;
  - fee = 0.06% × S, paid to insurance;
  - qty = S/entry, at most 100 tokens; each side of a market has its own open-interest cap.
- **Claims:** the taker's claim is `takerMargin + pnl(P) − funding`, and the maker's claim is the rest of the pool. Claims always sum to the pool, so value is conserved and payouts are capped by posted margins.
- **Close:** at oracle ∓ the maker's committed close spread, with a 0.06% fee on exit notional. The taker gets `max(0, claim − fee)`, capped by the pool, and the maker gets the rest.
- **Funding:** `rate = 0.01%/h × (longOI − shortOI) / (longOI + shortOI)`, using taker open interest. It accrues per second and is updated on every action and by anyone via `advanceFunding`.
- **Liquidation:** anyone can liquidate when either side's claim is below the 10% maintenance margin (0.5/maxL) at a fresh price. The side with the smaller claim pays a penalty of 1% of notional, split 50/50 between the liquidator and insurance. A shortfall is paid to the winning side from insurance, as far as the fund reaches.
- **Forced exit:** taker or maker posts a 0.001 ETH bond. After 7 days anyone settles at the oracle price with no spread, fee or penalty, or at the entry price if the oracle is dead. The bond is refunded whenever the position closes; a failed refund can be claimed later with `claimBond`.

### Events (for the indexer)

| Contract | Events |
|---|---|
| `VelumVault` | `Deposited`, `Withdrawn`, `ModuleApproval`, `InternalTransfer` |
| `SpotPools` | `PoolChanged` (after every reserve change), `LiquidityAdded`, `LiquidityRemoved`, `Swapped` |
| `MakerBook` | `OfferPosted`, `OfferFilled`, `OfferWithdrawn` |
| `PerpsMarkets` | `PositionChanged` (`Action`: Open, Close, AddMargin, RemoveMargin, Liquidate, ForcedExit), `PositionSettled`, `Liquidated`, `FundingAdvanced`, `InsuranceFunded`, `ForcedExitRequested`, `ForcedExitSettled`, `BondRefundDeferred` |
| `OracleAdapter` | `PriceRelayed` |

## Invariants (tested in `test/invariant/`)

1. Tokens leave the vault only through `withdraw`: vault holdings always equal net deposits.
2. The internal balances of all accounts (users, pools, offers, margins, insurance) sum to the vault's holdings, and each module's vault balance matches its own books.
3. A liquidation never pays more than the posted margins plus the insurance fund.
4. Closing the whole book returns every unit. After all positions close, offers are withdrawn and liquidity is removed, only insurance and the locked pool dust remain outside user balances.

Each run also checks that open interest equals the sum of open positions. The handler opens, closes, liquidates and force-exits positions, moves prices, jumps time, swaps and adds or removes liquidity.

## Commands

Foundry 1.5.1 and solc 0.8.28 are required. Use `--offline` if `binaries.soliditylang.org` is blocked and solc 0.8.28 is in `~/.svm`.

```bash
cd contracts
forge build
forge test                      # 66 tests: unit, fuzz (512 runs), invariants (64 × 128)
FOUNDRY_PROFILE=ci forge test   # fuzz 4096 runs, invariants 256 × 256
forge coverage --report summary --no-match-path "test/invariant/*"
forge fmt --check
forge snapshot                  # writes .gas-snapshot
```

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

This writes `deployments/46630.json` with the chain ID, contract addresses, tokens, relayer and start block. Optional settings: `OI_CAP_TOKENS` (default 10,000 per side), `PRICE_MIN_USD` and `PRICE_MAX_USD` (default 1 and 100,000), and `USDG_ADDRESS` + `STOCK_ADDRESSES` + `STOCK_SYMBOLS` to override the token list. Every contract locks itself during the script, so there is nothing to administer afterwards.

## Intentional simplifications vs docs/04 (Phase 3)

- **Matching is atomic.** A taker opens directly against a chosen standing offer. There is no lock-then-fill step, so the 15-minute maker fill window and refund (a Phase 4 coordinator flow) don't apply yet.
- **Maker margin per fill is S/maxL** (initial margin). Taker profit on a single position is therefore capped by that margin; beyond about a 10% move the maker side becomes liquidatable and the taker realises the profit through liquidation.
- **Insurance covers shortfalls immediately**, up to its balance, instead of through a deferred pro-rata claim after the next funding run.
- **Fees go to the insurance fund.** There is no treasury and no admin.
- **Funding runs within the hour by construction.** "Funding must have run within the last hour" holds because every open accrues funding first; there is no separate staleness gate.
- **Forced exit is available to both sides,** so a maker can't be stuck if the taker never closes.
- **Testnet prices are relay-sourced.** The Chainlink testnet feed addresses haven't been verified, so the deploy script configures every stock as relay-sourced, bounded and rate-limited.

## Known limitations and risks (review before any audit)

- **Relayer trust (testnet).** The relayer can move a price by up to 10% per second per token within the absolute bounds. That is acceptable for testnet only; production must use verified Chainlink feeds with an L2 sequencer-uptime check, which isn't implemented yet.
- **60-second freshness vs stock feeds.** Chainlink stock feeds update less often outside market hours, so opens, closes, liquidations and funding will revert with `StalePrice` then. That is deliberate (no trading on stale prices), but it means liquidations pause too and shortfalls can grow.
- **Closing against an insolvent maker.** The taker is paid at most the pool. To reach insurance, the taker (or anyone) should call `liquidate`, which pays the winner from insurance.
- **Dead-oracle forced exits.** These settle without accruing funding. The market's rate is then reset from the new open interest and applied to the whole gap at the next accrual, a small inaccuracy that only arises in a market with no price for 14 days.
- **Spot pools are public AMMs in Phase 3.** Trades can be sandwiched; `minOut` and the deadline are the protection. The first LP sets the starting price.
- **One-time approvals.** Users must call `vault.setApproval(module, true)` once per module before trading. The UI should batch this with the first deposit.
- **`startBlock` in the deployments JSON** is the block the script simulated against. The indexer should start from the deployment receipts in `broadcast/` if exact.
- **License and EVM target.** The license is left as `UNLICENSED`; the project owner should choose one before verifying on an explorer. `evm_version = cancun`: Robinhood Chain runs a recent Arbitrum Nitro (v3.11 per the docs), but confirm with a first testnet deployment.
