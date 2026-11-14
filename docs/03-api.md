# 03 — API contract (apps/api, Fastify)

Base URL: `https://<domain>/api` (Nginx proxies `/api/` → `127.0.0.1:4000/`).
All responses JSON. Money as **strings** in base units or fixed decimals; never JS floats.
The API holds no user keys and keeps no per-user state.

Rate limit: 120 req/min per IP on read routes, 30/min on `/v1/quote`, 10/min on `/v1/relay/*`.

## Read

### `GET /v1/health`
`{ "ok": true, "chainId": 46630, "block": 153118480, "lag": 1, "workers": 2, "db": true, "redis": true, "demoMode": true }`

`lag`: seconds since the price relay last wrote prices (null before the first tick). `workers`:
seconds since the workers process last reported alive, whether or not the price source has quotes
(null if never); `deploy/deploy.sh` requires a fresh one after each release. `block` is null when the
RPC is unreachable. 503 only when Postgres or Redis is down. Rate limited per client
(`RATE_LIMIT_HEALTH_PER_MIN`, default 60). Behind Nginx the client is `X-Real-IP`, trusted only on
requests that carry Nginx's `X-Velum-Proxy-Secret` when `PROXY_SECRET` is set (docs/05).

### `GET /v1/deployment`
Contract addresses and public keys the client needs (Phase 3+).
```json
{
  "chainId": 46630,
  "contracts": { "pool": "0x…", "spot": "0x…", "markets": "0x…", "oracle": "0x…" },
  "tokens": { "USDG": "0x…", "TSLA": "0x…" },
  "coordinatorKey": { "x": "…", "y": "…" },
  "riskKeys": [{ "x": "…", "y": "…" }, { "x": "…", "y": "…" }],
  "startBlock": 0
}
```

### `GET /v1/markets`
```json
[{
  "symbol": "TSLA", "name": "Tesla", "token": "0x…", "status": "live",
  "price": "391.65", "mark": "391.81", "open24h": "386.20",
  "change24h": "1.41", "fundingPerHour": "0.0042", "openInterest": "742000",
  "maxLeverage": 5, "takerFeeBps": 6, "maintenanceMargin": "0.10",
  "spark": ["390.1", "390.4", "…"]                       // last 60 points
}]
```
`status`: `live` | `coming_soon` | `close_only`. Each market also carries `stale` (true when no
price newer than the oracle max age exists), `source` (`demo`, `robinhood`, `chainlink`, or `null`
before the first tick) and `updatedAt`. On mainnet, a market the workers have not priced yet (no
snapshot) is returned with its seed price, `"stale": true` and `"source": null`; clients must not
show that price as live (the web shows dashes and disables trading).

### `GET /v1/markets/:symbol/candles?tf=15m|1h|4h|1D&limit=120`
`[{ "t": 1794646800000, "o": "390.02", "h": "391.10", "l": "389.25", "c": "390.88" }]`

### `GET /v1/markets/:symbol/funding?limit=48`
`[{ "t": 1794646800000, "rate": "0.0042", "index": "…" }]`

### `GET /v1/pools`
```json
[{ "symbol": "TSLA", "pair": "TSLA/USDG", "feeBps": 30,
   "sizeRounded": "1200000", "aprEst": "14.2", "updatedHour": 1794646800000 }]
```
Pool sizes are published hourly, rounded to 2 significant figures, only if the hour had
≥ 10 fills from ≥ 2 makers and no single fill > 25% of volume.

### `GET /v1/stats`
`{ "markets": 10, "openInterest": "4977000", "shieldedValue": "4800000", "proofsToday": 18420 }`

## Quotes

### `POST /v1/quote`
Request `{ "from": "USDG", "to": "TSLA", "amount": "1000" }`
Response
```json
{ "out": "2.544", "min": "2.531", "hops": 1, "route": ["USDG", "TSLA"],
  "feeUsd": "3.00", "rate": "0.002553", "roundedTo": 4 }
```
Rounded to 4 significant figures so quotes can't be used to back out pool reserves.

## Privacy (Phase 4)

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
Codes: `BAD_REQUEST`, `NOT_FOUND`, `RATE_LIMITED`, `STALE_PRICE`, `MARKET_CLOSED`,
`INSUFFICIENT_LIQUIDITY`, `PROOF_INVALID`, `NULLIFIER_SPENT`, `RELAY_FAILED`.
