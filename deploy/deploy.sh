#!/usr/bin/env bash
# Release script (Phase 2+). On the VPS run it as root, inside tmux (it ignores SIGHUP, but a closed
# terminal should never be able to stop a release halfway):
#   sudo bash /srv/velum/deploy/deploy.sh              deploy the branch the checkout is on (BRANCH=name to override)
#   sudo bash /srv/velum/deploy/deploy.sh --rollback   switch back to the previous release
#
# How a release works (audit M4, M6 and round 2):
#   1. Takes a lock (flock), so deploys, server-setup.sh, set-network.sh, new-key.sh and import-env.sh
#      never overlap. Checks that the base is safe for root: root-owned, no symbolic links except the
#      release pointers, a .git/config with only what git clone writes (R2-H2).
#   2. Runs git as root with hooks and fsmonitor disabled (root_git), then re-runs the pulled script.
#   3. Exports the commit into releases/<time>-<commit> (owner: app user, group: web group, 2750) and
#      builds it there as the app user: install, build every app, migrate. The live release is never
#      touched, so a failed build leaves the running site exactly as it was.
#      It records the settings the release was built with (VELUM_NETWORK, CHAIN_ID, NEXT_PUBLIC_*).
#      With ONCHAIN_WORKERS=true it also builds the signer's own copy (on-chain audit M-2): root exports the same
#      commit into the signer user's home, where that user installs and builds it; the signer never runs a file the
#      app user wrote (the app user owns and could rewrite its release).
#   4. First release in this base while the app user's PM2 still runs Velum apps from elsewhere (an
#      older in-place layout): keeps a root-only copy of that PM2 process list (R2-M2).
#   5. Renders web.env, signer.env and the Nginx snippets from .env (headers + CSP, the API's unix socket, the
#      proxy secret), switches `current` (and the signer's own pointer) atomically and reloads PM2 with zero
#      downtime: api + workers as the app user, the web as the web user (R2-M3), the price relayer and keeper as the
#      signer user (M-2, only with ONCHAIN_WORKERS=true), each daemon under its systemd unit (I-2).
#   6. Checks health: API (on its socket), web, a workers heartbeat written after the switch, the signer's status
#      written after the switch (when it runs), then after a settle period again, plus PM2 status and restart counts
#      (R2-L5). On failure it switches back to the previous release if that release was built with the settings
#      .env has now (R3-04), or (first release) restores the older layout's apps from step 4.
#   7. Keeps the newest KEEP_RELEASES (default 3) releases, always including current and previous.
# Everything that runs as another user starts in a new session without this terminal, and its output
# reaches the terminal without control characters (run_isolated, audit R3-01).
# --rollback refuses a release built with other settings than .env has now (R3-04) or by another app
# user (R3-05). Run without root on a checkout you own (local or single-user setups), everything runs as you.
# shellcheck disable=SC2015 # "A && B || die" is the intended idiom here: die exits.
set -euo pipefail
umask 022
# A dropped SSH session sends SIGHUP; finish (or roll back) instead of stopping halfway (R2-L6).
trap '' HUP
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
BASE="$(cd "$(dirname "${SELF}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${BASE}/deploy/lib/common.sh"
ENV_FILE="${BASE}/.env"
WEB_ENV_FILE="${BASE}/web.env"
RELEASES="${BASE}/releases"
CURRENT="${BASE}/current"
PREVIOUS="${BASE}/previous"
BACKUPS="${BASE}/backups"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
NGINX_SNIPPET="${NGINX_SNIPPET:-/etc/nginx/snippets/velum-security-headers.conf}"
NGINX_PROXY_SNIPPET="${NGINX_PROXY_SNIPPET:-/etc/nginx/snippets/velum-proxy-secret.conf}"
NGINX_API_SNIPPET="${NGINX_API_SNIPPET:-/etc/nginx/snippets/velum-api-upstream.conf}"
HEALTH_SETTLE_SECONDS="${HEALTH_SETTLE_SECONDS:-20}"
WORKERS_WAIT_SECONDS="${WORKERS_WAIT_SECONDS:-60}"
SIGNER_ENV_FILE="${BASE}/signer.env"
ACTION=deploy
case "${1:-}" in
  "") ;;
  --rollback) ACTION=rollback ;;
  *) die "Usage: deploy.sh [--rollback]" ;;
esac
[[ "${KEEP_RELEASES}" =~ ^[0-9]+$ ]] && [ "${KEEP_RELEASES}" -ge 2 ] || die "KEEP_RELEASES must be 2 or more."
[[ "${HEALTH_SETTLE_SECONDS}" =~ ^[0-9]+$ ]] && [[ "${WORKERS_WAIT_SECONDS}" =~ ^[0-9]+$ ]] || die "HEALTH_SETTLE_SECONDS and WORKERS_WAIT_SECONDS must be numbers."

# ── Who runs what, base checks (M4, R2-H2), lock ─────────────────────────────
velum_mode "${BASE}"
lock_deploy "${BASE}"

# ── Pull (as root, hooks off), then re-run the fresh copy of this script ─────
if [ "${ACTION}" = "deploy" ] && [ -z "${VELUM_DEPLOY_PULLED:-}" ]; then
  BRANCH="${BRANCH:-$(root_git rev-parse --abbrev-ref HEAD)}"
  valid_branch "${BRANCH}" || die "Invalid branch name: ${BRANCH}"
  say "Pulling latest (${BRANCH})"
  root_git fetch origin "${BRANCH}" --prune
  root_git reset --hard "origin/${BRANCH}"
  VELUM_DEPLOY_PULLED=1 BRANCH="${BRANCH}" exec bash "${SELF}" "$@"
fi

cd "${BASE}"
[ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE}. Run deploy/server-setup.sh (or deploy/import-env.sh when moving from an older layout)."
# The hot keys live in SIGNER_KEYS_FILE, never in .env, which the app user (and so a compromised API) can read
# (on-chain audit M-2). server-setup.sh moves them; nothing deploys while one is still here.
if [ "${SEPARATE}" = 1 ] && [ -n "$(hot_keys_in "${ENV_FILE}")" ]; then
  die "${ENV_FILE} still holds $(hot_keys_in "${ENV_FILE}" | tr '\n' ' ')(readable by ${APP_USER}). Run server-setup.sh once: it moves them into ${SIGNER_KEYS_FILE} (docs/05-deploy-vps.md, \"Upgrading to the separate signer\"). Nothing was changed."
