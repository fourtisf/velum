# 03 — API contract (apps/api, Fastify)

Base URL: `https://<domain>/api`. On the server Nginx proxies `/api/` to the API's unix socket
(`API_SOCKET`, `/run/velum-api/api.sock`, reachable only by the app user and Nginx: docs/05); in local
development the API listens on `HOST:PORT_API` (`127.0.0.1:4000`). `API_SOCKET` requires `PROXY_SECRET`:
on the socket no request has an address of its own, so without the secret every visitor would share one
rate-limit bucket, and the API refuses to start (`loadEnv`).
All responses JSON. Money as **strings** in base units or fixed decimals; never JS floats.
The API holds no user keys and keeps no per-user state.

**Status per endpoint.** Phase 2 implements `GET /v1/health`, `GET /v1/markets`,
`GET /v1/markets/:symbol`, `GET /v1/markets/:symbol/candles`, `GET /v1/pools`, `GET /v1/stats` and
`POST /v1/quote`. Phase 3 adds `GET /v1/deployment`, `GET /v1/accounts/:address/positions`,
`GET /v1/accounts/:address/activity` and `GET /v1/markets/:symbol/funding`: they read
`contracts/deployments/<CHAIN_ID>.json` (`DEPLOYMENTS_DIR`) and the indexer's tables, and answer 404
`NOT_FOUND` ("No Velum contracts are deployed on this network yet.") until that file exists. Everything
marked *planned* below is the contract for later phases and answers 404 today.

**Rate limits** (per client, per minute): 120 on read routes (`RATE_LIMIT_READ_PER_MIN`, the Phase 3 reads
included), 600 on
`/v1/markets` and `/v1/markets/:symbol` (`RATE_LIMIT_MARKETS_PER_MIN`, its own budget: the web polls
every 2 s, so one tab uses 30 and several users behind one NAT address would starve each other at 120),
30 on `/v1/quote`, 60 on `/v1/health`, 10 on `/v1/relay/*` (planned). The client is Nginx's `X-Real-IP`,
trusted only on requests carrying `X-Velum-Proxy-Secret` when `PROXY_SECRET` is set; IPv6 clients count
per /64 (one subscriber usually holds a whole /64), IPv4-mapped IPv6 as the IPv4 address. `HEAD` on a
route counts against the same budget as `GET` on it, and `OPTIONS` (CORS preflight) against the read
budget. Counters live in Redis, shared by every API instance; while Redis is unreachable each instance
counts in memory, so the limits stay on.

**Redis is not trusted.** On a shared server another tenant may write Velum's keys. Price snapshots,
candle caches and heartbeats carry an HMAC under a key the API and the workers derive from
`DATABASE_URL` (docs/02); a value without a valid MAC, or written for the other network, counts as
missing, so a forged price shows as `noPrice` (seed price, stale) and is never quoted. The API also
validates every value it reads (shape, decimal strings, prices in (0, 1e9), at most 60 spark points, no
time more than 30 s ahead). When Redis is down or slow (reads time out after 250 ms), answers are
degraded rather than failing: markets come from the last values the instance saw (or the seed price),
all `stale: true` with `staleReason: "unavailable"`; `/v1/quote` answers 503 `UNAVAILABLE`; candles come
from Postgres.

## Read

### `GET /v1/health`
`{ "ok": true, "chainId": 46630, "block": 153118480, "lag": 1, "workers": 2, "signer": null, "db": true, "redis": true, "demoMode": true, "rpcChainId": 46630, "onchain": null }`

`lag`: seconds since the price relay last wrote prices (null before the first tick). `workers`:
seconds since the workers process last reported alive, whether or not the price source has quotes
(null if never, or while the workers wait for Postgres and Redis at start-up); `deploy/deploy.sh`
requires a fresh one after each release. `signer` *(Phase 3)*: seconds since the signer process (the price relayer and
the keeper, their own Unix user, on-chain audit M-2) last wrote its status file (`SIGNER_STATUS_FILE`, default
`/run/velum-signer/status.json`), null without one (it runs only with `ONCHAIN_WORKERS=true`); `deploy/deploy.sh`
requires a fresh one after each release that runs the signer. `block` is null when the RPC is unreachable. `rpcChainId` is
`eth_chainId` of `RPC_URL` (null until the RPC answered; re-checked every 10 minutes). 503 when Postgres
or Redis is down, or when `rpcChainId` differs from `chainId` (a misconfigured `RPC_URL`); an unreachable
RPC alone does not fail the check. `demoMode` is always `true` in Phase 2: every trade is simulated,
whatever `DEMO_MODE` says. Rate limited per client (`RATE_LIMIT_HEALTH_PER_MIN`, default 60).

