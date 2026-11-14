# 05 — Deploy on Hostinger VPS (PM2 + Nginx)

Target: Ubuntu 22.04/24.04 VPS, 2 vCPU / 4 GB RAM minimum (8 GB once circuits are compiled
on the box). Domain A record → VPS IP. Disk: each kept release has its own `node_modules`
(hard-linked from the pnpm store) and `.next`; keep ~3 GB free for three releases.

Run every command below as root **inside tmux** (`tmux new -s velum`, reattach with
`tmux attach -t velum`). The scripts ignore SIGHUP (audit R2-L6), but without tmux a dropped SSH
session also closes the terminal they write to, and a failed write can still stop them halfway.

**Base path.** New installs and upgraded servers both use `/srv/velum`. The scripts do not depend on
the path (they work from wherever the root-owned clone is), so a server set up fresh with this layout
at `/opt/velum` keeps working there; but an *upgraded* server keeps its old `/opt/velum` untouched as
a fallback, so the new clone must go somewhere else, and one path for everyone keeps the
instructions copy-pasteable.

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
sudo -i
tmux new -s velum
git -c core.hooksPath=/dev/null -c core.fsmonitor=false clone --branch main <repo-url> /srv/velum
DOMAIN=velum.example EMAIL=you@example.com bash /srv/velum/deploy/server-setup.sh
```
Idempotent and safe on a VPS that already hosts other sites:
- runs api + workers as the `velum` system user and the web as its own `velum-web` user, each with
  its own PM2 daemon (`pm2-velum` and `pm2-velum-web` on boot);
- picks free ports (3000/4000, or the next free ones) and binds both apps to 127.0.0.1;
- installs only missing packages and never upgrades installed ones (no restart of a shared Nginx,
  Postgres or Redis); never upgrades Node or global tools, never enables ufw, never touches other
  Nginx sites;
- reuses an existing Redis as-is on a separate DB number (`REDIS_DB`, default 5). It refuses a
  shared Redis that answers without a password (`ALLOW_REDIS_WITHOUT_PASSWORD=yes` to accept the
  risk) and warns when its `maxmemory-policy` is not `noeviction` (BullMQ needs it). It sets a
  Redis password only when it installed Redis itself;
- creates its own Postgres role and database (`PG_PORT` if Postgres does not listen on 5432). The
  password reaches `psql` on stdin as a variable (never on a command line), with statement logging off.

`www.DOMAIN` always answers with a 301 to `https://DOMAIN` (HTTP and HTTPS), so the app has a
single origin: the private-account sign message is bound to the page's host, and two hosts would
give every user two different private accounts. Setup adds `www.` to the certificate when its A
record points at the server (`WWW=yes` forces it, `WWW=no` skips it).

It builds `.env` atomically (temp file with mode 600, values written by awk without sed so any
character is safe, the Redis password URL-encoded, everything read back and validated, then moved
into place). On re-runs it keeps `.env` and only generates a database password if it is empty or
`CHANGE_ME`. It generates `PROXY_SECRET` once (see "Client addresses" below), renders `web.env`,
writes the Nginx site plus two snippets, issues or re-installs HTTPS, runs the first release and
enables PM2 on boot. Check it with `runuser -u velum -- pm2 status` and
`runuser -u velum-web -- pm2 status`.

**Re-running setup never drops HTTPS** (audit R2-M1). It holds the deploy lock while it rewrites
`.env` and the Nginx files. It backs up `sites-available/velum.conf` and both snippets to
`/srv/velum/backups/nginx/` (newest 5 kept) and restores them whenever `nginx -t` or certbot fails.
What it does with the site file depends on what is there:

| Live `velum.conf` | Setup |
|---|---|
| none, or plain HTTP | writes the template, reloads, then gets a certificate (or installs the existing one) |
| managed by Certbot, current template version (`# velum-site-template: N`) | refreshes only the upstream ports; Certbot's lines stay; no reload if nothing changed |
| managed by Certbot, older template | renders the new template and runs `certbot install --cert-name <name>` **before** any reload, so Nginx goes from the old HTTPS site straight to the new HTTPS site |
| TLS lines Certbot does not manage | refuses to touch it |

The certificate is chosen explicitly: the one `certbot certificates` lists for the domain (the one the
site file references, if several). When it lacks a wanted name (`www.` added later) setup first runs
`certbot certonly --cert-name <name> --expand` while the current site keeps serving HTTPS, then
installs it. Hosts without IPv6 get the template without its `listen [::]` lines.