fi
# The signer runs only with the literal ONCHAIN_WORKERS=true (and as root: in a single-user checkout it is part of
# scope "all").
ONCHAIN=0
if [ "${SEPARATE}" = 1 ] && onchain_on "${ENV_FILE}"; then ONCHAIN=1; fi
# The signer's status directory (SIGNER_STATUS_FILE in .env, which the API reads too).
SIGNER_STATUS_DIR=""
if [ "${SEPARATE}" = 1 ]; then SIGNER_STATUS_DIR="$(dirname "$(signer_status_file "${ENV_FILE}")")"; fi
if [ "${ONCHAIN}" = 1 ]; then ensure_signer_keys_file; fi

# PM2 daemons under systemd (I-2): as root with systemd running, every pm2 command talks to the
# daemon its unit started (release.sh never starts one itself). Elsewhere the pm2 command starts it.
PM2_SYSTEMD=0
if [ "${SEPARATE}" = 1 ] && systemd_running; then PM2_SYSTEMD=1; fi
export VELUM_PM2_SYSTEMD="${PM2_SYSTEMD}"
if [ "${SEPARATE}" = 1 ] && [ "${PM2_SYSTEMD}" = 0 ]; then warn "systemd is not running: the PM2 daemons are started by this script and will not start at boot."; fi

# The API's unix socket (R3-03): required as root; root's health checks and Nginx use only the socket.
API_SOCKET_PATH="$(env_get "${ENV_FILE}" API_SOCKET)"
if [ "${SEPARATE}" = 1 ] || [ -n "${API_SOCKET_PATH}" ]; then
  valid_api_socket "${API_SOCKET_PATH}" || die "API_SOCKET in ${ENV_FILE} is missing or not /run/<dir>/<name>.sock. Re-run deploy/server-setup.sh: it sets it and creates the socket directory (audit R3-03)."
fi

current_id() { local t; t="$(readlink "${CURRENT}" 2>/dev/null || true)"; printf '%s' "${t##*/}"; }
releases_sorted() { [ -d "${RELEASES}" ] && find "${RELEASES}" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort; return 0; }
# release_ours ID — a finished release built by the current app user for the current web group. A
# release another (earlier, possibly compromised) app user built is never run again (R3-05).
release_ours() {
  [ -f "${RELEASES}/$1/.velum-release-ok" ] || return 1
  if [ "${SEPARATE}" = 1 ]; then [ "$(stat -c '%U:%G' "${RELEASES}/$1")" = "${APP_USER}:${WEB_GROUP}" ] || return 1; fi
}
previous_of() {
  local prev="" r
  while IFS= read -r r; do
    [ "${r}" = "$1" ] && break
    if release_ours "${r}"; then prev="${r}"; fi
  done < <(releases_sorted)
  printf '%s' "${prev}"
}
activate() {
  ln -sfn "releases/$1" "${BASE}/.current.new"
  mv -Tf "${BASE}/.current.new" "${CURRENT}"
}
# `previous` points at the release that was live before `current` (the --rollback target).
remember_previous() {
  if [ -n "$1" ]; then
    ln -sfn "releases/$1" "${BASE}/.previous.new"
    mv -Tf "${BASE}/.previous.new" "${PREVIOUS}"
  else
    rm -f "${PREVIOUS}"
  fi
}
previous_id() {
  local t
  t="$(readlink "${PREVIOUS}" 2>/dev/null || true)"
  t="${t##*/}"
  if [ -n "${t}" ] && [ "${t}" != "$1" ] && release_ours "${t}"; then printf '%s' "${t}"; else previous_of "$1"; fi
}
# Settings each release was built with (R3-04): releases/<id>.build-env, root-only.
record_of() { printf '%s/%s.build-env' "${RELEASES}" "$1"; }
# env_matches ID — true when .env holds exactly the values release ID was built with; otherwise warns
# with the differences (all public: NEXT_PUBLIC_* is compiled into the browser bundle).
env_matches() {
  local rec
  rec="$(record_of "$1")"
  if [ ! -f "${rec}" ]; then warn "Release $1 has no record of the settings it was built with (built by an older deploy.sh), so it cannot be checked."; return 2; fi
  [ "$(cat "${rec}")" = "$(build_env_record "${ENV_FILE}")" ] && return 0
  warn "Release $1 was built with other settings than ${ENV_FILE} has now:"
  awk 'FNR == 1 { f++ } !/=/ { next } { k = substr($0, 1, index($0, "=") - 1); v = substr($0, index($0, "=") + 1) }
    f == 1 { b[k] = v; next } { n[k] = v }
    END {
      for (k in b) if (!(k in n)) printf "  %s: built with \"%s\", now not set\n", k, b[k]; else if (n[k] != b[k]) printf "  %s: built with \"%s\", now \"%s\"\n", k, b[k], n[k]
      for (k in n) if (!(k in b)) printf "  %s: not set when built, now \"%s\"\n", k, n[k]
    }' "${rec}" <(build_env_record "${ENV_FILE}") | LC_ALL=C sort >&2
  return 1
}
# redis_url_ok_for ID — release ID understands the REDIS_URL in .env: a unix:// URL (deploy/redis-velum.sh)
# needs a release that ships redis-velum.sh, the version that added socket support (final audit L-2).
redis_url_ok_for() {
  case "$(env_get "${ENV_FILE}" REDIS_URL)" in
    unix://* | redis+unix://*) as_app test -f "${RELEASES}/$1/deploy/redis-velum.sh" ;;
    *) return 0 ;;
  esac
}
# drop_release ID-DIR — removes a release, its record and the signer's copy of it.
drop_release() { remove_release "$1"; rm -f -- "$1.build-env"; drop_signer_release "${1##*/}"; }