`onchain` *(Phase 3)*: `null` while the on-chain roles are off (`ONCHAIN_WORKERS` not `true`, or no
deployment file for the chain; the workers' status expires after two minutes, and `deploy.sh` removes the signer's
when it stops it), otherwise a summary of the indexer's status, which the workers write every 5 s to Redis
(authenticated like every value the API trusts), and of the relayer's and keeper's, which the signer writes every 5 s
to its status file (a directory the API may read but not write):
```json
{ "ok": true, "reasons": [], "age": 3, "signerAge": 2, "chainId": 46630,
  "indexer": { "block": 153118477, "head": 153118480, "lag": 3, "reorgs": 0, "lastRun": 1, "error": null },
  "relayer": { "enabled": true, "address": "0x…", "sending": true, "lastPush": 4, "balanceLow": false,
               "stuck": false, "gasCapped": false, "sequencerUp": true,
               "markets": { "TSLA": "pushed", "AMZN": "closed" }, "error": null },
  "keeper": { "enabled": true, "address": "0x…", "sending": true, "lastRun": 2, "balanceLow": false,
              "stuck": false, "gasCapped": false, "liquidations": 2, "forcedExits": 0, "error": null } }
```
Ages are seconds (`age`: the workers' status, `signerAge`: the signer's). `sending` is false on Robinhood Chain
mainnet without `ONCHAIN_MAINNET_CONFIRMED=yes` (the signer only reads there) or when `RPC_URL` serves another chain. `balanceLow`: the hot wallet holds less
than `RELAYER_MIN_BALANCE_ETH` / `KEEPER_MIN_BALANCE_ETH`. `markets` gives each market's last relay state:
`pushed`, `lagging` (the adapter's rate limit clamped the push), `converging`, `deferred`, `waiting`, or why it
is not pushed (`demo`, `stale`, `unconfirmed`, `frozen`, `closed`, `bounds`, `token-mismatch`,
`not-relay-sourced`, `sequencer-down`, `no-snapshot` (the signer has no quote of its own for it), `bad-price`);
`bounds` means the quote is outside the
adapter's bounds and is pushed as it is (the adapter clamps it; an alert is raised). `ok` is false, with one short
sentence per cause in `reasons` (at most 10), when:
- the status is older than 60 s;
- the on-chain workers are disabled although `ONCHAIN_WORKERS=true`: an invalid on-chain setting (named, never its
  value), or `REDIS_URL` is not a unix socket (they only run on Velum's own Redis, `deploy/redis-velum.sh`);
- the indexer reports an error;
- the workers run on-chain but the signer wrote no status (it is not running, or cannot write its status file), its
  status is older than 60 s, its settings do not ask for it (`ONCHAIN_WORKERS` not `true` there), or it signs
  nothing although asked (no deployment file, a keys file others could read, invalid settings: named, never a value);
  or the signer runs but the workers wrote no status (the indexer);
- an enabled hot wallet is low, stuck or failing, or raised an alert: a nonce still unused after its replacements
  ran out (it is being cancelled at up to the fee ceiling), a nonce-gap fill the node rejected, reverted pushes,
  a quote outside the oracle bounds;
- a role (relayer, keeper, indexer) runs but its process does not hold its lock (the indexer's in Redis, the signer's
  a socket in its own home), or its last successful tick is more than a minute (and five of its intervals) old;
- during an open US-equity session, the relayer (enabled, sending, sequencer not down) has confirmed no push for
  more than two push intervals.

It never makes the check answer 503 (a low relay balance must not fail a release). No key, and nothing derived from
one, is ever included.

### `GET /v1/deployment` *(Phase 3)*
The contracts of the configured chain, from `contracts/deployments/<CHAIN_ID>.json` (written by
`contracts/script/Deploy.s.sol`, committed after a deployment), addresses checksummed.
```json
{
  "chainId": 46630,
  "startBlock": 153118000,
  "contracts": { "vault": "0x…", "oracle": "0x…", "spotPools": "0x…", "makerBook": "0x…", "perpsMarkets": "0x…" },
  "tokens": { "USDG": "0x…", "TSLA": "0x…", "AMZN": "0x…" },
  "priceRelayer": "0x…",
  "guard": { "guardian": null, "closeOnly": { "TSLA": false, "AMZN": false } },
  "indexer": { "block": 153118477, "lag": 3, "age": 2 }
}
```
- `contracts` lists every address entry of the file (a later contract, such as a guarded-launch allowlist, appears
  under its own name).
- `guard`: what the contracts expose today: the optional close-only guardian (null: none) and each market's
  close-only flag (from the indexed `CloseOnlySet` events; null while the index cannot be read). Deposit caps or an
  allowlist will be added here once the vault exposes them.
- `indexer`: the block the index has reached, its lag behind the head (blocks) and the age of that status
  (seconds); null while the on-chain workers are off.
- `coordinatorKey` and `riskKeys` come with Phase 4 (planned).
- 404 before a deployment file exists for the chain.

### `GET /v1/accounts/:address/positions?status=open|closed|all&limit=100` *(Phase 3)*
The account's perps positions, as taker or maker, in the current deployment: open ones first, then the newest.
`address` is accepted in any letter case (no checksum required) and must be `0x` + 40 hex digits (400
`BAD_REQUEST` otherwise); every address in the answer is checksummed. `status` defaults to `all`
(`closed` = closed, liquidated or forced out); `limit` 1-500.
```json
[{
  "id": "12", "market": "TSLA", "token": "0x…", "role": "taker", "side": "long",
  "taker": "0x…", "maker": "0x…", "status": "liquidated",
  "qty": "2.550724637681159420", "entry": "392.04165", "size": "1000",
  "takerMargin": "200", "makerMargin": "200", "offerId": "1",
  "openedAt": 1794646800000, "openBlock": 153118000, "openTx": "0x…",
  "closedAt": 1794647400000, "closeBlock": 153118300, "closeTx": "0x…",
  "closePrice": "344.65", "exitPrice": "344.65", "takerPnl": "-120.87", "takerFunding": "0.01",
  "fee": "8.79", "takerOut": "70.33", "makerOut": "320.88",
  "liquidation": { "liquidator": "0x…", "side": "taker", "price": "344.65", "penalty": "8.79", "reward": "4.39", "shortfall": "0" },
  "forcedExit": null
}]
```
- `side` is the taker's side; `role` the queried account's. `qty` tokens, prices USDG per token, margins and
  payouts USDG, all exact decimal strings (no rounding; the chain's base units formatted).
- `size`: the USDG notional at open (the maker offer's fill). `takerMargin`/`makerMargin` are the posted margins
  (as of the last change; a settled position keeps the margins it had when it closed).
- `exitPrice`: the spread-adjusted exit of a close or a taker-requested forced exit, the oracle price of a
  liquidation; `fee`: the close fee, or the liquidation penalty. `forcedExit`: `{ "requester", "requestedAt",
  "settleAfter", "atEntry" }` once requested.
- Open positions are selected first, then the newest closed ones up to `limit`, so an open position is never left out
  however many closed ones the account has.
- From the indexer, which stays `CONFIRMATIONS` blocks behind the head: a position appears a few blocks after its
  transaction.

### `GET /v1/accounts/:address/activity?limit=50&before=<cursor>` *(Phase 3)*
Everything the account did or received in the current deployment, newest first.
```json
{ "items": [{ "kind": "position_settled", "tx": "0x…", "block": 153118300, "logIndex": 4,
              "at": 1794647400000, "contract": "0x…", "market": "TSLA", "token": "0x…", "positionId": "12",
              "data": { "kind": "liquidation", "role": "taker", "exitPrice": "344.65", "fee": "8.79", "payout": "70.33", "pnl": "-120.87", "funding": "0.01" } }],
  "next": "153118295-2" }
```
- Pass `next` as `before` for the next (older) page; it is null on the last page. `limit` 1-200. Pages never repeat
  or skip an item. A malformed `before`, or one whose block or log index is out of range, is a 400 `BAD_REQUEST`.
- `kind`: `deposit`, `withdraw`, `approval`, `position_open`, `position_close`, `position_add_margin`,
  `position_remove_margin`, `position_liquidate`, `position_forced_exit`, `position_settled`,
  `liquidation_reward`, `forced_exit_requested`, `offer_posted`, `offer_filled`, `offer_withdrawn`, `swap`,
  `liquidity_add`, `liquidity_remove`, `insurance_funded`, `cover_claim`, `cover_paid`, `bond_refund`,
  `bond_claimed`. `data` holds the event's fields as exact decimal strings in whole units (USDG, tokens, ETH for
  bonds) and checksummed addresses.

### `GET /v1/markets/:symbol/funding?limit=48` *(Phase 3)*
`[{ "t": 1794646800000, "rate": "0.0042", "index": "0.000081", "block": 153118000, "tx": "0x…" }]`

The funding index of the market after each `FundingAdvanced` event, oldest first (the newest `limit`, 1-500).
`rate`: percent per hour (0.0042 = 0.0042%/h, at most ±0.01), positive when longs pay shorts; `index`: the
cumulative funding per token in USDG (signed). `t` is the event's block time. 404 for an unknown market or one
the deployment does not list.

### `GET /v1/markets` and `GET /v1/markets/:symbol`
```json
[{
  "symbol": "TSLA", "name": "Tesla", "token": "0x…", "status": "live",
  "price": "391.65", "mark": "391.81", "open24h": "386.20",
  "change24h": "1.41", "fundingPerHour": "0.0042", "openInterest": "742000", "demo": true,
  "maxLeverage": 5, "takerFeeBps": 6, "maintenanceMargin": "0.10",
  "spark": ["390.1", "390.4", "…"],
  "stale": false, "staleReason": null, "marketOpen": true, "quoteAge": 3,
  "source": "robinhood", "updatedAt": 1794646800000
}]
```
- `status`: `live` | `coming_soon` | `close_only`. `spark`: last hour, one point per minute (at most 60).
- `fundingPerHour`, `openInterest`: demo values on testnet, where `demo` is `true`; on mainnet they are
  `null` and `demo` is `false` until they have a real source (Phase 3). `demo` describes these two
  numbers; where the price comes from is `source`.
- `source`: `demo` (simulated), `robinhood` (official quotes), `chainlink`, or `null` before the first
  tick (the seed price is returned then; clients must not show it as live, the web shows dashes).
- `updatedAt`: the **quote time**: when the quote behind `price` last changed (a new Robinhood bid/ask,
  a Chainlink round, a demo tick). Upstream response times advance while a closed market's bid/ask stays
  frozen for days, so they are not used. `quoteAge`: seconds since then (null without a price).
- `marketOpen`: whether the 24/5 US-equity session for Stock Tokens is open now: Sunday 20:00 to Friday
  20:00 US Eastern, minus NYSE holidays (packages/config `usEquitySession`, sources cited there). Early
  closes and unscheduled closures are not in the calendar; `quoteFrozen` covers them.
- `stale`: true when the price must not be treated as live. Clients do not trade on a stale price on
  mainnet (the web shows the last price as stale and disables trading). `staleReason` says why:

| `staleReason` | Meaning |
|---|---|
| `noPrice` | no snapshot yet (seed price returned) |
| `unavailable` | the price cache could not be read (Redis down); last known value returned |
| `outdated` | the workers have not confirmed the quote with the source for over 60 s |
| `demoSource` | a simulated price on mainnet (never live there) |
| `marketClosed` | real price source, session closed (weekend or US holiday) |
| `quoteFrozen` | real price source, session open, but the quote has not changed for 15 minutes, or the workers started without a snapshot of it and have not yet seen it change (its quote time is unknown) |

  Simulated prices on testnet ignore the calendar (`marketOpen` can be `false` while `stale` is `false`).
- Answers come from a 1 s in-process cache per API instance.

**Price fields from Robinhood.** `price` is the midpoint of the token's bid and ask from
`api.robinhood.com/rhj/prices/{symbol}`. The documented `bid`/`ask` there are the raw underlying-equity
quote (not adjusted for corporate actions); the response also carries `tokenBid`/`tokenAsk`, which are
undocumented and equal `bid`/`ask` × `currentMultiplier` (checked on 2026-11-15 against
`/rhj/assets`). The workers use `tokenBid`/`tokenAsk` and, when a quote lacks them, compute
`bid`/`ask` × `currentMultiplier` from `/rhj/assets` (matched by the exact token address). A quote with
neither is skipped, and so is the multiplier fallback while `/rhj/assets` has not been read for over a
day, or while it announces a multiplier change (`pendingMultiplier` set and different from
`currentMultiplier`: a corporate action whose effective time the API does not give; `""` on every asset
when checked on 2026-11-15). After a restart without a snapshot, the first quote of a market must also
pass the jump guard (a move over 25% needs three agreeing quotes) against the newest stored tick.

### `GET /v1/markets/:symbol/candles?tf=15m|1h|4h|1D&limit=120`
`[{ "t": 1794646800000, "o": "390.02", "h": "391.10", "l": "389.25", "c": "390.88" }]`

From the workers' cache when it is authenticated and validates (aligned, increasing bucket times, none
in the future, low/high bracketing open/close, written for this network), otherwise from Postgres: never
a bucket dated ahead of now. On mainnet only real history: the cache only when it was built from a real
price source (it records its source and network), Postgres only candles tagged `robinhood` or
`chainlink`. Candles of unknown source (older than the source column and not proven by stored ticks,
docs/02) are kept but not served on mainnet; testnet serves every candle.

### `GET /v1/pools`
```json
[{ "symbol": "TSLA", "pair": "TSLA/USDG", "feeBps": 30, "sizeRounded": "1200000",
   "aprEst": "14.2", "updatedHour": 1794646800000, "status": "live", "demo": true }]
```
Pool sizes are published hourly, rounded to 2 significant figures, only if the hour had
≥ 10 fills from ≥ 2 makers and no single fill > 25% of volume. Until pools publish (Phase 3), testnet
returns the demo seed with `"demo": true` and mainnet returns `null` sizes and APRs. Cached 30 s per
instance.

### `GET /v1/stats`
Testnet: `{ "markets": 10, "openInterest": "4977000", "shieldedValue": "4800000", "proofsToday": 18420, "demo": true }`
Mainnet: `{ "markets": 10, "openInterest": null, "shieldedValue": null, "proofsToday": null, "demo": false }`

Open interest, shielded value and proofs have no real source before Phases 3–4.

## Quotes

### `POST /v1/quote`
Request `{ "from": "USDG", "to": "TSLA", "amount": "1000" }`
Response
```json
{ "out": "2.544", "min": "2.531", "hops": 1, "route": ["USDG", "TSLA"],
  "feeUsd": "3.00", "rate": "0.002553", "roundedTo": 4 }
```
Rounded to 4 significant figures so quotes can't be used to back out pool reserves. A stock whose price
is stale answers 503 `STALE_PRICE` (the message says when the market is closed); Redis unavailable
answers 503 `UNAVAILABLE`.

## Privacy (Phase 4, all planned)

### `GET /v1/sync` → `{ "block": 153118480, "leafCount": 18234 }`
### `GET /v1/records?after=<leafIndex>&limit=500` → encrypted note records, paginated
`[{ "leaf": 18233, "commitment": "0x…", "ciphertext": "0x…", "ephemeralKey": "0x…", "tx": "0x…", "block": 153118470 }]`
### `GET /v1/tree/path/:leaf` → Merkle path for one leaf
### `POST /v1/nullifiers` `{ "nullifiers": ["0x…"] }` → `{ "spent": [false] }`

### `POST /v1/relay/:action`
`action`: `transfer` | `unshield` | `lock` | `release` | `open` | `update` | `close` | `swap` | `lp_add` | `lp_remove` | `exit`
Request `{ "proof": "0x…", "publicInputs": ["0x…"], "fee": "0.10" }`
Response `{ "jobId": "rj_01H…" }`

### `GET /v1/jobs/:id`
`{ "status": "queued|submitted|confirmed|failed", "tx": "0x…", "block": 153118480, "error": null }`

### `GET /v1/relayer` → `{ "feeAddress": "…", "minFee": "0.05" }`

## Errors
`{ "error": { "code": "INSUFFICIENT_LIQUIDITY", "message": "Not enough liquidity in the TSLA pool for this size." } }`
Codes: `BAD_REQUEST`, `NOT_FOUND`, `RATE_LIMITED`, `STALE_PRICE`, `MARKET_CLOSED` (the market is not on
this network yet), `UNAVAILABLE` (a dependency is down; retry), `INTERNAL`, and for later phases
`INSUFFICIENT_LIQUIDITY`, `PROOF_INVALID`, `NULLIFIER_SPENT`, `RELAY_FAILED`.
