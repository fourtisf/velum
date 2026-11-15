#!/usr/bin/env bash
# Dedicated Redis for Velum (docs/05-deploy-vps.md, "Dedicated Redis for Velum"; audit M-2). Run as root,
# inside tmux, from the root-owned base after server-setup.sh and at least one deploy.sh:
#   sudo bash /srv/velum/deploy/redis-velum.sh              set it up (or update it), point REDIS_URL at it
#   sudo bash /srv/velum/deploy/redis-velum.sh --rollback   point REDIS_URL back at the shared Redis
# then run `sudo bash /srv/velum/deploy/deploy.sh` so the apps reconnect.
#
# Why: on a shared server Velum's keys sit in the system Redis (REDIS_DB, default 5) behind the shared
# requirepass, so every co-tenant who knows that password can read and write them (queue jobs, prices,
# rate-limit counters). This script runs a second redis-server only for Velum:
#   - its own systemd unit velum-redis.service (User=redis, sandboxed, no network address family at all),
#     its own config /etc/velum-redis/redis.conf (root:redis 640), data /var/lib/velum-redis (redis, 750);
#   - a unix socket only (port 0, no TCP) in /run/velum-redis: owner redis, group the app user's group,
#     setgid, 2770 (tmpfiles.d, so it exists again after a reboot); the socket is 660. Only the app user
#     (api + workers) can connect; the web user and Nginx cannot;
#   - its own random password, maxmemory (REDIS_MAXMEMORY, default 256mb) with maxmemory-policy
#     noeviction (BullMQ needs it), AOF + RDB persistence in its own data directory, CONFIG/DEBUG/MODULE
#     disabled.
# It never touches the system Redis, its config or its data. Idempotent: a re-run keeps the password and
# the data, rewrites only files that differ, restarts velum-redis only when its config or unit changed.
# REDIS_URL changes only after the new Redis answered and only when the running release understands a
# socket URL (so deploy.sh's automatic switch-back stays safe); the previous REDIS_URL is kept (root only)
# for --rollback. Nothing needs migrating: what Velum keeps in Redis (prices, candle caches, queues,
# heartbeats, rate-limit counters) is rebuilt by the workers on start.
#
# Optional: REDIS_MAXMEMORY (e.g. 512mb). For tests only: VELUM_REDIS_ETC, VELUM_REDIS_DATA,
# VELUM_REDIS_RUN, VELUM_REDIS_TMPFILES, VELUM_REDIS_UNIT_DIR, VELUM_REDIS_USER.
#
# Known limit: deploy/server-setup.sh checks Redis over TCP (redis-cli -h/-p from REDIS_URL), so it stops
# at "Cannot reach Redis" while REDIS_URL names the socket. To re-run server-setup.sh, run --rollback
# first, then server-setup.sh, then this script again (docs/05).
# shellcheck disable=SC2015 # "A && B || die" is the intended idiom here: die exits.
set -euo pipefail
umask 022
# A dropped SSH session must not stop a rewrite of .env or the unit halfway (R2-L6).
trap '' HUP
[ "$(id -u)" -eq 0 ] || { echo "Run as root (or with sudo)." >&2; exit 1; }
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
BASE="$(cd "$(dirname "${SELF}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${BASE}/deploy/lib/common.sh"

ACTION=install
case "${1:-}" in
  "") ;;
  --rollback) ACTION=rollback ;;
  *) die "Usage: sudo bash deploy/redis-velum.sh [--rollback]" ;;
esac

UNIT=velum-redis
ETC_DIR="${VELUM_REDIS_ETC:-/etc/velum-redis}"
DATA_DIR="${VELUM_REDIS_DATA:-/var/lib/velum-redis}"
RUN_DIR="${VELUM_REDIS_RUN:-/run/velum-redis}"
TMPFILES_FILE="${VELUM_REDIS_TMPFILES:-/etc/tmpfiles.d/velum-redis.conf}"
UNIT_DIR="${VELUM_REDIS_UNIT_DIR:-/etc/systemd/system}"
REDIS_USER="${VELUM_REDIS_USER:-redis}"
MAXMEMORY="${REDIS_MAXMEMORY:-256mb}"
CONF="${ETC_DIR}/redis.conf"
SOCK="${RUN_DIR}/redis.sock"
UNIT_FILE="${UNIT_DIR}/${UNIT}.service"
# The REDIS_URL from before the switch (root:root 600), for --rollback.
SHARED_URL_FILE="${ETC_DIR}/shared-redis-url"
ENV_FILE="${BASE}/.env"

plain_path() { [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "/$1/" != *"/../"* ]] && [[ "/$1/" != *"/./"* ]]; }
for p in "${ETC_DIR}" "${DATA_DIR}" "${RUN_DIR}" "${TMPFILES_FILE}" "${UNIT_DIR}"; do
  plain_path "${p}" || die "Not a plain absolute path: ${p}"
