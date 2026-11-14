# Internal code audit — November 2026

Three independent reviewers (contracts, backend + deploy, frontend) audited the repository at
commit `0f2b776`+. Each tried to prove findings with tests. This is an **internal** review: it does
not replace the external audit that docs/04 §3 requires before any contract handles real funds.

Proof-of-concept tests: `contracts/test/audit/AuditPoC.t.sol` (tests named `*_fixed_*` are
regressions; the others still demonstrate open findings and must be inverted when fixed).

## Summary

| Area | Critical | High | Medium | Low | Fixed so far |
|---|---|---|---|---|---|
| Contracts (`contracts/`) | 1 | 1 | 5 | 6 | F-01–F-08, F-11, F-12, I-1; F-10, F-13 mitigated; F-09 accepted |
| Backend + deploy (`apps/api`, `apps/workers`, `deploy/`) | 0 | 0 | 6 | 14 | All (M1–M6, L1–L14); existing servers need the one-time upgrade in docs/05 |
| Frontend (`apps/web`) | 0 | 0 | 5 | 14 | M1–M4, M5 (mitigated), L1–L14, I2, I4–I6, I9 |

**Verdict (after the fix round):** every Critical, High and Medium finding is fixed or mitigated, each with a
regression test (`test_Fxx_fixed_*` for contracts; vitest/e2e for backend and web). Contracts are still **not
ready for an external audit** until a production oracle is chosen: opens need a price at most 10 s old, which
standard Chainlink stock feeds do not provide (see `contracts/README.md`). Contracts are not deployed anywhere.
Next 14 remains end-of-life (mitigated; upgrade to 15.5.x awaits sign-off). A second full audit pass follows.

## Contracts

| ID | Sev | Finding | Status |
|---|---|---|---|
| F-01 | Critical | Forced-exit bond was pushed to a user-controlled address during settlement; a huge revert payload blocked every close, liquidation and forced exit (freeze counterparties, drain insurance) | **Fixed**: pull-only refunds + `claimBond()` (`516d20b`), regression tests |
| F-04 | High | Testnet relay oracle: one key controls every price (10% per second, unbounded after 1 h) | **Fixed**: every price is banded (±10% from a reference that rolls at most once per 10 min; first price after silence capped); deploy refuses testnet without a dedicated `PRICE_RELAYER` |
| F-02 | Medium | Self-paired positions profit from insurance on price gaps > 20% (immediate, first-come cover) | **Fixed**: shortfalls become claims settled per hourly epoch, pro rata, capped at 10% of the fund (rest is a haircut); with the band the PoC straddle now loses 93–174 USDG instead of gaining 1,988 |
| F-03 | Medium | `isDead` true on one failed/out-of-bounds Chainlink read; forced exit then settles at entry | **Fixed**: `lastValidAt` recorded on every perps accrual / `poke`; failed or out-of-bounds reads are stale; dead only 14 days after `max(lastValidAt, setupAt)` |
| F-05 | Medium | No L2 sequencer-uptime check / grace period | **Fixed**: sequencer feed is a setup parameter (required with Chainlink feeds); down or < 1 h grace blocks opens, liquidations and margin removal; close and add margin allowed |
| F-06 | Medium | Takers get a free option on prices up to 60 s old against 0-spread offers | **Fixed**: opens need a price ≤ 10 s old (closes 60 s) and offers need an open spread ≥ 2 bps |
| F-07 | Medium | Stock splits/dividends not handled; immutable bounds can kill a market | **Fixed** (procedural): optional guardian fixed at setup can only toggle per-market close-only; split/dividend procedure in `contracts/README.md`; guardian needs owner sign-off |
| F-08 | Low | Forced exit of a liquidatable position skipped the liquidation penalty | **Fixed**: such a settlement is a liquidation (penalty applies, settler gets the keeper reward) |
| F-09 | Low | Funding wash trading with self-paired positions | **Accepted**, documented: bounded by the 0.01%/h cap, costs fees and 40% locked margin; clean fix needs identity or a new funding model |
| F-10 | Low | OI-cap griefing (and dust positions) | **Mitigated**: 10 USDG minimum position; filling a cap still possible at 40% of capped notional in margin (size caps accordingly) |
| F-11 | Low | No keeper reward on bad debt | **Fixed**: insurance tops the liquidator up to half the full penalty, ≤ 1 USDG, when the loser can't pay it |
| F-12 | Low | Closing against an insolvent counterparty forfeited insurance cover | **Fixed**: closing a liquidatable position settles it as a liquidation, so the shortfall is claimed |
| F-13 | Low | No emergency controls | **Mitigated**: the optional close-only guardian (F-07); no fund-moving powers by design |
| I-1 | Info | `deposit(..., to = module)` stranded funds | **Fixed**: deposits to module addresses are refused |