# ── The signer's own copy of a release (on-chain audit M-2) ──────────────────
# <signer home>/releases/<id>, built by the signer from `git archive` of the commit; <signer home>/current points at
# the one its PM2 runs. Root never writes, reads or deletes inside the signer's home itself: every step runs as the
# signer (as_signer), which can only touch its own files.
signer_rel() { printf '%s/releases/%s' "${SIGNER_HOME}" "$1"; }
# signer_ready ID — the signer's copy of release ID finished building.
signer_ready() { [ "${SEPARATE}" = 1 ] && [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] && as_signer test -f "$(signer_rel "$1")/.velum-signer-ok" >/dev/null 2>&1; }
drop_signer_release() {
  [ "${SEPARATE}" = 1 ] && [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || return 0
  # shellcheck disable=SC2016 # expanded by the signer's sh
  as_signer sh -c 'case "$(readlink "$HOME/current" 2>/dev/null)" in "releases/$1") exit 0 ;; esac; rm -rf -- "$HOME/releases/$1"' sh "$1" >/dev/null 2>&1 || true
}
# build_signer ID COMMIT — exports COMMIT into the signer's home and builds it there, as the signer.
build_signer() {
  local id="$1" commit="$2" dir
  dir="$(signer_rel "${id}")"
  say "Building the signer's own copy of ${id} as ${SIGNER_USER} (from the commit; never from ${APP_USER}'s files)"
  # shellcheck disable=SC2016 # expanded by the signer's sh
  as_signer sh -c 'umask 077 && chmod 700 "$HOME" && mkdir -p "$HOME/releases" "$HOME/.pm2" "$HOME/state" && chmod 700 "$HOME/releases" "$HOME/.pm2" "$HOME/state" && rm -rf -- "$HOME/releases/$1" && mkdir -m 700 "$HOME/releases/$1"' sh "${id}" ||
    die "Could not create ${dir} as ${SIGNER_USER}."
  root_git archive --format=tar "${commit}" | as_signer tar -x -C "${dir}" || die "Could not export ${commit:0:12} for ${SIGNER_USER}."
  as_signer bash "${dir}/deploy/release.sh" signer-build || die "The signer's build of ${id} failed (see above). Nothing was switched."
  signer_ready "${id}" || die "The signer's build of ${id} did not finish."
}
# signer_activate ID — points the signer's `current` at its copy of ID (atomically, as the signer).
signer_activate() {
  # shellcheck disable=SC2016 # expanded by the signer's sh
  as_signer sh -c 'ln -sfn "releases/$1" "$HOME/.current.new" && mv -Tf "$HOME/.current.new" "$HOME/current"' sh "$1" || die "Could not switch ${SIGNER_USER}'s current to ${1}."
}
# signer_off — the signer runs nothing (ONCHAIN_WORKERS not true, or the live release has no copy for it): its unit is
# stopped and disabled, so nothing signs; a later release with ONCHAIN_WORKERS=true enables it again.
signer_off() {
  [ "${SEPARATE}" = 1 ] || return 0
  if [ "${PM2_SYSTEMD}" = 1 ]; then
    if systemctl is-active --quiet "pm2-${SIGNER_USER}" 2>/dev/null || systemctl is-enabled --quiet "pm2-${SIGNER_USER}" 2>/dev/null; then
      say "The signer runs nothing now: stopping pm2-${SIGNER_USER}"
      systemctl disable --now --quiet "pm2-${SIGNER_USER}" >/dev/null 2>&1 || warn "Could not stop pm2-${SIGNER_USER}. See: systemctl status pm2-${SIGNER_USER}"
    fi
  else
    run_pm2 "${CURRENT}" signer kill >/dev/null 2>&1 || true
  fi
  # Its last status would read as a stale signer in /v1/health: removed (as the signer, in its own directory).
  if [ -n "${SIGNER_STATUS_DIR}" ]; then as_signer rm -f -- "${SIGNER_STATUS_DIR}/status.json" >/dev/null 2>&1 || true; fi
}
# Whether the signer runs with the live release: ONCHAIN_WORKERS=true and its copy of that release exists.
SIGNER_EXPECTED=0
signer_expect() { SIGNER_EXPECTED=0; if [ "${ONCHAIN}" = 1 ] && signer_ready "$1"; then SIGNER_EXPECTED=1; fi; }
port_of() { local p; p="$(env_get "${ENV_FILE}" "$1")"; if valid_port "${p}"; then printf '%s' "${p}"; else printf '%s' "$2"; fi; }
API_PORT="$(port_of PORT_API 4000)"
WEB_PORT="$(port_of PORT_WEB 3000)"
PROXY_SECRET_VALUE="$(env_get "${ENV_FILE}" PROXY_SECRET)"
[[ "${PROXY_SECRET_VALUE}" =~ ^[0-9a-fA-F]{32,128}$ ]] || PROXY_SECRET_VALUE=""

# The command to read an app's logs (as the user, without handing it this terminal: R3-01).
logs_hint() {
  local u="${APP_USER}"
  [ "$1" != velum-web ] || u="${WEB_USER}"
  [ "$1" != velum-signer ] || u="${SIGNER_USER}"
  if [ "${SEPARATE}" = 1 ]; then printf 'bash %s/deploy/as-user.sh %s pm2 logs %s --lines 100 --nostream' "${BASE}" "${u}" "$1"; else printf 'pm2 logs %s --lines 100 --nostream' "$1"; fi
}

# GET on the API: on its unix socket (R3-03), or 127.0.0.1:PORT_API in local setups without one. The
# proxy secret goes only to the socket, through curl's stdin config (never on a command line other
# users can read), so the check has its own rate-limit bucket (R2-I4). No proxy for local requests.
api_get() {
  local url="http://127.0.0.1:${API_PORT}$1" sock=()
  if [ -n "${API_SOCKET_PATH}" ]; then url="http://velum-api$1"; sock=(--unix-socket "${API_SOCKET_PATH}"); fi
  if [ -n "${PROXY_SECRET_VALUE}" ] && [ -n "${API_SOCKET_PATH}" ]; then
    printf 'header = "X-Velum-Proxy-Secret: %s"\nheader = "X-Real-IP: velum-deploy-%s"\n' "${PROXY_SECRET_VALUE}" "$$" | curl -fsS --noproxy '*' --max-time 5 "${sock[@]}" -K - "${url}"
  else
    curl -fsS --noproxy '*' --max-time 5 "${sock[@]}" "${url}"
  fi
}
web_code() { curl -s --noproxy '*' --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/" || true; }
workers_age() { api_get /v1/health 2>/dev/null | sed -n 's/.*"workers":\([0-9]\{1,9\}\)[,}].*/\1/p'; }
# Seconds since the signer last wrote its status file, as the API read it (root never reads the signer's files).
signer_age() { api_get /v1/health 2>/dev/null | sed -n 's/.*"signer":\([0-9]\{1,9\}\)[,}].*/\1/p'; }

# PM2 state of every Velum app instance in both daemons, "user<TAB>name<TAB>status<TAB>restarts", sorted.
pm2_snapshot() {
  {
    run_pm2 "${CURRENT}" app status | sed "s/^/${APP_USER}\t/"
    if [ "${SEPARATE}" = 1 ]; then run_pm2 "${CURRENT}" web status | sed "s/^/${WEB_USER}\t/"; fi
    if [ "${SIGNER_EXPECTED}" = 1 ]; then run_pm2 "${CURRENT}" signer status | sed "s/^/${SIGNER_USER}\t/"; fi
  } 2>/dev/null | tty_sanitize | sort
}
# check_snapshot TEXT — every expected app has instances, all online, under the expected user.
check_snapshot() {
  local snap="$1" app user line tab=$'\t' re
  re="^[a-z_][a-z0-9_-]*${tab}velum-[a-z]+${tab}[a-z_-]+${tab}[0-9]+\$"
  while IFS= read -r line; do
    [[ "${line}" =~ ${re} ]] || { warn "Unexpected PM2 status line: ${line}"; return 1; }
    [ "$(printf '%s' "${line}" | cut -f3)" = online ] || { warn "$(printf '%s' "${line}" | cut -f2) is $(printf '%s' "${line}" | cut -f3) in PM2. See: $(logs_hint "$(printf '%s' "${line}" | cut -f2)")"; return 1; }
  done <<<"${snap}"
  local apps="velum-api velum-workers velum-web"
  if [ "${SIGNER_EXPECTED}" = 1 ]; then apps="${apps} velum-signer"; fi
  for app in ${apps}; do
    user="${APP_USER}"
    [ "${app}" = velum-web ] && user="${WEB_USER}"
    [ "${app}" = velum-signer ] && user="${SIGNER_USER}"
    printf '%s\n' "${snap}" | awk -F'\t' -v u="${user}" -v a="${app}" '$1 == u && $2 == a' | grep -q . || { warn "${app} is not running under ${user}'s PM2."; return 1; }
  done
}

# health SINCE — SINCE is the time (epoch seconds) after PM2 applied this release.
health() {
  local since="$1" ok="" code="" w s1 s2
  # 1. API: 30 s (it answers within seconds; a crashing release keeps it down while we wait).
  for _ in $(seq 1 15); do
    if api_get /v1/health >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  [ -n "${ok}" ] || { warn "API health check failed. See: $(logs_hint velum-api)"; return 1; }
  # 2. Web root: 60 s.
  for _ in $(seq 1 30); do
    code="$(web_code)"
    [ "${code}" = "200" ] && break
    sleep 2
  done
  [ "${code}" = "200" ] || { warn "Web check failed (HTTP ${code:-none}). See: $(logs_hint velum-web)"; return 1; }
  # 3. Workers: a liveness heartbeat written after the switch proves the new process got through start-up.
  ok=""
  for _ in $(seq 1 "$(((WORKERS_WAIT_SECONDS + 1) / 2))"); do
    w="$(workers_age)"
    if [ -n "${w}" ] && [ "$(($(date +%s) - w))" -ge "$((since - 1))" ]; then ok=1; break; fi
    sleep 2
  done
  [ -n "${ok}" ] || { warn "The workers did not report alive within ${WORKERS_WAIT_SECONDS}s of the switch. See: $(logs_hint velum-workers)"; return 1; }
  # 3b. The signer (M-2): a status written after the switch proves the new signer got through start-up.
  if [ "${SIGNER_EXPECTED}" = 1 ]; then
    ok=""
    for _ in $(seq 1 "$(((WORKERS_WAIT_SECONDS + 1) / 2))"); do
      w="$(signer_age)"
      if [ -n "${w}" ] && [ "$(($(date +%s) - w))" -ge "$((since - 1))" ]; then ok=1; break; fi
      sleep 2
    done
    [ -n "${ok}" ] || { warn "The signer did not write its status within ${WORKERS_WAIT_SECONDS}s of the switch. See: $(logs_hint velum-signer)"; return 1; }
  fi
  # 4. Settle: catch an app that crashes or crash-loops after PM2 reported it started.
  s1="$(pm2_snapshot)"
  check_snapshot "${s1}" || return 1
  if [ "${HEALTH_SETTLE_SECONDS}" -gt 0 ]; then
    say "Watching the apps for ${HEALTH_SETTLE_SECONDS}s (crashes, restarts)"
    sleep "${HEALTH_SETTLE_SECONDS}"
  fi
  s2="$(pm2_snapshot)"
  check_snapshot "${s2}" || return 1
  if [ "${s1}" != "${s2}" ]; then
    warn "An app restarted while settling (PM2 restart counts changed):"
    diff <(printf '%s\n' "${s1}") <(printf '%s\n' "${s2}") | sed -n 's/^> /  now: /p' >&2 || true
    return 1
  fi
  api_get /v1/health >/dev/null 2>&1 || { warn "The API stopped answering while settling. See: $(logs_hint velum-api)"; return 1; }
  [ "$(web_code)" = 200 ] || { warn "The web stopped answering while settling. See: $(logs_hint velum-web)"; return 1; }
  w="$(workers_age)"
  [ -n "${w}" ] && [ "${w}" -le 15 ] || { warn "The workers heartbeat is stale (${w:-none}s). See: $(logs_hint velum-workers)"; return 1; }
  if [ "${SIGNER_EXPECTED}" = 1 ]; then
    w="$(signer_age)"
    [ -n "${w}" ] && [ "${w}" -le 15 ] || { warn "The signer's status is stale (${w:-none}s). See: $(logs_hint velum-signer)"; return 1; }
  fi
  # The API's answer is the app user's output: shown without control characters (R3-01).
  { api_get /v1/health | tty_sanitize; } && echo
}

# Root-rendered files the apps and Nginx read: web.env (the web's only settings) and the Nginx
# snippets (headers with the CSP, the API upstream on its unix socket, the proxy secret). Snippets are
# refreshed only when server-setup.sh created them; Nginx is reloaded only when one changed and nginx -t
# accepts it.
write_web_env() {
  [ "${SEPARATE}" = 1 ] || return 0
  render_web_env "${ENV_FILE}" | install_file "${WEB_ENV_FILE}" 640 "root:${WEB_GROUP}"
  # The signer's settings (M-2): no secrets, only what the signer reads, plus its paths.
  render_signer_env "${ENV_FILE}" | install_file "${SIGNER_ENV_FILE}" 640 "root:${SIGNER_GROUP}"
}
snippet_content() {
  case "$1" in
    "${NGINX_SNIPPET}") printf '%s' "${HEADERS}" ;;
    "${NGINX_PROXY_SNIPPET}") printf '%s' "${PROXY_INCLUDE}" ;;
    "${NGINX_API_SNIPPET}") printf '%s' "${API_UPSTREAM}" ;;
  esac
}
update_nginx() {
  local f content changed=0
  [ "$(id -u)" -eq 0 ] || return 0
  for f in "${NGINX_SNIPPET}" "${NGINX_PROXY_SNIPPET}" "${NGINX_API_SNIPPET}"; do
    [ -f "${f}" ] || continue
    content="$(snippet_content "${f}")"
    [ -n "${content}" ] || continue
    if printf '%s\n' "${content}" | cmp -s - "${f}"; then continue; fi
    cp -p "${f}" "${f}.prev"
    if [ "${f}" = "${NGINX_PROXY_SNIPPET}" ]; then printf '%s\n' "${content}" | install_file "${f}" 600 root:root; else printf '%s\n' "${content}" | install_file "${f}" 644 root:root; fi
    changed=1
  done
  [ "${changed}" = 1 ] || return 0
  if [ "${VELUM_NGINX_RELOAD:-1}" = "1" ] && command -v nginx >/dev/null; then
    if nginx -t -q 2>/dev/null; then
      if ! nginx_reload; then
        restore_nginx
        warn "Nginx did not apply the new snippets (see its error log); kept the previous ones. Not switching the apps."
        return 1
      fi
      say "Nginx snippets updated (CSP from .env; /api/ on the API socket)"
    else
      restore_nginx
      warn "nginx -t rejected the new snippets; kept the previous ones."
    fi
  fi
}
restore_nginx() {
  local f any=0
  [ "$(id -u)" -eq 0 ] || return 0
  for f in "${NGINX_SNIPPET}" "${NGINX_PROXY_SNIPPET}" "${NGINX_API_SNIPPET}"; do
    if [ -f "${f}.prev" ]; then mv -f "${f}.prev" "${f}"; any=1; fi
  done
  if [ "${any}" = 1 ] && [ "${VELUM_NGINX_RELOAD:-1}" = "1" ] && command -v nginx >/dev/null && nginx -t -q 2>/dev/null; then nginx_reload || true; fi
}
forget_nginx_backups() { rm -f "${NGINX_SNIPPET}.prev" "${NGINX_PROXY_SNIPPET}.prev" "${NGINX_API_SNIPPET}.prev" 2>/dev/null || true; }

