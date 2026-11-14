# Velum

Private spot and perps for tokenized stocks on Robinhood Chain (testnet).

> Status: **Phase 2**, a production frontend with demo trading. Wallet connect, public balances,
> prices and candles are real. Trades are simulated in the browser behind a visible "Demo mode" banner.
> Claude Code: start with `CLAUDE.md`.

## What's in this repo

| Path | What it is |
|---|---|
| `CLAUDE.md` | Master brief: rules, stack, routes, phases |
| `prototype/index.html` | Approved UI (Phase 1 serves it as-is). Visual source of truth |
| `apps/web` | Next.js 14 port of the prototype: landing + `/app/*` (wagmi v2 + viem) |
| `apps/api` | Fastify read API: health, markets, candles, pools, stats, quote |
| `apps/workers` | BullMQ workers: price relay + candles |
| `packages/config` | Verified chain constants, tokens, markets, protocol numbers, Redis contract |
| `packages/math` | 1e18 fixed-point money math and every formula in docs/01 §6 |
| `packages/db` | Prisma schema, migrations, generated client |
| `deploy/` | Nginx, PM2, Phase 1 script, Phase 2 server setup and release scripts |
| `docs/` | Product spec, architecture, API, contracts + privacy, deploy, roadmap |

## Phase 1: the prototype live (static)

On a fresh Hostinger VPS (Ubuntu 22.04+) with your domain's A record pointing at it:

```bash
git clone <this-repo> /opt/velum && cd /opt/velum
sudo DOMAIN=velum.example EMAIL=you@example.com bash deploy/phase1-static.sh
```

This installs Nginx, copies the prototype to `/var/www/velum`, opens the firewall (keeping your SSH
port), and issues HTTPS. `www.` is included only if its DNS points at the server (`WWW=yes` to force).

## Phase 2: full stack

```
apps/web      Next.js 14   127.0.0.1:3000   (PM2 cluster ×2; next free port if taken)
apps/api      Fastify      127.0.0.1:4000   (PM2 cluster ×2, Nginx /api/ → :4000/)
apps/workers  BullMQ       no port          (PM2 fork ×1)
PostgreSQL    :5432 (localhost)   Redis :6379 (localhost, password)
```

First time on the server (installs only what's missing, writes `.env` atomically with generated
passwords, adds the Nginx site and security headers, issues HTTPS, runs the first release, enables
PM2 on boot). Safe on a VPS that already runs other sites: own `velum` user and PM2, free ports,
installed packages never upgraded, existing Redis left untouched (but refused without a password).
The checkout must be root-owned; the apps build and run as `velum`.

```bash
sudo git clone <repo-url> /opt/velum
cd /opt/velum && sudo DOMAIN=velum.example EMAIL=you@example.com bash deploy/server-setup.sh
```

Every release after that (as root; it builds and runs as `velum`):

```bash
sudo bash /opt/velum/deploy/deploy.sh               # --rollback switches back to the previous release
```

Switch the network. Mainnet = real wallet and balances plus live official Robinhood quotes
(`PRICE_SOURCE=robinhood`); trades stay simulated and no contracts are deployed:

```bash
sudo bash /opt/velum/deploy/set-network.sh mainnet
```

`deploy.sh` takes a lock, pulls the branch the checkout is on (`BRANCH=` to override), builds the
commit in a fresh `releases/<time>-<commit>/` directory (frozen lockfile, every app, migrations),
switches the `current` symlink atomically, reloads PM2 with zero downtime and checks health. A
failed build leaves the running site untouched; a failed health check switches back. Each PM2 app
gets only the environment variables it reads. Servers set up before November 2026 need the one-time
upgrade in `docs/05-deploy-vps.md` (Upgrading). See that file for the security model, manual steps
and operations.

## Local development

Needs Node 20+, pnpm 9, PostgreSQL 16 and Redis 7.

```bash
pnpm install
cp .env.example .env        # set DATABASE_URL, REDIS_URL, CORS_ORIGIN=http://localhost:3000
pnpm db:migrate
pnpm --filter @velum/workers dev   # prices + candles
pnpm --filter @velum/api dev       # http://127.0.0.1:4000/v1/health
API_PROXY_TARGET=http://127.0.0.1:4000 pnpm --filter @velum/web dev   # http://localhost:3000
```

