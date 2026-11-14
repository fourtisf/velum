# 06 — Roadmap and acceptance criteria

## Phase 1 — Live today (static)
**Build:** nothing; serve `prototype/index.html`.
**Accept when:** `https://<domain>` loads the prototype over HTTPS; all demo flows work;
mobile layout correct; Lighthouse ≥ 90.

## Phase 2 — Production frontend, demo trading
**Build**
- pnpm monorepo (`apps/web`, `apps/api`, `apps/workers`, `packages/db`, `packages/config`).
- Next.js 14 port of every route in the prototype, component by component, using
  `design/tokens.css`. Fonts: Inter + Inter Tight via `next/font`.
- wagmi v2 + viem with a custom chain for Robinhood Chain testnet (`packages/config`).
  Connect: injected, WalletConnect, Coinbase/passkey connector.
- Real public balances (USDG + stock tokens) in Portfolio "Public wallet".
- `apps/api`: `/v1/health`, `/v1/markets`, `/v1/markets/:sym/candles`, `/v1/pools`,
  `/v1/stats`, `/v1/quote` (see 03-api.md). Prices from `price-relay` worker.
- Demo trading in the browser store (same flows, same receipts as the prototype),
  `DEMO_MODE=true` banner: "Demo mode. Trades are simulated."
- Faucet links in Portfolio empty state (Robinhood Chain faucet for ETH + stock tokens,
  Paxos faucet for USDG).

**Accept when**
- Visual diff against the prototype ≤ minor (same layout, spacing, copy) at 1440, 1024, 390 px.
- Wallet connects on testnet (chain ID verified), wrong network prompts a switch.
- Prices and candles update from the API; markets not on testnet show "Coming soon".
- All flows in 01-product-spec §7 run with correct numbers per §6.
- Deployed via `deploy/deploy.sh`; PM2: `velum-web`, `velum-api`, `velum-workers` online.

## Phase 3 — Public contracts on testnet
**Build:** contracts in 04 §1, Foundry tests (unit + invariant), deploy script, indexer,
wire UI to real txs (shield = deposit, perps open/close, spot, swap, LP, maker offers).
**Accept when:** end-to-end on testnet with real tokens from faucets; invariants pass;
explorer shows verified contracts (Sourcify or Blockscout).

## Phase 4 — Privacy layer
**Build:** circuits + verifiers (04 §2), `packages/sdk`, relayer, coordinator, risk workers,
encrypted record indexing, privacy endpoints in 03-api.md, UI switch from public to
private actions, "Chain view" rows backed by real commitments.
**Accept when:** explorer shows only commitments/proofs for trades; a fresh browser restores
the account from one signature; proof time < 3 s on a mid laptop; no plaintext position data
in API logs or DB.

## Phase 5 — Hardening and mainnet
External audit (contracts + circuits), bug bounty, monitoring/alerts, incident runbook,
legal review + geofencing, then mainnet deploy behind a feature flag.
