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
#   4. First release in this base while the app user's PM2 still runs Velum apps from elsewhere (an
#      older in-place layout): keeps a root-only copy of that PM2 process list (R2-M2).
#   5. Renders web.env and the Nginx snippets from .env, switches `current` atomically and reloads
#      PM2 with zero downtime: api + workers as the app user, the web as the web user (R2-M3).
#   6. Checks health: API, web, a workers heartbeat written after the switch, then after a settle
#      period again, plus PM2 status and restart counts (R2-L5). On failure it switches back to the
#      previous release, or (first release) restores the older layout's apps from step 4.
#   7. Keeps the newest KEEP_RELEASES (default 3) releases, always including current and previous.
# Run without root on a checkout you own (local or single-user setups), everything runs as you.
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
HEALTH_SETTLE_SECONDS="${HEALTH_SETTLE_SECONDS:-20}"
WORKERS_WAIT_SECONDS="${WORKERS_WAIT_SECONDS:-60}"
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

current_id() { local t; t="$(readlink "${CURRENT}" 2>/dev/null || true)"; printf '%s' "${t##*/}"; }
releases_sorted() { [ -d "${RELEASES}" ] && find "${RELEASES}" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort; return 0; }
previous_of() {
  local prev="" r
  while IFS= read -r r; do
    [ "${r}" = "$1" ] && break
    if [ -f "${RELEASES}/${r}/.velum-release-ok" ]; then prev="${r}"; fi
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
  if [ -n "${t}" ] && [ "${t}" != "$1" ] && [ -f "${RELEASES}/${t}/.velum-release-ok" ]; then printf '%s' "${t}"; else previous_of "$1"; fi
}
port_of() { local p; p="$(env_get "${ENV_FILE}" "$1")"; if valid_port "${p}"; then printf '%s' "${p}"; else printf '%s' "$2"; fi; }
API_PORT="$(port_of PORT_API 4000)"
WEB_PORT="$(port_of PORT_WEB 3000)"
PROXY_SECRET_VALUE="$(env_get "${ENV_FILE}" PROXY_SECRET)"
[[ "${PROXY_SECRET_VALUE}" =~ ^[0-9a-fA-F]{32,128}$ ]] || PROXY_SECRET_VALUE=""

logs_hint() { if [ "${SEPARATE}" = 1 ] && [ "$1" = velum-web ]; then printf 'runuser -u %s -- pm2 logs %s --lines 100' "${WEB_USER}" "$1"; elif [ "${SEPARATE}" = 1 ]; then printf 'runuser -u %s -- pm2 logs %s --lines 100' "${APP_USER}" "$1"; else printf 'pm2 logs %s --lines 100' "$1"; fi; }