done
[ "${#SOCK}" -le 100 ] || die "The socket path ${SOCK} is too long (100 characters at most)."
[[ "${MAXMEMORY}" =~ ^[1-9][0-9]{0,5}(kb|mb|gb|KB|MB|GB)$ ]] || die "REDIS_MAXMEMORY must look like 256mb or 1gb."
[[ "${REDIS_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && id -u "${REDIS_USER}" >/dev/null 2>&1 || die "User ${REDIS_USER} does not exist (the redis-server package creates it)."
[ "${REDIS_USER}" != root ] || die "Redis must not run as root."
[ -f "${ENV_FILE}" ] && [ ! -L "${ENV_FILE}" ] || die "Missing ${ENV_FILE} (or it is a symbolic link). Run deploy/server-setup.sh first."

# APP_USER/APP_GROUP/WEB_USER from the base (server-setup.sh's record); refuses a base root must not use.
velum_mode "${BASE}"
[ "${SEPARATE}" = 1 ] || die "Run as root."
# The same lock as deploy.sh, server-setup.sh, set-network.sh, new-key.sh and import-env.sh.
lock_deploy "${BASE}"
systemd_running || die "This script needs systemd (velum-redis runs as a systemd unit)."
REDIS_SERVER="$(command -v redis-server)" && REDIS_CLI="$(command -v redis-cli)" || die "redis-server is not installed (apt-get install redis-server; server-setup.sh installs it when missing)."
TMPFILES_BIN="$(command -v systemd-tmpfiles)" || die "systemd-tmpfiles is missing."
for p in "${REDIS_SERVER}" "${TMPFILES_BIN}"; do plain_path "${p}" || die "Not a plain absolute path: ${p}"; done

current_url() { env_get "${ENV_FILE}" REDIS_URL; }
is_socket_url() { [[ "$1" =~ ^(redis\+)?unix:// ]]; }
# set_redis_url URL — backs up .env, rewrites REDIS_URL atomically, checks the result.
set_redis_url() {
  local backup
  backup="$(env_backup "${ENV_FILE}")"
  env_set "${ENV_FILE}" REDIS_URL "$1"
  [ "$(current_url)" = "$1" ] || die "Writing .env failed; restore ${backup}."
  say "REDIS_URL updated (previous .env kept as ${backup##*/})"
}

# ── Rollback ─────────────────────────────────────────────────────────────────
if [ "${ACTION}" = rollback ]; then
  [ -f "${SHARED_URL_FILE}" ] && [ ! -L "${SHARED_URL_FILE}" ] && [ "$(stat -c %u "${SHARED_URL_FILE}")" = 0 ] ||
    die "No saved shared REDIS_URL (${SHARED_URL_FILE}). Put the shared Redis URL in ${ENV_FILE} by hand (as root), then run deploy.sh."
  shared="$(head -n1 "${SHARED_URL_FILE}")"
  [[ "${shared}" =~ ^rediss?:// ]] || die "${SHARED_URL_FILE} does not hold a redis:// URL."
  if [ "$(current_url)" = "${shared}" ]; then
    say "REDIS_URL already points at the shared Redis."
  else
    set_redis_url "${shared}"
  fi
  cat <<EOF
Next:
  1. sudo bash ${BASE}/deploy/deploy.sh          (the apps reconnect to the shared Redis)
  2. Optional, once the release is healthy:  systemctl disable --now ${UNIT}
     (its data stays in ${DATA_DIR}; re-running redis-velum.sh brings it back with the same password)
EOF
  exit 0
fi

# ── Install or update ────────────────────────────────────────────────────────
# Refuse to manage anything through a symbolic link (root never follows links it did not make).
for p in "${ETC_DIR}" "${CONF}" "${SHARED_URL_FILE}" "${DATA_DIR}" "${RUN_DIR}" "${TMPFILES_FILE}" "${UNIT_FILE}"; do
  [ ! -L "${p}" ] || die "${p} is a symbolic link; refusing to use it. Remove it by hand, then re-run."
done

say "Directories (config root:${REDIS_USER} 750, data ${REDIS_USER} 750)"
if [ -e "${ETC_DIR}" ]; then
  [ -d "${ETC_DIR}" ] && [ "$(stat -c %u "${ETC_DIR}")" = 0 ] || die "${ETC_DIR} exists but is not a root-owned directory."
fi
install -d -o root -g "${REDIS_USER}" -m 750 "${ETC_DIR}"
if [ -e "${DATA_DIR}" ]; then
  [ -d "${DATA_DIR}" ] && [ "$(stat -c %U "${DATA_DIR}")" = "${REDIS_USER}" ] || die "${DATA_DIR} exists but is not a directory owned by ${REDIS_USER}; refusing to use it."
  chmod 750 "${DATA_DIR}"
else
  install -d -o "${REDIS_USER}" -g "${REDIS_USER}" -m 750 "${DATA_DIR}"
fi

# The password: kept from the existing config (a re-run must not lock the apps out), else a new one.
PASS=""
if [ -f "${CONF}" ]; then
  [ "$(stat -c %u "${CONF}")" = 0 ] || die "${CONF} is not owned by root."
  PASS="$(sed -n 's/^requirepass \([0-9a-f]\{64\}\)$/\1/p' "${CONF}" | tail -n1)"
fi
[ -n "${PASS}" ] || PASS="$(openssl rand -hex 32)"
[[ "${PASS}" =~ ^[0-9a-f]{64}$ ]] || die "Could not create a password."

render_tmpfiles_redis() {
  printf '# Generated by deploy/redis-velum.sh: the socket directory of Velum'"'"'s Redis (audit M-2).\n'
  printf '# Owner %s (redis-server creates the socket), group %s (the app user connects); nobody else.\n' "${REDIS_USER}" "${APP_GROUP}"
  printf 'd %s 2770 %s %s -\n' "${RUN_DIR}" "${REDIS_USER}" "${APP_GROUP}"
}

render_conf() {
  local supervised="$1"
  cat <<EOF
# Generated by Velum's deploy/redis-velum.sh: rewritten when it differs. Do not edit (set REDIS_MAXMEMORY
# and re-run the script instead). Velum's own Redis (audit M-2): unix socket only, own password and data.
port 0
unixsocket ${SOCK}
unixsocketperm 660
daemonize no
supervised ${supervised}
loglevel notice
logfile ""
databases 1
requirepass ${PASS}
# BullMQ (Velum's job queues) requires noeviction: a full Redis refuses writes instead of dropping keys.
maxmemory ${MAXMEMORY}
maxmemory-policy noeviction
dir ${DATA_DIR}
dbfilename dump.rdb
save 900 1
save 300 10
save 60 10000
appendonly yes
appendfsync everysec
# Not needed by Velum; disabled so a compromised client cannot reconfigure Redis or load code.
rename-command CONFIG ""
rename-command DEBUG ""
rename-command MODULE ""
EOF
}

render_unit() {
  local type="$1"
  cat <<EOF
# Generated by Velum's deploy/redis-velum.sh: rewritten when it differs. Do not edit.
[Unit]
Description=Redis for Velum (unix socket only)
Documentation=man:redis-server(1)
After=network.target

[Service]
Type=${type}
User=${REDIS_USER}
Group=${REDIS_USER}
# Recreates the socket directory if it went missing (it is also created at boot by tmpfiles.d).
ExecStartPre=+${TMPFILES_BIN} --create ${TMPFILES_FILE}
ExecStart=${REDIS_SERVER} ${CONF}
Restart=always
RestartSec=2
TimeoutStartSec=120
TimeoutStopSec=120
UMask=0007
LimitNOFILE=10032
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=${DATA_DIR} ${RUN_DIR}
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
# Unix sockets only: this Redis cannot open a network socket at all.
RestrictAddressFamilies=AF_UNIX

[Install]
WantedBy=multi-user.target
EOF
}

# Type=notify needs redis-server built with systemd support (Ubuntu's is); otherwise a plain service.
SUPERVISED=no
UNIT_TYPE=simple
if ldd "${REDIS_SERVER}" 2>/dev/null | grep -q 'libsystemd'; then SUPERVISED=systemd; UNIT_TYPE=notify; fi

say "Socket directory ${RUN_DIR} (${REDIS_USER}:${APP_GROUP} 2770, tmpfiles.d)"
install -d -m 755 "$(dirname "${TMPFILES_FILE}")"
render_tmpfiles_redis | install_file "${TMPFILES_FILE}" 644 root:root
"${TMPFILES_BIN}" --create "${TMPFILES_FILE}" || die "systemd-tmpfiles could not create ${RUN_DIR}."
[ -d "${RUN_DIR}" ] && [ ! -L "${RUN_DIR}" ] && [ "$(stat -c %U:%G "${RUN_DIR}")" = "${REDIS_USER}:${APP_GROUP}" ] && [ -z "$(find "${RUN_DIR}" -maxdepth 0 -perm /0007)" ] ||
  die "${RUN_DIR} must be a directory owned by ${REDIS_USER}:${APP_GROUP} that others cannot enter."

say "Config ${CONF} and unit ${UNIT_FILE}"
changed=0
conf_new="$(render_conf "${SUPERVISED}")"
if ! printf '%s\n' "${conf_new}" | cmp -s - "${CONF}"; then
  printf '%s\n' "${conf_new}" | install_file "${CONF}" 640 "root:${REDIS_USER}"
  changed=1
fi
unset conf_new
unit_new="$(render_unit "${UNIT_TYPE}")"
if ! printf '%s\n' "${unit_new}" | cmp -s - "${UNIT_FILE}"; then
  printf '%s\n' "${unit_new}" | install_file "${UNIT_FILE}" 644 root:root
  systemctl daemon-reload
  changed=1
fi
systemctl is-enabled --quiet "${UNIT}" 2>/dev/null || systemctl enable --quiet "${UNIT}"
if [ "${changed}" = 1 ] || ! systemctl is-active --quiet "${UNIT}" || [ ! -S "${SOCK}" ]; then
  say "Starting ${UNIT}"
  systemctl restart "${UNIT}" || die "${UNIT} did not start. See: journalctl -u ${UNIT} -n 50"
fi

say "Checking ${UNIT}"
# The password reaches redis-cli through its environment (REDISCLI_AUTH), never its command line.
rcli() { REDISCLI_AUTH="${PASS}" "${REDIS_CLI}" -s "${SOCK}" "$@"; }
pong=""
for _ in $(seq 1 30); do
  pong="$(rcli ping 2>/dev/null || true)"
  [ "${pong}" = PONG ] && break
  sleep 1
done
[ "${pong}" = PONG ] || die "${UNIT} does not answer on ${SOCK}. See: journalctl -u ${UNIT} -n 50 (REDIS_URL was not changed)."
info="$(rcli info 2>/dev/null | tr -d '\r' || true)"
grep -qx 'tcp_port:0' <<<"${info}" || die "${UNIT} listens on TCP; expected a unix socket only (REDIS_URL was not changed)."
grep -qx 'maxmemory_policy:noeviction' <<<"${info}" || die "${UNIT} does not use maxmemory-policy noeviction (REDIS_URL was not changed)."
[ "$(stat -c '%U:%G %a' "${SOCK}")" = "${REDIS_USER}:${APP_GROUP} 660" ] || die "${SOCK} must be ${REDIS_USER}:${APP_GROUP} 660 (it is $(stat -c '%U:%G %a' "${SOCK}"))."
# The app user reaches the socket (and is asked for the password); the web user cannot reach it.
answer="$(as_app "${REDIS_CLI}" -s "${SOCK}" ping 2>&1 || true)"
grep -q NOAUTH <<<"${answer}" || die "${APP_USER} cannot connect to ${SOCK} (REDIS_URL was not changed)."
answer="$(as_web "${REDIS_CLI}" -s "${SOCK}" ping 2>&1 || true)"
if grep -q -e NOAUTH -e PONG <<<"${answer}"; then die "${WEB_USER} can connect to ${SOCK}; it must not (REDIS_URL was not changed)."; fi
echo "  ${UNIT} answers on ${SOCK}: no TCP, noeviction, maxmemory ${MAXMEMORY}; ${APP_USER} can connect, ${WEB_USER} cannot"

# ── Point REDIS_URL at it ────────────────────────────────────────────────────
NEW_URL="unix://:${PASS}@${SOCK}"
OLD_URL="$(current_url)"
if [ "${OLD_URL}" = "${NEW_URL}" ]; then
  say "REDIS_URL already points at ${UNIT}; nothing else to do."
  exit 0
fi
# The running release must understand a socket URL: if the next deploy fails, deploy.sh switches back to
# it with this .env. Releases of this version contain this script.
if ! [ -L "${BASE}/current" ] || ! as_app test -f "${BASE}/current/deploy/redis-velum.sh"; then
  die "The running release predates socket support for REDIS_URL. Run sudo bash ${BASE}/deploy/deploy.sh first, then re-run this script. ${UNIT} is set up; REDIS_URL was not changed."
fi
if [ -n "${OLD_URL}" ] && ! is_socket_url "${OLD_URL}"; then
  (umask 077 && printf '%s\n' "${OLD_URL}" | install_file "${SHARED_URL_FILE}" 600 root:root)
fi
set_redis_url "${NEW_URL}"
unset PASS NEW_URL OLD_URL
cat <<EOF
Velum's Redis is ready. Next:
  1. sudo bash ${BASE}/deploy/deploy.sh      (api and workers reconnect to ${SOCK}; queues and caches are rebuilt)
  2. Check: curl -s --unix-socket <API_SOCKET> http://velum-api/v1/health   ("redis":true, "workers" a few seconds)
     and:   systemctl status ${UNIT}
  3. Optional: remove Velum's old keys from the shared Redis (docs/05, "Dedicated Redis for Velum").
Roll back to the shared Redis: sudo bash ${BASE}/deploy/redis-velum.sh --rollback, then deploy.sh.
EOF
