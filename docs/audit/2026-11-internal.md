# Internal code audit — November 2026

Three independent reviewers (contracts, backend + deploy, frontend) audited the repository at
commit `0f2b776`+. Each tried to prove findings with tests. This is an **internal** review: it does
not replace the external audit that docs/04 §3 requires before any contract handles real funds.

Proof-of-concept tests: `contracts/test/audit/AuditPoC.t.sol` and, for the second contracts pass,
`contracts/test/audit/Round2PoC.t.sol` (tests named `*_fixed*` are regressions; the others still
demonstrate open findings and must be inverted when fixed).

## Summary

| Area | Critical | High | Medium | Low | Fixed so far |
|---|---|---|---|---|---|
| Contracts (`contracts/`) | 1 | 1 | 6 | 8 | F-01–F-08, F-11, F-12, I-1; F-10, F-13 mitigated; F-09 accepted. Round 2: R2-01–R2-05 fixed, R2-06/R2-07 documented, F-07 completed |
| Backend + deploy (`apps/api`, `apps/workers`, `deploy/`) | 0 | 0 | 6 | 14 | All (M1–M6, L1–L14); existing servers need the one-time upgrade in docs/05 |
| Frontend (`apps/web`) | 0 | 0 | 7 | 20 | M1–M4, M5 (mitigated), L1–L14, I2, I4–I6, I9. Round 2: R2-M2, R2-M4, R2-N1, R2-N2, R2-N4–N7, R2-N10 fixed; R2-N3 (CSP) owned by deploy |

**Verdict (after the fix round):** every Critical, High and Medium finding is fixed or mitigated, each with a
regression test (`test_Fxx_fixed_*` for contracts; vitest/e2e for backend and web). Contracts are still **not
ready for an external audit** until a production oracle is chosen: opens need a price at most 10 s old, which
standard Chainlink stock feeds do not provide (see `contracts/README.md`). Contracts are not deployed anywhere.
Next 14 remains end-of-life (mitigated; upgrade to 15.5.x awaits sign-off). A second full audit pass follows.

## Contracts

