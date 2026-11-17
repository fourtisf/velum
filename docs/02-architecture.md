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
               apps/workers (BullMQ on Redis; user velum, no keys)
               ├─ price-relay   pulls quotes → MAC'd Redis snapshots + PriceTick rows
               ├─ candles       aggregates ticks → 15m/1h/4h/1D candles
               ├─ indexer       contract events → positions, trades, offers, pools, vault, funding (Phase 3;
               │                notes, nullifiers, commitments in Phase 4)
               │
               velum-signer (apps/workers/src/signer.ts; its own user, no Redis, no Postgres; Phase 3)
               ├─ onchain relay its own Robinhood quotes → OracleAdapter (testnet relay oracle)
               ├─ keeper        liquidations, forced-exit settlement, advanceFunding, cover payouts, from the chain
               └─ status file   /run/velum-signer/status.json → /v1/health
               │
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
    src/onchain/{relayer,keeper,positions,cover-claims,indexer,projections,tx-sender,lock,...}.ts   (Phase 3)
    src/signer.ts, src/signer/{run,env,files,prices,lock}.ts   (Phase 3: the signer process, on-chain audit M-2)
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
- **Candle sources.** `Candle.source` is `demo`, `robinhood`, `chainlink`, `uniswap`, or NULL for *unknown*: rows
  from before the column, or written by a release that predates it (the previous release keeps running
  while a new one migrates, and `deploy.sh` switches back to it when a release fails its checks).
  Unknown is never evidence and never real: the workers clear history only on positive evidence of the
  other kind of source (a demo tick or demo-tagged candle when starting with a real source, or the
  reverse), the mainnet API serves only candles tagged `robinhood`, `chainlink` or `uniswap`, and nothing unknown is
  deleted. On every start the workers tag an unknown candle when its stored ticks prove the source: all
  ticks in its bucket of one kind, its open and close among their prices, its high and low their highest
  and lowest (`retagUnknownCandles` in apps/workers/src/bootstrap.ts). Candles older than the oldest
  stored tick (`PRICE_TICK_RETENTION_DAYS`, default 7) cannot be proven and stay unknown: kept in
  Postgres, not shown on mainnet. An operator who knows a server never ran demo prices can tag them by
  hand: `UPDATE "Candle" SET "source" = 'robinhood' WHERE "source" IS NULL;` (audit F-1, F-4).
- **DEX prices and candles (`PRICE_SOURCE=uniswap`, mainnet; the default of `deploy/set-network.sh mainnet`).**
  Stock Tokens trade on Uniswap on Robinhood Chain around the clock, while the official Robinhood quote is 24/5
  and frozen while the US session is closed (which drew flat "closed" charts on weekends). Only the curated pools
  in `packages/config/uniswap-mainnet.json` are read: hookless, fee tier at most 1%, each checked on chain (the
  chain also holds hundreds of look-alike pools with fees up to 99% or arbitrary hooks). `price-relay` reads, in
  one multicall through `RPC_URL`, every chart pool's current state and the block time; the price is the marginal
  price of the pool with the most in-range USDG (at least 1,000 USDG), rounded down to 4 decimals, behind the same
  jump guard as the Robinhood source, and only from a block at most 60 s old. Candles come from the chart pools'
  Swap events (`apps/workers/src/jobs/dex-candles.ts`), never from poll ticks: each swap's post-trade price in the
  bucket of its block's timestamp, exact to the second (logs on Robinhood Chain carry no block time, so bucket
  boundaries are located by block: `lib/block-clock.ts`). Two checkpoints (`IndexerCheckpoint` rows
  `uniswap-candles:*` and `uniswap-history:*`): the live cursor follows the head, the history cursor walks back
  from where live started, so the newest candles appear within a minute of a fresh start and older history
  fills in behind (a full rebuild reads several million swaps: on the public RPC the last weeks are in within
  minutes and the whole history takes an hour or more; a provider `RPC_URL` is faster). Live rows merge as newer and history rows as older (`candleMergeSql`),
  so the result is the same in any order; each range commits its candles and its checkpoint in one transaction.
  A changed pool list or a live checkpoint whose block left the chain rebuilds from scratch. Switching between
  kinds of history (simulated, stock quotes, DEX trades) clears stored history once (`priceKindOf`).