## Backend and deploy

| ID | Sev | Finding | Status |
|---|---|---|---|
| M1 | Medium | Robinhood quotes not sanity-checked (wide spreads, loose number parsing, overflow, future stamps) | **Fixed** (`35038ce`): strict format, bounds, 20% max spread, no future/old quotes, 25% jump needs 3 confirmations |
| M2 | Medium | History reset keyed on a Redis marker (evictable on a shared Redis); chainlink-without-feeds silently ran demo prices | **Fixed** (`35038ce`): decision from tagged ticks in Postgres; chainlink without feeds fails loudly |
| M3 | Medium | `server-setup.sh` builds `.env` non-atomically; sed breaks on special characters | **Fixed**: `.env.tmp` (umask 077) written with awk + ENVIRON (no sed), Redis password URL-encoded, read back and validated, then `mv`; re-runs regenerate an empty/`CHANGE_ME` DB password (with backup) |
| M4 | Medium | Root re-runs files the app user can edit; DB password interpolated into superuser SQL | **Fixed**: checkout and scripts root-owned (scripts refuse otherwise); git runs as root, install/build/migrate/PM2 as `velum` in app-owned release dirs; `.env` `root:velum 640`; password via psql stdin variable `:'p'` (hex-checked, statement logging off) |
| M5 | Medium | Every secret reaches every PM2 process (web included) and `dump.pm2` | **Fixed**: per-app allowlists parsed from `.env` in `ecosystem.config.cjs` + `filter_env`; PM2 always called with a clean env; clean delete+start when keys change; a daemon holding secrets is restarted; `~/.pm2` 700. Verified with PM2: web has no `DATABASE_URL`/`REDIS_URL`/`*_PRIVATE_KEY` |
| M6 | Medium | In-place builds under the live site; no deploy lock | **Fixed**: `releases/<time>-<commit>` built fresh, atomic `current` switch, `flock`, health check with automatic switch-back, `--rollback`, keeps 3. Verified: a broken commit failed to build while the site kept serving (156/156 probes 200) |
| L1 | Low | Old quotes re-stamped as fresh | **Fixed**: max quote age = API freshness (60 s) |
| L2 | Low | Pools query reads all rows | **Fixed**: one SQL query (`LATERAL … ORDER BY hour DESC LIMIT 1` per pool, outer `LIMIT 100`), tested on Postgres 16 |
| L3 | Low | `new-key.sh` edge cases | **Fixed**: backs up `.env` before any change, atomic write, refuses non-key values and duplicate lines, key from Node's CSPRNG; address derived as `velum` |
| L4 | Low | `source .env` shell expansion | **Fixed**: `.env` parsed as `KEY=VALUE` data (`deploy/lib/common.sh`, `ecosystem.config.cjs`); only the needed keys are loaded |
| L5 | Low | Shared Redis without password | **Fixed**: setup refuses it unless `ALLOW_REDIS_WITHOUT_PASSWORD=yes`; warns when `maxmemory-policy` is not `noeviction` |
| L6 | Low | `/v1/health` not rate limited | **Fixed**: own per-IP limit `RATE_LIMIT_HEALTH_PER_MIN` (default 60) |
| L7 | Low | Provider RPC URL (API key) in logs | **Fixed**: workers (`redactUrls`, `35038ce`); API and workers startup/env errors redact credentials, paths and queries of every URL |
| L8 | Low | psql password in argv | **Fixed** with M4 (stdin; verified absent from every process command line during setup) |
| L9 | Low | Candle cache drift | **Fixed**: ticks applied to drafts, written to Postgres, then committed to memory and Redis; candle jobs retried (5×, backoff); a late retry never moves the close back |
| L10 | Low | No HSTS/CSP | **Fixed**: HSTS over HTTPS only; CSP from a generated Nginx snippet whose `connect-src` follows `NEXT_PUBLIC_RPC_URL` (rewritten each release); static site too |
| L11 | Low | apt upgrades shared services | **Fixed**: port-80 check before any install; only missing packages, `--no-upgrade` |
| L12 | Low | Phase 1 webroot owned by www-data | **Fixed**: `root:root`, 755/644 |
| L13 | Low | PM2 kill timeout below the API's 10 s drain | **Fixed**: `kill_timeout` 12 s (`listen_timeout` 15 s for cluster reloads) |
| L14 | Low | Chainlink path checks | **Fixed**: rejects zero/future `updatedAt`, incomplete rounds, decimals > 36 and prices outside (0, 1e9) |
| — | Low | API `MARKET_CLOSED` said "testnet" on mainnet; Nginx `/_next/static` without HTTP/1.1 + Host; Nginx rate limit answered HTML 503 | **Fixed**: network label from config; proxy headers set; `/api` over the limit answers JSON `429 RATE_LIMITED` |

