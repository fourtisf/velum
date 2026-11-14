# Internal code audit — November 2026

Three independent reviewers (contracts, backend + deploy, frontend) audited the repository at
commit `0f2b776`+. Each tried to prove findings with tests. This is an **internal** review: it does
not replace the external audit that docs/04 §3 requires before any contract handles real funds.

Proof-of-concept tests: `contracts/test/audit/AuditPoC.t.sol` (tests named `*_fixed_*` are
regressions; the others still demonstrate open findings and must be inverted when fixed).

## Summary

| Area | Critical | High | Medium | Low | Fixed so far |
|---|---|---|---|---|---|
| Contracts (`contracts/`) | 1 | 1 | 5 | 6 | F-01 (Critical) |
| Backend + deploy (`apps/api`, `apps/workers`, `deploy/`) | 0 | 0 | 6 | 14 | M1, M2, L1, L7 |
| Frontend (`apps/web`) | 0 | 0 | 5 | 14 | M1–M4, M5 (mitigated), L1, L2, L3, L5, L7, L10 |

**Verdict:** contracts are **not ready** for an external audit until F-02 to F-07 are resolved and
a production oracle is chosen. Contracts are not deployed anywhere. The live site (Phase 2) runs no
contracts; its remaining open items are deployment hardening (backend M3–M6).

## Contracts

| ID | Sev | Finding | Status |
|---|---|---|---|
| F-01 | Critical | Forced-exit bond was pushed to a user-controlled address during settlement; a huge revert payload blocked every close, liquidation and forced exit (freeze counterparties, drain insurance) | **Fixed**: pull-only refunds + `claimBond()` (`516d20b`), regression tests |
| F-04 | High | Testnet relay oracle: one key controls every price (10% per second, unbounded after 1 h) | Open — production needs Chainlink + sequencer check; testnet relay needs bounded total move and a dedicated key |
| F-02 | Medium | Self-paired positions profit from insurance on price gaps > 20% (immediate, first-come cover) | Open — redesign cover (per-epoch, pro rata, capped) and gap handling (close-only around market close/earnings) |
| F-03 | Medium | `isDead` true on one failed/out-of-bounds Chainlink read; forced exit then settles at entry | Open — track `lastValidAt`, treat failures as stale |
| F-05 | Medium | No L2 sequencer-uptime check / grace period | Open |
| F-06 | Medium | Takers get a free option on prices up to 60 s old against 0-spread offers | Open — two-step fills or tight freshness for opens; maker minimum spread |
| F-07 | Medium | Stock splits/dividends not handled; immutable bounds can kill a market | Open — per-market split factor or halt-and-settle; confirm token mechanics |
| F-08–F-13, I-1 | Low/Info | Forced-exit penalty skip, funding wash trading, OI-cap griefing, no keeper reward on bad debt, close forfeits insurance, no emergency controls, deposit-to-module strands funds | Open |

## Backend and deploy

| ID | Sev | Finding | Status |
|---|---|---|---|
| M1 | Medium | Robinhood quotes not sanity-checked (wide spreads, loose number parsing, overflow, future stamps) | **Fixed** (`35038ce`): strict format, bounds, 20% max spread, no future/old quotes, 25% jump needs 3 confirmations |
| M2 | Medium | History reset keyed on a Redis marker (evictable on a shared Redis); chainlink-without-feeds silently ran demo prices | **Fixed** (`35038ce`): decision from tagged ticks in Postgres; chainlink without feeds fails loudly |
| M3 | Medium | `server-setup.sh` builds `.env` non-atomically; sed breaks on special characters | Open — build `.env.tmp` with umask 077 and node/awk, then move |
| M4 | Medium | Root re-runs files the app user can edit; DB password interpolated into superuser SQL | Open — root-owned checkout/scripts, `psql -v` variables |
| M5 | Medium | Every secret reaches every PM2 process (web included) and `dump.pm2` | Open — per-app env allowlists in `ecosystem.config.cjs` |
| M6 | Medium | In-place builds under the live site; no deploy lock | Open — release directories + `flock` |
| L1 | Low | Old quotes re-stamped as fresh | **Fixed**: max quote age = API freshness (60 s) |
| L7 | Low | Provider RPC URL (API key) in logs | **Fixed** in workers (`redactUrls`); API startup message still open |
| L2–L6, L8–L14 | Low | Pools query reads all rows, new-key edge cases, `source .env` shell expansion, shared Redis without password, health rate limit, psql password in argv, candle cache drift, no HSTS/CSP, apt upgrades shared services, webroot owner, PM2 kill timeout, chainlink path checks | Open |

## Frontend

| ID | Sev | Finding | Status |
|---|---|---|---|
| M1 | Medium | Demo ledger/session reused across networks | **Fixed** (`96c4864`): keys include chain ID |
| M2 | Medium | Mainnet showed a fabricated shield history and "visible onchain" claims | **Fixed**: labelled practice balance; flows, receipts, activity marked "Simulated" |
| M3 | Medium | `NEXT_PUBLIC_DEMO_MODE=false` hid notices while still simulating | **Fixed**: notices always on in Phase 2 |
| M4 | Medium | Mainnet fell back to simulated prices labelled "live" | **Fixed**: no fallback on mainnet, dashes and disabled trading without a price |
| M5 | Medium | Next 14.2.35 is end-of-life (critical advisories fixed only in 15.5.x) | **Mitigated**: image optimizer off and refused in Nginx, Upgrade headers no longer forwarded. **Upgrade to Next 15.5.x needs sign-off** (stack change, CLAUDE.md §7) |
| L1, L2, L3, L5, L7, L10 | Low | Close/liquidation double pay, flows after wallet switch, `1e400` crash, double wallet prompt, leverage not clamped, WalletConnect site URL | **Fixed** |
| L4, L6, L8, L9, L11–L14 | Low | No focus trap, unvalidated stored ledger, sign message not SIWE-shaped, no CSP/HSTS, loose number parsing, custom RPC not chain-checked, mainnet landing claims about contracts, third-party logos vs spec | Open |

## Next steps

1. Backend M3–M6 (deploy hardening), then the remaining Lows.
2. Contracts: F-04/F-05 (production oracle), F-02/F-03/F-06/F-07, regression tests per fix, then
   an external audit (contracts + circuits), bug bounty and monitoring before any mainnet deployment.
3. Decide on the Next 15.5.x upgrade.