- **Perps reference (mainnet, `PERPS_REF=hyperliquid`, the default there; `lighter` or `off`).** The terminal's
  Mark, Funding / h and Open interest show each market's perp on the venue, labelled with its name. Hyperliquid:
  the workers read once a minute one `metaAndAssetCtxs` of the xyz dex (api.hyperliquid.xyz, no key) and keep each
  pinned market's mark, oracle price as index, hourly funding (Hyperliquid's hourly fraction x 100) and open
  interest in USD at the mark (one side). Lighter (the perps venue of Robinhood Chain, a reference only): The workers (`jobs/perp-ref.ts`) read once a minute one
  funding list (`/api/v1/funding-rates`) and one `orderBookDetails?market_id=` per market from the public API
  (mainnet.zklighter.elliot.ai, no key), validate each value against the pinned market id and symbol
  (`packages/config/src/perps-ref.ts`, where the units checked on 2026-11-16 are written down) and store it
  authenticated in Redis for 15 minutes; the API serves it while under 5 minutes old. NFLX has no Lighter market.
- **Real perps through Hyperliquid (mainnet, web; `NEXT_PUBLIC_HL_PERPS=off` turns it off).** The Perps ticket,
  the positions card and Portfolio talk to api.hyperliquid.xyz straight from the browser (each user's own rate
  limit; the CSP allows the host on mainnet) for the user's own account on Hyperliquid's XYZ stock perps
  (`apps/web/lib/hyperliquid`, `packages/config/src/hyperliquid.ts`). Reads: the market list (hourly, checked
  against the pinned indices), mid prices (5 s), balances and positions (6 s), the account mode (1 min), fills (1
  min, while shown). Writes, each after a review dialog: the user's wallet approves a browser-generated agent key
  once per 30 days (`approveAgent`, EIP-712 on the wallet's chain, no gas; stored in localStorage only, never sent
  to Velum); the agent then signs `agentSendAsset` (standard accounts: the margin shortfall from the main USDC
  balance to the xyz balance, both the user's), `updateLeverage` (isolated, whole number up to 5x) and `order`
  (one IOC limit order at the mid moved by the slippage setting, sized and priced by Hyperliquid's lot and tick
  rules; Close is reduce-only for the whole size). Hyperliquid refuses withdrawals and transfers to others from an
  agent. Optional builder fee (`NEXT_PUBLIC_HL_BUILDER_ADDRESS`, `NEXT_PUBLIC_HL_BUILDER_FEE` in tenths of a bp):
  each wallet approves it once (`approveBuilderFee`), orders carry it. Checked against the live API with throwaway
  keys (`apps/web/e2e/hyperliquid-live.e2e.ts`) and in the browser (`apps/web/e2e/hyperliquid-browser.e2e.cjs`).
  Deposits stay inside Velum (`apps/web/lib/hyperliquid/deposit.ts`): the user's wallet switches to Arbitrum and
  transfers native USDC (0xaf88…5831) to Hyperliquid's bridge (0x2df1…3df7, packages/config/src/hyperliquid.ts), which
  credits the sender's address; at least 5 USDC (less is lost), balance and gas checked first, the transfer read back
  from its receipt and never re-sent on retry; Velum then waits for Hyperliquid to show the USDC and switches the wallet
  back. The browser reads Arbitrum through arb1.arbitrum.io (allowed in the CSP on mainnet).
- **Buying with ETH (mainnet, web).** On the Buy side the user can pay with ETH: one Universal Router call with the
  ETH as value, WRAP_ETH to the router, then V3_SWAP_EXACT_IN over WETH -> USDG (the curated ETH leg, WETH/USDG 0.01%,
  `ethLeg` in packages/config/uniswap-mainnet.json) -> stock (the market's best v3 pool by QuoterV2.quoteExactInput),
  paid by the router, the minimum from the slippage setting. No approval. Rehearsed on a mainnet fork
  (`apps/web/e2e/uniswap-eth-fork.e2e.ts`, `apps/web/e2e/uniswap-eth-browser.e2e.cjs`).
- **Real spot through Uniswap (mainnet, web).** The Spot ticket and the swap page trade from the connected wallet
  through the Universal Router (`apps/web/lib/uniswap`): the best on-chain quote among the market's curated pools,
  an exact ERC-20 approval to Permit2 and an exact 30-minute Permit2 allowance for the router (each only when
  short), then the swap with the minimum from the slippage setting and a 20-minute deadline. Stock to stock is two
  swaps through USDG. Receipts are read from the tokens' Transfer events. Public onchain, no Velum fee, no Velum
  contract involved; the private account stays simulated. Rehearsed against the deployed contracts on a
  mainnet fork: `apps/web/e2e/uniswap-fork.e2e.ts` (calldata, v3 and v4, both token orders) and
  `apps/web/e2e/uniswap-browser.e2e.cjs` (the mainnet web build with a test wallet: buy, sell, stock to stock).
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
positions/pools come from chain via API. The on-chain roles (`apps/workers/src/onchain`, the signer in
`apps/workers/src/signer`) are described below.

### Phase 3 on-chain workers

**Two processes, two users (on-chain audit M-2).** The indexer runs in the workers process (user `velum`, the same
user as the internet-facing API); it holds no key. The price relayer and the keeper, the only code holding hot keys,
run in the signer process `velum-signer` (`src/signer.ts`, `src/signer/run.ts`) as their own Unix user, which is in no
group but its own (docs/05, "The signer"). The signer uses neither Redis nor Postgres and reads nothing the app user
can write: its keys from `SIGNER_KEYS_FILE` (`/etc/velum/signer-keys.env`, root:velum-signer 640; never `.env`, never
an environment: `src/signer/files.ts`), its prices straight from Robinhood (`src/signer/prices.ts`), its candidates
straight from the chain (`positions.ts`, `cover-claims.ts`), its deployment file from its own copy of the release
(built by the signer user from the commit, never from the app user's release files; a deployment file on a path
another user could change is refused). A compromised app user can at worst degrade its liveness, which `/v1/health`
shows; it cannot make it sign. The signer's settings come from `signer.env` (root-rendered from `.env`, no secrets);
test-only settings (`SIGNER_TEST_PRICES_URL`, `SIGNER_TEST_ASSETS_URL`, `SIGNER_TEST_CLOCK_OFFSET_MS`) are honoured
on the local anvil chain (31337) only and refused anywhere else.

**Gate.** Off unless `ONCHAIN_WORKERS=true` (the literal `true`) **and** `contracts/deployments/<CHAIN_ID>.json`
exists (the workers: `DEPLOYMENTS_DIR`, default `contracts/deployments` of the release; the signer:
`SIGNER_DEPLOYMENTS_DIR`, default its own copy's; `Deploy.s.sol` writes it and it is committed after a deployment, so
every release carries it). On the guarded mainnet beta `deploy/deploy-contracts.sh` installs it instead in the
root-owned `/srv/velum/deployments` and sets `DEPLOYMENTS_DIR` in `.env`: root renders it into `signer.env` as
`SIGNER_DEPLOYMENTS_DIR` (a root-owned path the signer accepts), `release.sh` passes it to the web build (which compiles
the addresses in), and each release records the file's SHA-256 with its build settings (R3-04), so a rollback never
pairs a web bundle with another deployment. Without `ONCHAIN_WORKERS=true` `deploy.sh` does not run the signer at all. The relayer also
needs `PRICE_RELAY_PRIVATE_KEY` (its address must be the oracle's `relayer`), the keeper `KEEPER_PRIVATE_KEY`, a
separate key (refused if it is the relay key or the deployment's price relayer); without its key a component stays
off (the signer's status says why) and the indexer still runs. On Robinhood Chain mainnet (4663) nothing is ever signed without `ONCHAIN_MAINNET_CONFIRMED=yes`: the
sender refuses when the configured chain **or** `RPC_URL`'s (or `RPC_URL_SEND`'s) `eth_chainId` is 4663, and whenever
an endpoint serves another chain than `CHAIN_ID`; the relayer and keeper then only read, every signing path checks
it (submit, replacement, cancellation, nonce-gap fill), and a refused sender adopts no pending transaction (audit L-1).
Indexing mainnet is allowed. `deploy/ecosystem.config.cjs` passes no hot key to any app (it refuses to load if one is
on a list); the signer reads its keys file at start, keys become viem accounts there and are never logged (the logger
also redacts every `*_PRIVATE_KEY` value).

**Redis and settings (audit M-3, I-2).** The indexer's role lock and job scheduler live in Redis, so a tenant of a
shared Redis could hold the lock or delete the scheduler and stop it. The indexer therefore starts only
when `REDIS_URL` is a unix socket, Velum's own Redis from `deploy/redis-velum.sh`
(`unix://:PASSWORD@/run/velum-redis/redis.sock`); with a TCP `REDIS_URL` they stay off, log
`on-chain workers off` with the reason, and `/v1/health` shows it. An invalid on-chain setting (a malformed key,
`CONFIRMATIONS=-1`, a bad `RPC_URL_SEND`, ...) no longer stops the workers process: it is logged by variable name
(never the value), only the on-chain workers stay off, the Phase 2 price and candle workers run on, and while
`ONCHAIN_WORKERS` asks for them `/v1/health` names the problem.

**Layout.** The indexer: one BullMQ queue in the workers process (`velum-onchain-indexer` every `INDEXER_POLL_MS`),
concurrency 1, behind a Redis role lock (SET NX PX, renewed every tick), so a second process (a release overlap, a
mistaken copy) stays idle; job payloads are never read; a role whose last successful tick is more than a minute (and
ten intervals) old gets its job scheduler re-added (an older release's relay and keeper schedulers are removed). The
signer: plain loops in one process (the relayer every second, the keeper every `KEEPER_INTERVAL_MS`, its quote read
every 2 s), one tick at a time each, one instance per user (a lock socket in its 0700 state directory, which only the
signer user can take or remove). Each hot key has one sender (`tx-sender.ts`): one
transaction in flight; the nonce is the chain's transaction count; a transaction not mined after 6 s (relay) or 15 s
(keeper) is replaced at the same nonce with fees bumped 12.5% and a freshly rebuilt payload (or a 0-value transfer
to self when nothing qualifies any more), never above the fee ceiling (`RELAYER_MAX_GWEI`, `KEEPER_MAX_GWEI`). A
nonce is never left unused (audit M-1): after 6 payload replacements the sender cancels it with 0-value transfers to
itself, bumping the fee up to the ceiling, and once no valid bump fits under it re-broadcasts the newest version
until the nonce is used, with `stuck` and an alert in `/v1/health` meanwhile. Pending transactions of the key this
process did not send are adopted and cancelled; a nonce gap below the in-flight transaction (a reorg dropped earlier
ones) cancels its payload and fills the gap with self-transfers, and a filler the node rejects raises an alert and is
sent again at the ceiling while the gap persists. Old signed versions an RPC holds back can still land, so every
price push also expires on chain (`OracleAdapter.MAX_PUSH_DELAY`, 10 s after its observation). Optional
`RPC_URL_SEND`: a second, trusted endpoint the relayer and keeper broadcast through and read nonces and receipts from
(every other read uses `RPC_URL`), so an `RPC_URL` that withholds transactions or answers wrong receipts cannot stall
the keys; its path and query are redacted from logs like `RPC_URL`'s. Balances are read every minute; below
`RELAYER_MIN_BALANCE_ETH` / `KEEPER_MIN_BALANCE_ETH` the workers warn (every 10 minutes) and `/v1/health` says
`balanceLow`.

**Price relayer** (`relayer.ts`, `relay-math.ts`, in the signer). Every `PRICE_PUSH_INTERVAL_MS` (8-10 s, default
9 s) it pushes the deployment's markets in one `pushPrices` call, but only prices that are safe on chain: the
signer's own latest Robinhood quote (`src/signer/prices.ts`: it reads `/rhj/prices` itself every 2 s for the
deployment's markets with price-relay's code and guards: the exact mainnet token address, the multiplier rules, the
spread and freshness limits, the jump guard; quote time and confirmation as in price-relay; the last quote per market
kept in its own state directory, so a restart neither unfreezes a quote nor loses the jump guard's reference, which
is otherwise seeded from the price last relayed on chain; never Redis, so `PRICE_SOURCE` does not matter to it),
confirmed with its source within 6 s (`RELAY_SNAPSHOT_MAX_AGE_MS`) and newer than the snapshot last pushed for that
market (audit L-6), quote confirmed and not frozen (15 minutes), the US-equity session open, the market relay-sourced
on chain, and (off anvil) the
deployment's token equal to the verified token in `packages/config`; and only while `OracleAdapter.sequencerStatus()`
reports the sequencer up. A price outside the adapter's fixed bounds is pushed as it is (the adapter clamps it and the
market reads as lagging, IA-06) and raises an alert, instead of never being pushed (audit L-7). Every push carries its
observation time (audit M-1): the chain clock estimate minus the oldest snapshot's age (whole seconds, rounded up)
and one second of margin against clock skew; the adapter refuses it more than 10 s later, and that time is the
prices' source timestamp on chain (freshness, rate-limit clock). Rate limit (contracts/README.md, "The rate-limit
clock", FA-01): a push restarts the rate-limit clock at its observation time, so its allowance is 1/6000 of the price
per second since the clock (normally the previous push's observation), at most 5%; others' recordings that change
nothing leave the clock alone, and one that moves the price advances it only by the time the move used. The relayer
reads the band (`bands`, `relayed`) and computes the allowance at the push's expected block time. A move that fits is
pushed on cadence. One that does not is deferred second by second (the allowance keeps growing, and the push then
lands exactly, not lagging), but only while the last push's observation is younger than 12 s
(`RELAY_MAX_PUSH_GAP_S`, audit L-5; it was 15 s); a move that cannot fit by then (a jump) is pushed anyway so the
price converges, reading as lagging until it does, which is the protection the contracts want during a jump. The
residual option a deferral leaves: the on-chain price trails the market by at most 12 s × 1/6000 = 0.2% of price,
which a closing taker (60 s prices) can use, about 2.5 times the minimum close cost (2 bps spread + 6 bps fee);
opens and margin removal need a price at most 10 s old, so for them a deferral means at most 2 s without a fresh price
and no option. A pre-clamped, made-up price is never pushed (it would hide the lag). The push's gas limit is
`eth_estimateGas` of the same calldata sent to the relay's own address (intrinsic and calldata gas, plus on Arbitrum
chains the L1 data cost) with a 25% margin, plus a fixed bound for the execution (audit L-4; the push itself is not
estimated: in the latest block, on an idle chain the previous push, it would revert `TooSoon`). A reverted push backs
off (5 s, doubling to a minute) with an alert until a push succeeds. Its expected block time runs on from the newest
block seen at wall-clock speed.

**Keeper** (`keeper.ts`, in the signer). Everything it acts on comes from the chain, never from the index (which the
app user writes). Positions (`positions.ts`): every id below `nextPositionId` is read once with `getPosition` (at most
2,000 new ids a tick), the open ones are kept in memory, and a sweep re-reads every id in turn (`maxChecks` a tick),
which catches closures, forced-exit requests and anything a reorg changed. Cover claims (`cover-claims.ts`): the
perps engine's `CoverClaimFiled` logs from the deployment's start block, `CONFIRMATIONS` behind the head, each scan
reading the last 64 blocks again (reorg margin), in ranges of `INDEXER_CHUNK_BLOCKS` halved when the provider refuses
(a single refused block is read with `eth_getBlockReceipts`, or skipped with an alert); a claim is payable while
`coverClaims(epoch, account)` reads non-zero, and the scan position is kept in the signer's state. Each tick, most
urgent first: liquidations (the fresh open ids and the next `maxChecks` open ids in rotation), checked with
`isLiquidatable` (which applies the sequencer rules: none while it is down, only below MM / 2 in the grace hour),
ordered by risk (the urgent ones, below MM / 2 or unable to pay the full penalty, first, then the smallest remaining
claim relative to notional); matured forced exits (`getPosition`'s `exitRequestedAt` plus 7 days); `advanceFunding`
for markets with open interest whose funding is older than `FUNDING_EPOCH_SECONDS`; `claimCover` for unpaid shortfall
claims of ended epochs (the contracts have no keeper insurance top-up action: the keeper top-up is paid inside
`liquidate`). Every action is simulated against the latest block first (a cool-down follows a refusal),
so a position someone else liquidated costs nothing. A liquidation whose gas (at the current fee and
`KEEPER_ETH_PRICE_USD`) costs more than its expected reward is sent only when solvency needs it (the liquidated side
below MM / 2, or unable to pay the full penalty), and logged. Throughput (audit L-3): one transaction stays in
flight, but a tick does not stop at the first action: it polls the receipt every 250 ms and sends the next action as
soon as the previous one mined, for up to 10 s per tick; each candidate's reads go out together (JSON-RPC batched).
The end-to-end test liquidates 220 positions on anvil far inside the 572 s keeper window the contracts guarantee.

**Indexer** (`indexer.ts`, `projections.ts`). From `INDEXER_START_BLOCK` (or the deployment file's `startBlock`)
up to `CONFIRMATIONS` (default 3) blocks behind the head, `eth_getLogs` over every contract the deployment file
names, in ranges of `INDEXER_CHUNK_BLOCKS` (halved when the provider refuses; the texts of geth/Nitro, Alchemy,
Infura, QuickNode, Ankr, Chainstack and others are recognised). A single block whose logs still exceed the provider's
cap (anyone can fill one with `advanceFunding` calls) is read with `eth_getBlockReceipts`, or else contract by
contract and event by event, instead of stalling the index for good (audit L-2); the funding points of one market in
one block collapse to the block's last (every event stays in `ChainEvent`). Each range is one Postgres transaction
with its checkpoint (`IndexerCheckpoint`: block and hash), so a crash replays it, and the projections are
idempotent. Reorgs: the first new block's parent hash must equal the checkpoint's hash (and while idle the checkpoint
block must keep its hash and the head must not be below it); a mismatch must be seen on two consecutive polls (a
load-balanced RPC may answer once from a lagging node), then the indexer walks back through `IndexedBlock` (the
hashes of blocks with logs and of every range end) to the common ancestor, deletes this deployment's rows above it
(never another deployment's on the same chain) and refolds the positions, offers and pool reserves those blocks had
touched from the remaining `ChainEvent` rows, selected by id in SQL (audit L-8). Tables (amounts as integer base
units, `DECIMAL(78,0)`): `ChainEvent` (every log, decoded; `unknown:<topic0>` for a log no ABI knows, so a newer
vault's extra events never break it), `PerpPosition`, `PerpTrade`, `MakerOffer`, `SpotPoolState`, `SpotSwap`,
`SpotLiquidity`, `VaultTransfer`, `FundingPoint`, `AccountActivity` (one row per event and account involved: the
activity feed), `OnchainToken`, `IndexerCheckpoint`, `IndexedBlock`. Rows carry the chain id and the emitting
contract, so a redeploy or a network switch never mixes deployments; the API reads the current deployment's rows
(docs/03). To re-index, delete the deployment's `IndexerCheckpoint` row.

**Health.** The workers write an authenticated status (`velum:onchain:status`, 2-minute expiry) every 5 s: indexer
block, head, lag and reorgs, whether this process holds the indexer's lock and when its last successful tick was,
and, while the indexer is disabled although `ONCHAIN_WORKERS=true`, the reason. The signer writes its status every 5 s
to `SIGNER_STATUS_FILE` (`/run/velum-signer/status.json`: written atomically, 640, in a directory the API's group may
read but not write; no MAC needed, the app user cannot write it): relayer last push, per-market state, sequencer;
keeper last run and counts; each hot wallet's public address, balance, low/stuck/gas-capped flags, last (redacted)
error and alerts; per role whether it runs and when its last successful tick was; its quotes' state; and why it signs
nothing although requested (no deployment file, a keys file others could read, ...). `/v1/health` reads both and
summarises them as `onchain` with `ok` and the `reasons` it is not (docs/03): during an open session no confirmed push
for more than two push intervals, a role lock held by someone else, a role tick overdue, an alert, a stuck or low
wallet, an indexer error, no (or a stale) signer status while the workers run on-chain; `signer` is the signer
status's age in seconds, which `deploy.sh` checks after a release that runs the signer.

**Tests.** `bash apps/workers/e2e/onchain-e2e.sh` deploys the contracts on a local anvil with `forge script` (in a
scratch copy), runs the real indexer against its own Postgres (non-default port) and Redis (a unix socket in the
scratch directory, like production) and the relayer and keeper as the real signer process (`node dist/signer.js`, its
own keys file, state and status file, no Postgres or Redis, quotes from a fake Robinhood API on 127.0.0.1), and checks
a liquidation, a stuck-transaction replacement (seen in anvil's pool), a reorg, a funding advance and a forced exit end
to end, then the API endpoints over the same index, then the audit's reproductions inverted (`audit-e2e.test.ts`: a
withheld push landed late, a squatted indexer lock, a block over the provider's log cap, keeper throughput with 220
liquidatable positions found on the chain).

**Limits.** Arbitrum chains make blocks only for transactions: with `CONFIRMATIONS` above 0 the newest events wait
for later blocks (the relay's pushes make one every 8-10 s in market hours; over a weekend the last events stay
unindexed until the next transactions). The keeper checks open positions with one `isLiquidatable` call each
(JSON-RPC batched, at most 200 per tick, rotating) and re-reads 200 ids a tick in its sweep, so with many thousands
of positions a closure or a forced-exit request is noticed within a few minutes (a forced exit matures after 7 days).
A first start reads every position id (2,000 a tick) and the cover-claim logs from the deployment's start block (2 s
a tick) before it is caught up; the cover-claim position is kept across restarts. `KEEPER_ETH_PRICE_USD` is a fixed,
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
| Price relay (velum-signer) | oracle updater key (testnet bounds and rate limit enforced on-chain) | the keeper key; anything the app user can write (Redis, Postgres, its release files) |
| Keeper (Phase 3, velum-signer) | gas key for public liquidations, forced exits, funding, cover payouts | the price-relay key; anything the app user can write |
| Workers (indexer) and API | public chain data, the index, Redis, `.env` | any hot key |

Keys for relayer, coordinator, risk workers, price relay, keeper: separate keys, separate processes, least
privilege. Rotate on any incident. In Phase 3 the price relay and the keeper run in the signer process as their own
user, with separate keys and senders, reading the keys from `/etc/velum/signer-keys.env` (root:velum-signer 640); no
hot key is in `.env` or any app's environment (on-chain audit M-2).

## 5. Performance targets

- `/v1/markets` p95 < 50 ms (a 1 s in-process cache in front of Redis; one HMAC check per value read,
  microseconds). Candles cached per timeframe; a cold cache falls back to Postgres with one shared query
  per series. The hourly tick prune deletes through an index on `PriceTick.at` (audit F-8).
- Proof generation in browser < 3 s on a mid laptop (UltraHonk, WASM, threads when
  cross-origin isolated: set `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` on `/app/*`).
- Web JS < 250 KB gzip on landing (code-split the app and the prover).