## Frontend

| ID | Sev | Finding | Status |
|---|---|---|---|
| M1 | Medium | Demo ledger/session reused across networks | **Fixed** (`96c4864`): keys include chain ID |
| M2 | Medium | Mainnet showed a fabricated shield history and "visible onchain" claims | **Fixed**: labelled practice balance; flows, receipts, activity marked "Simulated" |
| M3 | Medium | `NEXT_PUBLIC_DEMO_MODE=false` hid notices while still simulating | **Fixed**: notices always on in Phase 2 |
| M4 | Medium | Mainnet fell back to simulated prices labelled "live" | **Fixed**: no fallback on mainnet, dashes and disabled trading without a price |
| M5 | Medium | Next 14.2.35 is end-of-life (critical advisories fixed only in 15.5.x) | **Mitigated**: image optimizer off and refused in Nginx, Upgrade headers no longer forwarded. **Upgrade to Next 15.5.x needs sign-off** (stack change, CLAUDE.md §7) |
| L1, L2, L3, L5, L7, L10 | Low | Close/liquidation double pay, flows after wallet switch, `1e400` crash, double wallet prompt, leverage not clamped, WalletConnect site URL | **Fixed** |
| L4 | Low | No focus trap in modals | **Fixed**: Tab cycles inside the dialog, the page behind is `inert`, a running flow focuses the dialog, focus returns to the trigger (or its nearest surviving container) |
| L6 | Low | Stored demo ledger not validated | **Fixed**: field-by-field decoder (`lib/ledger-codec.ts`), bigint only for money fields, bad entries dropped, unparsable data removed; `app/global-error.tsx` added |
| L8 | Low | Sign message not SIWE-shaped | **Fixed**: EIP-4361 message (host, origin, chain ID, fixed statement, deterministic nonce and Issued At), two signatures compared on first open (unstable signers refused with an explanation), domain-separated display address, signature kept out of the TanStack cache |
| L9 | Low | No CSP/HSTS | **Fixed**: app sends nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options DENY (`next.config.mjs`); CSP/HSTS in Nginx (backend L10); no inline handlers |
| L11 | Low | Loose number parsing | **Fixed**: strict web-side parser (`lib/amount.ts`) on every amount field: plain decimals, ≤ 15 integer / 18 decimal digits, inline hint, 34-character cap |
| L12 | Low | Custom RPC not chain-checked | **Fixed**: https only (loopback http for dev), one `eth_chainId` check at startup with fallback to the official RPC and a warning; wallets only ever get the official RPC |
| L13 | Low | Mainnet landing claims about contracts | **Fixed**: mainnet copy in `lib/copy.ts` describes the design ("designed to", "will"); testnet copy verbatim from the prototype |
| L14 | Low | Third-party logos vs spec | **Fixed**: logos kept at the owner's request; attribution corrected (Simple Icons is CC0, the logos are trademarks) and the spec deviation noted in `lib/logos.ts` |
| I2, I4, I5, I6, I9 | Info | No address checksum, no swap focus ring, "Minimum you get" rounded up, Max preset above the 100-token cap, LP removal valued at click | **Fixed**. I7 (per-connector imports) not applicable: wagmi 2.19 has no connector subpaths |
| — | Low | Trade page 2,000 px wide on phones (chips' hidden labels escaped the scrolling strip) | **Fixed**: `.strip` positioned; no visual change |

## Next steps

1. Second full audit pass by fresh reviewers over the fixed code.
2. Owner decisions: production oracle (low-latency verified feed), guardian on/off, new safety parameters,
   Next 15.5.x upgrade.
3. External audit (contracts + circuits), bug bounty and monitoring before any mainnet deployment.