### Who owns what (security model)

| Path | Owner, mode | Why |
|---|---|---|
| `/srv/velum` (git clone, `deploy/`, `.git`) | `root:velum`, 751 | root runs these scripts; no other user may change them. Others may traverse (the web user reaches `web.env` and `current/`), not list |
| `/srv/velum/.env` | `root:velum 640` | root writes it, api/workers (and the build) read it; edit it as root |
| `/srv/velum/.env.bak.*` | `root:root 600`, newest 3 | written before every change (setup, `set-network.sh`, `new-key.sh`, `import-env.sh`) |
| `/srv/velum/web.env` | `root:velum-web 640` | the web's only settings (`NEXT_PUBLIC_*`, `PUBLIC_SITE_URL`, `PORT_WEB`, `NODE_ENV`), rendered from `.env` by root on every release; no secrets |
| `/srv/velum/releases/` | `root`, 751 | |
| `/srv/velum/releases/<time>-<commit>/` | `velum:velum-web`, 2750, files 644/755 | one fresh build per release by `velum`; the web user can read, not write |
| `/srv/velum/current`, `previous` | `root` symlinks → `releases/…` | `current` is switched atomically; PM2 runs every app from it; `previous` is the `--rollback` target |
| `/srv/velum/backups/` | `root`, 700 | Nginx file backups, the PM2 process list saved before a first release over an older layout |
| `/home/velum/.pm2`, `/home/velum-web/.pm2` | owner only, 700 | PM2 logs and `dump.pm2` / `dump.pm2.bak` (each app's environment), 600 |
| `/etc/nginx/snippets/velum-security-headers.conf` | `root`, 644 | security headers and CSP, regenerated on every release |
| `/etc/nginx/snippets/velum-proxy-secret.conf` | `root`, 600 | the header Nginx adds for the API (`PROXY_SECRET`); the Nginx master reads it as root |

Root never runs or reads as root anything another user can write (audit M4, R2-H1, R2-H2):
- `deploy.sh`, `server-setup.sh`, `import-env.sh`, `set-network.sh` and `new-key.sh` refuse to run unless
  the base is safe: every file root-owned and not group/other-writable, no symbolic link except
  `current`/`previous`, `.git` a real directory, and `.git/config` holding exactly what `git clone`
  writes (repository format, filemode, bare, logallrefupdates, one `remote.origin.url` of a plain
  https-without-credentials / ssh / local-path form, the standard fetch refspec, `branch.<B>.remote`
  and `.merge`). Hooks paths, fsmonitor, includes, `sshCommand`, `insteadOf`, helpers and filters are
  all refused because they are not on that list. For an SSH deploy key, use `/root/.ssh/config`;
- every git command root runs goes through one helper with `-c core.hooksPath=/dev/null
  -c core.fsmonitor=false` and no `GIT_*` variables from the caller;
- anything under a user's home, PM2 home or release directory is created, chmod'ed, written or
  deleted **as that user** (`runuser`, clean environment): PM2 homes, `dump.pm2`, release contents
  (removed by the app user, the empty directory by root), the saved PM2 list (read as `velum`,
  written by root into `backups/`; restored by writing it as `velum`). A symbolic link planted in
  those places can only redirect a write the user could do anyway. Nothing ever `chown`s a user's
  files, so `velum`'s pnpm store stays its own (audit R2-L4).

**Per-app environment** (audit M5, R2-L3). Each PM2 app gets only the variables it reads
(`deploy/ecosystem.config.cjs`): the web gets `NEXT_PUBLIC_*`, `PUBLIC_SITE_URL`, `PORT_WEB`,
`NODE_ENV` (from `web.env`); api and workers get their own lists from `.env`;
`PRICE_RELAY_PRIVATE_KEY` reaches only the workers and no other hot key reaches any Phase 2 process.
PM2 also passes the environment of the `pm2` command itself to every app (on start, and merged in on
every reload), and cluster workers inherit the PM2 daemon's own environment. PM2's `filter_env`
does not prevent that (`filter_env: true` is ignored by PM2 6.0.14, and no form filters reloads or
the daemon), so Velum does not use it. Instead `release.sh` runs `pm2` under `env -i` with only `HOME`,
`PATH`, `LANG`, `PM2_HOME` and `VELUM_PM2_SCOPE`, and restarts a daemon whose own environment holds a
secret. Verified on a test server from `/proc/<pid>/environ` (and PM2's `pm2_env` for cluster
workers): each app sees exactly its list plus those five names. Do not run `pm2 reload`/`restart`
by hand from a shell with secrets exported; always use `deploy.sh`.

**The web runs as its own user** (audit R2-M3). Next 14 is end-of-life (frontend M5), so the web is
the most exposed process. As `velum-web` it cannot read `.env` or its backups, the api/workers
`/proc/<pid>/environ`, `velum`'s PM2 home or `dump.pm2`, or the proxy-secret snippet, and it cannot
write release files. It needs no writable cache: `next start` writes nothing at runtime (checked: no
ISR or fetch cache in the app). `velum-web` is not in the `velum` group (setup refuses if it is).

**Client addresses** (audit R2-I4). Other programs on a shared server can reach the API on
127.0.0.1 and send any `X-Forwarded-For`. With `PROXY_SECRET` in `.env` (setup generates it), Nginx
adds `X-Velum-Proxy-Secret` to every `/api/` request (root-only snippet) and the API trusts
`X-Real-IP` only on requests that carry it; anything else is rate-limited by its socket address in
one shared "direct" bucket, so spoofed headers neither dodge a limit nor spend a real client's
budget. The web never proxies to the API in production (`API_PROXY_TARGET` is for local development
and not in the web's allowlist), so the web never gets the secret. `deploy.sh` refuses to deploy when
`PROXY_SECRET` is set but the Nginx site does not include the snippet. Without `PROXY_SECRET` the API
keeps trusting `X-Forwarded-For` from loopback (older `.env` files).

Residual risks, stated plainly:
- api and workers still share the `velum` uid: a compromised api can read the workers' environment
  (`PRICE_RELAY_PRIVATE_KEY`) and `.env`. Splitting them is a Phase 3 item, when real hot keys arrive.
- A compromised `velum` can change the release files the web runs (it builds them), so it can take
  over the web too; that adds nothing it does not already have.
- A compromised web can still serve the site's pages and JavaScript (deface it, phish wallet users),
  open localhost connections (Redis and Postgres need passwords it does not have) and use the API like
  any visitor. It cannot read secrets.
- Root runs only system tools on these paths (`git` with hooks off, `node` for URL parsing and
  `.env` import, `nginx`, `certbot`, `pm2 startup`). The PM2 systemd units are PM2's own template
  (`PIDFile` in the user's PM2 home; systemd refuses a PID outside the unit's cgroup).

## Releases

```bash
sudo bash /srv/velum/deploy/deploy.sh                # deploy the branch the clone is on (BRANCH=name to override)
sudo bash /srv/velum/deploy/deploy.sh --rollback     # switch back to the release that was live before
```
1. Takes a lock (`flock` on `/srv/velum/.deploy.lock`): deploys, `server-setup.sh`,
   `set-network.sh`, `new-key.sh` and `import-env.sh` never overlap; the second one stops with a
   message. Ignores SIGHUP. Checks the base (see the security model).
2. Pulls as root (hooks and fsmonitor off), then re-runs the freshly pulled `deploy.sh`.
3. Exports the commit into a new `releases/<time>-<commit>/` and, as `velum`, installs with the
   frozen lockfile, builds every app (the web build sees only `NEXT_PUBLIC_*` and
   `PUBLIC_SITE_URL`), runs `prisma migrate deploy` (only `DATABASE_URL`) and makes the files
   readable for the web user. The live release is never touched: **a failed build leaves the running
   site exactly as it was** and the half-built directory is removed.
4. First release in a base while `velum`'s PM2 still runs Velum apps from elsewhere (an older
   in-place layout): saves that process list (`pm2 save` as `velum`) and keeps a root-only copy in
   `backups/pm2-dump-before-first-release.<time>.json` (audit R2-M2).
5. Renders `web.env`, switches `current` atomically, refreshes the Nginx snippets from `.env` (the
   CSP's `connect-src` follows `NEXT_PUBLIC_RPC_URL`; WalletConnect hosts appear only with
   `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`) and reloads PM2 with zero downtime: api + workers as `velum`,
   web as `velum-web`. When the app definitions or the set of env keys changed, it does a clean
   `pm2 delete` + `start` of that user's apps instead, so a removed secret never lingers in a running
   process; an app that is not online or runs from another directory is deleted and started on its
   own while the healthy ones reload (crash-looping workers never take the API down).
6. Health check (audit R2-L5): API `/v1/health` (30 s), web root (60 s), then a workers liveness
   heartbeat written **after** the switch (`workers` in `/v1/health`, 60 s), then it watches for
   `HEALTH_SETTLE_SECONDS` (default 20): every app online in PM2 with unchanged restart counts, and
   API, web and a fresh heartbeat again. A crash-looping worker or an API that dies after PM2 said
   "online" fails the check. On failure it switches back to the previous release; on a first release
   over an older layout it restores those apps from the copy of step 4 (`pm2 resurrect` as `velum`)
   and says so.
7. Keeps the newest 3 releases (`KEEP_RELEASES`), always including the current and previous one.

Rollback switches code only: migrations are not rolled back, so keep migrations
backward-compatible (add columns first, drop them a release later).

`NEXT_PUBLIC_*` values are compiled into the web build, so run a release after changing them.

### Network: testnet or mainnet
```bash
sudo bash /srv/velum/deploy/set-network.sh mainnet   # or testnet
```
Sets `VELUM_NETWORK`, `NEXT_PUBLIC_VELUM_NETWORK`, `CHAIN_ID`, `NEXT_PUBLIC_CHAIN_ID`, `RPC_URL`,
`NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_EXPLORER_URL` and `PRICE_SOURCE` together in one atomic
rewrite (backs up `.env` first, under the deploy lock), then runs a release. Mainnet is read-only
in Phase 2: real wallet and balances, live Robinhood prices, simulated trades, and the copy says so.
No Velum contract is deployed on mainnet before the Phase 5 audit. On mainnet a market with no
price snapshot yet is served with its seed price, `stale: true` and `source: null` (docs/03); the web
shows dashes for it. The public mainnet RPC rate-limits; for real traffic put a provider URL in
`RPC_URL` / `NEXT_PUBLIC_RPC_URL` (as root) and run a release (the CSP picks the new host up).

### Hot-wallet keys
```bash
sudo bash /srv/velum/deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY
```
Generates the key with Node's CSPRNG, backs up `.env`, writes it atomically and prints only the
address (derived as `velum`). A valid existing key is kept; any other existing value (or a
duplicated line) is refused, never replaced. Run a release afterwards so the workers get it.

## Upgrading a server set up before the November 2026 hardening

Older setups `chown`ed the checkout (`/opt/velum`) to `velum`, sourced `.env` in `deploy.sh` and
built in place. Treat `velum` as possibly compromised: it could have changed anything in that tree,
including `.git` (hooks, `core.hooksPath`, `core.fsmonitor`, a symlinked `.git` or hooks
directory), so **root must never run git in it or repair it in place** (the earlier in-place
instructions were bypassable five ways, audit R2-H2). Instead make a fresh root-owned clone at
`/srv/velum`, copy only `.env` across (checked and parsed as data), and leave `/opt/velum` untouched
as the fallback. Paste the blocks below in order, as root, in tmux; nothing is switched before step 4.

```bash
# 0a. Root shell in tmux. After a dropped connection: sudo -i, then tmux attach -t velum-upgrade
#     (the variables below are still set in that shell).
sudo -i
tmux new -s velum-upgrade
```

```bash
# 0b. Inside tmux:
OLD=/opt/velum
NEW=/srv/velum
DOMAIN=velumtrade.com
EMAIL=you@example.com                          # the address you gave Certbot before
REPO_URL=https://github.com/fourtisf/velum.git # check it: never copy it from $OLD/.git/config
BRANCH=claude/new-session-93ke66              # the branch the old checkout deployed (the repo's default branch)
BK=/root/velum-upgrade-$(date -u +%Y%m%d%H%M%S)
install -d -m 700 "$BK"
```

```bash
# 1. Backups. Files in $OLD are read as velum, never opened by root.
runuser -u velum -- cat "$OLD/.env" > "$BK/old.env"; chmod 600 "$BK/old.env"
runuser -u postgres -- pg_dump -Fc velum > "$BK/velum.pgdump"
cp -a /etc/nginx/sites-available/velum.conf "$BK/nginx-velum.conf"
runuser -u velum -- env -i HOME=/home/velum PATH="$PATH" pm2 save --force
runuser -u velum -- cat /home/velum/.pm2/dump.pm2 > "$BK/dump.pm2"; chmod 600 "$BK/dump.pm2"
certbot certificates | tee "$BK/certbot-certificates.txt"
ls -l "$BK"                                    # five non-empty files
```

```bash
# 2. Fresh root-owned clone from the repository URL, never from $OLD (a local clone hard-links files
#    velum owns; the scripts refuse such a base). A private repository needs a deploy key for root in
#    /root/.ssh: make a new one, do not copy velum's.
git -c core.hooksPath=/dev/null -c core.fsmonitor=false clone --branch "$BRANCH" "$REPO_URL" "$NEW"
git -C "$NEW" log --oneline -1
```

```bash
# 3. Copy .env across. import-env.sh opens the old file as velum with O_NOFOLLOW, refuses a
#    symbolic link, a non-regular file, more than one hard link, an owner other than root/velum, more
#    than 64 KiB and any line that is not KEY=VALUE / comment / blank, then prints every key (secrets
#    masked) for review. Check the values it prints; fix them as root with: nano "$NEW/.env"
bash "$NEW/deploy/import-env.sh" "$OLD/.env"
```

```bash
# 4. Setup and first release. Creates velum-web, renders web.env and PROXY_SECRET, re-renders the
#    Certbot-managed Nginx site from the new template and re-installs your existing certificate
#    before Nginx reloads (HTTPS stays up), then builds and starts the first release from $NEW.
#    The old apps are replaced by a clean restart (a few seconds of downtime) only after the build
#    succeeded, and come back automatically (pm2 resurrect) if the release fails its health checks.
DOMAIN="$DOMAIN" EMAIL="$EMAIL" bash "$NEW/deploy/server-setup.sh"
```
It ends with `✓ Velum Phase 2 is live` (tmux keeps the output; scroll with Ctrl-b [). If it ends with "The apps that ran before it were restored
…", the old site runs again from `/opt/velum` (unchanged); read the log, fix the cause and re-run
step 4.

```bash
# 5. Verify.
runuser -u velum -- pm2 status                  # velum-api ×2 and velum-workers online
runuser -u velum-web -- pm2 status              # velum-web ×2 online
runuser -u velum -- pm2 describe velum-api | grep 'exec cwd'   # /srv/velum/current/apps/api
curl -s https://$DOMAIN/api/v1/health; echo     # "ok":true, "workers" a few seconds
curl -sI https://$DOMAIN/ | grep -iE '^(HTTP|strict-transport|content-security)'
curl -sI http://www.$DOMAIN/ | head -1          # 301
runuser -u velum-web -- cat "$NEW/.env"                     # must say: Permission denied
runuser -u velum-web -- cat /home/velum/.pm2/dump.pm2       # must say: Permission denied
systemctl is-enabled pm2-velum pm2-velum-web
```

```bash
# 6. Only if you need to go back by hand later (the release above already does this on failure):
runuser -u velum-web -- env -i HOME=/home/velum-web PATH="$PATH" pm2 delete velum-web
runuser -u velum-web -- env -i HOME=/home/velum-web PATH="$PATH" pm2 save --force
systemctl disable pm2-velum-web
runuser -u velum -- env -i HOME=/home/velum PATH="$PATH" pm2 delete velum-api velum-workers
runuser -u velum -- sh -c 'umask 077; cat > /home/velum/.pm2/dump.pm2' < "$BK/dump.pm2"
runuser -u velum -- env -i HOME=/home/velum PATH="$PATH" pm2 resurrect
cp -a "$BK/nginx-velum.conf" /etc/nginx/sites-available/velum.conf && nginx -t && systemctl reload nginx
```
Database migrations applied by the new release stay applied (they are backward-compatible). The
`$BK/velum.pgdump` restores the database if ever needed (`pg_restore --clean -d velum`).

```bash
# 7. Clean up after a few days of stable operation (rm never follows symbolic links).
rm -rf --one-file-system /opt/velum
rm -rf "$BK"                                    # or copy it off the server first
```
If you suspect `velum` was compromised, rotate its secrets afterwards: set the password in
`DATABASE_URL` to `CHANGE_ME` and re-run `server-setup.sh` (it generates a new one and updates the
role); change the Redis password with the Redis owner and update `REDIS_URL`; empty
`PRICE_RELAY_PRIVATE_KEY` and run `new-key.sh` (then fund the new address); empty `PROXY_SECRET`
and re-run `server-setup.sh`. Run a release after each.

**If an earlier in-place upgrade attempt already ran** (the old steps `chown -R root:root /opt/velum`
…): that `chown` also changed the files `velum`'s pnpm store shares with `node_modules` (hard links),
and builds then fail with `EACCES … pnpm/store` (audit R2-L4). The store's directories still belong
to `velum`, so let `velum` remove it; the next release downloads it again:
```bash
runuser -u velum -- rm -rf /home/velum/.local/share/pnpm/store
```
Then follow the steps above from step 0 (a fresh clone; do not reuse the half-repaired `/opt/velum`
as the new base).

## Manual setup (fresh, dedicated server)

The script above does all of this; the steps are here for reference. Run them as root.

### 1. Base packages
```bash
apt update
apt -y install git nginx certbot python3-certbot-nginx postgresql redis-server tmux
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt -y install nodejs
npm i -g pm2
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```

### 2. Database and Redis
```bash
P="$(openssl rand -hex 24)"
printf '\\set p %s\nCREATE ROLE velum WITH LOGIN PASSWORD :'"'"'p'"'"';\n' "$P" | runuser -u postgres -- psql -X -v ON_ERROR_STOP=1
runuser -u postgres -- psql -X -c "CREATE DATABASE velum OWNER velum;"
sed -i "s/^# *requirepass .*/requirepass $(openssl rand -hex 24)/" /etc/redis/redis.conf
systemctl restart redis-server
```
Postgres and Redis listen on localhost only (defaults). Do not open 5432/6379 in ufw. Keep Redis on
`maxmemory-policy noeviction` (the default).

### 3. Users and app
```bash
useradd --system --create-home --shell /bin/bash velum
useradd --system --create-home --user-group --shell /usr/sbin/nologin velum-web
runuser -u velum -- sh -c 'mkdir -p ~/.pm2 && chmod 700 ~/.pm2'
runuser -u velum-web -- sh -c 'mkdir -p ~/.pm2 && chmod 700 ~/.pm2'
git -c core.hooksPath=/dev/null clone --branch main <repo-url> /srv/velum
chgrp velum /srv/velum && chmod 751 /srv/velum
install -m 640 -o root -g velum /srv/velum/.env.example /srv/velum/.env
nano /srv/velum/.env                                    # fill every value (URL-encode special characters in URLs);
                                                        # PROXY_SECRET: openssl rand -hex 32
```

### 4. Nginx + SSL (before the first release: deploy.sh refreshes these snippets)
The headers and proxy-secret snippets are rendered from `.env`, which only root can read, so this
runs as root (audit R2-I5):
```bash
cd /srv/velum && . deploy/lib/common.sh
install -d /etc/nginx/snippets
render_security_headers .env > /etc/nginx/snippets/velum-security-headers.conf
(umask 077 && render_proxy_secret .env > /etc/nginx/snippets/velum-proxy-secret.conf)
sed -e "s/velum.example/$DOMAIN/g" deploy/nginx/velum.conf > /etc/nginx/sites-available/velum.conf
ln -sf /etc/nginx/sites-available/velum.conf /etc/nginx/sites-enabled/velum.conf
nginx -t && systemctl reload nginx
certbot --nginx --cert-name $DOMAIN -d $DOMAIN -d www.$DOMAIN -m $EMAIL --agree-tos --redirect -n
```
`velum.conf` redirects `www.$DOMAIN` to `https://$DOMAIN` (301), sends HSTS only over HTTPS, the
CSP and the other security headers from the snippet, the proxy secret on `/api/`, and answers
Nginx's own rate limit on `/api/` with the API's JSON error (`429 RATE_LIMITED`). On a host without
IPv6, delete its `listen [::]` lines.

### 5. First release and PM2 on boot
```bash
bash /srv/velum/deploy/deploy.sh                        # builds as velum, starts api + workers as velum, web as velum-web
pm2 startup systemd -u velum --hp /home/velum
pm2 startup systemd -u velum-web --hp /home/velum-web
```

## Operations
- Status: `runuser -u velum -- pm2 status` (api, workers) and `runuser -u velum-web -- pm2 status` (web).
- Logs: `runuser -u velum -- pm2 logs velum-api --lines 200`, `runuser -u velum-web -- pm2 logs velum-web`
  (pm2-logrotate is installed by setup for both users).
- Health: `curl https://$DOMAIN/api/v1/health` (rate limited per client: `RATE_LIMIT_HEALTH_PER_MIN`,
  default 60). `lag` = seconds since the last price tick, `workers` = seconds since the workers process
  last reported alive (a few seconds when healthy, whether or not the market has quotes).
- Releases on disk: `ls -l /srv/velum/releases /srv/velum/current`.
- Backups: nightly `runuser -u postgres -- pg_dump -Fc velum > /var/backups/velum-$(date +%F).pgdump`
  (cron), keep 14 days, copy off-box.
- Relayer hot wallet: keep a small ETH balance, alert below threshold.
- Updates: `sudo unattended-upgrades` enabled.