# run_pm2 RELEASE-DIR app|web|signer ARGS… — release.sh ARGS as the app, web or signer user (isolated, R3-01). The
# signer always runs its own copy's release.sh (<signer home>/current), never the app user's (M-2).
run_pm2() {
  local dir="$1" who="$2"
  shift 2
  case "${who}" in
    web) as_web bash "${dir}/deploy/release.sh" "$@" ;;
    signer) as_signer bash "${SIGNER_HOME}/current/deploy/release.sh" "$@" ;;
    *) as_app bash "${dir}/deploy/release.sh" "$@" ;;
  esac
}

# pm2_daemon_up RELEASE-DIR app|web — with systemd: writes and enables pm2-<user>, moves a daemon of that
# user that runs outside the unit (started by hand or by an older deploy from root's shell) under it
# (its apps restart), starts the unit, and restarts it when the daemon holds a secret in its own
# environment (cluster workers inherit it). Returns 1 (with a warning) when the daemon cannot be started.
pm2_daemon_up() {
  local dir="$1" who="$2" user home unit main=0 others
  [ "${PM2_SYSTEMD}" = 1 ] || return 0
  case "${who}" in
    web) user="${WEB_USER}"; home="${WEB_HOME}" ;;
    signer) user="${SIGNER_USER}"; home="${SIGNER_HOME}" ;;
    *) user="${APP_USER}"; home="${APP_HOME}" ;;
  esac
  unit="pm2-${user}"
  ensure_pm2_unit "${user}" "${home}"
  if systemctl is-active --quiet "${unit}"; then main="$(systemctl show -p MainPID --value "${unit}")"; fi
  others="$(pm2_daemon_pids "${user}" "${home}/.pm2" | grep -vx -- "${main}" || true)"
  if [ -n "${others}" ]; then
    warn "The PM2 daemon of ${user} runs outside ${unit} (started by hand or by an older deploy); moving it under systemd, so its apps restart."
    run_pm2 "${dir}" "${who}" save >/dev/null 2>&1 || true
    run_pm2 "${dir}" "${who}" kill >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      others="$(pm2_daemon_pids "${user}" "${home}/.pm2" | grep -vx -- "${main}" || true)"
      [ -n "${others}" ] || break
      sleep 0.5
    done
    if [ -n "${others}" ]; then
      # As that user, so a reused PID can never hit another user's process.
      # shellcheck disable=SC2086
      as_user "${user}" "${home}" "${who}" kill -KILL ${others} >/dev/null 2>&1 || true
      sleep 1
      others="$(pm2_daemon_pids "${user}" "${home}/.pm2" | grep -vx -- "${main}" || true)"
      [ -z "${others}" ] || { warn "Could not stop the PM2 daemon of ${user} that runs outside ${unit} (PID ${others//$'\n'/ })."; return 1; }
    fi
  fi
  if ! systemctl is-active --quiet "${unit}"; then
    systemctl start "${unit}" || { warn "Could not start ${unit}. See: systemctl status ${unit}"; return 1; }
  fi
  main="$(systemctl show -p MainPID --value "${unit}")"
  if ! [[ "${main}" =~ ^[1-9][0-9]*$ ]] || [ "$(stat -c %U "/proc/${main}" 2>/dev/null)" != "${user}" ]; then
    warn "${unit} is active but runs no PM2 daemon of ${user}. See: systemctl status ${unit}"
    return 1
  fi
  if tr '\0' '\n' <"/proc/${main}/environ" 2>/dev/null | cut -d= -f1 | grep -Eq "${SECRET_ENV_NAMES}"; then
    say "The PM2 daemon of ${user} has secrets in its own environment; restarting ${unit} with a clean one"
    systemctl restart "${unit}" || { warn "Could not restart ${unit}."; return 1; }
  fi
}

