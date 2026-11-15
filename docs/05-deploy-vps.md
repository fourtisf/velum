# 05 — Deploy on Hostinger VPS (PM2 + Nginx)

Target: Ubuntu 22.04/24.04 VPS, 2 vCPU / 4 GB RAM minimum (8 GB once circuits are compiled
on the box). Domain A record → VPS IP. Disk: each kept release has its own `node_modules`
(hard-linked from the pnpm store) and `.next`; keep ~3 GB free for three releases.

Run every command below as root **inside tmux** (`tmux new -s velum`, reattach with
`tmux attach -t velum`). The scripts ignore SIGHUP (audit R2-L6), but without tmux a dropped SSH
session also closes the terminal they write to, and a failed write can still stop them halfway.

**Never switch to Velum's users with plain `runuser -u`, `su` or `sudo -u` from a root shell**
(audit R3-01). Those keep your session and controlling terminal, and the user's own code runs inside
nearly every command (PM2 loads modules from `~/.node_modules`, pnpm reads `~/.npmrc`, the release
files belong to `velum`): any process of that user can then push keystrokes into your root shell
(TIOCSTI; Ubuntu 22.04's kernel always allows it). Use `deploy/as-user.sh` (below); the scripts
do the same internally. Keep the scripts' output in tmux's scrollback (Ctrl-b [): what the apps' users
print is cleaned of control characters on the terminal and in pipes such as `| tee`, but written to
a file byte for byte, so read such a file with `less` or `cat -v`, never plain `cat`.

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
git -c core.hooksPath=/dev/null -c core.fsmonitor=false clone --branch claude/new-session-93ke66 https://github.com/fourtisf/velum.git /srv/velum
DOMAIN=velum.example EMAIL=you@example.com bash /srv/velum/deploy/server-setup.sh
```
(`claude/new-session-93ke66` is the repository's only branch.) Idempotent and safe on a VPS that
already hosts other sites:
- runs api + workers as the `velum` system user, the web as its own `velum-web` user and, with
  `ONCHAIN_WORKERS=true`, the price relayer and the keeper (the only code holding hot keys) as their own
  `velum-signer` user (see "The signer"), each with its own PM2 daemon running under its own systemd unit
  (`pm2-velum`, `pm2-velum-web`, `pm2-velum-signer`; written, enabled and started by `deploy.sh`, never started
  from your shell);
- the API listens on a unix socket, `/run/velum-api/api.sock`, in a directory only `velum` and
  Nginx's user can enter (recreated at boot by `/etc/tmpfiles.d/velum.conf`); the web listens on
  127.0.0.1 (3000, or the next free port);
- installs only missing packages and never upgrades installed ones (no restart of a shared Nginx,
  Postgres or Redis); never upgrades Node or global tools, never enables ufw, never touches other
  Nginx sites;
- reuses an existing Redis as-is on a separate DB number (`REDIS_DB`, default 5). It refuses a
  shared Redis that answers without a password (`ALLOW_REDIS_WITHOUT_PASSWORD=yes` to accept the
  risk) and warns when its `maxmemory-policy` is not `noeviction` (BullMQ needs it). It sets a
  Redis password only when it installed Redis itself;
- creates its own Postgres role and database (`PG_PORT` if Postgres does not listen on 5432). The
  password reaches `psql` on stdin as a variable (never on a command line), with statement logging off;
- keeps the hot keys out of `.env`: they live in `/etc/velum/signer-keys.env` (root:velum-signer 640), and a key an
  older layout left in `.env` is moved there once (see "Upgrading to the separate signer");
- rotates the three users' PM2 logs with logrotate (`/etc/logrotate.d/velum`: daily, 14 kept, as each
  user, copytruncate). It no longer installs the pm2-logrotate module (audit R3-02).

`www.DOMAIN` always answers with a 301 to `https://DOMAIN` (HTTP and HTTPS), so the app has a
single origin: the private-account sign message is bound to the page's host, and two hosts would
give every user two different private accounts. Setup adds `www.` to the certificate when its A
record points at the server (`WWW=yes` forces it, `WWW=no` skips it).

It builds `.env` atomically (temp file with mode 600, values written by awk without sed so any
character is safe, the Redis password URL-encoded, everything read back and validated, then moved
into place). On re-runs it keeps `.env` and only generates a database password if it is empty or
`CHANGE_ME`. It generates `PROXY_SECRET` once (see "Client addresses" below), sets `API_SOCKET`,
renders `web.env` and `signer.env`, writes the Nginx site plus three snippets, issues or re-installs HTTPS, records
the users in `/srv/velum/.velum-users` and runs the first release. Check it with
`bash /srv/velum/deploy/as-user.sh velum pm2 status`,
`bash /srv/velum/deploy/as-user.sh velum-web pm2 status` and (with `ONCHAIN_WORKERS=true`)
`bash /srv/velum/deploy/as-user.sh velum-signer pm2 status`.

**Re-running setup never drops HTTPS** (audit R2-M1). It holds the deploy lock while it rewrites
`.env` and the Nginx files. It backs up `sites-available/velum.conf` and the snippets to
`/srv/velum/backups/nginx/` (newest 5 kept) and restores them whenever `nginx -t` or certbot fails.
What it does with the site file depends on what is there:

| Live `velum.conf` | Setup |
|---|---|
| none, or plain HTTP | writes the template, reloads, then gets a certificate (or installs the existing one) |
| managed by Certbot, current template version (`# velum-site-template: N`) | refreshes only the web's upstream port; Certbot's lines stay; no reload if nothing changed |
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
| `/srv/velum/.velum-users` | `root`, 644 | the app, web and signer users setup installed with (`APP_USER`, `WEB_USER`, `SIGNER_USER`); every script uses them from here, only `server-setup.sh` changes them |
| `/srv/velum/.env` | `root:velum 640` | root writes it, api/workers (and the build) read it; edit it as root. **Never holds a hot key** (on-chain audit M-2): `deploy.sh` and `new-key.sh` refuse to run while one is there |
| `/srv/velum/.env.bak.*` | `root:root 600`, newest 3 | written before every change (setup, `set-network.sh`, `import-env.sh`); rewritten without the hot keys when they move, and a restore never brings one back |
| `/srv/velum/web.env` | `root:velum-web 640` | the web's only settings (`NEXT_PUBLIC_*`, `PUBLIC_SITE_URL`, `PORT_WEB`, `NODE_ENV`), rendered from `.env` by root on every release; no secrets |
| `/srv/velum/signer.env` | `root:velum-signer 640` | the signer's only settings (chain, RPC endpoints, on-chain settings, its paths), rendered from `.env` by root on every release; no `DATABASE_URL`, `REDIS_URL`, `PROXY_SECRET` or key |
| `/etc/velum/` | `root`, 755 | |
| `/etc/velum/signer-keys.env` | `root:velum-signer 640` | the hot keys (`PRICE_RELAY_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`): root writes it (`new-key.sh`, the one-time move out of `.env`), only `velum-signer` reads it, and the signer reads it itself at start (the keys never sit in an environment or a PM2 dump). Backups `signer-keys.env.bak.*` root:root 600, newest 3 |
| `/srv/velum/releases/` | `root`, 751 | |
| `/srv/velum/releases/<time>-<commit>/` | `velum:velum-web`, 2750, files 644/755 | one fresh build per release by `velum`; the web user can read, not write |
| `/srv/velum/releases/<time>-<commit>.build-env` | `root`, 600 | the settings the release was built with (`VELUM_NETWORK`, `CHAIN_ID`, `NEXT_PUBLIC_*`); a release only runs with an `.env` that matches (audit R3-04) |
| `/srv/velum/current`, `previous` | `root` symlinks → `releases/…` | `current` is switched atomically; PM2 runs every app from it; `previous` is the `--rollback` target |
| `/srv/velum/backups/` | `root`, 700 | Nginx file backups, the PM2 process list saved before a first release over an older layout |
| `/run/velum-api/` | `velum:www-data`, 2750 | the API socket's directory (`api.sock`, 660). Only `velum` and Nginx's user can enter it; nobody else can take the API's address and receive the proxy secret (audit R3-03). Created by root at boot from `/etc/tmpfiles.d/velum.conf` |
| `/run/velum-signer/` | `velum-signer:velum`, 2750 | the signer's status for `/v1/health` (`status.json`, 640, no secrets, written atomically every 5 s). Only the signer writes; the API (group `velum`) reads; nobody else enters. Created by root at boot from `/etc/tmpfiles.d/velum.conf` |
| `/home/velum-signer` | owner only, 700 | the signer's own copy of each release (`releases/<id>`, built by the signer from the commit, and `current`), its state (`state/`: last quote per market, the cover-claim scan position, the instance lock), `.pm2`, `.tmp` |
| `/home/velum/.pm2`, `/home/velum-web/.pm2`, `/home/velum-signer/.pm2` | owner only, 700 | PM2 logs and `dump.pm2` / `dump.pm2.bak` (each app's environment), 600 |
| `/home/velum/.tmp`, `/home/velum-web/.tmp`, `/home/velum-signer/.tmp` | owner only, 700 | each user's `TMPDIR`: nothing Velum runs uses the shared `/tmp` (R3-02); the PM2 units also get a private `/tmp` |
| `/etc/systemd/system/pm2-velum.service`, `pm2-velum-web.service`, `pm2-velum-signer.service` | `root`, 644 | the PM2 daemons' units, written by `deploy.sh` (`NoNewPrivileges`, `PrivateTmp`, umask 027, a fixed environment without secrets); the signer's is enabled only while `ONCHAIN_WORKERS=true` |
| `/etc/logrotate.d/velum` | `root`, 644 | PM2 log rotation, done as each user (`su velum velum`), symlinks refused |
| `/etc/nginx/snippets/velum-security-headers.conf` | `root`, 644 | security headers and CSP, regenerated on every release |
| `/etc/nginx/snippets/velum-api-upstream.conf` | `root`, 644 | `server unix:/run/velum-api/api.sock;` for the API upstream |
| `/etc/nginx/snippets/velum-proxy-secret.conf` | `root`, 600 | the header Nginx adds for the API (`PROXY_SECRET`); the Nginx master reads it as root |

Root never runs or reads as root anything another user can write (audit M4, R2-H1, R2-H2), and never
lets another user's code near its terminal (R3-01):
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
  deleted **as that user** (clean environment): PM2 homes, `dump.pm2`, release contents (removed by
  the app user, the empty directory by root), the saved PM2 list (read as `velum`, written by root
  into `backups/`; restored by writing it as `velum`). A symbolic link planted in those places can only
  redirect a write the user could do anyway. Nothing ever `chown`s a user's files, so `velum`'s pnpm
  store stays its own (audit R2-L4);
- every switch to another user (`velum`, `velum-web`, `postgres`) starts in a **new session without a
  controlling terminal**, from `/`, with every file descriptor above 2 closed (the deploy lock among
  them) and stdin from `/dev/null` unless data is piped in; its output reaches the terminal only through
  a filter that removes control characters (escape sequences, CR, BEL, C1); output the script itself
  captures stays exact. Ctrl-C terminates that session too. The pm2 command runs with
  `node --no-global-search-paths`, so it never loads modules from a user's `~/.node_modules`;
- the PM2 daemons run under their systemd units. `deploy.sh` writes and enables the unit, starts it,
  moves a daemon that runs outside it (an older layout's, or one started by hand) under it, restarts it
  when its own environment holds a secret, and only then uses the pm2 command, which never starts a
  daemon of its own as root's child.

**Per-app environment** (audit M5, R2-L3). Each PM2 app gets only the variables it reads
(`deploy/ecosystem.config.cjs`): the web gets `NEXT_PUBLIC_*`, `PUBLIC_SITE_URL`, `PORT_WEB`,
`NODE_ENV` (from `web.env`); api and workers get their own lists from `.env`; the signer its own from `signer.env`.
No hot key reaches any app's environment (on-chain audit M-2): the signer reads its keys from
`/etc/velum/signer-keys.env` itself, and the PM2 file refuses to load if a key is on any app's list.
PM2 also passes the environment of the `pm2` command itself to every app (on start, and merged in on
every reload), and cluster workers inherit the PM2 daemon's own environment. PM2's `filter_env`
does not prevent that (`filter_env: true` is ignored by PM2 6.0.14, and no form filters reloads or
the daemon), so Velum does not use it. Instead `release.sh` runs `pm2` under `env -i` with only `HOME`,
`PATH`, `LANG`, `PM2_HOME` and `VELUM_PM2_SCOPE`, and the daemon's own environment is the unit's
(`HOME`, `PATH`, `PM2_HOME`, `TMPDIR`, `LANG`, plus systemd's `USER`, `LOGNAME`, `SHELL`), never a
secret; `deploy.sh` restarts a daemon whose environment holds one. Verified from `/proc/<pid>/environ`:
each app has its own list plus those names. Do not run `pm2 reload`/`restart` by hand from a shell
with secrets exported; always use `deploy.sh`.

**The web runs as its own user** (audit R2-M3). The web is the most exposed process (it ran an
end-of-life Next 14 until the move to Next 15, frontend M5). As `velum-web` it cannot read `.env` or its backups, the api/workers
`/proc/<pid>/environ`, `velum`'s PM2 home or `dump.pm2`, the proxy-secret snippet, the signer's keys, status or
home, or reach the API socket, and it cannot write release files. It needs no writable cache: `next start` writes nothing at
runtime (checked: no ISR or fetch cache in the app). `velum-web` is not in the `velum` group (setup
refuses if it is).

**Client addresses** (audit R2-I4, R3-03). With `PROXY_SECRET` in `.env` (setup generates it), Nginx
adds `X-Velum-Proxy-Secret` to every `/api/` request (root-only snippet) and the API trusts
`X-Real-IP` only on requests that carry it; anything else is rate-limited in one shared "direct"
bucket, so spoofed headers neither dodge a limit nor spend a real client's budget. The secret travels
only over the API's unix socket: no other local user can enter `/run/velum-api`, so nobody can take
the API's address while it is down and collect the secret (as anyone could with 127.0.0.1:4000). Root's
health checks use the socket too (`curl --unix-socket`). PM2 cluster mode keeps working: the PM2 daemon
binds the socket once and every worker shares it, so reloads stay zero-downtime; a socket file left by
a crash is removed only when nothing answers on it. The web never calls the API from the server (the
browser calls `https://DOMAIN/api`; `API_PROXY_TARGET` is for local development and not in the web's
allowlist), so the web user needs no access to the socket and never gets the secret. `deploy.sh` refuses
to deploy when `PROXY_SECRET` is set but the Nginx site does not include the snippet, or when the site
still proxies `/api/` to TCP (older template: re-run setup).

### The signer (on-chain audit M-2)

The price relayer and the keeper are the only code that holds hot keys (`PRICE_RELAY_PRIVATE_KEY` can move the
on-chain price within the oracle's rate limit, `KEEPER_PRIVATE_KEY` pays gas for liquidations). They used to run in
`velum-workers`, as the same user as the internet-facing API: an API exploit could read the keys from `.env`, the
workers' `/proc/<pid>/environ` or `dump.pm2`, and feed the relayer prices through Redis or the keeper candidates
through Postgres. They now run in their own process, `velum-signer` (`apps/workers/src/signer.ts`), as their own
system user `velum-signer` (`SIGNER_USER`), which is in no group but its own:

| | `velum` (api + workers) | `velum-signer` |
|---|---|---|
| hot keys | never: not in `.env`, not in any environment | reads `/etc/velum/signer-keys.env` (root:velum-signer 640) at start |
| prices it signs | (the workers' own price-relay for the site) | its own reads of Robinhood's public quote API, with the same guards (exact token address, multiplier rules, spread and freshness limits, the jump guard, quote time and confirmation, the session calendar, the frozen-quote rule); never Redis |
| positions, forced exits, cover claims | the indexer writes Postgres | read from the chain itself (`nextPositionId`/`getPosition`, `CoverClaimFiled` logs + `coverClaims`); never Postgres |
| Redis, Postgres | yes | none: no `REDIS_URL`, no `DATABASE_URL` |
| code it runs | its release, `releases/<id>` (which it builds and owns) | **its own copy**: root exports the same commit (`git archive`) into the signer's home, where the signer installs and builds it (`release.sh signer-build`: the workers only, no lifecycle scripts, no Prisma). It never runs a file `velum` wrote |
| deployment file | its release's | its own copy's, refused when on a path another user could change |
| status | Redis (MAC'd) | `/run/velum-signer/status.json` (the API reads it) |

Why its own copy: `velum` owns the release files and builds them, so it could rewrite them (`dist/*.js`,
`node_modules`, `ecosystem.config.cjs`, `release.sh`) and the signer would run that code with its keys at the next
restart. No group or permission change on the releases can prevent that, so the signer gets no access to them at all.

A compromised `velum` therefore cannot read a key, cannot choose a price or an action the signer signs, cannot write
its status, signal it or read its memory or environment. At worst it degrades the signer's liveness (load on the
server, the shared RPC endpoint), which `/v1/health` shows (`onchain.reasons`, `signer`, `onchain.signerAge`). Gating is
unchanged: nothing runs unless `ONCHAIN_WORKERS=true` and the deployment file exists, nothing is signed on Robinhood
Chain mainnet (4663) without `ONCHAIN_MAINNET_CONFIRMED=yes`, `RPC_URL_SEND` works as before (only the signer gets
it). The indexer stays in `velum-workers` (it holds no key). One signer runs at a time (a lock socket in its home).
Without `ONCHAIN_WORKERS=true`, `deploy.sh` stops and disables `pm2-velum-signer`.

Residual risks, stated plainly:
- api and workers still share the `velum` uid: a compromised api can read the workers' environment and `.env`
  (database and Redis passwords, `PROXY_SECRET`, `RPC_URL_SEND`), but no hot key any more (on-chain audit M-2).
- Keys that sat in `.env` before this version were readable by `velum` until they moved; rotate them if `velum` may
  have been compromised before (see "Upgrading to the separate signer").
- The signer's own build installs npm packages as `velum-signer` (the same lockfile and registry as `velum`'s build);
  a malicious package version in the lockfile would run as the signer. That is the supply-chain risk every build
  has; the split does not add to it.
- A compromised `velum` can change the release files the web runs (it builds them), so it can take
  over the web too; that adds nothing it does not already have. It can also break its own deploys
  (health checks, builds); it cannot reach root or the signer through them.
- A compromised web can still serve the site's pages and JavaScript (deface it, phish wallet users),
  open localhost connections (Redis and Postgres need passwords it does not have) and use the API like
  any visitor. It cannot read secrets.
- The web still listens on 127.0.0.1:PORT_WEB (`next start` has no unix-socket mode). Whoever binds that
  port while the web is fully stopped (a clean restart, a few seconds; reloads never free it) receives
  visitors' page requests and can serve its own pages: content impersonation, but Nginx sends no secret
  to the web.
- Output the apps' users print is cleaned on the terminal and in pipes, not in files you redirect it to
  (read those with `less` or `cat -v`).
- Root runs only system tools on these paths (`git` with hooks off, `node` for URL parsing and
  `.env` import, `nginx`, `certbot`, `systemctl`, `logrotate`). The PM2 units keep PM2's design
  (`PIDFile` in the user's PM2 home); systemd refuses a PID outside the unit's cgroup.

## Releases

```bash
sudo bash /srv/velum/deploy/deploy.sh                # deploy the branch the clone is on (BRANCH=name to override)
sudo bash /srv/velum/deploy/deploy.sh --rollback     # switch back to the release that was live before
```
1. Takes a lock (`flock` on `/srv/velum/.deploy.lock`): deploys, `server-setup.sh`,
   `set-network.sh`, `new-key.sh` and `import-env.sh` never overlap; the second one stops with a
   message. Ignores SIGHUP. Checks the base (see the security model), refuses to go on while `.env` holds a hot key,
   and recreates the API socket's and the signer's status directories from their tmpfiles.d entries.
2. Pulls as root (hooks and fsmonitor off), then re-runs the freshly pulled `deploy.sh`.
3. Exports the commit into a new `releases/<time>-<commit>/` and, as `velum`, installs with the
   frozen lockfile, builds every app (the web build sees only `NEXT_PUBLIC_*` and
   `PUBLIC_SITE_URL`), runs `prisma migrate deploy` (only `DATABASE_URL`) and makes the files
   readable for the web user. The live release is never touched: **a failed build leaves the running
   site exactly as it was** and the half-built directory is removed. It records the settings the
   release was built with in `releases/<id>.build-env` (and stops if they change during the build).
   With `ONCHAIN_WORKERS=true` it then exports the same commit into `velum-signer`'s home
   (`~/releases/<id>`), where the signer user installs and builds its own copy; a failure there also leaves
   everything as it was.
4. First release in a base while `velum`'s PM2 still runs Velum apps from elsewhere (an older
   in-place layout): saves that process list (`pm2 save` as `velum`) and keeps a root-only copy in
   `backups/pm2-dump-before-first-release.<time>.json` (audit R2-M2).
5. Renders `web.env` and `signer.env`, switches `current` (and, as the signer, the signer's `~/current`)
   atomically, refreshes the Nginx snippets from `.env` (the CSP's `connect-src` follows `NEXT_PUBLIC_RPC_URL`;
   WalletConnect hosts appear only with `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`; `/api/` on the socket, with the proxy
   secret) and reloads PM2 with zero downtime: api + workers as `velum`, web as `velum-web`, and with
   `ONCHAIN_WORKERS=true` the signer as `velum-signer` (a single process, restarted), each daemon under its unit.
   When the app definitions or the set of env keys changed, it does a clean `pm2 delete` + `start` of
   that user's apps instead, so a removed secret never lingers in a running process; an app that is
   not online or runs from another directory is deleted and started on its own while the healthy
   ones reload (crash-looping workers never take the API down).
6. Health check (audit R2-L5): API `/v1/health` on its socket (30 s), web root (60 s), then a workers
   liveness heartbeat written **after** the switch (`workers` in `/v1/health`, 60 s), then, when the signer runs,
   a signer status written after the switch (`signer` in `/v1/health`, 60 s), then it watches
   for `HEALTH_SETTLE_SECONDS` (default 20): every app online in PM2 with unchanged restart counts, and
   API, web, a fresh heartbeat and (signer) a fresh status again. A crash-looping worker or an API that dies after PM2 said
   "online" fails the check. On failure it switches back to the previous release, but only to one
   built by the current app user with the settings `.env` has now; otherwise the failed release stays
   active and the message says why. On a first release over an older layout it restores those apps
   from the copy of step 4 (`systemctl restart pm2-velum` resurrects them) and says so.
7. Keeps the newest 3 releases (`KEEP_RELEASES`), always including the current and previous one.

Rollback switches code only: migrations are not rolled back, so keep migrations
backward-compatible (add columns first, drop them a release later). `--rollback` refuses a release
that was built with other `VELUM_NETWORK`, `CHAIN_ID` or `NEXT_PUBLIC_*` values than `.env` has now
(audit R3-04: its web bundle would target one network while web.env, the API and the CSP follow the
other) and lists the differences; put those values back (the `.env.bak.*` files keep earlier versions)
or deploy a new release. It also refuses releases another app user built (R3-05), and, with
`ONCHAIN_WORKERS=true`, a release the signer has no copy of (built while `ONCHAIN_WORKERS` was off): the relayer and
keeper would stop. The automatic switch-back after a failed release takes the signer back too when it has a copy of
that release, and otherwise stops it (it signs nothing) until the next healthy release.

`NEXT_PUBLIC_*` values are compiled into the web build, so run a release after changing them.
Ctrl-C stops a release cleanly (the step running as `velum` is terminated too), but only before the
switch; once it says "Switching", let it finish.

### Network: testnet or mainnet
```bash
sudo bash /srv/velum/deploy/set-network.sh mainnet   # or testnet
```
Sets `VELUM_NETWORK`, `NEXT_PUBLIC_VELUM_NETWORK`, `CHAIN_ID`, `NEXT_PUBLIC_CHAIN_ID`, `RPC_URL`,
`NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_EXPLORER_URL` and `PRICE_SOURCE` together in one atomic
rewrite (backs up `.env` first, under the deploy lock), then runs a release. If that release fails,
nothing mixes networks (R3-04): when its health check fails, the previous `.env` is put back before
switching back to the previous release (web.env and the CSP follow); when it fails before the switch,
`.env` and `web.env` are put back and the running release is untouched. Mainnet is read-only in Phase 2:
real wallet and balances, live Robinhood prices, simulated trades, and the copy says so. No Velum
contract is deployed on mainnet before the Phase 5 audit. On mainnet a market with no price snapshot yet
is served with its seed price, `stale: true` and `source: null` (docs/03); the web shows dashes for it.
The public mainnet RPC rate-limits; for real traffic put a provider URL in `RPC_URL` /
`NEXT_PUBLIC_RPC_URL` (as root) and run a release (the CSP picks the new host up).

### Hot-wallet keys
```bash
sudo bash /srv/velum/deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY    # or KEEPER_PRIVATE_KEY (a separate key)
sudo bash /srv/velum/deploy/deploy.sh                             # the signer restarts with it
```
Generates the key with Node's CSPRNG, backs up the keys file (`/etc/velum/signer-keys.env.bak.*`, root only),
writes it atomically into `/etc/velum/signer-keys.env` (root:velum-signer 640, never `.env`) and prints only the
address, derived as `velum-signer` with viem from the signer's own build (isolated like every other user command;
before the first release with `ONCHAIN_WORKERS=true` it asks you to run one first and run it again). A valid existing
key is kept; any other existing value (or a duplicated line) is refused, never replaced. It refuses to run while
`.env` still holds a key (run `server-setup.sh` first: it moves them). The price-relay key must be the address the
`OracleAdapter` was deployed with (`PRICE_RELAYER`); the keeper key must be another one.

Rotating: the keeper key can be replaced at any time (delete its line in the keys file as root, run `new-key.sh
KEEPER_PRIVATE_KEY`, fund the new address, `deploy.sh`). The oracle's relayer address is fixed at deployment, so a new
price-relay key needs a new deployment of the contracts (testnet), with `PRICE_RELAYER` set to its address.

## Dedicated Redis for Velum (strongly recommended on a shared server)

**Required for the Phase 3 on-chain workers:** with `ONCHAIN_WORKERS=true` the price relayer, keeper and
indexer refuse to start unless `REDIS_URL` is this unix-socket Redis (on-chain audit M-3: on a shared Redis a
co-tenant could hold their locks or delete their schedulers and stop them silently).

By default Velum shares the server's Redis (`REDIS_DB`, default 5) and its `requirepass`. Every other
program that knows that password can select Velum's database and read or write its keys: queue jobs,
price snapshots, candle caches, heartbeats, rate-limit counters (backend audit M-2, F-2).

What the apps do about it, so the shared Redis stays usable (an upgraded release keeps working on it):
- Price snapshots, candle caches and heartbeats are authenticated with an HMAC under a key the API and
  the workers derive from `DATABASE_URL`, which other tenants do not have (packages/config
  `cache-mac.ts`, docs/02). A forged or tampered value reads as missing: a forged price is never shown as
  live or quoted, a forged heartbeat never makes dead workers look alive to `deploy.sh`. Values written
  by a release older than this one also read as missing; the workers rewrite them at start.
- Changing the database password (`DATABASE_URL`) rotates that key: run `deploy.sh` (or restart api and
  workers together); until the workers have rewritten the values (a few seconds) prices read as missing.
  The API and the workers must always get the same `DATABASE_URL`, as they do from `.env`.
- Every value is validated after its MAC, and a queued job's payload is never trusted.

What stays possible for another tenant of a shared Redis (denial of service, never a false price):
deleting Velum's keys or putting back an older genuine value (prices read as missing or stale), filling
or deleting queue jobs, and changing rate-limit counters, which can lock visitors out (429) or lift the
limits. Only a separate Redis removes these. `deploy/redis-velum.sh` (root, idempotent, under the deploy
lock) runs one just for Velum and leaves the system Redis, its config and its data untouched:

| What | Where | Owner, mode |
|---|---|---|
| system user `velum-redis` (created by the script; not the shared Redis's `redis` user, final audit M-1) | | own group only, no login |
| systemd unit `velum-redis` (User=velum-redis, sandboxed, `RestrictAddressFamilies=AF_UNIX`) | `/etc/systemd/system/velum-redis.service` | root 644 |
| config: `port 0` (no TCP), unix socket, own random password, `maxmemory` (`REDIS_MAXMEMORY`, default 256mb) with `maxmemory-policy noeviction` (BullMQ needs it), AOF + RDB, `CONFIG`/`DEBUG`/`MODULE` disabled | `/etc/velum-redis/redis.conf` | root:velum-redis 640 |
| data | `/var/lib/velum-redis` | velum-redis 750 |
| socket directory, recreated at boot | `/run/velum-redis` (`/etc/tmpfiles.d/velum-redis.conf`) | velum-redis:velum 2750 (no group write: `velum` cannot replace the socket) |
| socket | `/run/velum-redis/redis.sock` | velum-redis:velum 660: only `velum` (api + workers) connects; `velum-web`, Nginx, the shared Redis and other users cannot |
| the shared `REDIS_URL` from before the switch | `/etc/velum-redis/shared-redis-url` | root 600 |

It needs a release of this version running first (so `deploy.sh` can safely switch back if the next
release fails), then:

```bash
sudo -i
tmux new -s velum-redis
bash /srv/velum/deploy/deploy.sh             # only if the running release predates redis-velum.sh
bash /srv/velum/deploy/redis-velum.sh        # REDIS_MAXMEMORY=512mb bash … for a larger limit
bash /srv/velum/deploy/deploy.sh             # api and workers reconnect to the socket
```
The script starts `velum-redis`, checks that it answers on the socket with no TCP port and
`noeviction`, that `velum` can reach the socket and `velum-web` cannot, and only then sets
`REDIS_URL=unix://:<password>@/run/velum-redis/redis.sock` in `.env` (backed up first). Nothing has to be
copied: prices, candle caches, queues and heartbeats are rebuilt by the workers on start (candles live
in Postgres; the MAC key comes from `DATABASE_URL`, so it does not change with the Redis); rate-limit
counters start from zero. Re-running it keeps the password and the data and restarts `velum-redis` only
when its config or unit changed.

Verify:
```bash
systemctl status velum-redis
ss -lx | grep velum-redis                     # the socket; ss -ltn shows no port for it
curl -s --unix-socket /run/velum-api/api.sock http://velum-api/v1/health | cat -v   # "redis":true, "workers":<a few s>
REDISCLI_AUTH="$(sed -n 's/^requirepass //p' /etc/velum-redis/redis.conf)" redis-cli -s /run/velum-redis/redis.sock info keyspace | cat -v
bash /srv/velum/deploy/as-user.sh velum-web redis-cli -s /run/velum-redis/redis.sock ping   # Permission denied
```
Optional, once the release is healthy: remove Velum's old keys from the shared Redis (with its
password, on Velum's database only), e.g.
`REDISCLI_AUTH=… redis-cli -n 5 --scan --pattern 'velum:*'` and `--pattern 'bull:velum-*'`, then delete
what they list.

Roll back to the shared Redis:
```bash
bash /srv/velum/deploy/redis-velum.sh --rollback   # REDIS_URL back to the saved shared URL (.env backed up)
bash /srv/velum/deploy/deploy.sh
systemctl disable --now velum-redis                 # optional; its data stays in /var/lib/velum-redis
```
To remove it for good afterwards: `rm /etc/systemd/system/velum-redis.service /etc/tmpfiles.d/velum-redis.conf`,
`systemctl daemon-reload`, then `rm -r /etc/velum-redis /var/lib/velum-redis /run/velum-redis`.

Notes:
- `server-setup.sh` checks Redis with the `REDIS_URL` in `.env`, over TCP or over the socket, so it can be
  re-run as it is after this switch.
- `deploy.sh --rollback` to a release older than `redis-velum.sh` would start code that only knows
  `redis://` URLs: roll Redis back first.
- The signer uses no Redis: `velum-signer` cannot reach the socket (the script checks it), like `velum-web`.
- The PM2 units (`pm2-velum`, `pm2-velum-web`, `pm2-velum-signer`) want and start after `postgresql`, `redis-server`
  and `velum-redis` at boot (the signer needs neither; the shared template keeps all three alike). `Wants=` starts an installed unit even when it is disabled (a missing one is
  skipped): to keep the system Redis off on a server where nothing else uses it, `systemctl mask
  redis-server`.

## Upgrading to the separate signer (on-chain audit M-2)

For a server already on the two-user layout (`velum` + `velum-web`, `/srv/velum`, optionally Velum's own Redis):
the live server runs commit 191c2a7's layout. This version adds the third user and moves the hot keys out of
`.env`. Until it is done, `deploy.sh` (and `set-network.sh` and `new-key.sh`) stop with a message
pointing here, after pulling but **before building or switching anything**: the site keeps running as it was.
Run as root, in tmux:

```bash
# U1. Backups (root only).
BK=/root/velum-signer-upgrade-$(date -u +%Y%m%d%H%M%S); install -d -m 700 "$BK"
cp -p /srv/velum/.env "$BK/env"                         # may hold PRICE_RELAY_PRIVATE_KEY / KEEPER_PRIVATE_KEY
bash /srv/velum/deploy/backup-db.sh "$BK/velum.pgdump"  # optional: nothing here changes the database schema
```

```bash
# U2. Pull, then setup once: it creates velum-signer (own group only, no login), records it in .velum-users,
#     creates /etc/velum/signer-keys.env (root:velum-signer 640), MOVES any hot key from .env into it (both files
#     backed up first, every .env.bak.* rewritten without the keys), renders signer.env, adds the signer's status
#     directory (tmpfiles.d) and its log rotation, then runs the release. With ONCHAIN_WORKERS=true the release
#     builds the signer's own copy and starts pm2-velum-signer; velum-workers restarts without any key (its
#     variables changed) and release.sh removes velum's previous PM2 list (dump.pm2.bak) that still held them.
#     (SIGNER_USER=… names another user; the default is velum-signer.)
bash /srv/velum/deploy/deploy.sh      # checks the base, pulls this version, then stops: "Re-run server-setup.sh once"
DOMAIN=velumtrade.com EMAIL=you@example.com bash /srv/velum/deploy/server-setup.sh
```
The first command builds and switches nothing (the running release stays as it was); it only brings the new
scripts. With Velum's own Redis, setup's Redis check passes as before (the socket still admits `velum`).

```bash
# U3. Verify.
U=/srv/velum/deploy/as-user.sh
grep -E '^(PRICE_RELAY|KEEPER)_PRIVATE_KEY=.' /srv/velum/.env   # prints nothing
ls -l /etc/velum/signer-keys.env                          # -rw-r----- root velum-signer
bash "$U" velum cat /etc/velum/signer-keys.env            # must say: Permission denied
bash "$U" velum ls /home/velum-signer                     # must say: Permission denied
bash "$U" velum-signer cat /srv/velum/.env                # must say: Permission denied
bash "$U" velum-signer ls /run/velum-api                  # must say: Permission denied
bash "$U" velum sh -c 'grep -c PRIVATE_KEY ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.bak'   # 0 (or no such file)
curl -s --unix-socket /run/velum-api/api.sock http://velum-api/v1/health | cat -v; echo   # "signer":<a few s> with ONCHAIN_WORKERS=true
```
With `ONCHAIN_WORKERS=true` also: `bash "$U" velum-signer pm2 status` (velum-signer online), `systemctl is-active
pm2-velum-signer`, and in `/v1/health` `onchain.relayer.address` / `onchain.keeper.address` are the keys' addresses.

```bash
# U4. The keys were readable by velum before this upgrade. If velum may ever have been compromised, rotate them:
#     the keeper key at once (see "Hot-wallet keys"), the price-relay key with the next contracts deployment.
#     Root-only copies that may still hold them: $BK/env and, from an older layout's upgrade,
#     /srv/velum/backups/pm2-dump-before-first-release.*.json. Delete them once no longer needed:
rm -f /srv/velum/backups/pm2-dump-before-first-release.*.json
rm -rf "$BK"                                              # after a few days of stable operation
```
Rolling back to a release from before this version (`deploy.sh --rollback`) is refused while `ONCHAIN_WORKERS=true`
(the signer has no copy of it); with `ONCHAIN_WORKERS=false` it works, and the older code finds no key in `.env`, so
it signs nothing.

## Upgrading a server set up before the November 2026 hardening

Older setups `chown`ed the checkout (`/opt/velum`) to `velum`, sourced `.env` in `deploy.sh` and
built in place. Treat `velum` as possibly compromised: it could have changed anything in that tree,
including `.git` (hooks, `core.hooksPath`, `core.fsmonitor`, a symlinked `.git` or hooks
directory), so **root must never run git in it or repair it in place** (the earlier in-place
instructions were bypassable five ways, audit R2-H2), and every command that runs as `velum` must
be isolated from your terminal (R3-01). Make a fresh root-owned clone at `/srv/velum`, copy only `.env`
across (checked and parsed as data), and leave `/opt/velum` untouched as the fallback. Paste the blocks
below in order, as root, in tmux; nothing is switched before step 4. This keeps the `velum` user; if
you suspect it was compromised, use "Compromise suspected" below instead of rotating secrets.

```bash
# 0a. Root shell in tmux. After a dropped connection: sudo -i, then tmux attach -t velum-upgrade
#     (the variables and the asu function below are still set in that shell).
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
BRANCH=claude/new-session-93ke66               # the repository's only branch
BK=/root/velum-upgrade-$(date -u +%Y%m%d%H%M%S)
install -d -m 700 "$BK"
# asu USER COMMAND…: runs COMMAND as USER without handing it this terminal (audit R3-01), for step 1
# (from step 2 on, $NEW/deploy/as-user.sh does the same). New session, from /, clean environment,
# stdin closed; on the terminal its output shows control characters as text (cat -v); output you
# redirect to a file stays exact.
asu() {
  local u="$1" rc; shift
  set -- runuser -u "$u" -- env -i HOME="$(getent passwd "$u" | cut -d: -f6)" PATH="$PATH" LANG=C.UTF-8 "$@"
  if [ -t 1 ]; then (cd / && exec setsid -w "$@" </dev/null) 2>&1 | cat -v; rc=${PIPESTATUS[0]}
  else { (cd / && exec setsid -w "$@" </dev/null) 2>&1 >&3 3>&- | cat -v >&2; rc=${PIPESTATUS[0]}; } 3>&1; fi
  return "$rc"
}
```

```bash
# 1. Backups. Files in $OLD are read as velum (through asu), never opened by root.
asu velum cat "$OLD/.env" > "$BK/old.env"; chmod 600 "$BK/old.env"
cp -a /etc/nginx/sites-available/velum.conf "$BK/nginx-velum.conf"
asu velum pm2 save --force
asu velum cat /home/velum/.pm2/dump.pm2 > "$BK/dump.pm2"; chmod 600 "$BK/dump.pm2"
certbot certificates | tee "$BK/certbot-certificates.txt"
ls -l "$BK"                                    # four non-empty files (the database dump follows in step 3)
```

```bash
# 2. Fresh root-owned clone from the repository URL, never from $OLD (a local clone hard-links files
#    velum owns; the scripts refuse such a base). A private repository needs a deploy key for root in
#    /root/.ssh: make a new one, do not copy velum's.
git -c core.hooksPath=/dev/null -c core.fsmonitor=false clone --branch "$BRANCH" "$REPO_URL" "$NEW"
git -C "$NEW" log --oneline -1
```

```bash
# 3. Copy .env across, then dump the database. import-env.sh opens the old file as velum (isolated,
#    with O_NOFOLLOW), refuses a symbolic link, a non-regular file, more than one hard link, an owner
#    other than root/velum, more than 64 KiB and any line that is not KEY=VALUE / comment / blank, then
#    prints every key (secrets masked) for review. Check the values it prints; fix them as root with:
#    nano "$NEW/.env". backup-db.sh dumps as the velum database role, not as the postgres superuser:
#    whoever owns a database's objects can make pg_dump run SQL as the role running it (CVE-2024-7348).
bash "$NEW/deploy/import-env.sh" "$OLD/.env"
bash "$NEW/deploy/backup-db.sh" "$BK/velum.pgdump"
```

```bash
# 4. Setup and first release. Creates velum-web, renders web.env and PROXY_SECRET, the API socket
#    directory, the PM2 units and log rotation, re-renders the Certbot-managed Nginx site from the new
#    template and re-installs your existing certificate before Nginx reloads (HTTPS stays up), then
#    builds and starts the first release from $NEW. Until then Nginx keeps proxying to the old apps.
#    The old apps are replaced by a clean restart (a few seconds of downtime: velum's PM2 daemon is
#    moved under its systemd unit) only after the build succeeded, and come back automatically if the
#    release fails its health checks.
DOMAIN="$DOMAIN" EMAIL="$EMAIL" bash "$NEW/deploy/server-setup.sh"
```
It ends with `✓ Velum Phase 2 is live` (tmux keeps the output; scroll with Ctrl-b [). If it ends with
"The apps that ran before it were restored …", the old site runs again from `/opt/velum`
(unchanged); read the log, fix the cause and re-run step 4.

```bash
# 5. Verify. Commands as velum or velum-web go through as-user.sh (same isolation as asu).
U="$NEW/deploy/as-user.sh"
bash "$U" velum pm2 status                     # velum-api ×2 and velum-workers online
bash "$U" velum-web pm2 status                 # velum-web ×2 online
bash "$U" velum pm2 describe velum-api | grep 'exec cwd'   # /srv/velum/current/apps/api
systemctl is-active pm2-velum pm2-velum-web    # active, active (the daemons run under systemd)
systemctl is-enabled pm2-velum pm2-velum-web   # enabled, enabled
curl -s https://$DOMAIN/api/v1/health | cat -v; echo     # "ok":true, "workers" a few seconds
curl -sI https://$DOMAIN/ | grep -iE '^(HTTP|strict-transport|content-security)' | cat -v
curl -sI http://www.$DOMAIN/ | head -1 | cat -v          # 301
bash "$U" velum-web cat "$NEW/.env"            # must say: Permission denied
bash "$U" velum-web cat /home/velum/.pm2/dump.pm2        # must say: Permission denied
bash "$U" velum-web ls /run/velum-api          # must say: Permission denied (the API socket)
```

```bash
# 6. Only if you need to go back by hand later (the release above already does this on failure):
U="$NEW/deploy/as-user.sh"
systemctl disable --now pm2-velum-web
bash "$U" velum pm2 delete velum-api velum-workers
bash "$U" velum sh -c 'umask 077; cat > "$HOME/.pm2/dump.pm2"' < "$BK/dump.pm2"
systemctl restart pm2-velum                    # resurrects the old apps from that list, under systemd
rm -f "$NEW/current" "$NEW/previous"           # so a later step 4 is a first release again
cp -a "$BK/nginx-velum.conf" /etc/nginx/sites-available/velum.conf && nginx -t && systemctl reload nginx
```
Database migrations applied by the new release stay applied (they are backward-compatible).
`$BK/velum.pgdump` restores the database if ever needed, as the velum role (never as postgres:
restoring runs the dump's SQL): `bash $NEW/deploy/backup-db.sh --restore "$BK/velum.pgdump"`.

```bash
# 7. After a few days of stable operation: remove the pm2-logrotate module the old setup installed
#    (logrotate now rotates the logs, as each user; pm2 uninstall only deletes the module, it runs no
#    npm), then the old tree and the backups (rm never follows symbolic links).
bash "$NEW/deploy/as-user.sh" velum pm2 uninstall pm2-logrotate
bash "$NEW/deploy/as-user.sh" velum pm2 save --force
rm -rf --one-file-system /opt/velum
rm -rf "$BK"                                    # or copy it off the server first
```

**If an earlier in-place upgrade attempt already ran** (the old steps `chown -R root:root /opt/velum`
…): that `chown` also changed the files `velum`'s pnpm store shares with `node_modules` (hard links),
and builds then fail with `EACCES … pnpm/store` (audit R2-L4). The store's directories still belong
to `velum`, so let `velum` remove it; the next release downloads it again:
```bash
bash /srv/velum/deploy/as-user.sh velum rm -rf /home/velum/.local/share/pnpm/store
```
(before step 2, use `asu velum rm -rf /home/velum/.local/share/pnpm/store`). Then follow the steps
above from step 0 (a fresh clone; do not reuse the half-repaired `/opt/velum` as the new base).

### Compromise suspected

Rotating secrets while `velum` still exists does not help: it can read `.env` (and every new secret
written there), and it controls its home, its crontab, its PM2 and every release it built. Evict it
first, then rotate (audit R3-05). The site is down from step C1 until step C3 has built the first
release with the new users (a few minutes). Run in tmux, as root, after the upgrade above (or instead
of its step 4 if you suspect the compromise before upgrading; the base needs `.env`, from step 3).

```bash
# C1. Stop the old users and everything they run, and lock them.
for u in velum velum-web velum-signer; do
  systemctl disable --now "pm2-$u"
  usermod --lock --expiredate 1 --shell /usr/sbin/nologin "$u"
  crontab -r -u "$u" 2>/dev/null; loginctl disable-linger "$u" 2>/dev/null
  while pkill -KILL -u "$u"; do sleep 1; done
  rm -f "/etc/systemd/system/pm2-$u.service"
done
systemctl daemon-reload
ps -u velum,velum-web,velum-signer -o pid,user,args   # nothing left
atq 2>/dev/null                                 # remove any at job of theirs with atrm
```

```bash
# C2. Rotate everything they could read. With the Redis owner: change the Redis password (it is
#     shared). Then edit .env as root: DATABASE_URL password → CHANGE_ME (setup generates a new one and
#     updates the role), REDIS_URL → the new Redis password, PROXY_SECRET → empty. The hot keys: velum could not
#     read /etc/velum/signer-keys.env (unless they were in .env before the signer split). If velum-signer may have
#     been compromised, or the keys predate the split, empty the keys file (move any funds off the old addresses
#     first; a new price-relay key needs a new contracts deployment).
nano /srv/velum/.env
nano /etc/velum/signer-keys.env                 # only if the keys must change: delete their lines
```

```bash
# C3. Install with new users. Releases the old users built are never run again (deploy.sh only uses
#     releases the current app user built; the first one is built from scratch). The users are
#     recorded in /srv/velum/.velum-users: later runs of every script use them without APP_USER.
#     With Velum's own Redis (REDIS_URL=unix://…), setup stops at its Redis check: run the
#     redis-velum.sh line (new password; the socket follows velum2), then the setup line again.
APP_USER=velum2 WEB_USER=velum2-web SIGNER_USER=velum2-signer DOMAIN=velumtrade.com EMAIL=you@example.com bash /srv/velum/deploy/server-setup.sh
bash /srv/velum/deploy/redis-velum.sh --rotate                 # only with Velum's own Redis, then setup again
bash /srv/velum/deploy/new-key.sh KEEPER_PRIVATE_KEY           # only for keys you emptied in C2; then fund the address
bash /srv/velum/deploy/deploy.sh                               # the signer restarts with its keys (ONCHAIN_WORKERS=true)
```

```bash
# C4. Remove what is left of them. Keep the locked accounts: a deleted uid is handed to the next new
#     user, who would then own every file the old one left anywhere. Delete them only once the find
#     below prints nothing (outside /opt/velum, which step 7 removes).
rm -rf --one-file-system /home/velum /home/velum-web /home/velum-signer
find / /tmp /var/tmp /dev/shm /run -xdev \( -user velum -o -user velum-web -o -user velum-signer \) -print 2>/dev/null
find /srv/velum/releases -mindepth 1 -maxdepth 1 -user velum -exec rm -rf --one-file-system {} +
```
If the database itself may have been changed (the old role owned it), restore a dump taken before the
compromise with `backup-db.sh --restore` (it runs as the role, never as postgres).

## Moving to Node 22 (shared server)

Velum targets Node 22 LTS (`.nvmrc`) and still builds and runs on Node 20.11+ (`engines`). On a fresh
server `server-setup.sh` installs Node 22 from the NodeSource apt repository; it never upgrades a
Node that is already installed, because other sites on the server may run on it. Upgrade it yourself,
as root, only once you know what else depends on it.

1. Find everything else that runs on the system Node:
   ```bash
   command -v node; node -v; apt-cache policy nodejs       # which Node, and from which repository
   ps -eo user,pid,comm,args | grep -w '[n]ode'            # every running Node process and its user
   ps -eo user,pid,args | grep '[P]M2 v'                   # every PM2 daemon (one per user)
   sudo -u <user> -H pm2 ls                                # the apps of each PM2 user found above
   systemctl list-units --type=service --all | grep -iE 'node|pm2'
   grep -rlE '(^|/)(node|npm|npx|pm2)( |$)' /etc/systemd/system /lib/systemd/system /etc/cron* 2>/dev/null
   ```
   Anything other than Velum's own processes (`velum-api` and `velum-workers` under `velum`,
   `velum-web` under `velum-web`, `velum-signer` under `velum-signer`, their `pm2-velum*` units) belongs to someone else: agree the upgrade
   with its owner first, or stay on Node 20, which Velum supports. If `apt-cache policy nodejs` shows
   Ubuntu's own package or Node came from nvm or a tarball, upgrade it that way instead; do not mix
   sources.
2. Upgrade through the NodeSource apt repository (its key in `/etc/apt/keyrings`, no `curl | bash`):
   ```bash
   install -d -m 755 /etc/apt/keyrings
   curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc
   echo 'deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
   apt-get update && apt-get install -y nodejs
   node -v                                                  # v22.x
   ```
   Remove any older NodeSource entry that still points at `node_20.x` (for example one left by the old
   `setup_20.x` script under another file name in `/etc/apt/sources.list.d/`), so apt sees one source.
   The global `pm2` (pinned to 6.0.14 by `server-setup.sh`) stays installed; do not upgrade it here.
3. Run a normal release, which installs and builds everything again on the new Node and reloads the
   apps:
   ```bash
   sudo bash /srv/velum/deploy/deploy.sh
   ```
   The PM2 daemons themselves keep running on the old Node until their next restart. To move them now
   (a few seconds of downtime): `systemctl restart pm2-velum pm2-velum-web pm2-velum-signer`, then check
   `bash /srv/velum/deploy/as-user.sh velum pm2 status` and the same for `velum-web`. Other users' PM2
   daemons move only when their owners restart them.

## Manual setup (fresh, dedicated server)

The script above does all of this; the steps are here for reference. Run them as root.

### 1. Base packages
```bash
apt update
apt -y install git nginx certbot python3-certbot-nginx postgresql redis-server tmux logrotate
# Node 22 from the NodeSource apt repository (what server-setup.sh does; see "Moving to Node 22")
install -d -m 755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc
echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
apt update && apt -y install nodejs
npm i -g pm2@6.0.14
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```

### 2. Database and Redis
```bash
P="$(openssl rand -hex 24)"
printf '\\set p %s\nCREATE ROLE velum WITH LOGIN PASSWORD :'"'"'p'"'"';\n' "$P" | (cd / && setsid -w runuser -u postgres -- env -i HOME=/var/lib/postgresql PATH="$PATH" psql -X -v ON_ERROR_STOP=1) 2>&1 | cat -v
(cd / && setsid -w runuser -u postgres -- env -i HOME=/var/lib/postgresql PATH="$PATH" psql -X -c "CREATE DATABASE velum OWNER velum;" </dev/null) 2>&1 | cat -v
sed -i "s/^# *requirepass .*/requirepass $(openssl rand -hex 24)/" /etc/redis/redis.conf
systemctl restart redis-server
```
Postgres and Redis listen on localhost only (defaults). Do not open 5432/6379 in ufw. Keep Redis on
`maxmemory-policy noeviction` (the default).

### 3. Users and app
```bash
useradd --system --create-home --shell /bin/bash velum
useradd --system --create-home --user-group --shell /usr/sbin/nologin velum-web
useradd --system --create-home --user-group --shell /usr/sbin/nologin velum-signer   # own group only, in no other
git -c core.hooksPath=/dev/null -c core.fsmonitor=false clone --branch claude/new-session-93ke66 https://github.com/fourtisf/velum.git /srv/velum
bash /srv/velum/deploy/as-user.sh velum sh -c 'mkdir -p ~/.pm2 ~/.tmp && chmod 700 ~/.pm2 ~/.tmp'
bash /srv/velum/deploy/as-user.sh velum-web sh -c 'mkdir -p ~/.pm2 ~/.tmp && chmod 700 ~/.pm2 ~/.tmp'
bash /srv/velum/deploy/as-user.sh velum-signer sh -c 'chmod 700 ~ && mkdir -p ~/.pm2 ~/.tmp ~/state ~/releases && chmod 700 ~/.pm2 ~/.tmp ~/state ~/releases'
chgrp velum /srv/velum && chmod 751 /srv/velum
printf 'APP_USER=velum\nWEB_USER=velum-web\nSIGNER_USER=velum-signer\n' > /srv/velum/.velum-users
install -m 640 -o root -g velum /srv/velum/.env.example /srv/velum/.env
install -d -m 755 /etc/velum && install -m 640 -o root -g velum-signer /dev/null /etc/velum/signer-keys.env   # deploy/new-key.sh fills it
nano /srv/velum/.env                                    # fill every value (URL-encode special characters in URLs);
                                                        # PROXY_SECRET: openssl rand -hex 32; API_SOCKET=/run/velum-api/api.sock
```

### 4. API socket, logs, Nginx + SSL (before the first release: deploy.sh refreshes the snippets)
The snippets are rendered from `.env`, which only root can read, so this runs as root (audit R2-I5):
```bash
cd /srv/velum && . deploy/lib/common.sh
render_tmpfiles /run/velum-api/api.sock velum www-data velum-signer velum /run/velum-signer > /etc/tmpfiles.d/velum.conf
systemd-tmpfiles --create /etc/tmpfiles.d/velum.conf    # /run/velum-api velum:www-data 2750, /run/velum-signer velum-signer:velum 2750
render_logrotate velum velum-web velum-signer > /etc/logrotate.d/velum
install -d /etc/nginx/snippets
install -d -m 755 /var/cache/nginx                      # parent of the /api/v1/markets micro-cache (nginx -t needs it)
render_security_headers .env > /etc/nginx/snippets/velum-security-headers.conf
render_api_upstream socket /run/velum-api/api.sock > /etc/nginx/snippets/velum-api-upstream.conf
(umask 077 && render_proxy_secret .env > /etc/nginx/snippets/velum-proxy-secret.conf)
sed -e "s/velum.example/$DOMAIN/g" deploy/nginx/velum.conf > /etc/nginx/sites-available/velum.conf
ln -sf /etc/nginx/sites-available/velum.conf /etc/nginx/sites-enabled/velum.conf
nginx -t && nginx_reload                                 # reload, then check Nginx really applied it (H-1)
certbot --nginx --cert-name $DOMAIN -d $DOMAIN -d www.$DOMAIN -m $EMAIL --agree-tos --redirect -n
```
(`www-data` is Nginx's user on Ubuntu: the `user` line of `/etc/nginx/nginx.conf`.) `velum.conf`
redirects `www.$DOMAIN` to `https://$DOMAIN` (301), sends HSTS only over HTTPS, the CSP and the other
security headers from the snippet, `/api/` to the API's socket with the proxy secret, and answers
Nginx's own rate limit on `/api/` with the API's JSON error (`429 RATE_LIMITED`). On a host without
IPv6, delete its `listen [::]` lines.

### 5. First release and PM2 on boot
```bash
bash /srv/velum/deploy/deploy.sh                        # builds as velum; writes, enables and starts pm2-velum
                                                        # (api + workers) and pm2-velum-web (web); with
                                                        # ONCHAIN_WORKERS=true also builds the signer's copy as
                                                        # velum-signer and starts pm2-velum-signer
```

## Operations
- Status: `sudo bash /srv/velum/deploy/as-user.sh velum pm2 status` (api, workers),
  `sudo bash /srv/velum/deploy/as-user.sh velum-web pm2 status` (web) and
  `sudo bash /srv/velum/deploy/as-user.sh velum-signer pm2 status` (the relayer and keeper, with `ONCHAIN_WORKERS=true`);
  `systemctl status pm2-velum pm2-velum-web pm2-velum-signer` (the daemons).
- Logs: `sudo bash /srv/velum/deploy/as-user.sh velum pm2 logs velum-api --lines 200 --nostream`,
  `sudo bash /srv/velum/deploy/as-user.sh velum-web pm2 logs velum-web --lines 200 --nostream`,
  `sudo bash /srv/velum/deploy/as-user.sh velum-signer pm2 logs velum-signer --lines 200 --nostream`.
  logrotate rotates them daily (`/etc/logrotate.d/velum`, 14 kept, as each user; check it with
  `logrotate -d /etc/logrotate.d/velum`).
- Never `runuser -u velum …`, `su velum` or `sudo -u velum …` from a root shell: use `as-user.sh`.
- Health: `curl -s https://$DOMAIN/api/v1/health | cat -v` (rate limited per client:
  `RATE_LIMIT_HEALTH_PER_MIN`, default 60). `lag` = seconds since the last price tick, `workers` =
  seconds since the workers process last reported alive (a few seconds when healthy, whether or not the
  market has quotes), `signer` = seconds since the signer last wrote its status file (null without one); `onchain`
  combines the indexer (from the workers) with the relayer and keeper (from the signer's status) and lists in
  `reasons` why it is not ok. From the server: `curl -s --unix-socket /run/velum-api/api.sock http://velum-api/v1/health`.
- Releases on disk: `ls -l /srv/velum/releases /srv/velum/current`.
- Backups: nightly from root's crontab, as the velum database role (never as postgres, audit I-3):
  `17 3 * * * bash /srv/velum/deploy/backup-db.sh /var/backups/velum-$(date +\%F).pgdump`; keep 14 days,
  copy off-box.
- Relayer and keeper hot wallets: keep a small ETH balance; `/v1/health` reports `balanceLow` below
  `RELAYER_MIN_BALANCE_ETH` / `KEEPER_MIN_BALANCE_ETH`.
- Updates: `sudo unattended-upgrades` enabled.
