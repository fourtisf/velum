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
               ├─ price-relay   pulls quotes → MAC'd Redis snapshots + PriceTick rows
               ├─ candles       aggregates ticks → 15m/1h/4h/1D candles
               ├─ onchain relay pushes MAC-verified real prices to OracleAdapter (Phase 3, testnet relay oracle)
               ├─ keeper        liquidations, forced-exit settlement, advanceFunding, cover payouts (Phase 3)
               ├─ indexer       contract events → positions, trades, offers, pools, vault, funding (Phase 3;
               │                notes, nullifiers, commitments in Phase 4)
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
    src/jobs/{price-relay,candles,prune}.ts
    src/onchain/{relayer,keeper,indexer,projections,tx-sender,lock,...}.ts   (Phase 3)
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
- **Candle sources.** `Candle.source` is `demo`, `robinhood`, `chainlink`, or NULL for *unknown*: rows
  from before the column, or written by a release that predates it (the previous release keeps running
  while a new one migrates, and `deploy.sh` switches back to it when a release fails its checks).
  Unknown is never evidence and never real: the workers clear history only on positive evidence of the
  other kind of source (a demo tick or demo-tagged candle when starting with a real source, or the
  reverse), the mainnet API serves only candles tagged `robinhood` or `chainlink`, and nothing unknown is
  deleted. On every start the workers tag an unknown candle when its stored ticks prove the source: all
  ticks in its bucket of one kind, its open and close among their prices, its high and low their highest
  and lowest (`retagUnknownCandles` in apps/workers/src/bootstrap.ts). Candles older than the oldest
  stored tick (`PRICE_TICK_RETENTION_DAYS`, default 7) cannot be proven and stay unknown: kept in
  Postgres, not shown on mainnet. An operator who knows a server never ran demo prices can tag them by
  hand: `UPDATE "Candle" SET "source" = 'robinhood' WHERE "source" IS NULL;` (audit F-1, F-4).
- The API serves `stale` with a reason: no snapshot, pipeline outdated, a demo price on mainnet, the
  US-equity session closed (`usEquitySession` in packages/config: Robinhood's 24/5 window minus NYSE
  holidays), a quote frozen for 15 minutes, or a quote not yet seen to change since the workers started
  without a snapshot of it (docs/03).
- Web reads `/v1/markets`, `/v1/markets/:sym/candles`. Wallet connect is real; public
  balances via viem `balanceOf`. Private balance and trades are simulated in the browser
  store, seeded like the prototype, persisted in `localStorage` per wallet (try/catch).

**Redis** holds only rebuildable state (snapshots, candle caches, queues, heartbeats, rate-limit
counters) and is treated as untrusted input (audit M-2, F-2). Every value the API trusts (price
snapshots, candle caches, heartbeats) is authenticated: `vmac1.<HMAC-SHA256>.<payload>`, the MAC over
the network, the Redis key and the payload, under a key both api and workers derive from `DATABASE_URL`
(HKDF-SHA256 with a Velum-specific label; packages/config/src/cache-mac.ts). A Redis co-tenant knows the
Redis password, not `DATABASE_URL`, so it cannot write a value the API accepts; a value with a bad or
missing MAC reads as missing. The payload is then validated (`parseSnapshot`, `parseCandleCache`,
`parseHeartbeat`). Consequences: api and workers must get the same `DATABASE_URL` (they do, from one
`.env`); changing the database password rotates the key, and values written before read as missing until
the workers rewrite them (within one price tick, at most a few seconds after both restarted). What
authentication cannot stop on a shared Redis: deleting values or putting back an older genuine one
(prices then read as missing or stale, never as a price that was not quoted), tampering with rate-limit
counters and with queues (denial of service only; job payloads are never trusted). Velum's own instance
(`deploy/redis-velum.sh`: a unix socket only the app user can reach, own password, `noeviction`) is the
only fix for those, and is strongly recommended on a shared server. `REDIS_URL` takes `redis://`,
`rediss://` or `unix://`. The API degrades instead of failing when Redis is down (last known values
marked stale, in-memory rate limits, short timeouts).

**Start-up order:** the workers wait for Postgres and Redis with backoff (never exiting, so PM2 never
marks them errored) and report alive only once started; PM2 restarts api and workers with an
exponential backoff, and each PM2 daemon's systemd unit starts after PostgreSQL and Redis.

**Phase 3 (public contracts):** web sends txs directly with wagmi; indexer stores events;
positions/pools come from chain via API. The on-chain workers (`apps/workers/src/onchain`) are described
below.

### Phase 3 on-chain workers