| ID | Sev | Finding | Status |
|---|---|---|---|
| F-01 | Critical | Forced-exit bond was pushed to a user-controlled address during settlement; a huge revert payload blocked every close, liquidation and forced exit (freeze counterparties, drain insurance) | **Fixed**: pull-only refunds + `claimBond()` (`516d20b`), regression tests |
| F-04 | High | Testnet relay oracle: one key controls every price (10% per second, unbounded after 1 h) | **Fixed** (completed by R2-01): every price is rate-limited against the last recorded price, 1/6000 per second (1%/min), at most 5% per recording; deploy refuses testnet without a dedicated `PRICE_RELAYER`. A compromised key moves a 5x maker's claim by ≤ 5.5% of its margin per minute |
| F-02 | Medium | Self-paired positions profit from insurance on price gaps > 20% (immediate, first-come cover) | **Fixed** (completed by R2-01–R2-03): shortfalls become claims paid per hourly epoch, pro rata, from a budget capped at 10% of the fund at the epoch's first draw (shared with keeper top-ups; rest is a haircut); with the rate limit the PoC straddle loses money (e.g. −121 USDG when self-liquidated at the first chance) |
| F-03 | Medium | `isDead` true on one failed/out-of-bounds Chainlink read; forced exit then settles at entry | **Fixed**: `lastValidAt` recorded on every perps accrual / `poke`; failed or out-of-bounds reads are stale; dead only 14 days after `max(lastValidAt, setupAt)` |
| F-05 | Medium | No L2 sequencer-uptime check / grace period | **Fixed**: sequencer feed is a setup parameter (required with Chainlink feeds); down or < 1 h grace blocks opens, liquidations and margin removal; close and add margin allowed |
| F-06 | Medium | Takers get a free option on prices up to 60 s old against 0-spread offers | **Fixed**: opens need a price ≤ 10 s old (closes 60 s) and offers need an open spread ≥ 2 bps |
| F-07 | Medium | Stock splits/dividends not handled; immutable bounds can kill a market | **Fixed** (procedural): optional guardian fixed at setup can only toggle per-market close-only; split/dividend procedure in `contracts/README.md`. Round 2 found it incomplete (guardian off by default, so the procedure can't run): the deploy script keeps the default (none, owner sign-off) but reads `GUARDIAN` and warns loudly when it is unset (`test_F07_fixed_deployWarnsWithoutGuardian`) |
| F-08 | Low | Forced exit of a liquidatable position skipped the liquidation penalty | **Fixed**: such a settlement is a liquidation (penalty applies, settler gets the keeper reward) |
| F-09 | Low | Funding wash trading with self-paired positions | **Accepted**, documented: bounded by the 0.01%/h cap, costs fees and 40% locked margin; clean fix needs identity or a new funding model |
| F-10 | Low | OI-cap griefing (and dust positions) | **Mitigated**: 10 USDG minimum position; filling a cap still possible at 40% of capped notional in margin (size caps accordingly) |
| F-11 | Low | No keeper reward on bad debt | **Fixed**: insurance tops the liquidator up to half the full penalty, ≤ 1 USDG, when the loser can't pay it; since R2-02 within the epoch's cover cap |
| F-12 | Low | Closing against an insolvent counterparty forfeited insurance cover | **Fixed**: closing a liquidatable position settles it as a liquidation, so the shortfall is claimed (at a lagging price, R2-04, the winner calls `liquidate`) |
| F-13 | Low | No emergency controls | **Mitigated**: the optional close-only guardian (F-07); no fund-moving powers by design |
| I-1 | Info | `deposit(..., to = module)` stranded funds | **Fixed**: deposits to module addresses are refused |

Second contracts pass (`contracts/test/audit/Round2PoC.t.sol`; each round-2 proof of concept inverted into a `*_fixed*` regression):

| ID | Sev | Finding | Status |
|---|---|---|---|
| R2-01 | Medium | Price band anchored to a reference fixed for 10 minutes: one push moved the price +22% inside a window (relayer + accomplice drained an honest maker's 10,000 USDG backing in 10 s), two records around an attacker-timed roll (`poke`) moved it +21% (F-02 straddle profitable again). Made F-02 and F-04 incomplete | **Fixed**: rate limit against the last recorded price, `maxMove = last × 5% × min(dt, 5 min) / 5 min` (1/6000 per second, ≤ 5% per recording); `poke` is an ordinary recording. Proven: no side of a 5x pair opened at any non-lagging price goes below zero within 12 min (worst case 13.1 min); a non-liquidatable side survives the next recording and needs ≥ 9.5 min of recordings to reach zero; a compromised relayer moves a maker's claim ≤ 5.5% of its margin per minute (maker liquidatable no sooner than 8.7 min). Regressions `test_R2_01*_fixed*`, `testFuzz_limit_everyRecordingWithinLimit`. Trade-off for the owner: with exact "effective ≠ source ⇒ lagging", normal volatility makes some opens retry (see `contracts/README.md`, limitations) |
| R2-02 | Low | The F-11 keeper top-up was paid at once outside the 10%/epoch cover cap (30 small insolvent self-pairs took 30% of the fund at once, 35%+ in total) | **Fixed**: top-ups draw on the epoch's cap ahead of the cover for that shortfall; the PoC event now takes ≤ 10% of the fund (`test_R2_02_fixed_keeperTopUpsCountAgainstEpochCap`) |
| R2-03 | Info | Epoch budget set by whoever settles first (fund size at settlement); one event can straddle two epochs; README's "a single event takes at most a tenth" overstated | **Fixed**: cap fixed at the epoch's first draw, draws leave the fund at once, budget independent of settlement time; README states the real bound (10% per epoch, 19% over two, 1 − 0.9^k over k) (`test_R2_03_fixed_capFixedAtFirstDrawAndTwoEpochsAtMost19Percent`) |
| R2-04 | Low | `close()` routed a liquidatable position to liquidation before the lagging check, so a losing taker exited at a known-wrong banded price | **Fixed**: `close()` refuses a lagging price on both routes; third-party keepers still liquidate; the bound for any liquidation at a lagging price is documented (loser keeps < 9% of notional vs the source price) (`test_R2_04_fixed_*`) |
| R2-05 | Info | `deposit` still accepted the vault itself and the oracle as recipients (stranded) | **Fixed**: refuses the vault, listed tokens and a deny-list fixed at setup (deploy passes the oracle); `withdraw` to the vault refused too (`test_R2_05_fixed_depositToProtocolContractsRefused`) |
| R2-06 | Info | README: "a close only removes risk" was wrong (a 60 s old close price is an exit option) | **Documented**: README corrected (option bounded by the rate limit and lagging refusal; priced by the close spread) |
| R2-07 | Info | README/NatSpec silent on the penalty when a losing taker's close settles as a liquidation, and on `priceLimit` checking only the spread-adjusted exit | **Documented**: README and `close()` NatSpec corrected (`test_R2_07_closeAsLiquidationPaysPenaltyNotSpread`) |

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
| M2 | Medium | Mainnet showed a fabricated shield history and "visible onchain" claims | **Fixed** (completed by R2-M2): labelled practice balance; flows, receipts, activity marked "Simulated" |
| M3 | Medium | `NEXT_PUBLIC_DEMO_MODE=false` hid notices while still simulating | **Fixed**: notices always on in Phase 2 |
| M4 | Medium | Mainnet fell back to simulated prices labelled "live" | **Fixed** (completed by R2-M4): no fallback on mainnet, dashes and disabled trading without a price |
| M5 | Medium | Next 14.2.35 is end-of-life (critical advisories fixed only in 15.5.x) | **Mitigated**: image optimizer off and refused in Nginx, Upgrade headers no longer forwarded. **Upgrade to Next 15.5.x needs sign-off** (stack change, CLAUDE.md §7) |
| L1, L2, L3, L5, L7, L10 | Low | Close/liquidation double pay, flows after wallet switch, `1e400` crash, double wallet prompt, leverage not clamped, WalletConnect site URL | **Fixed** |
| L4 | Low | No focus trap in modals | **Fixed** (completed by R2-N4): Tab cycles inside the dialog, the page behind is `inert`, a running flow focuses the dialog, focus returns to the trigger (or its nearest surviving container) |
| L6 | Low | Stored demo ledger not validated | **Fixed**: field-by-field decoder (`lib/ledger-codec.ts`), bigint only for money fields, bad entries dropped, unparsable data removed; `app/global-error.tsx` added |
| L8 | Low | Sign message not SIWE-shaped | **Fixed** (completed by R2-N1, R2-N2): EIP-4361 message (host, origin, chain ID, fixed statement, deterministic nonce and Issued At), two signatures compared on first open (unstable signers refused with an explanation), domain-separated display address, signature kept out of the TanStack cache |
| L9 | Low | No CSP/HSTS | **Fixed**: app sends nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options DENY (`next.config.mjs`); CSP/HSTS in Nginx (backend L10); no inline handlers |
| L11 | Low | Loose number parsing | **Fixed**: strict web-side parser (`lib/amount.ts`) on every amount field: plain decimals, ≤ 15 integer / 18 decimal digits, inline hint, 34-character cap |
| L12 | Low | Custom RPC not chain-checked | **Fixed**: https only (loopback http for dev), one `eth_chainId` check at startup with fallback to the official RPC and a warning; wallets only ever get the official RPC |
| L13 | Low | Mainnet landing claims about contracts | **Fixed**: mainnet copy in `lib/copy.ts` describes the design ("designed to", "will"); testnet copy verbatim from the prototype |
| L14 | Low | Third-party logos vs spec | **Fixed**: logos kept at the owner's request; attribution corrected (Simple Icons is CC0, the logos are trademarks) and the spec deviation noted in `lib/logos.ts` |
| I2, I4, I5, I6, I9 | Info | No address checksum, no swap focus ring, "Minimum you get" rounded up, Max preset above the 100-token cap, LP removal valued at click | **Fixed**. I7 (per-connector imports) not applicable: wagmi 2.19 has no connector subpaths |
| — | Low | Trade page 2,000 px wide on phones (chips' hidden labels escaped the scrolling strip) | **Fixed**: `.strip` positioned; no visual change |

Second pass (round 2, web). Regressions: `pnpm --filter @velum/web test` (vitest, `apps/web/tests/`) and Playwright runs through
an Nginx-equivalent CSP front end with a mock wallet, RPC and API on production builds (mainnet: 98 checks; default/testnet: 24).

| ID | Sev | Finding | Status |
|---|---|---|---|
| R2-M2 | Medium | Mainnet still fabricated on-chain evidence: random commitment and block in the account card ("Last thing the public chain saw") and Chain view, "Encrypted" badge, "decrypted on this device", Velum-contract steps, "Visible onchain" rows | **Fixed**: on mainnet `chainSaw` is a no-op and opens record no chain event (positions carry a zero placeholder; a stored `lastChain` is dropped on load); the account card says "Nothing is on-chain: demo trades are simulated"; Chain view hidden; badge "Simulated" and a practice-account subtitle; shield/unshield/send notes, steps and the Swap / Add-liquidity summary rows are network-aware (`SIM` in `lib/copy.ts`). Testnet copy unchanged (verbatim prototype). `tests/simulated.{mainnet,testnet}.test.ts` run every flow; Playwright on a mainnet build finds none of the fabricated strings after shield, open, close, spot, swap, LP, offer, unshield and send |
| R2-M4 | Medium | The seed price drove money logic when the live price was missing: with API `source: null` the config seed was stored as the price and used for liquidation, totals, swaps and LP; nothing went stale when the API went down | **Fixed**: one rule (`tradablePrice` / `livePrice` in `lib/markets.ts`): no price without live data; on mainnet also none when the API marks it stale, after 2 failed polls or 60 s without a successful poll (the feed records `lastOkAt`). The seed is never stored as a price. Liquidation skips unpriced markets; open, close, spot, swap and add-liquidity re-check at completion and cancel ("Price unavailable", nothing applied); the ticket, Close, Swap and Add liquidity disable; totals, values and P&L show "—"; the banner says live prices are unavailable and trading is paused; price cells keep the last price marked "stale". Proven in `tests/prices.{mainnet,testnet}.test.ts` (incl. `startMarketFeed` with a mocked API) and on a mainnet build with the API down from page load, going down mid-session, and each action losing its price mid-flow |
| R2-N1 | Low | Any wallet output opened an account: empty or constant signatures shared one account; v 0/1 or high-s encodings of one key opened different accounts; no warning when a wallet's account changes | **Fixed**: only a 65-byte ECDSA signature that recovers (`recoverMessageAddress`) to the connected wallet is accepted; empty, constant, other-key and ERC-1271/6492 signatures are refused with an explanation (contract wallets are a later, deliberate step); the hash input is normalized (r ‖ low-s ‖ v ∈ {27, 28}); a fingerprint of each wallet's account (per chain) survives disconnects and a different account is flagged before it opens. Existing accounts unchanged (pinned) |
| R2-N2 | Low | Sign message built from UI copy (`CHAIN.label`) | **Fixed**: statement and chain ID are frozen per-network constants (`SIGN_SCHEME` in `lib/account.ts`); `tests/account.test.ts` pins the exact bytes, keccak and derived address per network (identical to the previous build) |
| R2-N3 | Low | CSP misses hosts the wallet SDKs use (WalletLink, Google Fonts for AppKit, secure.walletconnect.org frame; pulse analytics only allowed through a wildcard) | **Deploy-owned** (`deploy/lib/common.sh`): see the backend and deploy section. The app cannot turn pulse analytics off (the WalletConnect provider drops AppKit's analytics flag) |
| R2-N4 | Low | Focus trap fought the WalletConnect modal (z-index 999): Tab reached our hidden dialog, Escape closed both | **Fixed**: while an AppKit / WalletConnect overlay is open the trap is suspended and our dialog is inert; focus moves to the overlay and back when it closes; Escape closes only the topmost layer |
| R2-N5 | Low | Legacy cleanup left `velum:session:v1` and `velum:demo:v1:*` | **Fixed**: v1 sessions and ledgers and v2 sessions on every chain are removed; current ledgers kept and still read |
| R2-N6 | Low | Connected landing nav overflowed at 360 px ("Launch app" clipped) | **Fixed**: at ≤ 480 px the landing wallet button keeps only its avatar (accessible name kept); desktop and app nav unchanged |
| R2-N7 | Info | A hung wallet sign request needed a reload | **Fixed**: after 5 s the sign dialog offers Cancel, which unlocks and resets it; a late wallet answer is discarded |
| R2-N10 | Info | No committed web regression tests | **Fixed**: `test` script (vitest 3.2.7): amount parser, ledger codec, sign message and signature rules, price rule, simulated-copy rules, storage cleanup (113 tests) |
| — | Low | `withdrawOffer` fell back to a stale offer object; `isPrivateAddress` accepted any `velum1…`; `bpsOrNull` accepted `1000.000000000000001` | **Fixed**: an offer gone at completion credits nothing ("Already withdrawn"); exact `velum1` + 36 lowercase hex (Send lowercases pasted input first); spreads compared exactly before float conversion |

## Next steps

1. Second full audit pass by fresh reviewers over the fixed code.
2. Owner decisions: production oracle (low-latency verified feed), guardian on/off, new safety parameters,
   Next 15.5.x upgrade.
3. External audit (contracts + circuits), bug bounty and monitoring before any mainnet deployment.
