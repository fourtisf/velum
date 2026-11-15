#!/usr/bin/env bash
# Phase 2 server setup (docs/05-deploy-vps.md). Safe to re-run, and safe on a VPS that already hosts
# other sites: it installs only missing packages and never upgrades installed ones (so shared Nginx,
# Postgres and Redis are not restarted), never edits an existing Redis config, never upgrades Node or
# global tools, never enables the firewall, never touches other Nginx sites, and picks free ports.
#
# Run as root (inside tmux) from a fresh root-owned clone; root runs its scripts, so no other user may
# own them:
#   git -c core.hooksPath=/dev/null clone <repo-url> /srv/velum
#   DOMAIN=velum.example EMAIL=you@example.com bash /srv/velum/deploy/server-setup.sh
# Moving from an older in-place layout (/opt/velum owned by velum): follow docs/05 "Upgrading"
# (fresh clone, deploy/import-env.sh, then this script).
# Optional: APP_USER (default velum, created if missing), WEB_USER (default velum-web, created if
#           missing; both are recorded in <base>/.velum-users and every other script uses them from
#           there; giving other names moves the install to new users, docs/05 "Compromise suspected"),
#           BRANCH (default: current branch), WWW=yes|no|auto, REDIS_DB (default 5, keeps
#           Velum's keys apart from other apps), REDIS_PORT (default 6379), REDIS_CONF (default
#           /etc/redis/redis.conf), PG_PORT (default 5432, the local PostgreSQL to use), NGINX_DIR
#           (default /etc/nginx), NGINX_USER (default: nginx.conf's user, else www-data; the only other
#           user that may reach the API socket), ALLOW_REDIS_WITHOUT_PASSWORD=yes (accept a shared
#           Redis without a password; not recommended).
# shellcheck disable=SC2015 # "A && B || die" is the intended idiom here: die exits.
set -euo pipefail
umask 022
# A dropped SSH session must not stop setup halfway (R2-L6); run it in tmux anyway.
trap '' HUP
: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=velum.example}"
: "${EMAIL:?Set EMAIL for SSL certificate notices}"
[ "$(id -u)" -eq 0 ] || { echo "Run as root (or with sudo)." >&2; exit 1; }
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "${SELF}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${ROOT}/deploy/lib/common.sh"
cd "${ROOT}"
# The users this base was installed with (recorded below), unless APP_USER/WEB_USER name new ones.
PREV_APP_USER="$(recorded_user "${ROOT}" APP_USER)"
PREV_WEB_USER="$(recorded_user "${ROOT}" WEB_USER)"
APP_USER="${APP_USER:-${PREV_APP_USER:-velum}}"
WEB_USER="${WEB_USER:-${PREV_WEB_USER:-velum-web}}"
WWW="${WWW:-auto}"
REDIS_DB="${REDIS_DB:-5}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_CONF="${REDIS_CONF:-/etc/redis/redis.conf}"
PG_PORT="${PG_PORT:-5432}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
ENV_FILE="${ROOT}/.env"
BACKUPS="${ROOT}/backups"
[[ "${DOMAIN}" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || die "DOMAIN must be a host name such as velum.example."
[[ "${EMAIL}" =~ ^[^[:space:]@\"\']+@[^[:space:]@\"\']+$ ]] || die "EMAIL does not look like an email address."
[[ "${APP_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [[ "${WEB_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "APP_USER and WEB_USER must be plain user names."
[ "${APP_USER}" != root ] && [ "${WEB_USER}" != root ] && [ "${APP_USER}" != "${WEB_USER}" ] || die "APP_USER and WEB_USER must be two different users, neither of them root."
[[ "${REDIS_DB}" =~ ^[0-9]{1,3}$ ]] || die "REDIS_DB must be a number."
valid_port "${REDIS_PORT}" || die "REDIS_PORT must be a port number."
valid_port "${PG_PORT}" || die "PG_PORT must be a port number."
case "${WWW}" in yes | no | auto) ;; *) die "WWW must be yes, no or auto." ;; esac

pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
port_free() { ! ss -ltn "( sport = :$1 )" | grep -q LISTEN; }
pick_port() { local p="$1"; while ! port_free "${p}"; do p=$((p + 1)); done; echo "${p}"; }
gen() { openssl rand -hex 24; }
# URL helpers: values go through the environment, never the command line.
url_encode() { VELUM_V="$1" node -e 'process.stdout.write(encodeURIComponent(process.env.VELUM_V))'; }
url_password() { VELUM_V="$1" node -e 'try { process.stdout.write(decodeURIComponent(new URL(process.env.VELUM_V).password)); } catch { process.exit(1); }'; }
url_with_password() { VELUM_V="$1" VELUM_P="$2" node -e 'const u = new URL(process.env.VELUM_V); u.password = encodeURIComponent(process.env.VELUM_P); process.stdout.write(u.href);'; }

echo "› Checkout (root-owned, no links, strict .git/config)"
# Root runs this checkout's scripts and git: nothing in it may be changeable by another user (M4, R2-H2).
VELUM_BASE_DIR="${ROOT}"
assert_root_owned_tree "${ROOT}"
# The same lock as deploy.sh, held while .env and the Nginx files are rewritten and through the first
# release (deploy.sh inherits it), so a concurrent deploy, set-network.sh or new-key.sh waits (R2-L7).
lock_deploy "${ROOT}"
BRANCH="${BRANCH:-$(root_git rev-parse --abbrev-ref HEAD)}"
valid_branch "${BRANCH}" || die "Invalid branch name: ${BRANCH}"

echo "› Port 80"
# Before installing anything: if another web server owns port 80, installing Nginx would fail (audit L11).
if ss -ltnp 'sport = :80' | grep -v -e nginx -e '^State' | grep -q .; then
  ss -ltnp 'sport = :80' >&2
  die "Port 80 is used by another program (often Apache: systemctl disable --now apache2). Stop it, then re-run."
fi

echo "› Packages (installs missing ones only; installed packages are never upgraded)"
HAD_REDIS=0
if pkg_installed redis-server || command -v redis-server >/dev/null || ! port_free "${REDIS_PORT}"; then HAD_REDIS=1; fi
want=(git curl ca-certificates nginx certbot python3-certbot-nginx postgresql dnsutils openssl logrotate)
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
# Node: installed only when missing (a fresh server), as Node 22 LTS from the NodeSource apt repository
# with its signing key in /etc/apt/keyrings (no `curl | bash`, SC-06). An installed Node is never
# upgraded: other sites may use it (docs/05-deploy-vps.md, "Moving to Node 22 (shared server)").
NODE_MAJOR=22
PM2_VERSION=6.0.14
if ! command -v node >/dev/null; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc.velum-new
  grep -q -- '-----BEGIN PGP PUBLIC KEY BLOCK-----' /etc/apt/keyrings/nodesource.asc.velum-new || { rm -f /etc/apt/keyrings/nodesource.asc.velum-new; die "The NodeSource signing key download is not a public key; nothing was installed."; }
  chmod 644 /etc/apt/keyrings/nodesource.asc.velum-new
  mv -f /etc/apt/keyrings/nodesource.asc.velum-new /etc/apt/keyrings/nodesource.asc
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_%s.x nodistro main\n' "${NODE_MAJOR}" >/etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-upgrade nodejs
elif ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 11) ? 0 : 1)'; then
  die "Node $(node -v) is installed; Velum needs 20.11+ (22 recommended). Upgrading it could affect other apps here, so do that yourself first (docs/05-deploy-vps.md, \"Moving to Node 22 (shared server)\")."
fi
command -v pm2 >/dev/null || npm i -g "pm2@${PM2_VERSION}"

echo "› Users (${APP_USER} builds and runs api + workers; ${WEB_USER} runs only the web)"
# Moving to new users (audit R3-05): the old ones must be stopped first, or their apps would keep the
# ports and the API socket (and they may be the reason for the move).
for u in ${PREV_APP_USER} ${PREV_WEB_USER}; do
  if [ "${u}" != "${APP_USER}" ] && [ "${u}" != "${WEB_USER}" ] && id -u "${u}" >/dev/null 2>&1 && [ -n "$(ps -u "${u}" -o pid= 2>/dev/null)" ]; then
    die "This base ran as ${PREV_APP_USER}/${PREV_WEB_USER}, and ${u} still has running processes. Stop and lock the old users first (docs/05-deploy-vps.md, \"Compromise suspected\"), then re-run."
  fi
done
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "${APP_USER}"
fi
if ! id -u "${WEB_USER}" >/dev/null 2>&1; then
  # Own group, no login shell, not in the app group (which can read .env) (R2-M3).
  useradd --system --create-home --user-group --shell /usr/sbin/nologin "${WEB_USER}"
fi
# Validates both users and homes (real directories owned by their user), refuses a web user that is in
# the app group, sets APP_HOME, WEB_HOME, PM2_DIR, WEB_PM2_DIR, SEPARATE=1.
velum_mode "${ROOT}" setup
[ -z "${PREV_APP_USER}" ] || [ "${PREV_APP_USER}/${PREV_WEB_USER}" = "${APP_USER}/${WEB_USER}" ] || say "Moving this install from ${PREV_APP_USER}/${PREV_WEB_USER} to ${APP_USER}/${WEB_USER}"
printf '# Written by deploy/server-setup.sh: the users this base runs as. Change them only with server-setup.sh.\nAPP_USER=%s\nWEB_USER=%s\n' "${APP_USER}" "${WEB_USER}" | install_file "${ROOT}/${VELUM_USERS_FILE}" 644 root:root
read -r NGINX_RUN_USER NGINX_RUN_GROUP < <(nginx_user_group "${NGINX_DIR}" || true; echo)
[ -n "${NGINX_RUN_USER:-}" ] || die "Cannot tell which user Nginx runs as (no usable 'user' line in ${NGINX_DIR}/nginx.conf). Set NGINX_USER=…"
[ "${NGINX_RUN_GROUP}" != "${APP_GROUP}" ] && [ "${NGINX_RUN_GROUP}" != "${WEB_GROUP}" ] && [ "${NGINX_RUN_USER}" != "${WEB_USER}" ] || die "Nginx must run as its own user and group, not as ${APP_USER} or ${WEB_USER}."
# PM2 homes hold dump.pm2 (each app's environment) and logs: owner only (M5). Created and chmod'ed as
# each user, never by root through a path that user controls (R2-H1).
# shellcheck disable=SC2016
as_app sh -c 'mkdir -p "$PM2_HOME" && chmod 700 "$PM2_HOME"'
# shellcheck disable=SC2016
as_web sh -c 'mkdir -p "$PM2_HOME" && chmod 700 "$PM2_HOME"'

echo "› Layout (root-owned base, app-owned releases)"
# Others may traverse the base (the web user reaches web.env and current/ that way) but not list it;
# .env stays root:${APP_GROUP} 640 and web.env root:${WEB_GROUP} 640.
chown root:"${APP_GROUP}" "${ROOT}"
chmod 751 "${ROOT}"
install -d -o root -g root -m 751 "${ROOT}/releases"
install -d -o root -g root -m 700 "${BACKUPS}"

echo "› Settings (.env)"
OLD_UMASK="$(umask)"
umask 077
if [ -f "${ENV_FILE}" ]; then
  [ ! -L "${ENV_FILE}" ] || die "${ENV_FILE} is a symbolic link."
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
  if [ -z "$(env_get "${ENV_FILE}" API_SOCKET)" ]; then
    backup="$(env_backup "${ENV_FILE}")"
    env_set "${ENV_FILE}" API_SOCKET "${API_SOCKET_DEFAULT}"
    echo "  the API now listens on ${API_SOCKET_DEFAULT} (previous .env kept as ${backup##*/})"
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
  TMP="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  cat .env.example >"${TMP}"
  env_set "${TMP}" \
    DOMAIN "${DOMAIN}" \
    PUBLIC_SITE_URL "https://${DOMAIN}" \
    NEXT_PUBLIC_SITE_URL "https://${DOMAIN}" \
    NEXT_PUBLIC_API_URL "https://${DOMAIN}/api" \
    CORS_ORIGIN "https://${DOMAIN},https://www.${DOMAIN}" \
    PORT_WEB "${PORT_WEB}" \
    PORT_API "${PORT_API}" \
    API_SOCKET "${API_SOCKET_DEFAULT}" \
    DATABASE_URL "postgresql://velum:${DB_PASS}@127.0.0.1:${PG_PORT}/velum?schema=public" \
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
# Root writes .env; the app user can only read it (set-network.sh, new-key.sh, import-env.sh run as root).
chown root:"${APP_GROUP}" "${ENV_FILE}"
chmod 640 "${ENV_FILE}"
env_backups_tidy "${ENV_FILE}"
rm -f "${ENV_FILE}.tmp" "${ENV_FILE}".tmp.* 2>/dev/null || true
# Nginx's shared secret for the API (R2-I4). A new one goes into .env only after Nginx sends it (below),
# so the API never distrusts a proxy that does not know the secret yet.
PROXY_SECRET="$(env_get "${ENV_FILE}" PROXY_SECRET)"
NEW_PROXY_SECRET=0
if ! [[ "${PROXY_SECRET}" =~ ^[0-9a-fA-F]{32,128}$ ]]; then
  PROXY_SECRET="$(openssl rand -hex 32)"
  NEW_PROXY_SECRET=1
fi
# The web's own settings (no secrets), readable by the web user only (R2-M3).
render_web_env "${ENV_FILE}" | install_file "${ROOT}/web.env" 640 "root:${WEB_GROUP}"

echo "› API socket directory (${NGINX_RUN_USER} and ${APP_USER} only) and log rotation"
API_SOCKET_PATH="$(env_get "${ENV_FILE}" API_SOCKET)"
valid_api_socket "${API_SOCKET_PATH}" || die "API_SOCKET in .env must look like /run/<dir>/<name>.sock (default ${API_SOCKET_DEFAULT})."
# Root-created at every boot (tmpfiles.d) before the PM2 units start (R3-03).
install -d -m 755 "$(dirname "${TMPFILES_CONF}")"
render_tmpfiles "${API_SOCKET_PATH}" "${APP_USER}" "${NGINX_RUN_GROUP}" | install_file "${TMPFILES_CONF}" 644 root:root
apply_tmpfiles "${API_SOCKET_PATH}"
# PM2 logs rotated by logrotate as each user, never by root, never through npm or /tmp (R3-02).
install -d -m 755 "$(dirname "${LOGROTATE_CONF}")"
render_logrotate "${APP_USER}" "${WEB_USER}" | install_file "${LOGROTATE_CONF}" 644 root:root

echo "› PostgreSQL (own role and database)"
systemctl is-active --quiet postgresql || systemctl enable --now postgresql
# As postgres in a new session without this terminal, with a clean environment (R3-01, I-1); -X: no
# ~postgres/.psqlrc.
psql_() { run_isolated runuser -u postgres -- env -i PATH="${PATH}" HOME="$(getent passwd postgres | cut -d: -f6)" LANG=C.UTF-8 psql -p "${PG_PORT}" -X -q -v ON_ERROR_STOP=1 "$@"; }
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
# REDIS_URL is TCP (redis://, the shared Redis) or a unix socket (unix://:PASSWORD@/run/…/redis.sock[?db=N],
# the dedicated Redis of deploy/redis-velum.sh). Lines: socket path or "-", host, port, db, password.
mapfile -t R < <(VELUM_V="${REDIS_URL}" node -e '
  const s = process.env.VELUM_V || "";
  const dec = (v) => decodeURIComponent(v || "");
  const m = /^(?:redis\+)?unix:\/\/(?:([^/?#]*)@)?(\/[^?#]*)(?:\?([^#]*))?$/i.exec(s);
  let out;
  if (m) {
    const q = new URLSearchParams(m[3] || "");
    const auth = m[1] || "";
    const pass = auth.includes(":") ? dec(auth.slice(auth.indexOf(":") + 1)) : (q.get("password") || "");
    out = [m[2], "-", "-", q.get("db") || "0", pass];
  } else {
    const u = new URL(s);
    if (!/^rediss?:$/.test(u.protocol)) throw new Error();
    out = ["-", u.hostname || "127.0.0.1", u.port || "6379", u.pathname.replace(/^\//, "") || "0", dec(u.password)];
  }
  if (out.some((v) => v.includes("\n")) || !/^\d{1,2}$/.test(out[3])) throw new Error();
  process.stdout.write(out.join("\n") + "\n");' 2>/dev/null)
[ "${#R[@]}" -eq 5 ] || die "REDIS_URL in .env is not a valid redis:// or unix:// URL."
R_SOCK="${R[0]}" R_HOST="${R[1]}" R_PORT="${R[2]}" R_DB="${R[3]}" R_PASS="${R[4]}"
rcli() {
  local where=(-h "${R_HOST}" -p "${R_PORT}")
  [ "${R_SOCK}" = "-" ] || where=(-s "${R_SOCK}")
  if [ -n "${R_PASS}" ]; then REDISCLI_AUTH="${R_PASS}" redis-cli "${where[@]}" -n "${R_DB}" "$@"
  else env -u REDISCLI_AUTH redis-cli "${where[@]}" -n "${R_DB}" "$@"; fi
}
REDIS_PONG="$(rcli ping 2>/dev/null || true)"
# (The reply is shown without control characters: whoever answers on that address wrote it, final audit L-1.)
[ "${REDIS_PONG}" = "PONG" ] || die "Cannot reach Redis with REDIS_URL from .env ($(printf '%s' "${REDIS_PONG:-no answer}" | tty_sanitize)). Fix REDIS_URL, then re-run."
if [ "${R_SOCK}" != "-" ]; then
  # Velum's own Redis (deploy/redis-velum.sh): root reaches any socket, but only the app user's group may
  # enter its directory. After a move to new users (docs/05, "Compromise suspected") it still admits the
  # old group, so the first release would fail (final audit M-2).
  R_GROUP="$(stat -c %G "$(dirname "${R_SOCK}")" 2>/dev/null || true)"
  [ "${R_GROUP}" = "${APP_GROUP}" ] || die "REDIS_URL names Velum's own Redis, but its socket directory $(dirname "${R_SOCK}") admits group ${R_GROUP:-?}, not ${APP_GROUP}. Run: bash ${ROOT}/deploy/redis-velum.sh --rotate (new password; the socket follows ${APP_USER}), then re-run this script."
fi
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
# From INFO, which works where CONFIG is disabled (Velum's own Redis disables it).
POLICY="$(rcli info memory 2>/dev/null | tr -d '\r' | sed -n 's/^maxmemory_policy://p' || true)"
case "${POLICY}" in
  noeviction) echo "  maxmemory-policy noeviction" ;;
  "") warn "Could not read Redis maxmemory-policy (CONFIG may be disabled). BullMQ needs noeviction; check it with the Redis owner." ;;
  *) warn "Redis maxmemory-policy is '${POLICY}'. BullMQ (Velum's job queues) needs 'noeviction': under memory pressure this Redis can silently drop Velum's queue keys. Ask the Redis owner to change it, or give Velum its own Redis." ;;
esac

# ── Nginx and HTTPS (R2-M1) ──────────────────────────────────────────────────
# Only Velum's own files are written: sites-available/velum.conf, its sites-enabled link and two
# snippets. Every file is backed up first and restored if nginx -t or certbot fails. A site file that
# Certbot manages is never replaced by the plain-HTTP template and reloaded: a file of the current
# template version only gets its upstream ports refreshed, and a file of an older version is
# re-rendered and its existing certificate re-installed with `certbot install` before Nginx reloads.
echo "› Nginx (the velum site and its snippets only; other sites untouched)"
SITE="${NGINX_DIR}/sites-available/velum.conf"
SITE_LINK="${NGINX_DIR}/sites-enabled/velum.conf"
HEADERS_SNIPPET="${NGINX_DIR}/snippets/velum-security-headers.conf"
PROXY_SNIPPET="${NGINX_DIR}/snippets/velum-proxy-secret.conf"
API_SNIPPET="${NGINX_DIR}/snippets/velum-api-upstream.conf"
# /api/ goes to the API's unix socket, with the proxy secret (R3-03). Before the first release in this
# base (moving from an older layout), Nginx keeps proxying to the older apps on 127.0.0.1:PORT_API,
# without the secret; deploy.sh switches both snippets when the new API runs.
API_MODE=socket
[ -n "$(readlink "${ROOT}/current" 2>/dev/null || true)" ] || API_MODE=tcp
NGINX_BACKUPS="${BACKUPS}/nginx"
STAMP="$(date -u +%Y%m%d%H%M%S)"
install -d -m 755 "${NGINX_DIR}/snippets" "${NGINX_DIR}/sites-available" "${NGINX_DIR}/sites-enabled"
# Parent of the /api/v1/markets micro-cache (velum.conf proxy_cache_path); Nginx creates velum/ in it
# for its worker user, but not this directory (Ubuntu's package has none), and nginx -t fails without it.
install -d -m 755 /var/cache/nginx
install -d -o root -g root -m 700 "${NGINX_BACKUPS}"
for f in "${SITE}" "${SITE_LINK}" "${HEADERS_SNIPPET}" "${PROXY_SNIPPET}" "${API_SNIPPET}"; do
  if [ -L "${f}" ] && [ "${f}" != "${SITE_LINK}" ]; then die "${f} is a symbolic link; Velum manages it as a regular file. Replace it by hand, then re-run."; fi
done
if [ -e "${SITE_LINK}" ] && ! { [ -L "${SITE_LINK}" ] && [ "$(readlink -f "${SITE_LINK}")" = "$(readlink -f "${SITE}")" ]; }; then
  die "${SITE_LINK} exists and is not a link to ${SITE}. Move it away by hand, then re-run."
fi

TEMPLATE_VERSION="$(sed -n 's/^# velum-site-template: \([0-9][0-9]*\).*/\1/p' deploy/nginx/velum.conf | head -n1)"
render_site() {
  sed -e "s/velum.example/${DOMAIN}/g" -e "s/127.0.0.1:3000/127.0.0.1:${PORT_WEB}/" deploy/nginx/velum.conf |
    if [ -e /proc/net/if_inet6 ]; then cat; else sed '/^[[:space:]]*listen[[:space:]]*\[::\]/d'; fi
}
# The web's upstream port is the only thing refreshed in a Certbot-managed file of the current template
# version (the API's upstream lives in its snippet).
merge_ports() {
  awk -v web="${PORT_WEB}" '
    /upstream[[:space:]]+velum_web[[:space:]]*\{/ { blk = "web" }
    blk == "web" { gsub(/server[[:space:]]+127\.0\.0\.1:[0-9]+/, "server 127.0.0.1:" web) }
    { print }
    blk != "" && /\}/ { blk = "" }' "$1"
}
backup_nginx() {
  local f
  for f in "${SITE}" "${HEADERS_SNIPPET}" "${PROXY_SNIPPET}" "${API_SNIPPET}"; do
    if [ -f "${f}" ]; then cp -p -- "${f}" "${NGINX_BACKUPS}/$(basename "${f}").${STAMP}"; fi
  done
  # Keep the newest 5 backups of each file.
  for f in "${SITE}" "${HEADERS_SNIPPET}" "${PROXY_SNIPPET}" "${API_SNIPPET}"; do
    find "${NGINX_BACKUPS}" -maxdepth 1 -type f -name "$(basename "${f}").*" -printf '%f\n' | sort -r | tail -n +6 | while IFS= read -r b; do rm -f -- "${NGINX_BACKUPS:?}/${b}"; done
  done
}
HAD_SITE=0
[ -f "${SITE}" ] && HAD_SITE=1
HAD_LINK=0
[ -L "${SITE_LINK}" ] && HAD_LINK=1
# Puts back the files this run found (and removes the ones it created), then reloads if Nginx accepts it.
restore_nginx() {
  local f b
  for f in "${SITE}" "${HEADERS_SNIPPET}" "${PROXY_SNIPPET}" "${API_SNIPPET}"; do
    b="${NGINX_BACKUPS}/$(basename "${f}").${STAMP}"
    if [ -f "${b}" ]; then cp -p -- "${b}" "${f}"; else rm -f -- "${f}"; fi
  done
  [ "${HAD_LINK}" = 1 ] || rm -f -- "${SITE_LINK}"
  if nginx -t -q 2>/dev/null; then nginx_reload || true; echo "  restored the previous Nginx files" >&2; else warn "Restored the previous Nginx files, but nginx -t still fails; check: nginx -t"; fi
}
nginx_test_or_restore() { nginx -t || { restore_nginx; die "nginx -t failed with the new Velum files; the previous ones were restored."; }; }
link_site() { [ -L "${SITE_LINK}" ] || ln -s "${SITE}" "${SITE_LINK}"; }

# What the live file is: none, managed by Certbot (and which template version), TLS by hand, or plain HTTP.
SITE_STATE=none
CUR_VERSION=""
if [ "${HAD_SITE}" = 1 ]; then
  CUR_VERSION="$(sed -n 's/^# velum-site-template: \([0-9][0-9]*\).*/\1/p' "${SITE}" | head -n1)"
  if grep -q 'managed by Certbot' "${SITE}"; then SITE_STATE=certbot
  elif grep -Eq '^[^#]*(listen[^;]*443|ssl_certificate)' "${SITE}"; then SITE_STATE=manual-tls
  else SITE_STATE=plain; fi
fi
[ "${SITE_STATE}" != manual-tls ] || die "${SITE} has TLS settings that Certbot does not manage. Velum will not rewrite it; update it by hand from deploy/nginx/velum.conf (keep your TLS lines), add the snippets, then re-run with the site file renamed if you want Velum to manage it."

backup_nginx
render_site >"${NGINX_BACKUPS}/velum.conf.template.${STAMP}"
render_security_headers "${ENV_FILE}" | install_file "${HEADERS_SNIPPET}" 644 root:root || die "Fix NEXT_PUBLIC_RPC_URL in .env, then re-run."
if [ "${API_MODE}" = socket ]; then
  proxy_secret_include "${PROXY_SECRET}" | install_file "${PROXY_SNIPPET}" 600 root:root
  render_api_upstream socket "${API_SOCKET_PATH}" | install_file "${API_SNIPPET}" 644 root:root
else
  render_proxy_secret_for tcp | install_file "${PROXY_SNIPPET}" 600 root:root
  render_api_upstream tcp "${PORT_API}" | install_file "${API_SNIPPET}" 644 root:root
fi

# HTTPS decision inputs: which names, and which existing certificate (from `certbot certificates`).
SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
WWW_IP="$(dig +short A "www.${DOMAIN}" 2>/dev/null | tail -n1 || true)"
NAMES=("${DOMAIN}")
if [ "${WWW}" = "yes" ] || { [ "${WWW}" = "auto" ] && [ -n "${WWW_IP}" ] && [ "${WWW_IP}" = "${SERVER_IP}" ]; }; then NAMES+=("www.${DOMAIN}"); fi
CERT_NAME=""
CERT_DOMAINS=""
CERT_VALID=0
cert_lookup() {
  local list pref n d v pick="" first=""
  CERT_NAME=""; CERT_DOMAINS=""; CERT_VALID=0
  list="$(certbot certificates 2>/dev/null | awk '
    /Certificate Name:/ { if (n != "") print n "|" d "|" v; n = $3; d = ""; v = 0 }
    /Domains:/ { s = $0; sub(/^[[:space:]]*Domains:[[:space:]]*/, "", s); d = s }
    /Expiry Date:/ { v = ($0 ~ /\(VALID/) ? 1 : 0 }
    END { if (n != "") print n "|" d "|" v }')" || true
  pref=""
  [ -f "${SITE}" ] && pref="$(sed -n 's#.*ssl_certificate[[:space:]][[:space:]]*/etc/letsencrypt/live/\([^/;[:space:]]*\)/fullchain\.pem.*#\1#p' "${SITE}" | head -n1)"
  while IFS='|' read -r n d v; do
    [ -n "${n}" ] || continue
    case " ${d} " in *" ${DOMAIN} "*) ;; *) continue ;; esac
    [ -n "${first}" ] || first="${n}|${d}|${v}"
    if [ "${n}" = "${pref}" ]; then pick="${n}|${d}|${v}"; break; fi
    if [ "${n}" = "${DOMAIN}" ] && [ -z "${pick}" ]; then pick="${n}|${d}|${v}"; fi
  done <<<"${list}"
  [ -n "${pick}" ] || pick="${first}"
  [ -n "${pick}" ] || return 0
  IFS='|' read -r CERT_NAME CERT_DOMAINS CERT_VALID <<<"${pick}"
}
cert_covers() { local n; for n in "${NAMES[@]}"; do case " ${CERT_DOMAINS} " in *" ${n} "*) ;; *) return 1 ;; esac; done; }
DOMAIN_ARGS=()
for n in "${NAMES[@]}"; do DOMAIN_ARGS+=(-d "${n}"); done
# Gets a certificate for NAMES without changing the live site (the ACME challenge runs on what Nginx
# serves now, so HTTPS stays up). --expand when an existing certificate lacks a name (e.g. www later).
certbot_get() { certbot certonly --nginx --cert-name "$1" "${DOMAIN_ARGS[@]}" -m "${EMAIL}" --agree-tos --keep-until-expiring --expand -n; }
# Installs an existing certificate into the site file (adds the 443 listeners and the HTTP redirect),
# then reloads Nginx itself.
certbot_install() { certbot install --nginx --cert-name "$1" --redirect -n; }
cert_lookup
CERT_FOR="${CERT_NAME:-${DOMAIN}}"
need_cert=1
if [ -n "${CERT_NAME}" ] && cert_covers && [ "${CERT_VALID}" = 1 ]; then need_cert=0; fi

echo "› HTTPS (${NAMES[*]}; certificate: ${CERT_NAME:-none yet}${CERT_DOMAINS:+ for ${CERT_DOMAINS}})"
case "${SITE_STATE}" in
  certbot)
    [ -n "${CERT_NAME}" ] || { restore_nginx; die "${SITE} is managed by Certbot, but certbot certificates lists no certificate for ${DOMAIN}. Nothing was changed; fix the certificate by hand (certbot certificates), then re-run."; }
    if [ "${need_cert}" = 1 ]; then
      say "Getting a certificate for ${NAMES[*]} (${CERT_FOR}, --expand) while the current site keeps serving HTTPS"
      certbot_get "${CERT_FOR}" || { restore_nginx; die "certbot could not get a certificate for ${NAMES[*]}; nothing was changed (HTTPS as before)."; }
      cert_lookup
    fi
    if [ "${CUR_VERSION}" = "${TEMPLATE_VERSION}" ]; then
      merge_ports "${SITE}" | install_file "${SITE}.velum-new" 644 root:root
      # (Certbot leaves the file without a final newline; awk adds one: compare without that difference.)
      if cmp -s "${SITE}.velum-new" <(awk '{ print }' "${SITE}") && [ "${need_cert}" = 0 ]; then
        rm -f "${SITE}.velum-new"
        echo "  ${SITE} (Certbot-managed, template ${CUR_VERSION}) is up to date"
      else
        mv -f "${SITE}.velum-new" "${SITE}"
        link_site
        nginx_test_or_restore
        if [ "${need_cert}" = 1 ]; then certbot_install "${CERT_NAME}" || { restore_nginx; die "certbot install failed; the previous Nginx files were restored (HTTPS as before)."; }; fi
        nginx_reload || { restore_nginx; die "Nginx did not apply the refreshed site (see its error log); the previous Nginx files were restored."; }
        echo "  refreshed the upstream ports in ${SITE}; Certbot's HTTPS settings kept"
      fi
    else
      # Older template: render the new one, then let certbot put the certificate back in before any reload.
      say "${SITE} comes from an older template (${CUR_VERSION:-none}); re-rendering it and re-installing certificate ${CERT_NAME} before Nginx reloads"
      render_site | install_file "${SITE}" 644 root:root
      link_site
      nginx_test_or_restore
      certbot_install "${CERT_NAME}" || { restore_nginx; die "certbot install failed; the previous Nginx files were restored (HTTPS as before). Template kept at ${NGINX_BACKUPS}/velum.conf.template.${STAMP}."; }
      if ! grep -q 'managed by Certbot' "${SITE}" || ! nginx -t -q 2>/dev/null; then restore_nginx; die "certbot did not install the certificate into ${SITE}; the previous Nginx files were restored."; fi
      nginx_reload || { restore_nginx; die "Nginx did not apply the new Velum site (see its error log: [emerg]); the previous Nginx files were restored and HTTPS is as before."; }
    fi
    ;;
  none | plain)
    render_site | install_file "${SITE}" 644 root:root
    link_site
    nginx_test_or_restore
    systemctl is-active --quiet nginx || systemctl enable --now nginx
    nginx_reload || { restore_nginx; die "Nginx did not apply the new Velum site (see its error log: [emerg]); the previous Nginx files were restored."; }
    if [ -n "${CERT_NAME}" ] && [ "${need_cert}" = 0 ]; then
      if ! certbot_install "${CERT_NAME}"; then
        if [ "${SITE_STATE}" = plain ]; then restore_nginx; die "certbot install failed; the previous Nginx files were restored."; fi
        die "certbot install failed. The site answers on plain HTTP; fix it and re-run."
      fi
    else
      certbot_get "${CERT_FOR}" && cert_lookup && certbot_install "${CERT_NAME:-${CERT_FOR}}" || {
        if [ "${SITE_STATE}" = plain ]; then restore_nginx; die "certbot failed; the previous Nginx files were restored."; fi
        die "certbot failed (DNS for ${NAMES[*]} pointing here? port 80 reachable?). The site answers on plain HTTP; fix it and re-run."
      }
    fi
    ;;
esac
nginx -t -q 2>/dev/null || { restore_nginx; die "nginx -t fails after the HTTPS step; the previous Nginx files were restored."; }
if ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 'Nginx Full' || true; fi
# Nginx sends the proxy secret to the API's socket (now, or from the first release in this base on,
# when deploy.sh switches /api/ to the socket): the API may require it from the next release on (R2-I4).
if [ "${NEW_PROXY_SECRET}" = 1 ]; then
  backup="$(env_backup "${ENV_FILE}")"
  env_set "${ENV_FILE}" PROXY_SECRET "${PROXY_SECRET}"
  echo "  added PROXY_SECRET to .env (previous .env kept as ${backup##*/})"
fi
unset PROXY_SECRET

# The release starts each user's PM2 daemon under its systemd unit (pm2-${APP_USER}, pm2-${WEB_USER}),
# enabled for boot, and saves the process lists (I-2). No pm2-logrotate module (R3-02).
echo "› First release (api + workers as ${APP_USER}, web as ${WEB_USER}, each PM2 under its systemd unit)"
APP_USER="${APP_USER}" WEB_USER="${WEB_USER}" BRANCH="${BRANCH}" NGINX_SNIPPET="${HEADERS_SNIPPET}" NGINX_PROXY_SNIPPET="${PROXY_SNIPPET}" NGINX_API_SNIPPET="${API_SNIPPET}" NGINX_SITE="${SITE}" bash "${ROOT}/deploy/deploy.sh"

echo "✓ Velum Phase 2 is live at https://${DOMAIN}"
echo "  Status:   bash ${ROOT}/deploy/as-user.sh ${APP_USER} pm2 status ; bash ${ROOT}/deploy/as-user.sh ${WEB_USER} pm2 status"
echo "  Logs:     bash ${ROOT}/deploy/as-user.sh ${APP_USER} pm2 logs velum-api --lines 100 --nostream"
echo "  Health:   curl -s https://${DOMAIN}/api/v1/health"
echo "  Releases: sudo bash ${ROOT}/deploy/deploy.sh   (roll back: sudo bash ${ROOT}/deploy/deploy.sh --rollback)"
