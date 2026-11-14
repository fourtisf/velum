#!/usr/bin/env bash
# Phase 2 server setup (docs/05-deploy-vps.md steps 1–4). Safe to re-run, and safe on a VPS that
# already hosts other sites: it never edits an existing Redis config, never upgrades Node or global
# tools, never enables the firewall, never touches other Nginx sites, and picks free ports.
#
# Run as root from the repo checkout:
#   cd /opt/velum && DOMAIN=velum.example EMAIL=you@example.com bash deploy/server-setup.sh
# Optional: APP_USER (default velum, created if missing), BRANCH (default: current branch),
#           WWW=yes|no|auto, REDIS_DB (default 5, keeps Velum's keys apart from other apps).
set -euo pipefail
: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=velum.example}"
: "${EMAIL:?Set EMAIL for SSL certificate notices}"
[ "$(id -u)" -eq 0 ] || { echo "Run as root (or with sudo)." >&2; exit 1; }
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP_USER="${APP_USER:-velum}"
WWW="${WWW:-auto}"
REDIS_DB="${REDIS_DB:-5}"
BRANCH="${BRANCH:-$(git -c safe.directory="${ROOT}" -C "${ROOT}" rev-parse --abbrev-ref HEAD)}"
as_app() { if [ "${APP_USER}" = "root" ]; then bash -lc "$*"; else runuser -u "${APP_USER}" -- bash -lc "$*"; fi; }
port_free() { ! ss -ltn "( sport = :$1 )" | grep -q LISTEN; }
pick_port() { local p="$1"; while ! port_free "${p}"; do p=$((p + 1)); done; echo "${p}"; }
env_get() { sed -n "s#^$1=##p" .env 2>/dev/null | tail -n1; }