Checks (run before every commit): `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## What changed in Phase 2

- **Real prices** (`PRICE_SOURCE=robinhood`): official quotes from api.robinhood.com/rhj/prices
  (documented at docs.robinhood.com/chain/stock-token-apis), using the bid/ask midpoint. Each quote must name
  the exact mainnet token address. Switching between simulated and real prices clears stored history
  once, so charts never mix the two. On mainnet, protocol metrics (open interest, funding, pool size,
  APR, proofs) show "—" until contracts exist.
- **Testnet or mainnet** (`VELUM_NETWORK`). Mainnet constants in `packages/config/robinhood-mainnet.json`
  come from docs.robinhood.com and Robinhood's own asset list (api.robinhood.com/rhj/assets), and
  each was checked on-chain. On mainnet all 10 markets exist. Every sentence that says "testnet"
  switches to wording that is true there, and receipts add "Simulated, nothing was sent onchain".
- **Verified chain constants** (`packages/config/robinhood-testnet.json`). Chain ID 46630, RPC and
  explorer match docs.robinhood.com and the RPC itself. All six token contracts were checked on-chain:
  USDG has 6 decimals, stock tokens have 18. Multicall3 is deployed. Chainlink feed addresses are not verified yet, so
  `PRICE_SOURCE=demo` stays the default.
- **Web**: every prototype route ported with its CSS verbatim, giving the same layout at 1440, 1024 and 390 px. The only
  visible additions are the demo banner and "Coming soon" on NVDA, AAPL, META, MSFT and COIN, which have
  no testnet token. Lighthouse: performance 91–92, accessibility 96, best practices 100, SEO 100.
- **Wallet**: every installed wallet listed by name and icon (EIP-6963: MetaMask, Rabby, Phantom, …),
  plus WalletConnect when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set,
  plus the Coinbase/passkey connector. Wrong networks prompt a switch. Public balances come from the chain
  through Multicall3. Third-party wallet SDKs load only when chosen and with telemetry off, so a session
  talks only to our API and the testnet RPC.
- **Private account (demo)**: one signature is hashed in the browser into a `velum1…` address. The
  signature is never stored or sent. Private balances, positions, offers and LP are a demo ledger kept
  per wallet in `localStorage`, using the prototype's flows, receipts and toasts and the fixed-point
  formulas in `@velum/math`. New wallets start with 12,500 USDG, 4 TSLA and 10 AMZN (AMZN replaces the
  prototype's NVDA, which is not on testnet).
- **API**: per docs/03-api.md. Money is returned as strings, quotes are rounded down to 4 significant
  figures, rate limits live in Redis, there is one error format, and the API holds no per-user state or keys.
- **Workers**: demo or Chainlink price source, Redis snapshots with a last-hour sparkline,
  PriceTick rows, 15m/1h/4h/1D candles, demo backfill and tick pruning.
- **Deploy**: Nginx security headers now survive per-location `add_header`. Cross-origin isolation
  is deferred to Phase 4 because it breaks wallet popups. Server setup is now one script, and the release script
  re-runs itself after pulling.
- **Deploy hardening (internal audit, backend M3–M6 and Lows)**: root-owned checkout, apps built and run as
  `velum` in release directories with an atomic `current` switch, rollback and a deploy lock; per-app env
  allowlists in PM2 (the web never sees database URLs or keys); `.env` written atomically and parsed as data;
  psql passwords on stdin; shared Redis without a password refused; HSTS and a CSP that follows the configured
  RPC; JSON 429 from Nginx on `/api`. `deploy.sh`, `set-network.sh` and `new-key.sh` now run with `sudo`.
  API: `/v1/health` is rate limited, pools are read with one bounded query, startup errors never print URLs.
  Workers: candle cache follows Postgres and failed candle jobs are retried; Chainlink rounds are time- and
  bounds-checked.

## Stack

Next.js 14 · Fastify · Prisma · PostgreSQL · Redis · BullMQ · wagmi/viem · PM2 · Nginx
(Foundry and Noir arrive in Phases 3–4.)

## Disclaimer

An independent project on Robinhood Chain, not affiliated with Robinhood. Testnet only.
Test tokens have no value. Trades are simulated in Phase 2. Contracts are not audited.
