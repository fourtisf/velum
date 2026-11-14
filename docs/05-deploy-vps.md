# 05 — Deploy on Hostinger VPS (PM2 + Nginx)

Target: Ubuntu 22.04/24.04 VPS, 2 vCPU / 4 GB RAM minimum (8 GB once circuits are compiled
on the box). Domain A record → VPS IP. Disk: each kept release has its own `node_modules`
(hard-linked from the pnpm store) and `.next`; keep ~3 GB free for three releases.

## Phase 1: static prototype (5 minutes)

```bash
sudo DOMAIN=velum.example EMAIL=you@example.com bash deploy/phase1-static.sh
```
Checks port 80 first and stops with a clear message if another program (often Apache) holds it.
Installs Nginx + Certbot only if they are missing (installed packages are never upgraded), copies
`prototype/index.html` to `/var/www/velum/` (root-owned, read-only for Nginx), enables
`deploy/nginx/velum-static.conf` (security headers, CSP, HSTS over HTTPS), opens the firewall only
if ufw is already on, issues HTTPS. `www.` is added only when its A record points at the server
(`WWW=yes` to force).

## Phase 2: one command

```bash
sudo git clone <repo-url> /opt/velum          # as root: the checkout must be root-owned
cd /opt/velum && sudo DOMAIN=velum.example EMAIL=you@example.com bash deploy/server-setup.sh
```
Idempotent and safe on a VPS that already hosts other sites:
- runs Velum as its own `velum` system user with its own PM2 daemon (`pm2-velum` on boot);
- picks free ports (3000/4000, or the next free ones) and binds both apps to 127.0.0.1;
- installs only missing packages and never upgrades installed ones (no restart of a shared Nginx,
  Postgres or Redis); never upgrades Node or global tools, never enables ufw, never removes other
  Nginx sites;
- reuses an existing Redis as-is on a separate DB number (`REDIS_DB`, default 5). It refuses a
  shared Redis that answers without a password (`ALLOW_REDIS_WITHOUT_PASSWORD=yes` to accept the
  risk) and warns when its `maxmemory-policy` is not `noeviction` (BullMQ needs it). It sets a
  Redis password only when it installed Redis itself;
- creates its own Postgres role and database. The password reaches `psql` on stdin as a variable
  (never on a command line), with statement logging off for that session.

`www.DOMAIN` always answers with a 301 to `https://DOMAIN` (HTTP and HTTPS), so the app has a
single origin: the private-account sign message is bound to the page's host, and two hosts would
give every user two different private accounts. Setup adds `www.` to the certificate when its A
record points at the server (`WWW=yes` forces it, `WWW=no` skips it).

It builds `.env` atomically (temp file with mode 600, values written by awk without sed so any
character is safe, the Redis password URL-encoded, everything read back and validated, then moved
into place). On re-runs it keeps `.env` and only generates a database password if it is empty or
`CHANGE_ME`. It adds `velum.conf` plus `/etc/nginx/snippets/velum-security-headers.conf` to Nginx,
issues HTTPS, runs the first release and enables PM2 on boot. Check it with
`runuser -u velum -- pm2 status`.

### Who owns what (security model)

| Path | Owner, mode | Why |
|---|---|---|
| `/opt/velum` (git checkout, `deploy/`, `.git`) | `root`, not writable by others | root runs these scripts; the app user must not be able to change them |
| `/opt/velum/.env` | `root:velum 640` | root writes it, the apps read it; edit it as root |
| `/opt/velum/releases/<time>-<commit>/` | `velum` | one fresh build per release: `node_modules`, `.next`, `dist`, `generated` |
| `/opt/velum/current`, `/opt/velum/previous` | `root` symlinks → `releases/…` | `current` is switched atomically by `deploy.sh` and PM2 runs the apps from it; `previous` is the `--rollback` target |
| `/home/velum/.pm2` | `velum`, 700 | PM2 logs and `dump.pm2` (holds the api/workers environment) |

Root never executes anything the app user can write: `deploy.sh`, `set-network.sh`, `new-key.sh`
and `server-setup.sh` refuse to run if the checkout is not root-owned. They run git as root and
everything that touches `node_modules` (install, build, migrations, PM2, viem) as `velum` with a
clean environment.

