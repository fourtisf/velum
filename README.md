# Velum

Private spot and perps for Stock Tokens on Robinhood Chain.

> Status: **Phase 2**, a production frontend with demo trading. Wallet connect, public balances,
> prices and candles are real; trades are simulated in the browser behind a visible "Demo mode" banner.
> The site runs on testnet, or on mainnet with live 24/7 prices and candles from Uniswap on Robinhood Chain,
> **real spot trades through Uniswap** from the user's wallet and **real perps through the user's own Hyperliquid
> account** (Hyperliquid's XYZ stock perps); the private account stays simulated. Velum contracts are not deployed on mainnet; the guarded mainnet beta (allowlisted wallets, small
> caps, unaudited contracts) is prepared: `docs/07-mainnet-guarded-beta.md`. Claude Code: start with `CLAUDE.md`.

## What's in this repo

| Path | What it is |
|---|---|
| `CLAUDE.md` | Master brief: rules, stack, routes, phases |
| `prototype/index.html` | Approved UI (Phase 1 serves it as-is). Visual source of truth |
| `apps/web` | Next.js 15 port of the prototype: landing + `/app/*` (wagmi v3 + viem) |
| `apps/api` | Fastify read API: health, markets, candles, pools, stats, quote |
| `apps/workers` | BullMQ workers: price relay + candles + the Phase 3 indexer; and the signer program (`src/signer.ts`: the on-chain price relayer and keeper, run as their own user) |
| `packages/config` | Verified chain constants, tokens, markets, protocol numbers, session calendar, Redis contract |
| `packages/math` | 1e18 fixed-point money math and every formula in docs/01 §6 |
| `packages/db` | Prisma schema, migrations, generated client |
| `contracts/` | Foundry project: the Phase 3 contracts, tests and deploy script (testnet, or mainnet as the guarded beta only; not audited) |
| `deploy/` | Nginx, PM2, Phase 1 script, Phase 2 server setup, release scripts, dedicated Redis (`redis-velum.sh`) |
| `docs/` | Product spec, architecture, API, contracts + privacy, deploy, roadmap (with the owner's decisions) |
| `.github/` | CI (lint, typecheck, test, build, Foundry) and Dependabot |
| `LICENSE`, `SECURITY.md` | Proprietary licence (all rights reserved); how to report a vulnerability |

## Phase 1: the prototype live (static)

**Superseded by the Phase 2 app.** The Next.js app (below) is what goes live; the static prototype is
kept as the visual and behavioural design reference (CLAUDE.md). It runs offline on demo data and
simulates every trade; its copy says so ("Stock Tokens", "Testnet. Test tokens have no value.", privacy
features described as designed, not live), matching the web. The script below still works for a quick
static preview:

On a fresh Hostinger VPS (Ubuntu 22.04+) with your domain's A record pointing at it:

```bash
git clone <this-repo> /opt/velum && cd /opt/velum
sudo DOMAIN=velum.example EMAIL=you@example.com bash deploy/phase1-static.sh
```

This installs Nginx, copies the prototype to `/var/www/velum`, opens the firewall (keeping your SSH
port), and issues HTTPS. `www.` is included only if its DNS points at the server (`WWW=yes` to force).

## Phase 2: full stack

```
apps/web      Next.js 15   127.0.0.1:3000             (PM2 cluster ×2 as velum-web; next free port if taken)
apps/api      Fastify      /run/velum-api/api.sock    (PM2 cluster ×2 as velum; Nginx /api/ → the socket)
apps/workers  BullMQ       no port                    (PM2 fork ×1 as velum)
velum-signer  (workers)    no port                    (PM2 fork ×1 as velum-signer, only with ONCHAIN_WORKERS=true:
                                                       the price relayer and keeper, its own build, no Redis/Postgres)
PostgreSQL    :5432 (localhost)   Redis :6379 (localhost, password), or Velum's own Redis on a socket
```
Each user's PM2 daemon runs under its own systemd unit (`pm2-velum`, `pm2-velum-web`, `pm2-velum-signer`), started
after PostgreSQL and Redis at boot. The hot keys live in `/etc/velum/signer-keys.env` (root:velum-signer 640), never in
`.env` (`sudo bash /srv/velum/deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY`; docs/05, "The signer"). On a shared server, give Velum its own Redis (a unix socket only `velum`
can reach, its own password): `sudo bash /srv/velum/deploy/redis-velum.sh`, then `deploy.sh`
(docs/05, "Dedicated Redis for Velum").

First time on the server, as root in tmux (installs only what's missing, writes `.env` atomically with
generated passwords, adds the Nginx site and security headers, issues HTTPS, runs the first release,
enables PM2 on boot). Safe on a VPS that already runs other sites: own users and PM2 daemons, free
ports, installed packages never upgraded, existing Redis left untouched (but refused without a
password), other Nginx sites never touched. The clone must be root-owned; api and workers build and run
as `velum`, the web runs as `velum-web`, which cannot read `.env` or the other apps' environment.

```bash
git -c core.hooksPath=/dev/null -c core.fsmonitor=false clone --branch claude/new-session-93ke66 https://github.com/fourtisf/velum.git /srv/velum
DOMAIN=velum.example EMAIL=you@example.com bash /srv/velum/deploy/server-setup.sh
```
(`claude/new-session-93ke66` is the repository's only branch.) Commands that must run as `velum` or
`velum-web` go through `sudo bash /srv/velum/deploy/as-user.sh <user> <command>`, never plain
`runuser`/`su`/`sudo -u` (see docs/05).

Every release after that (as root; re-running setup is safe too and never drops HTTPS):

```bash
sudo bash /srv/velum/deploy/deploy.sh               # --rollback switches back to the previous release
```

Switch the network. Mainnet = real wallet and balances plus live official Robinhood quotes
(`PRICE_SOURCE=robinhood`); trades stay simulated and no contracts are deployed:

```bash
sudo bash /srv/velum/deploy/set-network.sh mainnet
```

`deploy.sh` takes a lock, checks that the clone is safe for root (root-owned, no symlinks, a
`.git/config` with only what `git clone` writes), pulls with git hooks disabled, builds the commit in a
fresh `releases/<time>-<commit>/` directory (frozen lockfile, every app, migrations), switches the
`current` symlink atomically, reloads PM2 with zero downtime and checks API, web, a fresh workers
heartbeat and, after a settle period, PM2 restart counts. A failed build leaves the running site
untouched; a failed health check switches back. Each PM2 app gets only the environment variables it
reads. **Servers set up before November 2026** (`/opt/velum` owned by `velum`) move to the new layout
with the tmux procedure in `docs/05-deploy-vps.md` ("Upgrading"): fresh root-owned clone at
`/srv/velum`, `deploy/import-env.sh` for `.env`, setup, automatic fallback to the old apps if the first
release fails; if the app user may be compromised, its "Compromise suspected" section moves the install to
new users before rotating secrets. See that file for the security model, manual steps and operations.

## Local development

Needs Node 22 LTS, pnpm 9, PostgreSQL 16 and Redis 7.

```bash
pnpm install
cp .env.example .env        # set DATABASE_URL, REDIS_URL, CORS_ORIGIN=http://localhost:3000
pnpm db:migrate
pnpm --filter @velum/workers dev   # prices + candles
pnpm --filter @velum/api dev       # http://127.0.0.1:4000/v1/health
API_PROXY_TARGET=http://127.0.0.1:4000 pnpm --filter @velum/web dev   # http://localhost:3000
```

Checks (run before every commit; CI runs them on every push): `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
The Postgres-backed tests run when `TEST_DATABASE_URL` points at a migrated scratch database.

## What changed: perps risk tools (November 17 2026)

- **Take profit / stop loss** on the ticket (checkbox, two prices, the P&L at each trigger) and on any position (TP/SL
  button: set, replace or remove). Reduce-only trigger market orders; on a market order Velum fills first, then sets TP/SL
  on the whole position (`positionTpsl`, sized to it and following it); on a limit order they wait for its fill
  (`normalTpsl`). A long's stop must sit between its liquidation price and its entry (and the other way for a short), or
  the ticket says why (`planTpsl` in `apps/web/lib/hyperliquid/risk.ts`).
- **Limit orders**: Market / Limit on the ticket; a limit order rests at the user's price (Gtc), sized and margined at it.
- **Orders** tab next to Positions: limit orders and TP/SL with **Cancel** and **Cancel all**; the position row shows its
  TP / SL.
- **Close** opens a dialog: 25 / 50 / 75% or all (a partial close must be at least 10 USD). **Margin**: add to or remove
  from an isolated position, with the new liquidation price estimate (Hyperliquid's formula), topping up the stock perps
  balance from the main one when needed.
- All of these are signed by the browser's trading key (the wallet signs once to enable trading); none can withdraw.
- Fix: Relay re-quotes (deposits and withdrawals) no longer refuse a minimum that drifted by a few millionths; they go
  ahead within 0.5% of the reviewed minimum and refuse anything lower (`RELAY_REQUOTE_TOLERANCE_BPS`). The withdrawal e2e
  caught it against Relay's live API.
- Checked: `apps/web/tests/hl-risk.mainnet.test.ts` (exact TP/SL checks and P&L, trigger orders, limit orders, partial
  closes, margin math, open orders, each flow), and `apps/web/e2e/hyperliquid-risk.e2e.cjs` (23 checks in the browser:
  market long with TP/SL, TP/SL on the position and under Orders, replacing the TP, adding margin, closing half, a resting
  limit order and its cancel, cancel all, 360 px). The other perps suites pass (35, 27, 17, 18, 18).

## What changed: withdraw from the perps account (November 17 2026)

- **Withdraw** sits next to **+ Deposit** under the perps balance on the ticket, and **Withdraw from perps** next to
  **Deposit for perps** on the Portfolio. The dialog (`apps/web/components/hyperliquid/HlWithdraw.tsx`) shows the free
  USDC (margin in open positions stays) and sends it back to the same address:
  - **Robinhood Chain** (USDG or ETH) or **Ethereum** (ETH) through Relay, with a live quote: two wallet signatures and no
    gas: Relay's nonce mapping (posted to Relay's `/authorize`, signed on the wallet's current chain), then a transfer of
    exactly the amount, with that nonce, to Relay's Hyperliquid address (`RELAY_HL_DEPOSIT_ADDRESS`, pinned after checking
    Relay's quotes and Hyperliquid's public ledger). Velum signs only messages it builds from a fully checked quote
    (`validateWithdrawQuote` in `apps/web/lib/hyperliquid/withdraw.ts`) and re-quotes before signing, refusing a lower
    minimum than the one reviewed. Relay quoted from 1 USDC at about $0.03.
  - **Arbitrum** (USDC): the exchange's own withdrawal (`withdraw3`), signed by the wallet; the exchange keeps 1 USDC and
    it arrives within about 5 minutes (minimum 2 USDC).
  - Standard accounts first move what the main balance lacks out of the stock perps balance, signed by the browser's
    agent (which can only move money between the user's own balances, never out).
- The review dialogs now say what the wallet really signs (deposits and withdrawals had the trading line before), and a
  failed deposit or withdrawal is no longer toasted as "Trade not completed".
- The e2e mock wallet now refuses typed data whose domain names another chain, as MetaMask does.
- Checked: `apps/web/tests/withdraw.mainnet.test.ts` (two real Relay quotes accepted; 22 kinds of tampering refused; the
  authorization signed on chain 4663; one transfer with Relay's nonce, never twice; the re-quote guard; refunds; the
  Arbitrum withdrawal), `apps/web/e2e/hl-withdraw-sig.mjs` (the transfer and `withdraw3` signatures recovered by the
  live exchange for an empty throwaway key) and `apps/web/e2e/hyperliquid-withdraw.e2e.cjs` (27 checks in the browser:
  Relay's real quotes and real `/authorize` accepting Velum's signature, the agent's move, the exact transfer, Ethereum,
  Arbitrum, no gas, the venue named only in the review, 360 px). The other perps suites still pass (35, 17, 18, 18).

## What changed: "Perps are open" ad (November 17 2026)

- `design/marketing/video/velum-perps-are-open-1080p.mp4` (0:44, 1080p, with music; poster
  `velum-perps-are-open-poster.jpg`) and its post copy `design/marketing/perps-ad-copy.md` (English and Indonesian, each
  within X's 280). Intro ("PERPS are open."), a hook ("Go long. Go short. Up to 5×"), the product in a moving window
  with a caption per shot (live order book, deposit from Robinhood Chain or Ethereum, 5× long, open, P&L, close), four
  feature tiles, outro with velumtrade.com, @velumtrade and the risk and independence notice. The venue is not named
  anywhere in it.
- Footage: `record-perps.cjs` records the real mainnet web build with a throwaway wallet on a Robinhood Chain fork,
  trading against a model of the user's perps account (nothing is sent to the exchange); the order book and mids are
  live, the price rise is illustrative and labelled so. It also records when each order review opens, and the edit
  refuses any shot that would show one.
- Edit: `ad-perps.html` (all scenes, 120 BPM, every cut on a beat) rendered frame by frame by `edit-ad.cjs`
  (`VIDEO_DIR=<out> OUT_FILE=<mp4> MUSIC=<wav>`; `STILLS=` for layout checks, `FROM`/`TO` for chunks). Music: an
  original track synthesized by `music-perps.py` (no samples), hits laid on the edit's timeline.

## What changed: perps order book, neutral perps wording (November 17 2026)

- In Perps mode the trade page shows an **Order book** beside the chart (`apps/web/components/hyperliquid/HlOrderBook.tsx`):
  the market's live book read from Hyperliquid's public `l2Book` every 1.5 s (`useHlBook` in
  `apps/web/lib/hyperliquid/book.ts`), 12 levels per side, cumulative size in USD with depth bars, spread and mid price.
  Under 1180 px wide it goes below the chart. Spot mode is unchanged.
- The venue name is gone from labels, tags, buttons, the banner, balances and error messages ("Perps account",
  "Open long", "Exchange fee only", "Send X to your perps account through Relay"). It stays only where it is a
  disclosure: the **Venue** row of the confirmation dialogs (the wallet's signature prompt names it anyway) and the
  footer and FAQ.
- Checked: `apps/web/tests/hl-book.mainnet.test.ts` (book shaping, spread, cumulative totals), the updated flow and copy
  tests (400 web tests), and the browser e2e suites on forks: perps 35, Relay 17, Relay from Ethereum 18, Arbitrum
  deposit 18. The perps e2e checks the book (12 asks, 12 bids, best ask above best bid, 268 px beside the chart) and that
  no visible app text names the venue.

## What changed: perps deposits from Ethereum (November 17 2026)

- The Deposit dialog now offers three sources: **Robinhood Chain** (ETH or USDG), **Ethereum** (ETH from Ethereum
  mainnet) and **Arbitrum** (USDC). Ethereum goes through Relay like Robinhood Chain, to the same pinned depository: the
  wallet switches to Ethereum for the one deposit and back to Robinhood Chain after; the balance and receipt are read
  from Ethereum (`l1` in `apps/web/lib/ethereumEth.ts`); 0.001 ETH stays for Ethereum gas. Quotes are validated for the
  chosen chain (a quote for another chain, or USDG from Ethereum, is refused).
- Checked: `apps/web/tests/relay.mainnet.test.ts` (a real Ethereum quote accepted; cross-chain mix-ups refused; the
  switch, deposit and switch back) and `apps/web/e2e/hyperliquid-relay-ethereum.e2e.cjs` (forks of Ethereum and
  Robinhood Chain, Relay's live quote API and real depository: exactly 0.02 ETH in one transaction on Ethereum, the
  wallet back on Robinhood Chain, the perps ticket funded; 18 checks).

## What changed: Markets rows open the market (November 17 2026)

- On the Markets page a live market's whole row opens its Trade page (the market name is the keyboard link), and
  **Buy** is a solid button next to **Long or short** (it used to be grey text and looked disabled).

## What changed: perps funded from Robinhood Chain (November 17 2026)

- **Deposit to Hyperliquid with ETH or USDG from Robinhood Chain**, the Deposit dialog's new default ("From Robinhood
  Chain"; "From Arbitrum" keeps the USDC route): a live quote from Relay (relay.link) shows what Hyperliquid receives,
  the minimum Relay guarantees, fees and route; one transaction from the wallet (plus an exact approval for USDG), and
  the USDC lands at the same address on Hyperliquid within about a minute. Wallets that hold nothing on Arbitrum can now
  fund perps and trade. `apps/web/lib/hyperliquid/relay.ts`, constants in `packages/config/src/hyperliquid.ts`.
- Every quote is checked before the wallet is asked (sender and recipient are the user, output is Hyperliquid perps
  USDC, only an exact approval and one deposit to Relay's pinned depository with exactly the amount); the deposit is
  re-quoted when it runs and refused below the reviewed minimum; never sent twice. CSP: `api.relay.link` on mainnet.
- Checked: `apps/web/tests/relay.mainnet.test.ts` (real quotes recorded on 2026-11-17 accepted, tampered ones refused,
  the flow) and `apps/web/e2e/hyperliquid-relay.e2e.cjs` (Relay's live quote API and real depository on a Robinhood
  Chain fork: exactly 0.02 ETH to the depository in one transaction, the perps ticket funded and ready to trade).

## What changed: VELUM token CA on the site (November 17 2026)

- The landing page's "CA" pill (hero and footer) shows the VELUM token,
  `0xa9721E7ee2C84fa60c772a82B5021485a0d2C5Ec` on Robinhood Chain mainnet (owner-provided; verified on chain: contract
  code, name and symbol "VELUM", 18 decimals, 1,000,000,000 supply). It is the default in `apps/web/lib/token-ca.ts`, so
  no `.env` change is needed; a correctly checksummed `NEXT_PUBLIC_TOKEN_CA` still overrides it. Copy gives the full
  checksummed address; the link opens it on the Robinhood Chain explorer.
- `design/marketing/token-live-tweets.md` now carries `$VELUM` and the real CA (no venue named: no Uniswap v3 pool yet).

## What changed: Telegram on the site (November 17 2026)

- Velum's Telegram (`https://t.me/velumtrade`, `SOCIAL.tg` in `apps/web/lib/copy.ts`) next to X everywhere X appears:
  a Telegram button in the top navigation of every page (on phones in the app it stays in the brand line, like X),
  "Join on Telegram" in the landing page's closing call to action, and in the footer. The mark is Simple Icons'
  `telegram.svg`, inline.

## What changed: Portfolio on the landing page, video copy (November 17 2026)

- **Landing page Portfolio** (mainnet without Velum contracts): a "Portfolio" link in the landing navigation and a
  `#portfolio` section (`apps/web/components/landing/Portfolio.tsx`). Not connected: what the Portfolio does and a
  "Connect wallet to see yours" button (no sample balances). Connected: the live preview (wallet value, Stock P&L, the
  holdings with value, P&L and Sell, links to Buy and the full Portfolio), loaded on demand so the landing page stays
  light. It shares one hook with the app's Portfolio page (`usePortfolioData` in
  `apps/web/components/views/LivePortfolio.tsx`), so both show the same numbers.
- **Video copy** (`design/marketing/how-to-buy-video-copy.md`): X posts with the video (English and Indonesian), a
  six-post thread, Reels/TikTok/Shorts captions, YouTube titles and a description with chapters, alt text, the
  on-screen text and posting tips. `check-x-posts.cjs` now counts bare domains (velumtrade.com) as 23-character links.
- **Professional threads** (`design/marketing/threads-professional.md`): six ready-to-post threads (Introducing Velum,
  How to buy, Portfolio, Security and custody, Stock perps, Private accounts next) plus Indonesian versions of the first
  two; 49 posts, each within X's 280 characters (so they also fit Threads), facts checked against the code.

## What changed: "How to buy stocks on Velum" video (November 17 2026)

- `design/marketing/video/velum-how-to-buy-1080p.mp4` (1:46, 1080p, with music; poster `velum-how-to-buy-poster.jpg`):
  title, the four steps, then the real app on a mainnet fork with a test wallet: velumtrade.com, Launch app, connect
  (no signature), pick NVDA, Spot, pay with ETH (order value and "You get" in dollars), review and confirm, the
  Portfolio (NVDA with its value and P&L, the account card's Stock P&L, the buy in the wallet activity), Sell from the
  Portfolio (the ticket opens with the whole balance) and the sale in the activity; outro with velumtrade.com and
  @velumtrade. Captions say it is a product demo in a test environment.
- Rebuild: `record-howto.cjs` (fork, chain-1 anvil, local API and the mainnet web build; see its header), then
  `VIDEO_DIR=<out> SCENES=scenes-howto.html ORDER=intro,steps,ui,outro OUT_FILE=<file> node design/marketing/video/edit.cjs`
  (`edit.cjs` now takes the scene file and order, defaulting to the introduction video's).
- Music: an original track synthesized by `design/marketing/video/music-howto.py` (no samples or third-party audio, so
  no licence to clear; 100 BPM, F-C-G-Am, laid out on the video's timeline: pad over the titles, the beat enters with
  the app, claps from the Portfolio, a bell on the outro). Add it with `MUSIC=<wav>` on `edit.cjs` (-16 LUFS).

## What changed: Portfolio P&L, Sell button, USDG logo (November 17 2026)

- **P&L per Stock Token** under its value in the Portfolio, and a **Stock P&L** line on the account card
  (`apps/web/lib/costBasis.ts`, average cost from the wallet's own trades read from the chain): a buy with USDG costs
  the USDG paid; a buy with ETH costs the USDG the ETH became inside the swap (read from the receipt,
  `usdgFromEthLeg`); sells realize P&L at the average cost; swaps carry cost over; sends remove it. Tokens without a
  known cost (a transfer in, bought before the ~12-day activity window, or more held than the trades explain) show
  "P&L —", never a guess. The activity read is now rate-limited (4 requests at a time) for the public RPC.
- **Sell** on each Stock Token row: opens the trade page's Spot ticket on Sell with the whole balance filled in.
- **USDG logo**: the Global Dollar "G" mark (from the SmolDapp token assets, same as Trust Wallet's), inline.
- Phone layout: on narrow screens the amount moves under the token name, so value, P&L and Sell fit at 360 px.
- Checked: `apps/web/tests/cost-basis.mainnet.test.ts`, and on a mainnet fork in the browser
  (`apps/web/e2e/uniswap-eth-browser.e2e.cjs`: buy TSLA with ETH, P&L shown, Sell from the Portfolio sells the whole
  balance, the sale appears in the activity).

## What changed: ETH on Ethereum (ERC20) in the Portfolio (November 17 2026)

- The mainnet Portfolio now also tracks the wallet's **ETH on Ethereum mainnet** (the "ERC20" network, same address):
  its own row ("ETH on Ethereum (ERC20)") next to "ETH on Robinhood Chain", an "ETH (Ethereum)" line on both account
  cards, and it is added to the wallet value (Portfolio and wallet button), at the live ETH price.
- Read from the browser through PublicNode's free public RPC (`packages/config/src/ethereum.ts`; balance only, no key),
  which must answer chain 1 first (`apps/web/lib/ethereumEth.ts`). If it cannot be read, the row says so and the total
  is Robinhood Chain only, with a note saying Ethereum is left out (`fullTotal` in `apps/web/lib/walletValue.ts`).
- The site's Content-Security-Policy allows `https://ethereum-rpc.publicnode.com` on mainnet (`deploy/lib/common.sh`):
  run `deploy/deploy.sh` to apply it.
- Checked: `apps/web/tests/ethereum-eth.mainnet.test.ts` and `apps/web/e2e/ethereum-eth-browser.e2e.cjs` (a local chain-1
  anvil answers in place of the public RPC: the row, the totals on every card, and the unreachable / wrong-chain cases).

## What changed: token logos, Robinhood Chain ETH and WETH (November 17 2026)

- **Logos** for ETH (Ethereum glyph from Simple Icons on the usual ETH blue), WETH and USDG (a dollar monogram; Paxos'
  mark is not in Simple Icons), next to the Stock Token logos (`apps/web/lib/logos.ts`).
- The Portfolio's ETH row now says **"ETH on Robinhood Chain"** (it is the chain's own ETH, the gas token), and the
  account card says "ETH (Robinhood Chain)".
- **WETH on Robinhood Chain** is read with the other balances (`WETH_TOKEN` in `apps/web/lib/balances.ts`), valued at the
  live ETH price, counted in the wallet value, listed in Your assets when held, and its transfers are part of the wallet
  activity.

## What changed: mainnet is real only, with dollar values (November 17 2026)

On mainnet without Velum's own contracts (`WALLET_ONLY` in `apps/web/lib/onchain/deployment.ts`) nothing is simulated:

- **Dollar values everywhere**: a live ETH price, read every 20 s from the WETH/USDG 0.01% pool
  (`apps/web/lib/uniswap/ethPrice.ts`, unknown once older than three minutes, never a demo price). The Spot ticket
  shows the wallet's value, "Order value", "You get ≈ $" and the price in dollars, for USDG and for Pay with ETH; the
  review shows "You pay 0.05 ETH (≈ $91.40)". ETH counts in the account card, the wallet button and the Portfolio
  (`apps/web/lib/walletValue.ts`).
- **Real Portfolio** (`apps/web/components/views/LivePortfolio.tsx`): wallet value at live prices, the wallet's assets
  (ETH, USDG, Stock Tokens; a token bought anywhere shows up), the Hyperliquid perps balance, open positions and fills,
  and **wallet activity read from the chain** (`apps/web/lib/walletActivity.ts`: USDG and Stock Token transfers into and
  out of the wallet over the last ~12 days, grouped per transaction into bought / sold / swapped / sent / received; a
  buy paid with ETH is recognised from the transaction; each line links to the explorer). No practice balance, private
  address, Shield/Unshield or demo history.
- **Connect without a signature**: the wallet is the account; the demo "Sign message" step is gone on mainnet.
- **Earn and Makers** need Velum's own contracts: hidden from the navigation, and their pages say so.
- Wording: "private accounts are in development" instead of "simulated" (banner, landing, FAQ, footer).
- Checked: unit tests (`apps/web/tests/live-wallet.mainnet.test.ts`), and on a mainnet fork in the browser
  (`apps/web/e2e/uniswap-eth-browser.e2e.cjs`: dollar values, a real ETH buy, then the Portfolio showing the TSLA and
  the trade "Bought 0.2411 TSLA, Paid 0.050000 ETH"; the USDG spot, perps and deposit suites pass with the new connect).

## What changed: buy Stock Tokens with ETH (mainnet, November 17 2026)

- **Pay with ETH** on the Spot ticket's Buy side, next to Pay with USDG: the wallet's ETH becomes USDG, then the Stock
  Token, in one Uniswap transaction with no approval (`apps/web/lib/uniswap`: `encodeEthBuy` = WRAP_ETH, then a v3
  exact-input swap WETH -> USDG -> stock paid by the router; `quoteEthBuy` quotes the whole path on QuoterV2 for each of
  the market's v3 pools; `uniEthBuyFlow`). The ETH leg is one vetted pool, WETH/USDG 0.01%
  (`packages/config/uniswap-mainnet.json` `ethLeg`: about 4,941 WETH and 1.48M USDG, better quotes than every other ETH
  pool read the same day); every market has a v3 pool for the second hop. Max keeps 0.0005 ETH for gas.
- Rehearsed on a mainnet fork against the deployed router, pools and tokens: `apps/web/e2e/uniswap-eth-fork.e2e.ts`
  (all 10 markets: exactly the quoted tokens for 0.05 ETH, exactly 0.05 ETH plus gas spent, a minimum one unit above
  the quote refused) and `apps/web/e2e/uniswap-eth-browser.e2e.cjs` (the ticket, review and receipt in the browser).

## What changed: Velum on X, marketing kit (November 16 2026)

- **X on the site**: an X button (`@velumtrade`) in the top navigation of every page (on phones in the app it stays
  in the brand line under the page, so the nav keeps room for the wallet button) and a "Follow @velumtrade" button
  in the landing page's closing call to action. The footer link and the link metadata were already there.
- **Marketing** (`design/marketing/`): "How Velum works" banners (16:9 post, 4:5 portrait, X header) rendered from
  `banners.html`, the copy deck (`how-velum-works-copy.md`) and ready-to-post X posts (`x-posts.md`: pinned post,
  launch thread, daily posts, reply templates, a two-week schedule, English and Bahasa Indonesia), each checked
  against X's 280-character count by `check-x-posts.cjs`.
  A professional-tone set (`banners-pro.html`, `how-it-works-professional.md`) and an article, "Introducing Velum"
  (`article-introducing-velum.md`, English and Bahasa Indonesia), with premium covers (`article-cover.html`: 5:2 for
  X Articles, 16:9 for Medium, blogs and link previews). `node design/marketing/render-banners.cjs` renders them all.
- **Introduction video** (`design/marketing/video/velum-introduction-1080p.mp4`, 2:02, 1080p, no audio): logo intro,
  then the real app with a test wallet: connect, buy and sell TSLA (real Uniswap swaps on a local mainnet fork),
  a 3x long on the Hyperliquid perps ticket, P&L moving and a close in profit (the Hyperliquid account and its price
  move are a labelled, illustrative model), the privacy layer as "in development", and an outro with the disclaimer.
  Rebuild: `record-demo.cjs` (needs the mainnet web build, a fork and a local API, see its header), then `edit.cjs`.

## What changed: real perps through Hyperliquid (mainnet, November 16 2026)

- **Why**: the owner wants real perps without putting up Velum's own capital or liquidity ("ok hyperliquid aja").
  Hyperliquid's XYZ market (trade.xyz, a HIP-3 dex) lists stock perps for every Velum market, with its own order
  book and free public API. Velum routes orders there from each user's **own** Hyperliquid account: Velum never
  holds funds, has no counterparty risk and needs no capital.
- **Markets** (`packages/config/src/hyperliquid.ts`): the ten Velum symbols pinned to their index in the xyz
  universe (asset id = 100000 + 10000 x dex index 1 + index, e.g. TSLA 110001), re-checked against the live market
  list before any order (a moved, renamed or delisted market is refused).
- **Web** (`apps/web/lib/hyperliquid`, `components/hyperliquid`, mainnet builds; `NEXT_PUBLIC_HL_PERPS=off` keeps the
  simulated ticket): the Perps ticket shows the user's Hyperliquid balance, size in USD, whole-number leverage 1 to
  5x, isolated margin, the slippage limit, the exact position size, margin and an estimated liquidation price.
  The order is an immediate-or-cancel limit order at the mid price moved by the slippage setting (Hyperliquid's
  tick and lot rules), so a fast market cancels it instead of filling worse. The positions card and Portfolio show
  the real positions (Close = a reduce-only order for the whole size) and the Activity tab the real fills.
- **Signing**: the user's wallet signs once per 30 days (EIP-712, no gas) to approve an agent key that this
  browser generates and keeps in localStorage; the agent signs orders, leverage changes and moves between the
  user's own Hyperliquid balances. Hyperliquid does not let an agent withdraw or transfer funds out, and the key
  never reaches Velum's server (CLAUDE.md §1.6). A Velum builder fee is optional and off by default
  (`NEXT_PUBLIC_HL_BUILDER_ADDRESS` / `NEXT_PUBLIC_HL_BUILDER_FEE`; with a fee set, each wallet approves it once).
- **Deposits inside Velum** (`apps/web/lib/hyperliquid/deposit.ts`, November 16): "Deposit USDC" in the ticket,
  the positions card and "+ Deposit" next to the balance open Velum's own dialog. The user's wallet switches to
  Arbitrum, sends native USDC to Hyperliquid's bridge (credited to the same address in under a minute; at least 5 USDC,
  since less is lost; balance and gas checked first; never sent twice on retry), Velum waits for the credit and switches
  the wallet back to Robinhood Chain. Rehearsed against the real USDC contract and bridge on an Arbitrum fork
  (`apps/web/e2e/hyperliquid-deposit.e2e.cjs`: 18 checks, exact balances on the fork). The USDC itself must already
  be on Arbitrum.
- **Metrics**: Mark, Funding / h and Open interest now default to the same Hyperliquid markets (`PERPS_REF=hyperliquid`;
  `lighter` keeps the Lighter reference).
- **Checked**: unit tests for the order math, agent storage, account reads (trimmed real answers) and every flow
  step; `apps/web/e2e/hyperliquid-live.e2e.ts` sends refused requests signed by throwaway keys to the live API and
  confirms Hyperliquid recovers exactly the expected agent and user addresses (order, leverage, transfer,
  approval on chain 0x1237); `apps/web/e2e/hyperliquid-browser.e2e.cjs` runs the mainnet build in a browser with a
  test wallet against a model of the API (open, close, a cancelled order and retry, no deposit, 360 px), verifying
  every signature and payload. A real fill with real money has not been run: the owner's first small trade is
  the final check.
- **CSP**: `deploy/lib/common.sh` adds `https://api.hyperliquid.xyz` and `https://arb1.arbitrum.io` (deposits) to `connect-src` on mainnet.
- **Account card (mainnet)**: the trade page's right column shows the wallet's real balances (USDG, Stock Tokens at the
  live price, ETH for gas) and the Hyperliquid USDC and open positions, instead of the simulated private account; the
  private account is named only as in development.

## What changed: live 24/7 prices and real spot through Uniswap (mainnet, November 2026)

- **Why**: the official Robinhood quote is 24/5 and freezes while the US session is closed, so weekend charts were
  flat lines marked "closed". Stock Tokens trade on Uniswap on Robinhood Chain around the clock (Uniswap holds
  nearly all of their DEX liquidity), so that is now the price and the chart on mainnet.
- **Curated pools** (`packages/config/uniswap-mainnet.json`, typed by `packages/config/src/uniswap.ts`): 2 to 4 pools
  per market (Uniswap v3 and v4, hookless, fee at most 1%), each checked on chain and quoted both ways on
  2026-11-15. The chain also holds hundreds of look-alike pools with fees up to 99% or hooks: never used.
- **Workers** (`PRICE_SOURCE=uniswap`): the price is the deepest chart pool's current price (one multicall per tick,
  block-time dated, jump-guarded). Candles are real swaps (`jobs/dex-candles.ts`): every swap's post-trade price in
  the bucket of its block time, exact to the second; history builds newest first from the chain and resumes from
  checkpoints. Live check against mainnet: `apps/workers/e2e/dex/live-dex.e2e.ts` (rebuilds history into a
  scratch database and compares every recent bucket with an independent per-swap derivation). A first start shows
  the last weeks within minutes; the full history (several million swaps) takes an hour or more on the public RPC.
- **API**: a `uniswap` price is live on weekends and holidays (`marketOpen: true`, never `marketClosed`/`quoteFrozen`).
- **Web**: the Spot ticket and the swap page trade for real from the wallet through the Uniswap Universal Router
  (`apps/web/lib/uniswap`): on-chain quote from the best curated pool, exact ERC-20 approval to Permit2, exact
  30-minute Permit2 allowance, swap with the slippage minimum and a deadline, receipt checked from Transfer
  events. Stock to stock is two swaps through USDG. Public onchain, no Velum fee, a confirmation box before
  anything is signed. Rehearsed against the deployed contracts with real tokens on a mainnet fork
  (`apps/web/e2e/uniswap-fork.e2e.ts`: v3 and v4, both token orders, buy and sell, exact amounts, slippage
  reverts; `apps/web/e2e/uniswap-browser.e2e.cjs`: the mainnet web build with a test wallet buys, sells and swaps
  stock to stock, every amount checked on chain). Perps, shield/unshield, liquidity and maker offers stay simulated, and the banner says so.
- **Perps metrics** (November 16): Mark, Funding / h and Open interest on mainnet are each market's live perp on
  Lighter, the perps venue of Robinhood Chain (public API, no key; `apps/workers/src/jobs/perp-ref.ts`), labelled
  "Lighter" as a market reference until Velum's own perps are live. NFLX has none. The 24h change with Uniswap prices
  now comes from the candles per market (a market without a day of history no longer zeroes the others), and the
  mainnet copy says plainly that spot is real and perps are simulated.
- **Deploy**: `deploy/set-network.sh mainnet` now sets `PRICE_SOURCE=uniswap` (`PRICE_SOURCE_MAINNET=robinhood`
  keeps the official quotes). A provider `RPC_URL` makes the first history build much faster.

## What changed in Phase 2

- **Real prices** (`PRICE_SOURCE=robinhood`): official quotes from api.robinhood.com/rhj/prices
  (documented at docs.robinhood.com/chain/stock-token-apis). The price is the midpoint of the token's
  bid and ask. The documented `bid`/`ask` are the raw underlying-equity quote; Velum reads the
  undocumented `tokenBid`/`tokenAsk` (equal to `bid`/`ask` × `currentMultiplier`, which includes
  corporate actions) and, when a quote lacks them, computes `bid`/`ask` × `currentMultiplier` from
  api.robinhood.com/rhj/assets itself. Each quote must name the exact mainnet token address. A quote
  that stops changing (weekends, US holidays, an early close) is not shown as live: snapshots carry the
  quote time, and the API marks the market stale (`marketClosed` from a 24/5 session calendar, or
  `quoteFrozen` after 15 minutes without a change). Switching between simulated and real prices clears
  stored history once, so charts never mix the two; mainnet refuses simulated prices. On mainnet,
  protocol metrics (open interest, funding, pool size, APR, proofs) are null in the API and show "—"
  until contracts exist.
- **Testnet or mainnet** (`VELUM_NETWORK`). Mainnet constants in `packages/config/robinhood-mainnet.json`
  come from docs.robinhood.com and Robinhood's own asset list (api.robinhood.com/rhj/assets), and
  each was checked on-chain. On mainnet all 10 markets exist. Every sentence that says "testnet"
  switches to wording that is true there, and receipts add "Simulated, nothing was sent onchain".
- **Verified chain constants** (`packages/config/robinhood-testnet.json`). Chain ID 46630, RPC and
  explorer match docs.robinhood.com and the RPC itself. All six token contracts were checked on-chain:
  USDG has 6 decimals, Stock Tokens have 18. Multicall3 is deployed. Chainlink feed addresses are not verified yet, so
  `PRICE_SOURCE=demo` stays the default.
- **Web**: every prototype route ported with its CSS verbatim, giving the same layout at 1440, 1024 and 390 px. The only
  visible additions are the demo banner and "Coming soon" on NVDA, AAPL, META, MSFT and COIN, which have
  no testnet token. Lighthouse scores are a target (CLAUDE.md §6), not a measured claim here.
- **Wallet**: every installed wallet listed by name and icon (EIP-6963: MetaMask, Rabby, Phantom, …),
  plus WalletConnect when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set,
  plus the Coinbase/passkey connector. Wrong networks prompt a switch. Public balances come from the chain
  through Multicall3. Third-party wallet SDKs load only when chosen and with telemetry off: the browser
  talks to Velum's API and the configured network's RPC, plus the chosen wallet SDK's own services
  (WalletConnect relay, Coinbase Wallet) once the user picks one.
- **Private account (demo)**: one signature is hashed in the browser into a `velum1…` address. The
  signature is never stored or sent. Private balances, positions, offers and LP are a demo ledger kept
  per wallet in `localStorage`, using the prototype's flows, receipts and toasts and the fixed-point
  formulas in `@velum/math`. New wallets start with 12,500 USDG, 4 TSLA and 10 AMZN (AMZN replaces the
  prototype's NVDA, which is not on testnet).
- **API**: per docs/03-api.md. Money is returned as strings, quotes are rounded down to 4 significant
  figures, rate limits live in Redis, there is one error format, and the API holds no per-user state or keys.
- **Workers**: demo, Robinhood or Chainlink price source, Redis snapshots with a last-hour sparkline,
  PriceTick rows, 15m/1h/4h/1D candles tagged with their price source, demo backfill and tick pruning.
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
- **Deploy and backend, second audit round (R2)**: the web runs as its own `velum-web` user with its own
  PM2 daemon and a root-rendered `web.env` (no secrets); root never writes through paths another user
  controls; the upgrade from the old in-place layout is a fresh root-owned clone (`/srv/velum`) with a
  checked `.env` import instead of repairing `/opt/velum`; re-running setup keeps Certbot's HTTPS
  (template versions, `certbot install` before any reload, explicit certificate names, `--expand`);
  the first release over the old layout restores the old apps automatically if it fails; health checks
  cover the workers (liveness heartbeat, `workers` in `/v1/health`) and apps that crash after start;
  the CSP lists exactly the hosts the installed wallet SDKs use (WalletConnect only with a project ID);
  the API trusts client addresses only from Nginx (`PROXY_SECRET`); URL redaction never prints any part
  of a password; a candle retry after a worker restart no longer moves the close back.
- **Deploy, third audit round (R3)**: every switch from root to an app user starts in a new session
  without root's terminal (no keystroke injection through TIOCSTI) and its output reaches the terminal
  without control characters (`deploy/as-user.sh` for operators); the PM2 daemons run under their systemd
  units; the pm2-logrotate module is replaced by root-owned logrotate rules run as each user, and each
  user has a private `TMPDIR`; the API listens on a unix socket only Nginx can reach, so no local user can
  catch the proxy secret; `--rollback` and failed releases never mix two networks (each release records
  the settings it was built with; `set-network.sh` puts `.env` back on failure); the database backup runs
  as Velum's own role (`deploy/backup-db.sh`); docs/05 adds a "Compromise suspected" path (new users first,
  then rotation), and the users a base runs as are recorded in `.velum-users`.

- **Full backend audit (November 2026)**: prices frozen over a weekend are no longer reported as live
  (quote time in snapshots, `marketOpen`, `quoteAge` and `staleReason` in `/v1/markets`); everything
  read back from Redis is validated and a queued candle job is never trusted (its tick is read back
  from Postgres), so another tenant of a shared Redis cannot plant prices or candles, and
  `deploy/redis-velum.sh` gives Velum a Redis of its own; the workers wait for Postgres and Redis at
  boot instead of exiting (PM2 backoff, systemd ordering); candles dated in the future are dropped;
  IPv6 clients are rate limited per /64; `API_SOCKET` requires `PROXY_SECRET`; a Redis outage degrades
  the API (stale last-known prices, in-memory rate limits) instead of failing it; `/v1/markets` is
  cached for a second and has its own budget; secret values are redacted from logs; demo numbers carry
  `"demo": true` on testnet and are null on mainnet; `/v1/health` checks the RPC's chain id and always
  reports `demoMode: true`; the workers no longer receive a hot key in Phase 2.

- **On-chain audit M-2 (November 2026): the signer runs as its own user.** The price relayer and the keeper, the only
  code holding hot keys, moved out of `velum-workers` (same user as the internet-facing API) into `velum-signer`, a
  separate process and Unix user in no other group, with its own PM2 daemon and unit, its own private home, and its
  own build of each release (the signer user builds the commit itself; it never runs a file the app user wrote). The
  keys moved out of `.env` into `/etc/velum/signer-keys.env` (root:velum-signer 640, read by the signer at start, in no
  environment or PM2 dump); `server-setup.sh` moves existing keys once and rewrites `.env` backups and the PM2 dumps
  without them. The signer reads nothing the app user can write: prices straight from Robinhood with price-relay's
  guards, positions and cover claims straight from the chain, no Redis, no Postgres. It reports through
  `/run/velum-signer/status.json`, which `/v1/health` combines with the workers' status (`signer`,
  `onchain.signerAge`); `deploy.sh` checks it after every release that runs the signer. Upgrade a server on the
  two-user layout with docs/05, "Upgrading to the separate signer".

- **Guarded mainnet beta (prepared, November 2026; owner decision, no testnet phase).** `contracts/script/Deploy.s.sol`
  accepts Robinhood Chain mainnet only as the guarded beta: the launch guard with every cap, a dedicated price relayer
  that is neither the deployer nor the guard admin, exactly the verified mainnet token list (checked against
  `packages/config/robinhood-mainnet.json` and on chain), oracle bounds at least 5x around each token's current price,
  and two steps: a simulation that prints the full summary and writes a plan (a hash of every input, the build and the
  deployer's nonce), then a broadcast that needs that plan (at most an hour old) and a confirmation phrase naming the
  chain, the guard admin and the relayer. `deploy/deploy-contracts.sh` runs it from the VPS as root (pinned Foundry and
  solc, encrypted keystore, the relay address derived from the signer's key, every receipt and role checked), installs
  the deployment file in `/srv/velum/deployments` and sets `DEPLOYMENTS_DIR`, which the API, the indexer, the web build
  and the signer (through `signer.env`) now all honour; a release records the deployment file's hash. Rehearsal on a
  mainnet fork: `apps/workers/e2e/fork/fork-e2e.sh` (every flow, real tokens, replayed quotes, the web) and
  `fork-live.sh` (chain id 4663, the mainnet deploy path, live quotes, production processes). Runbook, ETH budget and
  risk statement: `docs/07-mainnet-guarded-beta.md`.

## Stack

Next.js 15 · React 19 · Node 22 LTS · Fastify · Prisma · PostgreSQL · Redis · BullMQ · wagmi/viem ·
PM2 · Nginx · Foundry (`contracts/`). Noir circuits arrive in Phase 4.

## Licence

Proprietary: all rights reserved (see `LICENSE`). The source is public to read, not to use. Report
vulnerabilities privately (see `SECURITY.md`).

## Disclaimer

An independent project on Robinhood Chain, not affiliated with Robinhood. The site runs on Robinhood
Chain mainnet in read-only mode (real wallet and balances, live prices, simulated trades) or on testnet.
Velum contracts are not audited. Before an external audit they go to mainnet only as a guarded beta for
allowlisted wallets with small deposit caps (docs/07-mainnet-guarded-beta.md). Test tokens have no value.
