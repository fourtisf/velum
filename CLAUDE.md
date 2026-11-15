# CLAUDE.md — Velum build brief

You are building **Velum**, a private exchange for tokenized stocks on Robinhood Chain.
Users buy stock tokens (spot) or go long/short with leverage (perps). Balances, positions
and P&L are encrypted; zero-knowledge proofs let the chain verify every trade without
seeing it.

Read this file first, then `docs/` in order. The approved UI is `prototype/index.html`.
It is the **visual and behavioral source of truth**: match its layout, spacing, type,
colors, copy and interactions. Do not redesign.

---

## 1. Ground rules

1. **Match the prototype.** Port it to React components faithfully. Every color, radius,
   font size and label in `prototype/index.html` and `design/tokens.css` is intentional.
2. **Use the house stack** (do not substitute):
   - Frontend: **Next.js 15** (App Router, TypeScript, React 19)
   - API: **Fastify** (TypeScript)
   - DB: **PostgreSQL** via **Prisma**
   - Cache/queues: **Redis** (BullMQ for jobs)
   - Hosting: **Hostinger VPS** (Ubuntu), **PM2** process manager, **Nginx** reverse proxy, Certbot SSL
   - Wallet: **wagmi v2 + viem**
   - Contracts: **Foundry** (Solidity ^0.8.28)
   - ZK circuits: **Noir** + **Barretenberg** (UltraHonk verifier generated to Solidity)
3. **Ship in phases** (section 4). Each phase must be deployable and demo-able on its own.
   Never leave `main` broken.
4. **Testnet first.** Everything targets Robinhood Chain **testnet** until an external audit
   is done. Show "Testnet. Test tokens have no value." wherever money appears.
5. **Write original code.** Do not copy code from rooq.trade or any other protocol. Their
   contracts are BUSL-1.1 licensed (no commercial use). Use only public standards and
   your own implementation.
6. **Never hold user keys.** Private keys and viewing keys live only in the browser.
   The server never receives a seed, signature-derived key or decrypted note.
7. **Brand rules.** Velum is independent: never use Robinhood logos or imply partnership.
   Footer must say "An independent project on Robinhood Chain, not affiliated with Robinhood."
8. **Secrets** only via environment variables (`.env.example` lists all). Never commit `.env`.

---

## 2. Repo layout (target)

```
velum/
├─ CLAUDE.md                ← this file
├─ README.md
├─ prototype/index.html     ← approved UI (single file, runs offline)
├─ design/tokens.css        ← design tokens extracted from the prototype
├─ docs/
│  ├─ 01-product-spec.md    ← pages, components, flows, formulas, copy
│  ├─ 02-architecture.md    ← services, data flow, monorepo layout
│  ├─ 03-api.md             ← REST contract between web and api
│  ├─ 04-contracts-and-privacy.md ← on-chain design, circuits, threat model
│  ├─ 05-deploy-vps.md      ← Hostinger VPS step by step
│  └─ 06-roadmap.md         ← phases + acceptance criteria
├─ packages/
│  ├─ db/prisma/schema.prisma   ← starting schema (extend, don't break)
│  └─ config/robinhood-testnet.json ← chain + token constants (verify before use)
├─ deploy/
│  ├─ ecosystem.config.cjs  ← PM2
│  ├─ nginx/velum.conf      ← full app (web + api)
│  ├─ nginx/velum-static.conf ← phase 1 static prototype
│  ├─ deploy.sh             ← pull → install → migrate → build → reload
│  └─ phase1-static.sh      ← put the prototype live in minutes
└─ .env.example
```

Create these as you build:

```
apps/web/        Next.js 15 app (landing + /app/*)
apps/api/        Fastify read API, quotes, candles, relay queue
apps/workers/    price relay, indexer, funding, risk workers (BullMQ)
packages/sdk/    TS SDK: key derivation, note encryption, proving (noir_js + bb.js)
contracts/       Foundry project
circuits/        Noir circuits
```

Use **pnpm workspaces**. Node 22 LTS (still runs on Node 20.11+).

---

## 3. Routes (must match the prototype)