**Gate.** Off unless `ONCHAIN_WORKERS=true` (the literal `true`) **and** `contracts/deployments/<CHAIN_ID>.json`
exists (`DEPLOYMENTS_DIR`, default `contracts/deployments` of the release; `Deploy.s.sol` writes it and it is
committed after a deployment, so every release carries it). The relayer also needs `PRICE_RELAY_PRIVATE_KEY`
(its address must be the oracle's `relayer`), the keeper `KEEPER_PRIVATE_KEY`, a separate key (refused if it is
the relay key or the deployment's price relayer); without its key a component stays off and the indexer still
runs. On Robinhood Chain mainnet (4663) nothing is ever signed without `ONCHAIN_MAINNET_CONFIRMED=yes`: the
sender refuses when the configured chain **or** `RPC_URL`'s `eth_chainId` is 4663, and whenever `RPC_URL` serves
another chain than `CHAIN_ID`; the relayer and keeper then only read. Indexing mainnet is allowed.
`deploy/ecosystem.config.cjs` passes the two hot keys to `velum-workers` only while `.env` says
`ONCHAIN_WORKERS=true`, never to the API or the web (it refuses to load if a hot key is on their lists). Keys
become viem accounts at start and are never logged (the logger also redacts every `*_PRIVATE_KEY` value).

**Layout.** Three BullMQ queues in the workers process (`velum-onchain-relay` every second,
`velum-onchain-keeper` every `KEEPER_INTERVAL_MS`, `velum-onchain-indexer` every `INDEXER_POLL_MS`), each with
concurrency 1 and behind a Redis role lock (SET NX PX, renewed every tick), so a second process (a release
overlap, a mistaken copy) stays idle; job payloads are never read. Each hot key has one sender (`tx-sender.ts`):
one transaction in flight; the nonce is the chain's transaction count; a transaction not mined after 6 s (relay)
or 15 s (keeper) is replaced at the same nonce with fees bumped 12.5% and a freshly rebuilt payload (or a
0-value transfer to self when nothing qualifies any more), never above the fee ceiling (`RELAYER_MAX_GWEI`,
`KEEPER_MAX_GWEI`); pending transactions of the key this process did not send are adopted and cancelled; a nonce
gap below the in-flight transaction (a reorg dropped earlier ones) cancels its payload and fills the gap with
self-transfers, so an old price push can never mine late. Balances are read every minute; below
`RELAYER_MIN_BALANCE_ETH` / `KEEPER_MIN_BALANCE_ETH` the workers warn (every 10 minutes) and `/v1/health` says
`balanceLow`.

**Price relayer** (`relayer.ts`, `relay-math.ts`). Every `PRICE_PUSH_INTERVAL_MS` (8-10 s, default 9 s) it pushes
the deployment's markets in one `pushPrices` call, but only prices that are safe on chain: the latest
MAC-verified Redis snapshot, confirmed with its source within 10 s, never a demo price (on any network: with the
testnet default `PRICE_SOURCE=demo` nothing is pushed, so on-chain testnet trading needs
`PRICE_SOURCE=robinhood`), quote confirmed and not frozen (15 minutes), the US-equity session open, the market
relay-sourced on chain, the price inside the adapter's fixed bounds, and (off anvil) the deployment's token equal
to the verified token in `packages/config`; and only while `OracleAdapter.sequencerStatus()` reports the
sequencer up. Rate limit (contracts/README.md, "The rate-limit clock", FA-01): a push restarts the rate-limit
clock at its own block time, so its allowance is 1/6000 of the price per second since the clock (normally the
previous push), at most 5%; others' recordings that change nothing leave the clock alone, and one that moves the
price advances it only by the time the move used. The relayer reads the band (`bands`, `relayed`) and computes the
allowance at the push's expected block time. A move that fits is pushed on cadence. One that does not is deferred
second by second (the allowance keeps growing, and the push then lands exactly, not lagging), but only while the
last push is younger than 15 s (`RELAY_MAX_PUSH_GAP_S`, which bounds the extra exit option a deferral gives a
closing taker to 0.25% of price); a move that cannot fit by then (a jump) is pushed anyway so the price
converges, reading as lagging until it does, which is the protection the contracts want during a jump. A
pre-clamped, made-up price is never pushed (it would hide the lag). The push's gas limit is fixed (an estimate
runs in the latest block, on an idle chain the previous push, and reverts `TooSoon`), and its expected block time
runs on from the newest block seen at wall-clock speed.

