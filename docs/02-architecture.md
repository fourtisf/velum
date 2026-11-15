# 02 — Architecture

## 1. System overview

```
 Browser (Next.js 15 app)
 ├─ wagmi/viem  ── public txs (shield, approve) ──────────────► Robinhood Chain
 ├─ @velum/sdk  ── keys, note decrypt, Noir proofs (WASM)          ▲
 │                                                                  │
 └─ HTTPS ───► Nginx ──► apps/api (Fastify :4000)                   │
                         ├─ read API (markets, candles, pools)      │
                         ├─ quote API                               │
                         ├─ relay API ──► Redis queue ──► relayer ──┘ (pays gas)
                         └─ Prisma ──► PostgreSQL
                                  ▲
               apps/workers (BullMQ on Redis)
               ├─ price-relay   pulls oracle prices → DB/Redis, pushes to OracleAdapter (testnet)
               ├─ candles       aggregates ticks → 15m/1h/4h/1D candles
               ├─ indexer       reads contract events → notes, nullifiers, commitments
               ├─ funding       advances funding index each epoch
               ├─ coordinator   matches taker locks with maker offers (Phase 4)
               ├─ risk-a / risk-b  watch positions, submit liquidations (Phase 4, separate keys)
               └─ aggregates    hourly rounded public totals (min 10 fills, 2 makers)
```

## 2. Monorepo

```
apps/
  web/            Next.js 15 App Router, TS
    app/(landing)/page.tsx
    app/app/layout.tsx           app shell (nav tabs, bottom bar ≤960px)
    app/app/trade/[symbol]/page.tsx
    app/app/markets/page.tsx
    app/app/swap/page.tsx
    app/app/portfolio/page.tsx
    app/app/liquidity/page.tsx
    app/app/makers/page.tsx
    components/ (Button, Seg, Sides, Input, Card, Badge, Avatar, Table, Modal,
                 FlowModal, Toast, Chart, MarketStrip, Ticket, PositionsTable, ...)
    lib/ (format.ts, math.ts (fixed-point), store.ts (zustand), wagmi.ts, api.ts)
    styles/tokens.css            ← copy of design/tokens.css
  api/            Fastify, TS
    src/routes/{markets,candles,pools,quote,relay,deployment,health}.ts
    src/plugins/{prisma,redis,rateLimit,cors}.ts
  workers/        Node, TS, BullMQ
    src/{price-relay,candles,indexer,funding,coordinator,risk,aggregates}.ts
packages/
  db/             Prisma schema + generated client
  config/         chain constants, token list, protocol params
  sdk/            key derivation, note encryption, proving, API client
contracts/        Foundry
circuits/         Noir
deploy/           Nginx, PM2, scripts
```

State in the web app: **zustand** store mirroring the prototype's `S` object
(connected, addr, paddr, veiled, wallet, priv, positions, history, offers, lp, lastChain,
sel, mode, side, lev, size, spotSide, spotAmt, slip, tf, ...). Server data via
**TanStack Query** with 2 s polling for prices (or SSE `/v1/stream` later).

## 3. Data flow by phase

**Phase 2 (demo trading):**
- Prices: `price-relay` reads the price source every 2 s (`PRICE_SOURCE`: `demo` on testnet,
  official Robinhood quotes on mainnet, where `demo` is refused) → Redis `velum:price:{sym}`
  snapshots stamped with the **quote time** (when the quote last changed) and the time it was read →
  `PriceTick` rows in Postgres → a BullMQ job naming the tick time → the `candles` worker reads that
  tick back from Postgres (a queued job's payload is never trusted) and builds 15m/1h/4h/1D candles,
  each tagged with its price source.
- The API serves `stale` with a reason: no snapshot, pipeline outdated, a demo price on mainnet, the
  US-equity session closed (`usEquitySession` in packages/config: Robinhood's 24/5 window minus NYSE
  holidays) or a quote frozen for 15 minutes (docs/03).
- Web reads `/v1/markets`, `/v1/markets/:sym/candles`. Wallet connect is real; public
  balances via viem `balanceOf`. Private balance and trades are simulated in the browser
  store, seeded like the prototype, persisted in `localStorage` per wallet (try/catch).

**Redis** holds only rebuildable state (snapshots, candle caches, queues, heartbeats, rate-limit
counters) and is treated as untrusted input: readers validate every value (packages/config
`parseSnapshot`, `parseCandles`, `parseHeartbeat`). On a shared server it should be Velum's own
instance (`deploy/redis-velum.sh`: a unix socket only the app user can reach, own password,
`noeviction`); `REDIS_URL` takes `redis://`, `rediss://` or `unix://`. The API degrades instead of
failing when Redis is down (last known values marked stale, in-memory rate limits, short timeouts).

**Start-up order:** the workers wait for Postgres and Redis with backoff (never exiting, so PM2 never
marks them errored) and report alive only once started; PM2 restarts api and workers with an
exponential backoff, and each PM2 daemon's systemd unit starts after PostgreSQL and Redis.

**Phase 3 (public contracts):** web sends txs directly with wagmi; indexer stores events;
positions/pools come from chain via API.

**Phase 4 (private):** web builds proofs with the SDK → `POST /v1/relay/:action` →
queue → relayer submits → indexer stores encrypted records → web fetches
`/v1/records` and decrypts locally.

## 4. Security boundaries

| Component | Holds | Must never hold |
|---|---|---|
| Browser | seed (derived from one wallet signature), viewing/spending keys, decrypted notes | — |
| API | public chain data, encrypted records, rate-limit state | user keys, plaintext positions |
| Relayer | hot wallet for gas (small balance, alerting) | user keys; it only submits proofs |
| Coordinator | lock terms against one-time addresses | wallet ↔ position link |
| Risk workers (2) | keys to decrypt position health fields only | user wallets |
| Price relay | oracle updater key (testnet bounds enforced on-chain) | — |

Keys for relayer, coordinator, risk workers, price relay: separate env vars, separate
processes, least privilege. Rotate on any incident.

## 5. Performance targets

- `/v1/markets` p95 < 50 ms (a 1 s in-process cache in front of Redis). Candles cached per timeframe;
  a cold cache falls back to Postgres with one shared query per series.
- Proof generation in browser < 3 s on a mid laptop (UltraHonk, WASM, threads when
  cross-origin isolated: set `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` on `/app/*`).
- Web JS < 250 KB gzip on landing (code-split the app and the prover).