Each PM2 app gets only the variables it reads (`deploy/ecosystem.config.cjs`, `filter_env`):
the web gets `NEXT_PUBLIC_*`, `PUBLIC_SITE_URL`, `PORT_WEB`, `NODE_ENV`; the api and workers get
their own lists; `PRICE_RELAY_PRIVATE_KEY` reaches only the workers and no other hot key reaches any
Phase 2 process. `.env` is parsed as data (`KEY=VALUE`, never `source`d). Do not run
`pm2 reload`/`restart` by hand from a shell with secrets exported: PM2 merges the caller's
environment into every app on reload, and cluster workers inherit the PM2 daemon's environment.
Always use `deploy.sh`.

## Releases

```bash
sudo bash /opt/velum/deploy/deploy.sh                # deploy the branch the checkout is on (BRANCH=name to override)
sudo bash /opt/velum/deploy/deploy.sh --rollback     # switch back to the release that was live before
```
1. Takes a lock (`flock` on `/opt/velum/.deploy.lock`): two deploys, `set-network.sh` or
   `new-key.sh` never overlap; the second one stops with a message.
2. Pulls as root, then re-runs the freshly pulled `deploy.sh`.
3. Exports the commit into a new `releases/<time>-<commit>/` and, as `velum`, installs with the
   frozen lockfile, builds every app (the web build sees only `NEXT_PUBLIC_*` and
   `PUBLIC_SITE_URL`) and runs `prisma migrate deploy` (only `DATABASE_URL`). The live release is
   never touched: **a failed build leaves the running site exactly as it was** and the half-built
   directory is removed.
4. Switches `current` atomically, refreshes the Nginx headers snippet from `.env` (the CSP's
   `connect-src` follows `NEXT_PUBLIC_RPC_URL`), and reloads PM2 with zero downtime. When the app
   definitions or the set of env keys changed, it does a clean `pm2 delete` + `start` instead, so a
   removed secret never lingers in a running process.
5. Health-checks `/v1/health` and the web root. On failure it switches back to the previous release.
6. Keeps the newest 3 releases (`KEEP_RELEASES`), always including the current and previous one.

Rollback switches code only: migrations are not rolled back, so keep migrations
backward-compatible (add columns first, drop them a release later).

`NEXT_PUBLIC_*` values are compiled into the web build, so run a release after changing them.

### Network: testnet or mainnet
```bash
sudo bash /opt/velum/deploy/set-network.sh mainnet   # or testnet
```
Sets `VELUM_NETWORK`, `NEXT_PUBLIC_VELUM_NETWORK`, `CHAIN_ID`, `NEXT_PUBLIC_CHAIN_ID`, `RPC_URL`,
`NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_EXPLORER_URL` and `PRICE_SOURCE` together in one atomic
rewrite (backs up `.env` first, under the deploy lock), then runs a release. Mainnet is read-only
in Phase 2: real wallet and balances, live Robinhood prices, simulated trades, and the copy says so.
No Velum contract is deployed on mainnet before the Phase 5 audit. The public mainnet RPC
rate-limits; for real traffic put a provider URL in `RPC_URL` / `NEXT_PUBLIC_RPC_URL` (as root)
and run a release (the CSP picks the new host up).

### Hot-wallet keys
```bash
sudo bash /opt/velum/deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY
```
Generates the key with Node's CSPRNG, backs up `.env`, writes it atomically and prints only the
address. A valid existing key is kept; any other existing value (or a duplicated line) is refused,
never replaced. Run a release afterwards so the workers get it.

## Upgrading a server set up before the November 2026 hardening

Older setups `chown`ed the checkout to `velum`, sourced `.env` in `deploy.sh` and built in place.
Run once, as root (the site keeps serving until step 5 switches over):