# GET on the API. With PROXY_SECRET it sends the header Nginx sends, through curl's stdin config (never
# on a command line other users can read), so the check has its own rate-limit bucket (R2-I4).
api_get() {
  local url="http://127.0.0.1:${API_PORT}$1"
  if [ -n "${PROXY_SECRET_VALUE}" ]; then
    printf 'header = "X-Velum-Proxy-Secret: %s"\nheader = "X-Real-IP: velum-deploy-%s"\n' "${PROXY_SECRET_VALUE}" "$$" | curl -fsS --max-time 5 -K - "${url}"
  else
    curl -fsS --max-time 5 "${url}"
  fi
}
web_code() { curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/" || true; }
workers_age() { api_get /v1/health 2>/dev/null | sed -n 's/.*"workers":\([0-9]\{1,9\}\)[,}].*/\1/p'; }

# PM2 state of every Velum app instance in both daemons, "user<TAB>name<TAB>status<TAB>restarts", sorted.
pm2_snapshot() {
  {
    as_app bash "${CURRENT}/deploy/release.sh" status | sed "s/^/${APP_USER}\t/"
    if [ "${SEPARATE}" = 1 ]; then as_web bash "${CURRENT}/deploy/release.sh" status | sed "s/^/${WEB_USER}\t/"; fi
  } 2>/dev/null | sort
}
# check_snapshot TEXT — every expected app has instances, all online, under the expected user.
check_snapshot() {
  local snap="$1" app user line tab=$'\t' re
  re="^[a-z_][a-z0-9_-]*${tab}velum-[a-z]+${tab}[a-z_-]+${tab}[0-9]+\$"
  while IFS= read -r line; do
    [[ "${line}" =~ ${re} ]] || { warn "Unexpected PM2 status line: ${line}"; return 1; }
    [ "$(printf '%s' "${line}" | cut -f3)" = online ] || { warn "$(printf '%s' "${line}" | cut -f2) is $(printf '%s' "${line}" | cut -f3) in PM2. See: $(logs_hint "$(printf '%s' "${line}" | cut -f2)")"; return 1; }
  done <<<"${snap}"
  for app in velum-api velum-workers velum-web; do
    user="${APP_USER}"
    [ "${app}" = velum-web ] && user="${WEB_USER}"
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
  api_get /v1/health && echo
}

# Root-rendered files the apps and Nginx read: web.env (the web's only settings) and the Nginx
# snippets (headers with the CSP, proxy secret). Snippets are refreshed only when server-setup.sh
# created them; Nginx is reloaded only when one changed and nginx -t accepts it.
write_web_env() {
  [ "${SEPARATE}" = 1 ] || return 0
  render_web_env "${ENV_FILE}" | install_file "${WEB_ENV_FILE}" 640 "root:${WEB_GROUP}"
}
update_nginx() {
  local f content changed=0
  [ "$(id -u)" -eq 0 ] || return 0
  for f in "${NGINX_SNIPPET}" "${NGINX_PROXY_SNIPPET}"; do
    [ -f "${f}" ] || continue
    if [ "${f}" = "${NGINX_SNIPPET}" ]; then content="${HEADERS}"; else content="${PROXY_INCLUDE}"; fi
    [ -n "${content}" ] || continue
    if printf '%s\n' "${content}" | cmp -s - "${f}"; then continue; fi
    cp -p "${f}" "${f}.prev"
    if [ "${f}" = "${NGINX_SNIPPET}" ]; then printf '%s\n' "${content}" | install_file "${f}" 644 root:root; else printf '%s\n' "${content}" | install_file "${f}" 600 root:root; fi
    changed=1
  done
  [ "${changed}" = 1 ] || return 0
  if [ "${VELUM_NGINX_RELOAD:-1}" = "1" ] && command -v nginx >/dev/null; then
    if nginx -t -q 2>/dev/null; then
      systemctl reload nginx
      say "Nginx snippets updated (CSP follows NEXT_PUBLIC_RPC_URL and NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID)"
    else
      restore_nginx
      warn "nginx -t rejected the new snippets; kept the previous ones."
    fi
  fi
}
restore_nginx() {
  local f any=0
  [ "$(id -u)" -eq 0 ] || return 0
  for f in "${NGINX_SNIPPET}" "${NGINX_PROXY_SNIPPET}"; do
    if [ -f "${f}.prev" ]; then mv -f "${f}.prev" "${f}"; any=1; fi
  done
  if [ "${any}" = 1 ] && [ "${VELUM_NGINX_RELOAD:-1}" = "1" ] && command -v nginx >/dev/null && nginx -t -q 2>/dev/null; then systemctl reload nginx; fi
}
forget_nginx_backups() { rm -f "${NGINX_SNIPPET}.prev" "${NGINX_PROXY_SNIPPET}.prev" 2>/dev/null || true; }

pm2_apply() {
  as_app bash "${CURRENT}/deploy/release.sh" pm2
  if [ "${SEPARATE}" = 1 ]; then as_web bash "${CURRENT}/deploy/release.sh" pm2; fi
}
pm2_list() {
  as_app pm2 ls || true
  if [ "${SEPARATE}" = 1 ]; then as_web pm2 ls || true; fi
}

# ── First release over an older layout (R2-M2) ───────────────────────────────
# The app user's PM2 may still run Velum from an older in-place checkout. Before this release
# replaces those apps, keep a root-only copy of the process list (saved and read as the app user;
# root never reads or writes through the app user's paths) so a failed release can put them back.
LEGACY_DUMP=""
capture_legacy() {
  local running
  [ "${SEPARATE}" = 1 ] && [ -z "$(current_id)" ] || return 0
  running="$(as_app bash "${REL}/deploy/release.sh" status 2>/dev/null || true)"
  [ -n "${running}" ] || return 0
  say "The app user's PM2 runs Velum apps from an older layout; saving its process list first"
  install -d -o root -g root -m 700 "${BACKUPS}"
  LEGACY_DUMP="${BACKUPS}/pm2-dump-before-first-release.$(date -u +%Y%m%d%H%M%S).json"
  if ! as_app pm2 save --force >/dev/null || ! as_app cat -- "${PM2_DIR}/dump.pm2" | install_file "${LEGACY_DUMP}" 600 root:root || ! grep -q '"velum-' "${LEGACY_DUMP}"; then
    rm -f "${LEGACY_DUMP}"
    remove_release "${REL}"
    STAGE=aborted
    die "Could not save the running PM2 process list; nothing was switched (the old apps keep running). Save it by hand (docs/05-deploy-vps.md, Upgrading) and re-run."
  fi
  say "Saved to ${LEGACY_DUMP} (root-only). If this release fails its checks, those apps are restored from it automatically."
}
restore_legacy() {
  local ok="" code=""
  warn "Restoring the apps that ran before this first release (older layout) from ${LEGACY_DUMP}"
  as_web pm2 delete velum-web >/dev/null 2>&1 || true
  as_web pm2 save --force >/dev/null 2>&1 || true
  as_app pm2 delete velum-api velum-workers velum-web >/dev/null 2>&1 || true
  # Written as the app user into its own PM2 home, then resurrected by its own PM2.
  # shellcheck disable=SC2016
  as_app sh -c 'umask 077 && cat >"$PM2_HOME/dump.pm2.velum-restore" && mv -f "$PM2_HOME/dump.pm2.velum-restore" "$PM2_HOME/dump.pm2" && rm -f "$PM2_HOME/velum-apps.sha256"' <"${LEGACY_DUMP}"
  as_app pm2 resurrect >/dev/null
  rm -f "${CURRENT}" "${PREVIOUS}"
  restore_nginx
  for _ in $(seq 1 30); do
    code="$(web_code)"
    if [ "${code}" = 200 ] && curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:${API_PORT}/v1/health"; then ok=1; break; fi
    sleep 2
  done
  as_app pm2 ls || true
  if [ -n "${ok}" ]; then echo "✓ The apps from before this release run again (API and web answer)." >&2; else warn "The restored apps do not answer yet. Check: $(logs_hint velum-api)"; fi
}

# ── Rollback ─────────────────────────────────────────────────────────────────
if [ "${ACTION}" = "rollback" ]; then
  cur="$(current_id)"
  [ -n "${cur}" ] || die "No current release to roll back from."
  prev="$(previous_id "${cur}")"
  [ -n "${prev}" ] || die "No earlier release is kept; nothing to roll back to."
  say "Rolling back ${cur} → ${prev}"
  write_web_env
  activate "${prev}"
  remember_previous ""
  pm2_apply
  health "$(date +%s)" || die "The previous release ${prev} is not healthy either. See pm2 logs."
  pm2_list
  echo "✓ Rolled back to ${prev}. Database migrations are not rolled back."
  exit 0
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
HEADERS=""
PROXY_INCLUDE=""
if [ "$(id -u)" -eq 0 ] && [ -f "${NGINX_SNIPPET}" ]; then
  HEADERS="$(render_security_headers "${ENV_FILE}")" || die "Fix NEXT_PUBLIC_RPC_URL in ${ENV_FILE}."
fi
if [ "$(id -u)" -eq 0 ] && [ -f "${NGINX_PROXY_SNIPPET}" ]; then
  PROXY_INCLUDE="$(render_proxy_secret "${ENV_FILE}")" || die "Fix PROXY_SECRET in ${ENV_FILE} (or re-run deploy/server-setup.sh)."
fi
# With PROXY_SECRET the API trusts X-Real-IP only from requests that carry it (R2-I4). If Nginx does
# not send it, every visitor would share one rate-limit bucket: refuse instead of deploying that.
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/velum.conf}"
if [ "$(id -u)" -eq 0 ] && [ -n "${PROXY_SECRET_VALUE}" ] && [ -f "${NGINX_SITE}" ] && ! grep -q 'velum-proxy-secret\.conf' "${NGINX_SITE}"; then
  die "PROXY_SECRET is set in .env but ${NGINX_SITE} does not include snippets/velum-proxy-secret.conf, so the API would see every visitor as one client. Re-run deploy/server-setup.sh (it updates the site file) or remove PROXY_SECRET from .env."