echo "› Packages"
HAD_REDIS=0; command -v redis-server >/dev/null && HAD_REDIS=1
apt-get update -y
apt-get install -y git curl ca-certificates nginx certbot python3-certbot-nginx postgresql redis-server dnsutils openssl
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
elif [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Node $(node -v) is installed; Velum needs 20+. Upgrading it could affect other apps here, so do that yourself first." >&2
  exit 1
fi
command -v pm2 >/dev/null || npm i -g pm2

echo "› App user (${APP_USER})"
if [ "${APP_USER}" != "root" ] && ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "${APP_USER}"
fi
APP_HOME="$(getent passwd "${APP_USER}" | cut -d: -f6)"
chown -R "${APP_USER}:" "${ROOT}"

echo "› Settings (.env)"
gen() { openssl rand -hex 24; }
if [ -f .env ]; then
  echo "  keeping existing .env"
  PORT_WEB="$(env_get PORT_WEB)"; PORT_API="$(env_get PORT_API)"
  DB_PASS="$(sed -n 's#^DATABASE_URL=postgresql://velum:\([^@]*\)@.*#\1#p' .env)"
  REDIS_URL="$(env_get REDIS_URL)"
else
  PORT_WEB="$(pick_port 3000)"
  PORT_API="$(pick_port 4000)"
  [ "${PORT_API}" = "${PORT_WEB}" ] && PORT_API="$(pick_port $((PORT_WEB + 1)))"
  DB_PASS="$(gen)"
  if [ "${HAD_REDIS}" = "1" ]; then
    # Shared Redis: reuse its existing password (if any) and never change its config.
    REDIS_PASS="$(sed -n 's/^requirepass[[:space:]]\+//p' /etc/redis/redis.conf | tail -n1)"
  else
    REDIS_PASS="$(gen)"
    sed -i -E "s/^#? *requirepass .*/requirepass ${REDIS_PASS}/" /etc/redis/redis.conf
    grep -q "^requirepass " /etc/redis/redis.conf || echo "requirepass ${REDIS_PASS}" >> /etc/redis/redis.conf
    systemctl enable redis-server
    systemctl restart redis-server
  fi
  REDIS_URL="redis://${REDIS_PASS:+:${REDIS_PASS}@}127.0.0.1:6379/${REDIS_DB}"
  cp .env.example .env
  sed -i \
    -e "s#^DOMAIN=.*#DOMAIN=${DOMAIN}#" \
    -e "s#^PUBLIC_SITE_URL=.*#PUBLIC_SITE_URL=https://${DOMAIN}#" \
    -e "s#^NEXT_PUBLIC_SITE_URL=.*#NEXT_PUBLIC_SITE_URL=https://${DOMAIN}#" \
    -e "s#^NEXT_PUBLIC_API_URL=.*#NEXT_PUBLIC_API_URL=https://${DOMAIN}/api#" \
    -e "s#^CORS_ORIGIN=.*#CORS_ORIGIN=https://${DOMAIN},https://www.${DOMAIN}#" \
    -e "s#^PORT_WEB=.*#PORT_WEB=${PORT_WEB}#" \
    -e "s#^PORT_API=.*#PORT_API=${PORT_API}#" \
    -e "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://velum:${DB_PASS}@127.0.0.1:5432/velum?schema=public#" \
    -e "s#^REDIS_URL=.*#REDIS_URL=${REDIS_URL}#" \
    .env
  echo "  wrote .env (web :${PORT_WEB}, api :${PORT_API}, redis db ${REDIS_DB})"
fi
PORT_WEB="${PORT_WEB:-3000}"; PORT_API="${PORT_API:-4000}"
chown "${APP_USER}:" .env
chmod 600 .env

echo "› PostgreSQL (own role and database)"
systemctl enable --now postgresql
if [ -n "${DB_PASS}" ]; then
  if runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='velum'" | grep -q 1; then
    runuser -u postgres -- psql -q -c "ALTER USER velum WITH PASSWORD '${DB_PASS}';"
  else
    runuser -u postgres -- psql -q -c "CREATE USER velum WITH PASSWORD '${DB_PASS}';"
  fi
fi
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='velum'" | grep -q 1 || runuser -u postgres -- psql -q -c "CREATE DATABASE velum OWNER velum;"

echo "› Redis check"
REDIS_CHECK_PASS="$(printf '%s' "${REDIS_URL}" | sed -n 's#^redis://[^:/@]*:\([^@]*\)@.*#\1#p')"
REDIS_CHECK_DB="$(printf '%s' "${REDIS_URL}" | sed -n 's#.*/\([0-9][0-9]*\)$#\1#p')"
if [ -n "${REDIS_CHECK_PASS}" ]; then REDIS_PONG="$(REDISCLI_AUTH="${REDIS_CHECK_PASS}" redis-cli -n "${REDIS_CHECK_DB:-0}" ping 2>/dev/null || true)"
else REDIS_PONG="$(redis-cli -n "${REDIS_CHECK_DB:-0}" ping 2>/dev/null || true)"; fi
[ "${REDIS_PONG}" = "PONG" ] || { echo "Cannot reach Redis with REDIS_URL from .env (${REDIS_PONG:-no answer}). Fix REDIS_URL, then re-run." >&2; exit 1; }

echo "› Nginx (adds velumtrade site only; other sites untouched)"
if ss -ltnp 'sport = :80' | grep -v -q -e nginx -e '^State'; then
  echo "Port 80 is used by another program. Stop it, then re-run." >&2
  exit 1
fi
sed -e "s/velum.example/${DOMAIN}/g" -e "s/127.0.0.1:3000/127.0.0.1:${PORT_WEB}/" -e "s/127.0.0.1:4000/127.0.0.1:${PORT_API}/" \
  deploy/nginx/velum.conf > /etc/nginx/sites-available/velum.conf
ln -sf /etc/nginx/sites-available/velum.conf /etc/nginx/sites-enabled/velum.conf
nginx -t
systemctl enable --now nginx
systemctl reload nginx
if ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 'Nginx Full' || true; fi

echo "› HTTPS"
SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
WWW_IP="$(dig +short A "www.${DOMAIN}" | tail -n1)"
DOMAINS=(-d "${DOMAIN}")
if [ "${WWW}" = "yes" ] || { [ "${WWW}" = "auto" ] && [ -n "${WWW_IP}" ] && [ "${WWW_IP}" = "${SERVER_IP}" ]; }; then DOMAINS+=(-d "www.${DOMAIN}"); fi
certbot --nginx "${DOMAINS[@]}" -m "${EMAIL}" --agree-tos --redirect -n

echo "› First release (as ${APP_USER})"
as_app "cd '${ROOT}' && BRANCH='${BRANCH}' bash deploy/deploy.sh"

echo "› PM2 on boot (as ${APP_USER})"
pm2 startup systemd -u "${APP_USER}" --hp "${APP_HOME}" >/dev/null
as_app "pm2 save"
as_app "pm2 install pm2-logrotate >/dev/null 2>&1 || true"

echo "✓ Velum Phase 2 is live at https://${DOMAIN}"
echo "  Status:   runuser -u ${APP_USER} -- pm2 status"
echo "  Logs:     runuser -u ${APP_USER} -- pm2 logs velum-api --lines 100"
echo "  Health:   curl -s https://${DOMAIN}/api/v1/health"
echo "  Releases: runuser -u ${APP_USER} -- bash -lc 'cd ${ROOT} && bash deploy/deploy.sh'"