```bash
sudo -i
cd /opt/velum
# 1. Take the checkout away from the app user (it stops being able to change what root runs).
chown -R root:root /opt/velum
chown root:velum /opt/velum/.env && chmod 640 /opt/velum/.env
chmod 750 /opt/velum && chgrp velum /opt/velum
# 2. The app user could edit .git before step 1: neutralise hooks and review the config before running git as root.
find .git/hooks -type f ! -name '*.sample' -print -delete
git config --file .git/config --list      # expect only core.*, remote.origin.*, branch.*; remove anything else
# 3. Restore every tracked file to the published version, then fetch the hardened scripts.
B="$(git rev-parse --abbrev-ref HEAD)"     # the deployed branch, usually main
git -c core.hooksPath=/dev/null -c core.fsmonitor=false fetch origin "$B"
git -c core.hooksPath=/dev/null -c core.fsmonitor=false reset --hard "origin/$B"
git -c core.fsmonitor=false status --short # untracked files listed here are not run, but review them
# 4. Re-run setup with the same DOMAIN/EMAIL: re-renders the Nginx site + headers snippet (and
#    re-installs the existing certificate), checks Redis (it now refuses a Redis without a password
#    unless ALLOW_REDIS_WITHOUT_PASSWORD=yes), re-syncs the Postgres role password, then runs the
#    first release.
DOMAIN=velum.example EMAIL=you@example.com bash deploy/server-setup.sh
# 5. The first release restarts PM2 cleanly from /opt/velum/current (new cwd and env allowlists) and
#    restarts the PM2 daemon if it still holds secrets from the old deploy.sh. Then check:
runuser -u velum -- pm2 status
# 6. Remove the old in-place build output (never `git clean -X`: it would delete .env).
rm -rf /opt/velum/node_modules /opt/velum/apps/*/node_modules /opt/velum/packages/*/node_modules \
       /opt/velum/apps/web/.next /opt/velum/apps/*/dist /opt/velum/packages/db/generated
```
If `velum` fetched the repository with its own SSH deploy key, give root the same access (copy the
key to `/root/.ssh` or set `core.sshCommand` in `/opt/velum/.git/config`) before step 3. From now on,
run `deploy.sh`, `set-network.sh` and `new-key.sh` with `sudo` (they refuse to run as `velum`).

## Manual setup (fresh, dedicated server)

The script above does all of this; the steps are here for reference.

### 1. Base packages
```bash
sudo apt update
sudo apt -y install git nginx certbot python3-certbot-nginx postgresql redis-server
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs
sudo npm i -g pm2
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw --force enable
```

### 2. Database and Redis
```bash
P="$(openssl rand -hex 24)"
printf '\\set p %s\nCREATE ROLE velum WITH LOGIN PASSWORD :'"'"'p'"'"';\n' "$P" | sudo -u postgres psql -X -v ON_ERROR_STOP=1
sudo -u postgres psql -X -c "CREATE DATABASE velum OWNER velum;"
sudo sed -i "s/^# *requirepass .*/requirepass $(openssl rand -hex 24)/" /etc/redis/redis.conf
sudo systemctl restart redis-server
```
Postgres and Redis listen on localhost only (defaults). Do not open 5432/6379 in ufw. Keep Redis on
`maxmemory-policy noeviction` (the default).

### 3. App
```bash
sudo useradd --system --create-home --shell /bin/bash velum
sudo install -d -o velum -g velum -m 700 /home/velum/.pm2
sudo git clone <repo-url> /opt/velum                     # root-owned
sudo chgrp velum /opt/velum && sudo chmod 750 /opt/velum
sudo install -m 640 -o root -g velum /opt/velum/.env.example /opt/velum/.env
sudo nano /opt/velum/.env                                # fill every value (URL-encode special characters in URLs)
sudo bash /opt/velum/deploy/deploy.sh                    # builds and starts PM2 as velum
sudo pm2 startup systemd -u velum --hp /home/velum
```

### 4. Nginx + SSL
```bash
cd /opt/velum && . deploy/lib/common.sh
sudo install -d /etc/nginx/snippets
render_security_headers .env | sudo tee /etc/nginx/snippets/velum-security-headers.conf >/dev/null
sudo cp deploy/nginx/velum.conf /etc/nginx/sites-available/velum.conf
sudo sed -i "s/velum.example/$DOMAIN/g" /etc/nginx/sites-available/velum.conf
sudo ln -sf /etc/nginx/sites-available/velum.conf /etc/nginx/sites-enabled/velum.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN -m $EMAIL --agree-tos --redirect -n
```
`velum.conf` redirects `www.$DOMAIN` to `https://$DOMAIN` (301), sends HSTS only over HTTPS, the
CSP and the other security headers from the snippet, and answers Nginx's own rate limit on `/api/`
with the API's JSON error (`429 RATE_LIMITED`).

## Operations
- Logs: `runuser -u velum -- pm2 logs velum-api --lines 200` (pm2-logrotate is installed by setup).
- Health: `curl https://$DOMAIN/api/v1/health` (rate limited per IP: `RATE_LIMIT_HEALTH_PER_MIN`, default 60).
- Releases on disk: `ls -l /opt/velum/releases /opt/velum/current`.
- Backups: nightly `pg_dump velum | gzip > /var/backups/velum-$(date +%F).sql.gz`
  (cron), keep 14 days, copy off-box.
- Relayer hot wallet: keep a small ETH balance, alert below threshold.
- Updates: `sudo unattended-upgrades` enabled.
