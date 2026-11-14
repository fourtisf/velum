# 05 — Deploy on Hostinger VPS (PM2 + Nginx)

Target: Ubuntu 22.04/24.04 VPS, 2 vCPU / 4 GB RAM minimum (8 GB once circuits are compiled
on the box). Domain A record → VPS IP.

## Phase 1: static prototype (5 minutes)

```bash
sudo DOMAIN=velum.example EMAIL=you@example.com bash deploy/phase1-static.sh
```
Installs Nginx + Certbot, copies `prototype/index.html` to `/var/www/velum/`, enables
`deploy/nginx/velum-static.conf`, opens the firewall (keeps your SSH port), issues HTTPS.
`www.` is added only when its A record points at the server (`WWW=yes` to force). It stops with a
clear message if another program (often Apache) holds port 80.

## Phase 2: one command

```bash
cd /opt/velum && DOMAIN=velum.example EMAIL=you@example.com bash deploy/server-setup.sh
```
Runs steps 1–4 below idempotently and is safe on a VPS that already hosts other sites:
- runs Velum as its own `velum` system user with its own PM2 daemon (`pm2-velum` on boot);
- picks free ports (3000/4000, or the next free ones) and binds both apps to 127.0.0.1;
- reuses an existing Redis as-is (its password, if any) on a separate DB number (`REDIS_DB`, default 5),
  and only sets a Redis password when it installed Redis itself;
- creates its own Postgres role and database;
- never upgrades Node or global tools, never enables ufw, never removes other Nginx sites.

It writes `.env` (mode 600, kept on re-runs), adds `velum.conf` to Nginx, issues HTTPS,
runs the first release and enables PM2 on boot. Check it with
`runuser -u velum -- pm2 status`. The manual steps follow (for a fresh, dedicated server).

## Phase 2+: full stack

### 1. Base packages
```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install git nginx certbot python3-certbot-nginx postgresql redis-server ufw
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs
sudo npm i -g pnpm@9 pm2
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw --force enable
```

### 2. Database and Redis
```bash
sudo -u postgres psql -c "CREATE USER velum WITH PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "CREATE DATABASE velum OWNER velum;"
sudo sed -i 's/^# *requirepass .*/requirepass CHANGE_ME_REDIS/' /etc/redis/redis.conf
sudo systemctl restart redis-server
```
Postgres and Redis listen on localhost only (defaults). Do not open 5432/6379 in ufw.

### 3. App
```bash
sudo mkdir -p /opt/velum && sudo chown $USER /opt/velum
git clone <repo-url> /opt/velum && cd /opt/velum
cp .env.example .env && nano .env        # fill every value
pnpm install --frozen-lockfile
pnpm --filter @velum/db prisma migrate deploy
pnpm build
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup                  # run the printed command
```

### 4. Nginx + SSL
```bash
sudo cp deploy/nginx/velum.conf /etc/nginx/sites-available/velum.conf
sudo sed -i "s/velum.example/$DOMAIN/g" /etc/nginx/sites-available/velum.conf
sudo ln -sf /etc/nginx/sites-available/velum.conf /etc/nginx/sites-enabled/velum.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN -m $EMAIL --agree-tos --redirect -n
```

### 5. Releases
```bash
runuser -u velum -- bash -lc 'cd /opt/velum && bash deploy/deploy.sh'
```
(Or `cd /opt/velum && bash deploy/deploy.sh` if you set the server up manually as your own user.)
Pulls the branch the checkout is on (`BRANCH=name` to override), installs, migrates, builds,
reloads PM2 with zero downtime and waits for `/v1/health` and the web root to answer.

`NEXT_PUBLIC_*` values are compiled into the web build, so run a release after changing them.

### 6. Operations
- Logs: `pm2 logs velum-api --lines 200`; rotate with `pm2 install pm2-logrotate`.
- Health: `curl https://$DOMAIN/api/v1/health`.
- Backups: nightly `pg_dump velum | gzip > /var/backups/velum-$(date +%F).sql.gz`
  (cron), keep 14 days, copy off-box.
- Relayer hot wallet: keep a small ETH balance, alert below threshold.
- Updates: `sudo unattended-upgrades` enabled.
