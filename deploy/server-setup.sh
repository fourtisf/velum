#!/usr/bin/env bash
# Phase 2 one-time server setup (docs/05-deploy-vps.md steps 1–4), safe to re-run.
# Run on the VPS from the repo checkout at /opt/velum:
#   sudo DOMAIN=velum.example EMAIL=you@example.com bash deploy/server-setup.sh
# Optional: BRANCH (default: the branch this checkout is on), APP_USER (default: the user who ran sudo), WWW=yes|no|auto.
# It installs Node 20, pnpm 9, PM2, PostgreSQL, Redis, Nginx and Certbot, creates the database,
# writes .env with generated passwords (kept on re-runs), switches Nginx to the full-stack
# config, issues HTTPS, then runs deploy/deploy.sh as APP_USER.
set -euo pipefail
: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=velum.example}"
: "${EMAIL:?Set EMAIL for SSL certificate notices}"
BRANCH="${BRANCH:-$(git -C "$(dirname "$0")/.." rev-parse --abbrev-ref HEAD)}"
WWW="${WWW:-auto}"
APP_USER="${APP_USER:-${SUDO_USER:-root}}"
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
as_app() { if [ "${APP_USER}" = "root" ]; then bash -lc "$*"; else sudo -u "${APP_USER}" -H bash -lc "$*"; fi; }

echo "› Base packages"
apt-get update -y
apt-get install -y git curl ca-certificates nginx certbot python3-certbot-nginx postgresql redis-server ufw dnsutils openssl
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
npm i -g pnpm@9 pm2

echo "› Firewall (keeps your SSH port open)"
for port in $(ss -ltnp | awk '/sshd/ {n=split($4,a,":"); print a[n]}' | sort -u); do ufw allow "${port}/tcp" || true; done
ufw allow OpenSSH || true
ufw allow 'Nginx Full' || true
ufw --force enable || true

echo "› Secrets (.env)"
gen() { openssl rand -hex 24; }
if [ -f .env ]; then
  DB_PASS="$(sed -n 's#^DATABASE_URL=postgresql://velum:\([^@]*\)@.*#\1#p' .env)"
  REDIS_PASS="$(sed -n 's#^REDIS_URL=redis://:\([^@]*\)@.*#\1#p' .env)"
fi
DB_PASS="${DB_PASS:-$(gen)}"
REDIS_PASS="${REDIS_PASS:-$(gen)}"
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i \
    -e "s#^DOMAIN=.*#DOMAIN=${DOMAIN}#" \
    -e "s#^PUBLIC_SITE_URL=.*#PUBLIC_SITE_URL=https://${DOMAIN}#" \
    -e "s#^NEXT_PUBLIC_API_URL=.*#NEXT_PUBLIC_API_URL=https://${DOMAIN}/api#" \
    -e "s#^CORS_ORIGIN=.*#CORS_ORIGIN=https://${DOMAIN},https://www.${DOMAIN}#" \
    -e "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://velum:${DB_PASS}@127.0.0.1:5432/velum?schema=public#" \
    -e "s#^REDIS_URL=.*#REDIS_URL=redis://:${REDIS_PASS}@127.0.0.1:6379#" \
    .env
  echo "  wrote .env (edit it for WalletConnect or a private RPC, then run deploy/deploy.sh)"
fi
chown "${APP_USER}" .env
chmod 600 .env

echo "› PostgreSQL"
systemctl enable --now postgresql
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='velum'" | grep -q 1; then
  sudo -u postgres psql -q -c "ALTER USER velum WITH PASSWORD '${DB_PASS}';"
else
  sudo -u postgres psql -q -c "CREATE USER velum WITH PASSWORD '${DB_PASS}';"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='velum'" | grep -q 1 || sudo -u postgres psql -q -c "CREATE DATABASE velum OWNER velum;"

echo "› Redis (localhost only, password required)"
sed -i -E "s/^#? *requirepass .*/requirepass ${REDIS_PASS}/" /etc/redis/redis.conf
grep -q "^requirepass " /etc/redis/redis.conf || echo "requirepass ${REDIS_PASS}" >> /etc/redis/redis.conf
systemctl enable redis-server
systemctl restart redis-server

echo "› App directory ownership"
chown -R "${APP_USER}" "${ROOT}"

echo "› Nginx (full stack)"
if ss -ltnp 'sport = :80' | grep -v -q -e nginx -e '^State'; then
  echo "Port 80 is used by another program. Stop it (for Apache: systemctl disable --now apache2) and re-run." >&2
  exit 1
fi
sed "s/velum.example/${DOMAIN}/g" deploy/nginx/velum.conf > /etc/nginx/sites-available/velum.conf
ln -sf /etc/nginx/sites-available/velum.conf /etc/nginx/sites-enabled/velum.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "› HTTPS"
SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
WWW_IP="$(dig +short A "www.${DOMAIN}" | tail -n1)"
DOMAINS=(-d "${DOMAIN}")
if [ "${WWW}" = "yes" ] || { [ "${WWW}" = "auto" ] && [ -n "${WWW_IP}" ] && [ "${WWW_IP}" = "${SERVER_IP}" ]; }; then DOMAINS+=(-d "www.${DOMAIN}"); fi
certbot --nginx "${DOMAINS[@]}" -m "${EMAIL}" --agree-tos --redirect -n

echo "› First release"
as_app "cd '${ROOT}' && BRANCH='${BRANCH}' bash deploy/deploy.sh"

echo "› Start PM2 on boot"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "${APP_USER}" --hp "$(getent passwd "${APP_USER}" | cut -d: -f6)" >/dev/null
as_app "pm2 save"
command -v pm2 >/dev/null && as_app "pm2 install pm2-logrotate >/dev/null 2>&1 || true"

echo "✓ Velum Phase 2 is live at https://${DOMAIN}"
echo "  Health: curl https://${DOMAIN}/api/v1/health"
echo "  Later releases: cd ${ROOT} && BRANCH=${BRANCH} bash deploy/deploy.sh"
