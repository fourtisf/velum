# 05 — Deploy on Hostinger VPS (PM2 + Nginx)

Target: Ubuntu 22.04/24.04 VPS, 2 vCPU / 4 GB RAM minimum (8 GB once circuits are compiled
on the box). Domain A record → VPS IP.

## Phase 1: static prototype (5 minutes)

```bash
sudo DOMAIN=velum.example EMAIL=you@example.com bash deploy/phase1-static.sh
```
Installs Nginx + Certbot, copies `prototype/index.html` to `/var/www/velum/`, enables
`deploy/nginx/velum-static.conf`, issues HTTPS.

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
cd /opt/velum && bash deploy/deploy.sh
```
Pulls, installs, migrates, builds, reloads PM2 with zero downtime.

### 6. Operations
- Logs: `pm2 logs velum-api --lines 200`; rotate with `pm2 install pm2-logrotate`.
- Health: `curl https://$DOMAIN/api/v1/health`.
- Backups: nightly `pg_dump velum | gzip > /var/backups/velum-$(date +%F).sql.gz`
  (cron), keep 14 days, copy off-box.
- Relayer hot wallet: keep a small ETH balance, alert below threshold.
- Updates: `sudo unattended-upgrades` enabled.