pm2_apply() {
  { pm2_daemon_up "${CURRENT}" app && run_pm2 "${CURRENT}" app pm2; } || return 1
  if [ "${SEPARATE}" = 1 ]; then { pm2_daemon_up "${CURRENT}" web && run_pm2 "${CURRENT}" web pm2; } || return 1; fi
  if [ "${SIGNER_EXPECTED}" = 1 ]; then { pm2_daemon_up "${CURRENT}" signer && run_pm2 "${CURRENT}" signer pm2; } || return 1; else signer_off; fi
}
pm2_list() {
  run_pm2 "${CURRENT}" app ls || true
  if [ "${SEPARATE}" = 1 ]; then run_pm2 "${CURRENT}" web ls || true; fi
  if [ "${SIGNER_EXPECTED}" = 1 ]; then run_pm2 "${CURRENT}" signer ls || true; fi
}

# ── First release over an older layout (R2-M2) ───────────────────────────────
# The app user's PM2 may still run Velum from an older in-place checkout. Before this release
# replaces those apps, keep a root-only copy of the process list (saved and read as the app user;
# root never reads or writes through the app user's paths) so a failed release can put them back.
LEGACY_DUMP=""
capture_legacy() {
  local running
  [ "${SEPARATE}" = 1 ] && [ -z "$(current_id)" ] || return 0
  running="$(run_pm2 "${REL}" app status 2>/dev/null || true)"
  [ -n "${running}" ] || return 0
  say "The app user's PM2 runs Velum apps from an older layout; saving its process list first"
  install -d -o root -g root -m 700 "${BACKUPS}"
  LEGACY_DUMP="${BACKUPS}/pm2-dump-before-first-release.$(date -u +%Y%m%d%H%M%S).json"
  if ! run_pm2 "${REL}" app save >/dev/null || ! as_app cat -- "${PM2_DIR}/dump.pm2" | install_file "${LEGACY_DUMP}" 600 root:root || ! grep -q '"velum-' "${LEGACY_DUMP}"; then
    rm -f "${LEGACY_DUMP}"
    drop_release "${REL}"
    STAGE=aborted
    die "Could not save the running PM2 process list; nothing was switched (the old apps keep running). Save it by hand (docs/05-deploy-vps.md, Upgrading) and re-run."
  fi
  say "Saved to ${LEGACY_DUMP} (root-only). If this release fails its checks, those apps are restored from it automatically."
}
restore_legacy() {
  local ok="" code=""
  warn "Restoring the apps that ran before this first release (older layout) from ${LEGACY_DUMP}"
  run_pm2 "${REL}" web delete velum-web >/dev/null 2>&1 || true
  run_pm2 "${REL}" web save >/dev/null 2>&1 || true
  if [ "${PM2_SYSTEMD}" = 1 ]; then systemctl disable --now --quiet "pm2-${WEB_USER}" >/dev/null 2>&1 || true; fi
  SIGNER_EXPECTED=0
  signer_off
  run_pm2 "${REL}" app delete velum-api velum-workers velum-web >/dev/null 2>&1 || true
  # Written as the app user into its own PM2 home, then resurrected by its own PM2 (under its unit).
  # shellcheck disable=SC2016
  as_app sh -c 'umask 077 && cat >"$PM2_HOME/dump.pm2.velum-restore" && mv -f "$PM2_HOME/dump.pm2.velum-restore" "$PM2_HOME/dump.pm2" && rm -f "$PM2_HOME/velum-apps.sha256"' <"${LEGACY_DUMP}"
  if [ "${PM2_SYSTEMD}" = 1 ]; then
    systemctl restart "pm2-${APP_USER}" || warn "Could not restart pm2-${APP_USER}. See: systemctl status pm2-${APP_USER}"
  else
    run_pm2 "${REL}" app resurrect >/dev/null || true
  fi
  rm -f "${CURRENT}" "${PREVIOUS}"
  restore_nginx
  # The older layout's API listens on TCP and knows no proxy secret: none is sent.
  for _ in $(seq 1 30); do
    code="$(web_code)"
    if [ "${code}" = 200 ] && curl -fsS --noproxy '*' --max-time 5 -o /dev/null "http://127.0.0.1:${API_PORT}/v1/health"; then ok=1; break; fi
    sleep 2
  done
  run_pm2 "${REL}" app ls || true
  if [ -n "${ok}" ]; then echo "✓ The apps from before this release run again (API and web answer)." >&2; else warn "The restored apps do not answer yet. Check: $(logs_hint velum-api)"; fi
}

