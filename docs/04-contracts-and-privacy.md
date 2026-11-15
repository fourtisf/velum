# 04 — Contracts and privacy design

Write all contracts and circuits from scratch. Do not copy any other protocol's code.

## 1. Phase 3: public contracts (no privacy yet)

Foundry project in `contracts/`; `contracts/README.md` has the full model, events, tests and known
limitations. Solidity ^0.8.28, OpenZeppelin 5.4.0 (MIT, vendored unmodified) for ERC20 helpers and
ReentrancyGuard only. First-party code is proprietary (`SPDX-License-Identifier: UNLICENSED`).
**Testnet only** until the Phase 5 external audit: the deploy script refuses Robinhood Chain mainnet (4663).
No owner, no pause, no upgrade: every contract is wired by a one-time `setup` and then locked. The only roles are
the optional guardian (close-only switch) and the optional launch-guard admin (who may deposit and how much, until it
switches the guard off for good); neither can move funds or block an exit.

| Contract | Responsibility |
|---|---|
| `VelumVault` | Holds all tokens. Deposits (credits what actually arrived), withdrawals from your own balance only, internal balances per (account, token). Neither a deposit nor a withdrawal may go to an address that can never use it: a module, the vault itself, a listed token or a protocol address fixed at setup (the oracle). Modules move internal balances, never tokens, so `deposit` is the only way tokens enter. No admin over funds, no pause, no sweep; optional launch guard below. |
| `SpotPools` | Constant-product pools (Stock/USDG), 30 bps fee kept in the pool, LP shares, 2-hop routing through USDG in one call (two fees). Pools and fees fixed at deploy. Swaps and liquidity changes need a non-zero minimum out (slippage protection) and a deadline. |
| `PerpsMarkets` | Isolated-margin pairs between one taker and one maker. IM 1/maxL (20%), MM 0.5/maxL (10%), leverage 1x–5x in 0.5 steps, taker fee 6 bps on open and on close (to insurance), penalty 1%, max 100 tokens/position, minimum position 10 USDG, per-market OI cap per side. Maker margin per fill = S/maxL. Opens need an oracle price ≤ **10 s** old that is not lagging, the sequencer past its grace hour and a market not in close-only; closes a price ≤ 60 s old that is not lagging. Opens and closes need a non-zero price limit (slippage protection). Margin removal keeps the claim ≥ IM and needs the open freshness (10 s). |
| `MakerBook` | Standing offers: backing, largest fill, open spread (2 bps–5%), close spread (≤ 5%), expiry. Phase 3 matching is atomic (a taker opens directly against a chosen offer; the 15-minute fill window is a Phase 4 coordinator flow). A fill takes the maker margin S/maxL out of the backing, so backing caps the maker's margin, not its exposure (up to 5 × backing of notional, on either side). Close spread is binding: the taker can close any time without maker signature. |
| `OracleAdapter` | One source per token, fixed at setup: a Chainlink feed guarded by the L2 sequencer-uptime feed (production), or the testnet price relay, a trusted key that must be a dedicated address (not the deployer). Every source price is clamped to fixed bounds, then rate-limited against the last recorded price (≤ 1/6000 per second, 1% per minute, ≤ 5% per recording), which bounds what a compromised relay key can do. The rate-limit clock only moves when a reading brings a new source value or changes the price, and then only by the time the move used, so third-party reads and pokes cannot keep prices lagging. The price is *lagging* when the reported price differs from the source. Max age 60 s (10 s for opens, margin removal and forced-exit settlement). Dead after 14 days without a valid (positive) answer; out-of-bounds answers count as live, failed or zero reads do not. Feeds are read defensively: a broken feed reads as stale (sequencer: down) and never reverts; setup refuses an unreadable feed or a sequencer feed whose answer is not 0/1. |
| `Funding` | Funding index per market, accrued per second at rate = 0.01%/h × (longOI − shortOI) / (longOI + shortOI) (capped at 0.01%/h). Every open accrues first, so "funding ran in the last hour" holds for every match by construction. Funding runs on the oracle's live clock: a gap of more than 14 days (the dead threshold) between two valid prices is never charged, whether the position leaves by a dead-oracle exit (which accrues up to the last valid price) or stays open until prices return; a shorter gap is charged at the next accrual (at most 3.36% of the price, under the 10% − 5% cushion). |
| `Liquidation` | Anyone (risk workers in Phase 4) can liquidate a side below maintenance at a price ≤ 60 s old (a lagging price is accepted); penalty 1% of notional split 50/50 worker/insurance; if the loser cannot pay it, insurance tops the worker up to half the penalty, ≤ 1 USDG. Sequencer: no liquidations while the L2 sequencer is down; during the 1-hour grace period after it returns, only positions below half the maintenance margin (MM/2); after that, all below MM. A shortfall becomes an insurance cover claim, paid pro rata after the hourly epoch from a budget capped at 10% of the insurance fund as it stood at the epoch's first draw (keeper top-ups included); the rest is a haircut. |
| `ForcedExit` | Either side requests with a 0.001 ETH refundable bond; after 7 days anyone settles. Price: the oracle price, at most 10 s old (the settler picks the moment); the entry price if the oracle is dead; the bound if the source is outside the oracle bounds and the reported price has reached it. A forced exit the **taker** requested costs exactly a plain close (committed close spread and close fee, capped at the taker's claim, also at the entry price); one the **maker** requested settles with no spread and no fee. A position that is liquidatable at settlement is liquidated instead (penalty applies). |
| Guardian | Optional, fixed at setup (off by default; the deploy script warns when unset): can only switch a market into or out of close-only, for the stock split / dividend procedure. It cannot move, freeze or redirect funds or change prices or parameters. |
| Launch guard | Optional, in `VelumVault`, fixed at setup (off by default, the testnet setting; it does not lift the deploy script's mainnet refusal). For a beta limited to approved wallets and small amounts before the external audit. While the **allowlist** is on, only allowlisted addresses can deposit (payer and credited account) or grant module approvals, so nobody else can open, post offers, add liquidity or swap. While **caps** are on, per token (base units): each account's net deposits (deposits minus withdrawals, never below zero, funds locked in modules included) stay within the account cap and the vault's holdings within the global cap. The guard admin (owner wallet or multisig) can only add addresses (no removal), raise caps, call the one-way `openToPublic()` and `liftCaps()`, and hand the role over in two steps; once both are off the role is cleared and the guard is inert. It cannot move, freeze or redirect funds, lower a cap or block anything: withdrawals, closes, liquidations, forced exits and claims never pass the guard. Details: `contracts/README.md`, Guarded launch. |

Insurance fund: open and close fees plus half of each liquidation penalty; anyone can add to it.

Token requirements: only non-rebasing tokens without transfer fees can be listed. Tokens that reach the
vault outside `deposit` (airdrops, rebases) are stranded, by design (no sweep). The Robinhood Chain stock
tokens are reported to be beacon proxies with `uiMultiplier()` (splits change a multiplier, not balances) and
USDG has 6 decimals and an issuer freeze power; confirm with the issuers before listing (rebasing, dividends,
upgrade control, freeze/wipe powers, transfer fees; checklist in `contracts/README.md`).

Tests: Foundry unit, fuzz and invariant tests (no token can leave the vault except via valid
withdraw/close/liquidate; sum of balances == vault holdings; liquidation, whether through liquidate, close or
forced exit, never pays more than posted margins + insurance; cover is deferred and capped; the suites run with
an L2 sequencer feed moving between down, grace and up, and with the launch guard on: nobody outside an active
allowlist adds funds, active caps hold, no withdrawal or exit is blocked, the guard admin never changes a balance),
audit regressions for every finding, and a test tying
the contract constants to `packages/config/robinhood-testnet.json` (it fails with a clear message when
`packages/config` is missing).

## 2. Phase 4: privacy layer

### Model
A **shielded pool**: tokens enter one contract (public deposit = *shield*). Inside,
ownership is a set of **notes** `(token, amount, ownerPubKey, salt)`. The contract stores
only **commitments** in an append-only Merkle tree and a set of spent **nullifiers**.
Each action is a zero-knowledge proof that it spends notes the user owns, creates new notes
that balance, and follows market rules.

### Keys (client only)
1. User signs one fixed message with their wallet (EIP-191, deterministic signers only).
2. `seed = HKDF(signature)`; derive spending key, viewing key, and a private address
   `velum1…` (bech32m of the viewing/receiving public key).
3. Passkey fallback for wallets that don't sign deterministically.
4. Optional "remember device": store the encrypted seed under a non-exportable WebCrypto key
   or passkey. Never send it anywhere.

### Circuits (Noir, `circuits/`)
| Circuit | Proves |
|---|---|
| `transfer` | spend ≤2 notes, create ≤2 notes, same token, amounts balance |
| `unshield` | spend notes → public withdrawal of exact amount to recipient |
| `lock` / `release` | move free balance into/out of a margin or offer lock |
| `open_pair` | taker lock + maker lock match; both meet initial margin at fresh price; OI cap |
| `update_pair` | add/remove margin, reduce; remove requires staying above IM |
| `close_pair` | close at oracle ± committed close spread; payouts capped by posted margins |
| `liquidate` | position below maintenance at fresh price (risk worker proves with its key) |
| `swap` | private swap request against pool with min-out; filled in tree order (no reordering) |
| `lp_add` / `lp_remove` | private LP share notes |

Hash: Poseidon2. Curve: BN254 (Grumpkin embedded curve for in-circuit keys).
Generate verifiers: `bb write_vk` + `bb write_solidity_verifier` (UltraHonk) → `contracts/src/verifiers/`.

### Note encryption
ECDH (Grumpkin or X25519) between an ephemeral key and the recipient viewing key →
ChaCha20-Poly1305 ciphertext emitted in the event. Indexer stores ciphertexts; clients
trial-decrypt locally (`scanCreated`).

### Services (Phase 4)
- **Relayer:** submits proofs, pays gas, charges a small fee note; can't sign for users.
- **Coordinator:** matches taker locks with maker offers within signed limits.
- **Risk workers (2, separate keys):** can decrypt size/margin/entry per position against a
  one-time address to run funding and liquidations while users are offline.
- **Fallback rule:** never fall back to public execution. If proving or a service fails,
  the action stops or refunds.

### What is public vs private (show this table in the UI)
| Public | Private |
|---|---|
| Shield/unshield: wallet, token, amount, time | Private balances |
| That a position opened/changed in a market | Size, side, entry, margin, P&L |
| Liquidation events and price | Which maker backs a fill |
| Funding index per period | Transfer amounts and parties |
| Hourly rounded pool totals (thresholds) | Liquidity you provide |

### Threat model notes
- Timing/amount linkage of shield → unshield: UI tips (vary amounts, wait, fresh wallet).
- Thin markets leak more (few makers, distinct spreads).
- Services can delay/refuse but can't steal: contracts enforce custody and math.
- Leaked decrypted data can't be recalled. Keep risk worker keys in separate hosts.

## 3. Audit gate
No mainnet deployment until: external audit of contracts **and** circuits, fixes verified,
bug bounty live, monitoring and incident runbook written.

## 4. Compliance notes (product, not legal advice)
Robinhood Stock Tokens are not available to US persons and are restricted in some
jurisdictions (e.g. UK, Canada, Switzerland, UAE at time of writing). Before mainnet:
legal review, terms of use, geofencing on the frontend, sanctions screening on
shield/unshield addresses.