fi
if [ "${SEPARATE}" = "1" ]; then install -d -o root -g root -m 751 "${RELEASES}"; else mkdir -p "${RELEASES}"; fi

COMMIT="$(root_git rev-parse HEAD)"
ID="$(date -u +%Y%m%d%H%M%S)-${COMMIT:0:12}"
while [ -e "${RELEASES}/${ID}" ]; do sleep 1; ID="$(date -u +%Y%m%d%H%M%S)-${COMMIT:0:12}"; done
REL="${RELEASES}/${ID}"
PREV_ID="$(current_id)"
STAGE=build
on_exit() {
  local rc=$?
  if [ "${rc}" -ne 0 ] && [ "${STAGE}" = "build" ]; then
    remove_release "${REL}"
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
as_app ${PREV_ID:+"VELUM_PREVIOUS=${RELEASES}/${PREV_ID}"} bash "${REL}/deploy/release.sh" build
[ -f "${REL}/.velum-release-ok" ] || die "The build did not finish."

capture_legacy

say "Switching current → ${ID}"
STAGE=switched
write_web_env
activate "${ID}"
update_nginx
PM2_OK=1
pm2_apply || PM2_OK=0
SINCE="$(date +%s)"

say "Health check"
if [ "${PM2_OK}" = "1" ] && health "${SINCE}"; then
  forget_nginx_backups
  remember_previous "${PREV_ID}"
else
  if [ -n "${PREV_ID}" ] && [ -f "${RELEASES}/${PREV_ID}/.velum-release-ok" ]; then
    warn "Release ${ID} is not healthy; switching back to ${PREV_ID}."
    activate "${PREV_ID}"
    restore_nginx
    pm2_apply || true
    health "$(date +%s)" >/dev/null || warn "The previous release is not healthy either. See pm2 logs."
    remove_release "${REL}"
    die "Release ${ID} failed its checks and was rolled back to ${PREV_ID}. Migrations it applied stay applied."
  fi
  if [ -n "${LEGACY_DUMP}" ]; then
    warn "Release ${ID} is not healthy."
    restore_legacy
    remove_release "${REL}"
    die "Release ${ID} failed its checks. The apps that ran before it were restored from ${LEGACY_DUMP}; this base has no current release again. Fix the problem, then run deploy.sh again. Migrations it applied stay applied."
  fi
  die "Release ${ID} failed its checks and there is no previous release to switch back to. See pm2 logs."
fi

# Prune: keep the newest KEEP_RELEASES, always current and previous.
mapfile -t ALL < <(releases_sorted)
n=0
for ((i = ${#ALL[@]} - 1; i >= 0; i--)); do
  r="${ALL[i]}"
  n=$((n + 1))
  if [ "${n}" -gt "${KEEP_RELEASES}" ] && [ "${r}" != "${ID}" ] && [ "${r}" != "${PREV_ID}" ]; then remove_release "${RELEASES}/${r}"; fi
done

pm2_list
echo "✓ Deployed ${ID}${PREV_ID:+ (previous: ${PREV_ID}; roll back with: deploy.sh --rollback)}"