# ── Rollback ─────────────────────────────────────────────────────────────────
if [ "${ACTION}" = "rollback" ]; then
  cur="$(current_id)"
  [ -n "${cur}" ] || die "No current release to roll back from."
  prev="$(previous_id "${cur}")"
  [ -n "${prev}" ] || die "No earlier release built by ${APP_USER} is kept; nothing to roll back to."
  # A release runs only with the settings it was built with (R3-04): after set-network.sh (or an edit
  # of NEXT_PUBLIC_*) the previous release would serve a web bundle for one network while web.env, the
  # API and the CSP follow the other.
  redis_url_ok_for "${prev}" || die "Not rolling back to ${prev}: it predates the unix-socket REDIS_URL in ${ENV_FILE} (Velum's own Redis) and could not connect to Redis. Run deploy/redis-velum.sh --rollback first, or deploy a new release."
  env_matches "${prev}" || die "Not rolling back to ${prev}: running it with this .env would mix two configurations (web bundle, API and CSP). Put the values it was built with back into ${ENV_FILE} (the .env.bak.* files next to it keep earlier versions; set-network.sh switches the network with a new release) and run --rollback again, or deploy a new release."
  # With ONCHAIN_WORKERS=true the signer must run with it: only from its own copy of that release (M-2).
  if [ "${ONCHAIN}" = 1 ] && ! signer_ready "${prev}"; then
    die "Not rolling back to ${prev}: ONCHAIN_WORKERS=true, but ${SIGNER_USER} has no copy of ${prev} (it was built while ONCHAIN_WORKERS was off, or before the signer split), so the price relayer and keeper would stop. Deploy a new release instead, or set ONCHAIN_WORKERS=false first."
  fi
  say "Rolling back ${cur} → ${prev}"
  if [ "${SEPARATE}" = 1 ]; then apply_tmpfiles "${API_SOCKET_PATH}" "${SIGNER_STATUS_DIR}"; fi
  write_web_env
  activate "${prev}"
  signer_expect "${prev}"
  if [ "${SIGNER_EXPECTED}" = 1 ]; then signer_activate "${prev}"; fi
  remember_previous ""
  pm2_apply || die "PM2 could not start ${prev}. See: $(logs_hint velum-api)"
  health "$(date +%s)" || die "The previous release ${prev} is not healthy either. See pm2 logs."
  pm2_list
  echo "✓ Rolled back to ${prev}. Database migrations are not rolled back."
  exit 0
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
HEADERS=""
PROXY_INCLUDE=""
API_UPSTREAM=""
if [ "$(id -u)" -eq 0 ] && [ -f "${NGINX_SNIPPET}" ]; then
  HEADERS="$(render_security_headers "${ENV_FILE}")" || die "Fix NEXT_PUBLIC_RPC_URL in ${ENV_FILE}."
