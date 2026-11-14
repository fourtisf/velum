#!/usr/bin/env bash
# Phase 2 server setup (docs/05-deploy-vps.md). Safe to re-run, and safe on a VPS that already hosts
# other sites: it installs only missing packages and never upgrades installed ones (so shared Nginx,
# Postgres and Redis are not restarted), never edits an existing Redis config, never upgrades Node or
# global tools, never enables the firewall, never touches other Nginx sites, and picks free ports.
#
# Run as root from a root-owned checkout (root runs its scripts, so the app user must not own them):
#   git clone <repo-url> /opt/velum && cd /opt/velum
#   DOMAIN=velum.example EMAIL=you@example.com bash deploy/server-setup.sh
# Optional: APP_USER (default velum, created if missing), BRANCH (default: current branch),
#           WWW=yes|no|auto, REDIS_DB (default 5, keeps Velum's keys apart from other apps),
#           REDIS_PORT (default 6379), REDIS_CONF (default /etc/redis/redis.conf), NGINX_DIR (default /etc/nginx),
#           ALLOW_REDIS_WITHOUT_PASSWORD=yes (accept a shared Redis without a password; not recommended).
set -euo pipefail
umask 022
: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=velum.example}"
: "${EMAIL:?Set EMAIL for SSL certificate notices}"
[ "$(id -u)" -eq 0 ] || { echo "Run as root (or with sudo)." >&2; exit 1; }
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "${SELF}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${ROOT}/deploy/lib/common.sh"
cd "${ROOT}"
APP_USER="${APP_USER:-velum}"
WWW="${WWW:-auto}"
REDIS_DB="${REDIS_DB:-5}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_CONF="${REDIS_CONF:-/etc/redis/redis.conf}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
ENV_FILE="${ROOT}/.env"
[[ "${DOMAIN}" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || die "DOMAIN must be a host name such as velum.example."
[[ "${EMAIL}" =~ ^[^[:space:]@\"\']+@[^[:space:]@\"\']+$ ]] || die "EMAIL does not look like an email address."
[[ "${APP_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "APP_USER must be a plain user name."
[[ "${REDIS_DB}" =~ ^[0-9]{1,3}$ ]] || die "REDIS_DB must be a number."
valid_port "${REDIS_PORT}" || die "REDIS_PORT must be a port number."

pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
port_free() { ! ss -ltn "( sport = :$1 )" | grep -q LISTEN; }
pick_port() { local p="$1"; while ! port_free "${p}"; do p=$((p + 1)); done; echo "${p}"; }
gen() { openssl rand -hex 24; }
# URL helpers: values go through the environment, never the command line.
url_encode() { VELUM_V="$1" node -e 'process.stdout.write(encodeURIComponent(process.env.VELUM_V))'; }
url_password() { VELUM_V="$1" node -e 'try { process.stdout.write(decodeURIComponent(new URL(process.env.VELUM_V).password)); } catch { process.exit(1); }'; }
url_with_password() { VELUM_V="$1" VELUM_P="$2" node -e 'const u = new URL(process.env.VELUM_V); u.password = encodeURIComponent(process.env.VELUM_P); process.stdout.write(u.href);'; }
app_pm2() { runuser -u "${APP_USER}" -- env -i HOME="${APP_HOME}" PATH="${PATH}" PM2_HOME="${APP_HOME}/.pm2" LANG="${LANG:-C.UTF-8}" pm2 "$@"; }

echo "› Checkout ownership"
# Root runs this checkout's scripts: nothing in it may be changeable by the app user (audit M4).
bad="$(find "${ROOT}" -xdev \( -path "${ROOT}/releases" -o -path "${ENV_FILE}" -o -path "${ROOT}/.deploy.lock" -o -name '.env.bak.*' \) -prune -o \
  ! -type l \( ! -user root -o -perm -0002 -o \( -perm -0020 ! -group root \) \) -print -quit)"
if [ -n "${bad}" ]; then
  die "${bad} is not root-owned (or is writable by others). Make the checkout root-owned first:
  chown -R root:root ${ROOT}, then review git as described in docs/05-deploy-vps.md (Upgrading), then re-run."
fi
BRANCH="${BRANCH:-$(git -C "${ROOT}" rev-parse --abbrev-ref HEAD)}"

echo "› Port 80"
# Before installing anything: if another web server owns port 80, installing Nginx would fail (audit L11).
if ss -ltnp 'sport = :80' | grep -v -e nginx -e '^State' | grep -q .; then
  ss -ltnp 'sport = :80' >&2
  die "Port 80 is used by another program (often Apache: systemctl disable --now apache2). Stop it, then re-run."
fi

echo "› Packages (installs missing ones only; installed packages are never upgraded)"
HAD_REDIS=0
if pkg_installed redis-server || command -v redis-server >/dev/null || ! port_free "${REDIS_PORT}"; then HAD_REDIS=1; fi
want=(git curl ca-certificates nginx certbot python3-certbot-nginx postgresql dnsutils openssl)
[ "${HAD_REDIS}" = "1" ] || want+=(redis-server)
missing=()
for p in "${want[@]}"; do pkg_installed "${p}" || missing+=("${p}"); done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "  installing: ${missing[*]}"
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-upgrade "${missing[@]}"
else
  echo "  all present"
fi
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-upgrade nodejs
elif [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  die "Node $(node -v) is installed; Velum needs 20+. Upgrading it could affect other apps here, so do that yourself first."
fi
command -v pm2 >/dev/null || npm i -g pm2

echo "› App user (${APP_USER})"
if [ "${APP_USER}" != "root" ] && ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "${APP_USER}"
fi
APP_HOME="${APP_HOME:-$(getent passwd "${APP_USER}" | cut -d: -f6)}"
APP_GROUP="$(id -gn "${APP_USER}")"
# PM2's home holds dump.pm2 (process env, incl. the workers' secrets) and logs: owner only (audit M5).
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 700 "${APP_HOME}/.pm2"
chmod 700 "${APP_HOME}/.pm2"

echo "› Layout (root-owned checkout, app-owned releases)"
chown root:"${APP_GROUP}" "${ROOT}"
chmod 750 "${ROOT}"
install -d -o root -g "${APP_GROUP}" -m 750 "${ROOT}/releases"

echo "› Settings (.env)"
OLD_UMASK="$(umask)"
umask 077
if [ -f "${ENV_FILE}" ]; then
  echo "  keeping existing .env"
  PORT_WEB="$(env_get "${ENV_FILE}" PORT_WEB)"
  PORT_API="$(env_get "${ENV_FILE}" PORT_API)"
  REDIS_URL="$(env_get "${ENV_FILE}" REDIS_URL)"
  DATABASE_URL="$(env_get "${ENV_FILE}" DATABASE_URL)"
  DB_PASS="$(url_password "${DATABASE_URL}")" || die "DATABASE_URL in .env is not a valid URL."
  if [ -z "${DB_PASS}" ] || [ "${DB_PASS}" = "CHANGE_ME" ]; then
    DB_PASS="$(gen)"
    backup="$(env_backup "${ENV_FILE}")"
    env_set "${ENV_FILE}" DATABASE_URL "$(url_with_password "${DATABASE_URL}" "${DB_PASS}")"
    echo "  generated a new database password (previous .env kept as ${backup##*/})"
  fi
else
  PORT_WEB="$(pick_port 3000)"
  PORT_API="$(pick_port 4000)"
  [ "${PORT_API}" = "${PORT_WEB}" ] && PORT_API="$(pick_port $((PORT_WEB + 1)))"
  DB_PASS="$(gen)"
  if [ "${HAD_REDIS}" = "1" ]; then
    # Shared Redis: reuse its existing password (if any) and never change its config.
    REDIS_PASS="$(sed -n 's/^[[:space:]]*requirepass[[:space:]]\+//p' "${REDIS_CONF}" 2>/dev/null | tail -n1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/')"
  else
    REDIS_PASS="$(gen)"
    # Velum installed this Redis itself: the generated password is hex, so sed is safe here.
    sed -i -E "s/^#? *requirepass .*/requirepass ${REDIS_PASS}/" "${REDIS_CONF}"
    grep -q "^requirepass " "${REDIS_CONF}" || echo "requirepass ${REDIS_PASS}" >>"${REDIS_CONF}"
    systemctl enable redis-server
    systemctl restart redis-server
  fi
  REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/${REDIS_DB}"
  [ -z "${REDIS_PASS}" ] || REDIS_URL="redis://:$(url_encode "${REDIS_PASS}")@127.0.0.1:${REDIS_PORT}/${REDIS_DB}"
  # Built in a temp file (mode 600) with awk + ENVIRON (no sed, so any character in a value is
  # safe), validated, then moved into place in one step (audit M3).
  TMP="${ENV_FILE}.tmp"
  rm -f "${TMP}"
  cp .env.example "${TMP}"
  chmod 600 "${TMP}"
  env_set "${TMP}" \
    DOMAIN "${DOMAIN}" \
    PUBLIC_SITE_URL "https://${DOMAIN}" \
    NEXT_PUBLIC_SITE_URL "https://${DOMAIN}" \
    NEXT_PUBLIC_API_URL "https://${DOMAIN}/api" \
    CORS_ORIGIN "https://${DOMAIN},https://www.${DOMAIN}" \
    PORT_WEB "${PORT_WEB}" \
    PORT_API "${PORT_API}" \
    DATABASE_URL "postgresql://velum:${DB_PASS}@127.0.0.1:5432/velum?schema=public" \
    REDIS_URL "${REDIS_URL}"
  # Validate before it goes live: every value reads back exactly as intended.
  [ "$(env_get "${TMP}" DOMAIN)" = "${DOMAIN}" ] || die "Validation failed: DOMAIN."
  [ "$(env_get "${TMP}" PORT_WEB)" = "${PORT_WEB}" ] && [ "$(env_get "${TMP}" PORT_API)" = "${PORT_API}" ] || die "Validation failed: ports."
  [ "$(url_password "$(env_get "${TMP}" DATABASE_URL)")" = "${DB_PASS}" ] || die "Validation failed: DATABASE_URL."
  [ "$(url_password "$(env_get "${TMP}" REDIS_URL)")" = "${REDIS_PASS}" ] || die "Validation failed: REDIS_URL does not carry the Redis password."
  render_security_headers "${TMP}" >/dev/null || die "Validation failed: NEXT_PUBLIC_RPC_URL."
  mv -f "${TMP}" "${ENV_FILE}"
  echo "  wrote .env (web :${PORT_WEB}, api :${PORT_API}, redis db ${REDIS_DB})"
fi
umask "${OLD_UMASK}"
valid_port "${PORT_WEB:-}" || PORT_WEB=3000
valid_port "${PORT_API:-}" || PORT_API=4000
# Root writes .env; the app user can only read it (set-network.sh and new-key.sh run as root).
chown root:"${APP_GROUP}" "${ENV_FILE}"
chmod 640 "${ENV_FILE}"

echo "› PostgreSQL (own role and database)"
systemctl is-active --quiet postgresql || systemctl enable --now postgresql
psql_() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; }
ROLE_EXISTS="$(psql_ -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'velum'")"
if [[ "${DB_PASS}" =~ ^[0-9a-f]{32,128}$ ]]; then
  VERB=ALTER
  [ "${ROLE_EXISTS}" = "1" ] || VERB=CREATE
  # The password reaches psql on stdin as a variable (audit M4, L8): never on a command line (ps),
  # quoted by psql itself (:'p'), with statement logging off so it never lands in the server log.
  {
    printf '\\set p %s\n' "${DB_PASS}"
    printf "SET log_statement = 'none';\nSET log_min_duration_statement = -1;\n"
    printf "%s ROLE velum WITH LOGIN PASSWORD :'p';\n" "${VERB}"
  } | psql_
elif [ "${ROLE_EXISTS}" = "1" ]; then
  warn "The DATABASE_URL password is not a generated hex value; leaving the velum role's password as it is."
else
  die "The DATABASE_URL password in .env is not a hex value. Remove it (postgresql://velum:@…) or set it to CHANGE_ME to have one generated, then re-run."
fi
[ "$(psql_ -tAc "SELECT 1 FROM pg_database WHERE datname = 'velum'")" = "1" ] || psql_ -c "CREATE DATABASE velum OWNER velum;"

echo "› Redis check"
read -r R_HOST R_PORT R_DB < <(VELUM_V="${REDIS_URL}" node -e '
  const u = new URL(process.env.VELUM_V);
  console.log(u.hostname || "127.0.0.1", u.port || "6379", u.pathname.replace(/^\//, "") || "0");') || die "REDIS_URL in .env is not a valid URL."
R_PASS="$(url_password "${REDIS_URL}")" || die "REDIS_URL in .env is not a valid URL."
rcli() {
  if [ -n "${R_PASS}" ]; then REDISCLI_AUTH="${R_PASS}" redis-cli -h "${R_HOST}" -p "${R_PORT}" -n "${R_DB}" "$@"
  else env -u REDISCLI_AUTH redis-cli -h "${R_HOST}" -p "${R_PORT}" -n "${R_DB}" "$@"; fi
}
REDIS_PONG="$(rcli ping 2>/dev/null || true)"
[ "${REDIS_PONG}" = "PONG" ] || die "Cannot reach Redis with REDIS_URL from .env (${REDIS_PONG:-no answer}). Fix REDIS_URL, then re-run."
if [ -z "${R_PASS}" ]; then
  # A shared Redis without a password lets every local program read and change Velum's data (audit L5).
  if [ "${ALLOW_REDIS_WITHOUT_PASSWORD:-}" = "yes" ]; then
    warn "Redis has no password (ALLOW_REDIS_WITHOUT_PASSWORD=yes). Any program on this server can read and change Velum's data."
  else
    die "This Redis answers without a password, so any program on this server can read and change Velum's data.
  Set requirepass in its config (for a shared Redis, with its owner), put it in REDIS_URL (redis://:PASSWORD@127.0.0.1:6379/${REDIS_DB}; URL-encode special characters) and re-run.
  To accept the risk anyway: ALLOW_REDIS_WITHOUT_PASSWORD=yes."
  fi
fi
POLICY="$(rcli config get maxmemory-policy 2>/dev/null | sed -n 2p || true)"
case "${POLICY}" in
  noeviction) echo "  maxmemory-policy noeviction" ;;
  "") warn "Could not read Redis maxmemory-policy (CONFIG may be disabled). BullMQ needs noeviction; check it with the Redis owner." ;;
  *) warn "Redis maxmemory-policy is '${POLICY}'. BullMQ (Velum's job queues) needs 'noeviction': under memory pressure this Redis can silently drop Velum's queue keys. Ask the Redis owner to change it, or give Velum its own Redis." ;;
esac

echo "› Nginx (adds the velum site and its headers snippet only; other sites untouched)"
install -d -m 755 "${NGINX_DIR}/snippets" "${NGINX_DIR}/sites-available" "${NGINX_DIR}/sites-enabled"
render_security_headers "${ENV_FILE}" >"${NGINX_DIR}/snippets/velum-security-headers.conf.tmp" || die "Fix NEXT_PUBLIC_RPC_URL in .env, then re-run."
mv -f "${NGINX_DIR}/snippets/velum-security-headers.conf.tmp" "${NGINX_DIR}/snippets/velum-security-headers.conf"
sed -e "s/velum.example/${DOMAIN}/g" -e "s/127.0.0.1:3000/127.0.0.1:${PORT_WEB}/" -e "s/127.0.0.1:4000/127.0.0.1:${PORT_API}/" \
  deploy/nginx/velum.conf >"${NGINX_DIR}/sites-available/velum.conf"
ln -sf "${NGINX_DIR}/sites-available/velum.conf" "${NGINX_DIR}/sites-enabled/velum.conf"
nginx -t
systemctl is-active --quiet nginx || systemctl enable --now nginx
systemctl reload nginx
if ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 'Nginx Full' || true; fi

echo "› HTTPS"
SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
WWW_IP="$(dig +short A "www.${DOMAIN}" | tail -n1)"
DOMAINS=(-d "${DOMAIN}")
if [ "${WWW}" = "yes" ] || { [ "${WWW}" = "auto" ] && [ -n "${WWW_IP}" ] && [ "${WWW_IP}" = "${SERVER_IP}" ]; }; then DOMAINS+=(-d "www.${DOMAIN}"); fi
certbot --nginx "${DOMAINS[@]}" -m "${EMAIL}" --agree-tos --redirect -n

echo "› First release (builds and runs as ${APP_USER})"
APP_USER="${APP_USER}" APP_HOME="${APP_HOME}" BRANCH="${BRANCH}" NGINX_SNIPPET="${NGINX_DIR}/snippets/velum-security-headers.conf" bash "${ROOT}/deploy/deploy.sh"

echo "› PM2 on boot (as ${APP_USER})"
env -i PATH="${PATH}" HOME=/root pm2 startup systemd -u "${APP_USER}" --hp "${APP_HOME}" >/dev/null
app_pm2 install pm2-logrotate >/dev/null 2>&1 || true
app_pm2 save >/dev/null

echo "✓ Velum Phase 2 is live at https://${DOMAIN}"
echo "  Status:   runuser -u ${APP_USER} -- pm2 status"
echo "  Logs:     runuser -u ${APP_USER} -- pm2 logs velum-api --lines 100"
echo "  Health:   curl -s https://${DOMAIN}/api/v1/health"
echo "  Releases: sudo bash ${ROOT}/deploy/deploy.sh   (roll back: sudo bash ${ROOT}/deploy/deploy.sh --rollback)"