| Route | Content |
|---|---|
| `/` | Landing: hero + live demo terminal, stats strip, bento features, how it works, privacy comparison, markets table, FAQ, CTA, footer |
| `/app/trade/[symbol]` | Trade terminal: market strip, chart, Spot/Perps ticket, positions/activity, private account card |
| `/app/markets` | Markets table with search, stats cards |
| `/app/swap` | Private swap (USDG ↔ stock, stock ↔ stock routes through USDG) |
| `/app/portfolio` | Private balance, private assets, public wallet, open positions, activity; Shield / Unshield / Send privately |
| `/app/liquidity` | "Earn": pool cards, add/remove liquidity |
| `/app/makers` | Maker desk: post standing offers, list offers |

The prototype uses hash routes (`#/app/trade/TSLA`). In Next.js use real paths.
Default symbol for `/app/trade` is `TSLA`. Query `?mode=spot|perps` preselects the ticket.

---

## 4. Phases (summary — details and acceptance criteria in docs/06-roadmap.md)

- **Phase 1 — Live today (static).** Serve `prototype/index.html` on the domain via Nginx
  (`deploy/phase1-static.sh`). Demo data only. Goal: shareable link.
- **Phase 2 — Production frontend, demo trading.** Next.js port, pixel-faithful. Real wallet
  connect (wagmi, Robinhood Chain testnet), real public balances (USDG + stock tokens),
  real prices + candles from the API. Trading flows stay **simulated** behind a visible
  "Demo mode" flag, using the exact flow/receipt UX of the prototype.
- **Phase 3 — Public contracts on testnet.** Foundry contracts for spot pools, perps with
  maker standing offers, oracle adapter, funding, liquidation, insurance, forced exit —
  **without** privacy first. Wire the UI to real transactions.
- **Phase 4 — Privacy layer.** Shielded pool (note tree, nullifiers), Noir circuits for each
  action, generated UltraHonk verifiers, relayer, coordinator, risk workers, encrypted
  note indexing, client SDK. Swap Phase 3 actions to private versions.
- **Phase 5 — Hardening.** External audit of contracts + circuits, bug bounty, monitoring,
  legal review and geofencing, then mainnet.

Do Phase 1 and Phase 2 now unless told otherwise. Phases 3–5 need explicit go-ahead.

---

## 5. Key numbers (from the prototype; keep them in one config file)

| Param | Value |
|---|---|
| Markets | TSLA, AMZN, PLTR, NVDA, NFLX, AMD, AAPL, META, MSFT, COIN (testnet: launch only the tokens that exist on testnet; others show "Coming soon") |
| Quote / margin asset | USDG |
| Max leverage | 5× (slider 1–5, step 0.5) |
| Maintenance margin | `0.5 / maxLeverage` (10% at 5×) |
| Perps taker fee | 0.06% of position size |
| Liquidation penalty | 1% of position value |
| Spot pool fee | 0.30% per pool (2 hops = 2 fees) |
| Max position | 100 tokens per position |
| Maker fill window | 15 minutes, margin refunded if unfilled |
| Forced exit delay | 7 days |
| Default slippage | 0.5% (options 0.1 / 0.5 / 1) |

Formulas are in `docs/01-product-spec.md` §6. Use decimal-safe math (bigint / fixed point)
everywhere money is computed; the prototype's floats are demo only.

---

## 6. Definition of done (every phase)

- Lighthouse ≥ 90 performance, ≥ 95 accessibility on `/` and `/app/trade/TSLA`.
- Responsive down to 360 px; mobile app tabs move to a bottom bar (see prototype).
- Keyboard focus visible; `prefers-reduced-motion` respected.
- No console errors. TypeScript strict. ESLint clean.
- `deploy/deploy.sh` runs green on the VPS; PM2 shows all apps online; HTTPS works.
- README updated with what changed.

---

## 7. How to work

- Start by reading the prototype source end to end: CSS tokens, then the `<script>` (state
  `S`, `MARKETS`, `perpsCalc`, `spotCalc`, `swapCalc`, `runFlow`, views `vTrade`, `vSwap`, …).
  Each view function maps to one route.
- Build shared components first: Button, Seg (segmented), Sides (long/short), Input, Card,
  Badge, Avatar, Table, Modal, FlowModal (step list + receipt), Toast, Chart (canvas).
- Keep a `DEMO_MODE` env flag. When true, use the prototype's simulated flows.
- Ask before: changing the stack, changing any number in §5, adding paid services,
  or touching mainnet.