fi
if [ "$(id -u)" -eq 0 ] && [ -f "${NGINX_PROXY_SNIPPET}" ] && [ -n "${API_SOCKET_PATH}" ]; then
  PROXY_INCLUDE="$(render_proxy_secret_for socket "${ENV_FILE}")" || die "Fix PROXY_SECRET in ${ENV_FILE} (or re-run deploy/server-setup.sh)."
fi
if [ "$(id -u)" -eq 0 ] && [ -f "${NGINX_API_SNIPPET}" ] && [ -n "${API_SOCKET_PATH}" ]; then
  API_UPSTREAM="$(render_api_upstream socket "${API_SOCKET_PATH}")"
fi
# With PROXY_SECRET the API trusts X-Real-IP only from requests that carry it (R2-I4). If Nginx does
# not send it, every visitor would share one rate-limit bucket: refuse instead of deploying that. As
# root the API listens only on its unix socket (R3-03): the site must take /api/ there.
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/velum.conf}"
if [ "$(id -u)" -eq 0 ] && [ -f "${NGINX_SITE}" ]; then
  if [ -n "${PROXY_SECRET_VALUE}" ] && ! grep -q 'velum-proxy-secret\.conf' "${NGINX_SITE}"; then
    die "PROXY_SECRET is set in .env but ${NGINX_SITE} does not include snippets/velum-proxy-secret.conf, so the API would see every visitor as one client. Re-run deploy/server-setup.sh (it updates the site file) or remove PROXY_SECRET from .env."
  fi
  if [ "${SEPARATE}" = 1 ] && { ! grep -q 'velum-api-upstream\.conf' "${NGINX_SITE}" || [ ! -f "${NGINX_API_SNIPPET}" ]; }; then
    die "${NGINX_SITE} comes from an older template: it does not send /api/ to the API's unix socket (snippets/velum-api-upstream.conf). Re-run deploy/server-setup.sh (it updates the site file and keeps HTTPS)."
  fi
fi
if [ "${SEPARATE}" = "1" ]; then
  install -d -o root -g root -m 751 "${RELEASES}"
  apply_tmpfiles "${API_SOCKET_PATH}" "${SIGNER_STATUS_DIR}"
else
  mkdir -p "${RELEASES}"
fi

COMMIT="$(root_git rev-parse HEAD)"
ID="$(date -u +%Y%m%d%H%M%S)-${COMMIT:0:12}"
while [ -e "${RELEASES}/${ID}" ]; do sleep 1; ID="$(date -u +%Y%m%d%H%M%S)-${COMMIT:0:12}"; done
REL="${RELEASES}/${ID}"
PREV_ID="$(current_id)"
STAGE=build
on_exit() {
  local rc=$?
  if [ "${rc}" -ne 0 ] && [ "${STAGE}" = "build" ]; then
    drop_release "${REL}"
    echo "✗ Build of ${COMMIT:0:12} failed. Nothing was switched: the running release (${PREV_ID:-none}) is untouched." >&2
  fi
}
trap on_exit EXIT

say "Creating release ${ID}"
mkdir -m 750 "${REL}"
if [ "${SEPARATE}" = "1" ]; then
  # Owner: the app user (builds it). Group: the web user's group (runs the web from it, read-only).
  chown "${APP_USER}:${WEB_GROUP}" "${REL}"
  chmod 2750 "${REL}"