**Keeper** (`keeper.ts`). Each tick, most urgent first: liquidations (open positions from the index, plus ids
above the highest indexed one from `nextPositionId`, so the confirmation lag never hides one), checked with
`isLiquidatable` (which applies the sequencer rules: none while it is down, only below MM / 2 in the grace hour),
most underwater first; matured forced exits; `advanceFunding` for markets with open interest whose funding is
older than `FUNDING_EPOCH_SECONDS`; `claimCover` for shortfall claims of ended epochs (the contracts have no
keeper insurance top-up action: the keeper top-up is paid inside `liquidate`). Every action is simulated against
the latest block first (a cool-down follows a refusal), so a position someone else liquidated costs nothing. A
liquidation whose gas (at the current fee and `KEEPER_ETH_PRICE_USD`) costs more than its expected reward is sent
only when solvency needs it (the liquidated side below MM / 2, or unable to pay the full penalty), and logged.

**Indexer** (`indexer.ts`, `projections.ts`). From `INDEXER_START_BLOCK` (or the deployment file's `startBlock`)
up to `CONFIRMATIONS` (default 3) blocks behind the head, `eth_getLogs` over every contract the deployment file
names, in ranges of `INDEXER_CHUNK_BLOCKS` (halved when the provider refuses). Each range is one Postgres
transaction with its checkpoint (`IndexerCheckpoint`: block and hash), so a crash replays it, and the projections
are idempotent. Reorgs: the first new block's parent hash must equal the checkpoint's hash (and while idle the
checkpoint block must keep its hash); otherwise the indexer walks back through `IndexedBlock` (the hashes of
blocks with logs and of every range end) to the common ancestor, deletes everything above it and refolds the
positions, offers and pool reserves those blocks had touched from the remaining `ChainEvent` rows. Tables
(amounts as integer base units, `DECIMAL(78,0)`): `ChainEvent` (every log, decoded; `unknown:<topic0>` for a log no
ABI knows, so a newer vault's extra events never break it), `PerpPosition`, `PerpTrade`, `MakerOffer`,
`SpotPoolState`, `SpotSwap`, `SpotLiquidity`, `VaultTransfer`, `FundingPoint`, `AccountActivity` (one row per event
and account involved: the activity feed), `OnchainToken`, `IndexerCheckpoint`, `IndexedBlock`. Rows carry the chain
id and the emitting contract, so a redeploy or a network switch never mixes deployments; the API reads the current
deployment's rows (docs/03). To re-index, delete the deployment's `IndexerCheckpoint` row.

**Health.** The workers write an authenticated status (`velum:onchain:status`, 2-minute expiry) every 5 s:
indexer block, head, lag and reorgs; relayer last push, per-market state, sequencer; keeper last run and counts;
each hot wallet's public address, balance, low/stuck/gas-capped flags and last (redacted) error. `/v1/health`
summarises it as `onchain` (docs/03).

**Tests.** `bash apps/workers/e2e/onchain-e2e.sh` deploys the contracts on a local anvil with `forge script` (in a
scratch copy), runs the real relayer, keeper and indexer against their own Postgres and Redis (non-default ports,
scratch directories), and checks a liquidation, a stuck-transaction replacement, a reorg, a funding advance and a
forced exit end to end, then the API endpoints over the same index.

**Limits.** Arbitrum chains make blocks only for transactions: with `CONFIRMATIONS` above 0 the newest events wait
for later blocks (the relay's pushes make one every 8-10 s in market hours; over a weekend the last events stay
unindexed until the next transactions). The keeper checks every open position each tick with one
`isLiquidatable` call each (JSON-RPC batched, at most 200 per tick, rotating). `KEEPER_ETH_PRICE_USD` is a fixed,
rough price.

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
| Price relay | oracle updater key (testnet bounds and rate limit enforced on-chain) | the keeper key |
| Keeper (Phase 3) | gas key for public liquidations, forced exits, funding, cover payouts | the price-relay key |

Keys for relayer, coordinator, risk workers, price relay, keeper: separate env vars, separate
processes, least privilege. Rotate on any incident. In Phase 3 the price relay and the keeper run in the
workers process with separate keys and senders; `deploy/ecosystem.config.cjs` gives their keys to
`velum-workers` only with `ONCHAIN_WORKERS=true`.

## 5. Performance targets

- `/v1/markets` p95 < 50 ms (a 1 s in-process cache in front of Redis; one HMAC check per value read,
  microseconds). Candles cached per timeframe; a cold cache falls back to Postgres with one shared query
  per series. The hourly tick prune deletes through an index on `PriceTick.at` (audit F-8).
- Proof generation in browser < 3 s on a mid laptop (UltraHonk, WASM, threads when
  cross-origin isolated: set `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` on `/app/*`).
- Web JS < 250 KB gzip on landing (code-split the app and the prover).
