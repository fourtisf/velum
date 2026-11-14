# 04 — Contracts and privacy design

Write all contracts and circuits from scratch. Do not copy any other protocol's code.

## 1. Phase 3: public contracts (no privacy yet)

Foundry project in `contracts/`. Solidity ^0.8.28, OpenZeppelin for ERC20 helpers and
ReentrancyGuard only.

| Contract | Responsibility |
|---|---|
| `VelumVault` | Holds all tokens. Deposits, withdrawals, internal balances. No admin, no pause on balances. |
| `SpotPools` | Constant-product pools (Stock/USDG), 30 bps fee kept in pool, LP shares, 2-hop routing through USDG in one call. Pools and fees fixed at deploy. |
| `PerpsMarkets` | Per-market params (IM 1/maxL, MM 0.5/maxL, taker fee 6 bps, penalty 1%, OI cap, max 100 tokens/position), isolated margin. |
| `MakerBook` | Standing offers: backing, largest fill, open spread, close spread, expiry. Taker lock filled against an offer. Close spread is binding: taker can close any time without maker signature. |
| `OracleAdapter` | Accepts a price only if fresh (≤ 60 s), within bounds, from the approved feed per token. Dead after 14 days without a fresh price. |
| `Funding` | Hourly funding index per market, capped at 0.01%/h; matching requires funding ran in the last hour. |
| `Liquidation` | Anyone (risk workers in Phase 4) can liquidate below maintenance at a fresh price; penalty split 50/50 worker/insurance. Shortfall → insurance claim paid pro rata after next funding. |
| `ForcedExit` | Request with 0.001 ETH refundable bond; after 7 days settles at oracle price, no spread, no penalty. With a dead oracle: settles at entry price. |

Tests: Foundry unit + invariant tests (no token can leave the vault except via valid
withdraw/close/liquidate; sum of balances == vault holdings; liquidation never pays more
than posted margins + insurance).

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