fi
root_git archive --format=tar "${COMMIT}" | as_app tar -x -C "${REL}"

say "Building ${ID} as ${APP_USER} (the live release is not touched)"
BUILD_RECORD="$(build_env_record "${ENV_FILE}")"
# The Next.js cache only from a release this app user built (never from an earlier app user's, R3-05).
CACHE_FROM=""
if [ -n "${PREV_ID}" ] && release_ours "${PREV_ID}"; then CACHE_FROM="${RELEASES}/${PREV_ID}"; fi
as_app ${CACHE_FROM:+"VELUM_PREVIOUS=${CACHE_FROM}"} bash "${REL}/deploy/release.sh" build
[ -f "${REL}/.velum-release-ok" ] || die "The build did not finish."
[ "$(build_env_record "${ENV_FILE}")" = "${BUILD_RECORD}" ] || die "VELUM_NETWORK, CHAIN_ID or a NEXT_PUBLIC_* value in .env changed during the build. Run deploy.sh again."
printf '%s\n' "${BUILD_RECORD}" | install_file "$(record_of "${ID}")" 600 root:root
if [ "${ONCHAIN}" = 1 ]; then build_signer "${ID}" "${COMMIT}"; fi

capture_legacy

say "Switching current → ${ID}"
STAGE=switched
write_web_env
activate "${ID}"
signer_expect "${ID}"
if [ "${SIGNER_EXPECTED}" = 1 ]; then signer_activate "${ID}"; fi
PM2_OK=1
# A snippet change Nginx does not apply (H-1) would leave /api/ pointing elsewhere: treat it as a failed release.
if update_nginx; then pm2_apply || PM2_OK=0; else PM2_OK=0; fi
SINCE="$(date +%s)"

say "Health check"
if [ "${PM2_OK}" = "1" ] && health "${SINCE}"; then
  forget_nginx_backups
  remember_previous "${PREV_ID}"
else
  if [ -n "${PREV_ID}" ] && release_ours "${PREV_ID}"; then
    warn "Release ${ID} is not healthy."
    # set-network.sh passes the .env it replaced: with it, the previous release runs with its own
    # network again (R3-04).
    if [ -n "${VELUM_ENV_RESTORE:-}" ] && ! env_matches "${PREV_ID}" >/dev/null 2>&1; then
      restore_env_backup "${VELUM_ENV_RESTORE}"
      warn "Put back ${ENV_FILE} from ${VELUM_ENV_RESTORE##*/} (the settings ${PREV_ID} was built with)."
    fi
    if env_matches "${PREV_ID}" && redis_url_ok_for "${PREV_ID}"; then
      warn "Switching back to ${PREV_ID}."
      write_web_env
      activate "${PREV_ID}"
      # The signer goes back with it when it has a copy of that release; otherwise it stops (it signs nothing).
      signer_expect "${PREV_ID}"
      if [ "${SIGNER_EXPECTED}" = 1 ]; then signer_activate "${PREV_ID}"; elif [ "${ONCHAIN}" = 1 ]; then warn "${SIGNER_USER} has no copy of ${PREV_ID}: the price relayer and keeper stay stopped until the next healthy release."; fi
      restore_nginx
      pm2_apply || true
      health "$(date +%s)" >/dev/null || warn "The previous release is not healthy either. See: $(logs_hint velum-api)"
      drop_release "${REL}"
      die "Release ${ID} failed its checks and was rolled back to ${PREV_ID}. Migrations it applied stay applied."
    fi
    forget_nginx_backups
    remember_previous "${PREV_ID}"
    die "Release ${ID} failed its checks and stays active: running ${PREV_ID} with this .env would mix two configurations (above). Fix the problem and deploy again, or put back the values ${PREV_ID} was built with and run deploy.sh --rollback."
  fi
  if [ -n "${LEGACY_DUMP}" ]; then
    warn "Release ${ID} is not healthy."
    restore_legacy
    drop_release "${REL}"
    die "Release ${ID} failed its checks. The apps that ran before it were restored from ${LEGACY_DUMP}; this base has no current release again. Fix the problem, then run deploy.sh again. Migrations it applied stay applied."
  fi
  die "Release ${ID} failed its checks and there is no previous release to switch back to. See pm2 logs."
fi

# Prune: keep the newest KEEP_RELEASES, always current and previous (and every release record whose
# release is gone).
mapfile -t ALL < <(releases_sorted)
n=0
for ((i = ${#ALL[@]} - 1; i >= 0; i--)); do
  r="${ALL[i]}"
  n=$((n + 1))
  if [ "${n}" -gt "${KEEP_RELEASES}" ] && [ "${r}" != "${ID}" ] && [ "${r}" != "${PREV_ID}" ]; then drop_release "${RELEASES}/${r}"; fi
done
while IFS= read -r r; do
  [ -d "${RELEASES}/${r%.build-env}" ] || rm -f -- "${RELEASES:?}/${r}"
done < <(find "${RELEASES}" -maxdepth 1 -type f -name '*.build-env' -printf '%f\n')
# The signer's copies of releases that are gone (as the signer; never the one its current points at).
if [ "${SEPARATE}" = 1 ] && id -u "${SIGNER_USER}" >/dev/null 2>&1; then
  KEEP_IDS="$(releases_sorted | tr '\n' ' ')"
  # shellcheck disable=SC2016 # expanded by the signer's sh
  as_signer env KEEP_IDS=" ${KEEP_IDS}" sh -c 'cd "$HOME/releases" 2>/dev/null || exit 0; cur="$(readlink "$HOME/current" 2>/dev/null)"; for d in *; do [ -e "$d" ] || continue; case "$KEEP_IDS" in *" $d "*) continue ;; esac; [ "$cur" = "releases/$d" ] && continue; rm -rf -- "$d"; done' >/dev/null 2>&1 || true
fi

pm2_list
echo "✓ Deployed ${ID}${PREV_ID:+ (previous: ${PREV_ID}; roll back with: deploy.sh --rollback)}"
