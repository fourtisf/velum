# 06 — Roadmap and acceptance criteria

## Decisions (owner approvals)

CLAUDE.md asks for sign-off before changing the stack, any number in its §5, adding paid services or
touching mainnet. The owner's approvals so far:

- **November 2026: mainnet in read-only mode.** The site may run on Robinhood Chain mainnet with a real
  wallet connection, real public balances and live official prices, while every trade stays simulated
  (`deploy/set-network.sh mainnet`). Nothing is sent onchain by Velum on mainnet.
- **November 2026: Phase 3 contracts on testnet.** The Foundry contracts (`contracts/`) are built and
  deployed on Robinhood Chain testnet only.
- **Standing rule: no contract on mainnet before an external audit.** Velum contracts are never
  deployed to mainnet before the Phase 5 external audit of contracts and circuits (the deploy script
  refuses chain 4663).
- **2026-11-15:**
  - Stack update to **Next.js 15, React 19 and Node 22 LTS** (CLAUDE.md §1 names Next.js 14 and Node 20).
  - Product wording **"Stock Tokens"** (Robinhood Chain brand guidelines; never "tokenized stocks").
  - Privacy features are **labelled as simulated on both networks** until the Phase 4 privacy layer
    exists.
  - **Proprietary licence** (root `LICENSE`: all rights reserved; public source grants no licence).
  - Contracts: a **taker forced exit pays the committed close spread and fee**, like a normal close.
  - Contracts: positions **below half the maintenance margin may be liquidated during the sequencer
    grace period** (the other checks wait for the grace period to end).
  - **wagmi v3** (CLAUDE.md §1 named wagmi v2), upgraded before the Phase 3 wiring: `wagmi` 3.7.11, keeping
    viem. In v3 the connector SDKs are optional peer dependencies, so the web installs only what it uses:
    injected / EIP-6963 (built in), WalletConnect and the Coinbase SDK (the "Passkey account" option).
    **WalletConnect stays on the Apache-2.0 provider line**: `@walletconnect/ethereum-provider` 2.21.x with
    Reown AppKit 1.7.x (2.21.1 / 1.7.8, as audited; 2.21.9 and later, and AppKit 1.8, are under the Reown
    Community License and are not used). The MetaMask SDK (ConsenSys licence, non-commercial) and the other
    optional SDKs (Base Account, Safe, Tempo) are no longer installed; MetaMask still connects as an injected
    EIP-6963 wallet. Each connector is imported from its own `wagmi/connectors/<name>` path.

## Phase 1 — Live today (static)
**Build:** nothing; serve `prototype/index.html`.
**Accept when:** `https://<domain>` loads the prototype over HTTPS; all demo flows work;
mobile layout correct; Lighthouse ≥ 90.

## Phase 2 — Production frontend, demo trading
**Build**
- pnpm monorepo (`apps/web`, `apps/api`, `apps/workers`, `packages/db`, `packages/config`).
- Next.js port (14, then 15 after the 2026-11-15 decision) of every route in the prototype, component by component, using
  `design/tokens.css`. Fonts: Inter + Inter Tight via `next/font`.
- wagmi (v2, then v3 after the 2026-11-15 decision) + viem with a custom chain for Robinhood Chain testnet (`packages/config`).
  Connect: injected, WalletConnect, Coinbase/passkey connector.
- Real public balances (USDG + Stock Tokens) in Portfolio "Public wallet".
- `apps/api`: `/v1/health`, `/v1/markets`, `/v1/markets/:sym/candles`, `/v1/pools`,
  `/v1/stats`, `/v1/quote` (see 03-api.md). Prices from `price-relay` worker.
- Demo trading in the browser store (same flows, same receipts as the prototype),
  `DEMO_MODE=true` banner: "Demo mode. Trades are simulated."
- Faucet links in Portfolio empty state (Robinhood Chain faucet for ETH + Stock Tokens,
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
