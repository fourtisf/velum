#!/usr/bin/env bash
# Release script (Phase 2+). On the VPS run it as root; it builds and runs the apps as the app user:
#   sudo bash /opt/velum/deploy/deploy.sh              deploy the branch the checkout is on (BRANCH=name to override)
#   sudo bash /opt/velum/deploy/deploy.sh --rollback   switch back to the previous release
#
# How a release works (audit M4, M6):
#   1. Takes a lock (flock), so two deploys, set-network.sh or new-key.sh never overlap.
#   2. Runs git as root in the root-owned checkout (the app user cannot change anything root runs).
#   3. Exports the commit into a fresh directory releases/<time>-<commit>, owned by the app user, and
#      builds it there as the app user: install, build every app, migrate. The live release is never
#      touched, so a failed build leaves the running site exactly as it was.
#   4. Switches the `current` symlink atomically, then reloads PM2 (zero downtime) from it.
#   5. Health-checks API and web; on failure switches back to the previous release.
#   6. Keeps the newest KEEP_RELEASES (default 3) releases, always including current and previous.
# Run without root on a checkout you own (local or single-user setups), everything runs as you.
set -euo pipefail
umask 022
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
BASE="$(cd "$(dirname "${SELF}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${BASE}/deploy/lib/common.sh"
ENV_FILE="${BASE}/.env"
RELEASES="${BASE}/releases"
CURRENT="${BASE}/current"
PREVIOUS="${BASE}/previous"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
NGINX_SNIPPET="${NGINX_SNIPPET:-/etc/nginx/snippets/velum-security-headers.conf}"
ACTION=deploy
case "${1:-}" in
  "") ;;
  --rollback) ACTION=rollback ;;
  *) die "Usage: deploy.sh [--rollback]" ;;
esac
[[ "${KEEP_RELEASES}" =~ ^[0-9]+$ ]] && [ "${KEEP_RELEASES}" -ge 2 ] || die "KEEP_RELEASES must be 2 or more."

# ── Who runs what, checkout ownership (audit M4), lock ───────────────────────
velum_mode "${BASE}"
lock_deploy "${BASE}"

# ── Pull (as root, in the root-owned checkout), then re-run the fresh copy of this script ──
if [ "${ACTION}" = "deploy" ] && [ -z "${VELUM_DEPLOY_PULLED:-}" ]; then
  BRANCH="${BRANCH:-$(git -C "${BASE}" rev-parse --abbrev-ref HEAD)}"
  say "Pulling latest (${BRANCH})"
  git -C "${BASE}" fetch origin "${BRANCH}" --prune
  git -C "${BASE}" reset --hard "origin/${BRANCH}"
  VELUM_DEPLOY_PULLED=1 BRANCH="${BRANCH}" exec bash "${SELF}" "$@"
fi

cd "${BASE}"
[ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE}. Copy .env.example to .env and fill it (or run deploy/server-setup.sh)."

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

health() {
  local api web code="" ok=""
  api="$(port_of PORT_API 4000)"
  web="$(port_of PORT_WEB 3000)"
  # 30 s for the API (it answers within seconds; a crashing release keeps it down while we wait).
  for _ in $(seq 1 15); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:${api}/v1/health"; then ok=1; break; fi
    sleep 2
  done
  [ -n "${ok}" ] || { warn "API health check failed. See: pm2 logs velum-api --lines 100"; return 1; }
  for _ in $(seq 1 30); do
    code="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${web}/" || true)"
    [ "${code}" = "200" ] && break
    sleep 2
  done
  [ "${code}" = "200" ] || { warn "Web check failed (HTTP ${code:-none}). See: pm2 logs velum-web --lines 100"; return 1; }
  curl -s --max-time 5 "http://127.0.0.1:${api}/v1/health" && echo
}

# Security headers snippet (CSP connect-src follows the configured RPC). Root only, and only when
# server-setup.sh created it. Reloads Nginx when the content changed.
update_headers() {
  local headers="$1"
  [ "$(id -u)" -eq 0 ] && [ -f "${NGINX_SNIPPET}" ] || return 0
  if printf '%s\n' "${headers}" | cmp -s - "${NGINX_SNIPPET}"; then return 0; fi
  cp -p "${NGINX_SNIPPET}" "${NGINX_SNIPPET}.prev"
  printf '%s\n' "${headers}" >"${NGINX_SNIPPET}.tmp" && mv -f "${NGINX_SNIPPET}.tmp" "${NGINX_SNIPPET}"
  if [ "${VELUM_NGINX_RELOAD:-1}" = "1" ] && command -v nginx >/dev/null; then
    if nginx -t -q 2>/dev/null; then
      systemctl reload nginx
      say "Nginx security headers updated (CSP follows NEXT_PUBLIC_RPC_URL)"
    else
      mv -f "${NGINX_SNIPPET}.prev" "${NGINX_SNIPPET}"
      warn "nginx -t rejected the new security headers; kept the previous ones."
    fi
  fi
}
restore_headers() {
  if [ "$(id -u)" -eq 0 ] && [ -f "${NGINX_SNIPPET}.prev" ]; then
    mv -f "${NGINX_SNIPPET}.prev" "${NGINX_SNIPPET}"
    if [ "${VELUM_NGINX_RELOAD:-1}" = "1" ] && command -v nginx >/dev/null && nginx -t -q 2>/dev/null; then systemctl reload nginx; fi
  fi
}

pm2_apply() { as_app bash "${CURRENT}/deploy/release.sh" pm2; }
pm2_list() { as_app pm2 ls || true; }

# ── Rollback ─────────────────────────────────────────────────────────────────
if [ "${ACTION}" = "rollback" ]; then
  cur="$(current_id)"
  [ -n "${cur}" ] || die "No current release to roll back from."
  prev="$(previous_id "${cur}")"
  [ -n "${prev}" ] || die "No earlier release is kept; nothing to roll back to."
  say "Rolling back ${cur} → ${prev}"
  activate "${prev}"
  remember_previous ""
  pm2_apply
  health || die "The previous release ${prev} is not healthy either. See pm2 logs."
  pm2_list
  echo "✓ Rolled back to ${prev}. Database migrations are not rolled back."
  exit 0
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
HEADERS=""
if [ "$(id -u)" -eq 0 ] && [ -f "${NGINX_SNIPPET}" ]; then
  HEADERS="$(render_security_headers "${ENV_FILE}")" || die "Fix NEXT_PUBLIC_RPC_URL in ${ENV_FILE}."
fi
if [ "${SEPARATE}" = "1" ]; then install -d -o root -g "${APP_GROUP}" -m 750 "${RELEASES}"; else mkdir -p "${RELEASES}"; fi

COMMIT="$(git rev-parse HEAD)"
ID="$(date -u +%Y%m%d%H%M%S)-${COMMIT:0:12}"
while [ -e "${RELEASES}/${ID}" ]; do sleep 1; ID="$(date -u +%Y%m%d%H%M%S)-${COMMIT:0:12}"; done
REL="${RELEASES}/${ID}"
PREV_ID="$(current_id)"
STAGE=build
on_exit() {
  local rc=$?
  if [ "${rc}" -ne 0 ] && [ "${STAGE}" = "build" ]; then
    rm -rf "${REL:?}"
    echo "✗ Build of ${COMMIT:0:12} failed. Nothing was switched: the running release (${PREV_ID:-none}) is untouched." >&2
  fi
}
trap on_exit EXIT

say "Creating release ${ID}"
if [ "${SEPARATE}" = "1" ]; then install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 750 "${REL}"; else mkdir -m 750 "${REL}"; fi
git archive --format=tar "${COMMIT}" | as_app tar -x -C "${REL}"

say "Building ${ID} as ${APP_USER} (the live release is not touched)"
as_app ${PREV_ID:+"VELUM_PREVIOUS=${RELEASES}/${PREV_ID}"} bash "${REL}/deploy/release.sh" build
[ -f "${REL}/.velum-release-ok" ] || die "The build did not finish."

say "Switching current → ${ID}"
STAGE=switched
activate "${ID}"
update_headers "${HEADERS}"
PM2_OK=1
pm2_apply || PM2_OK=0

say "Health check"
if [ "${PM2_OK}" = "1" ] && health; then
  rm -f "${NGINX_SNIPPET}.prev" 2>/dev/null || true
  remember_previous "${PREV_ID}"
else
  if [ -n "${PREV_ID}" ] && [ -f "${RELEASES}/${PREV_ID}/.velum-release-ok" ]; then
    warn "Release ${ID} is not healthy; switching back to ${PREV_ID}."
    activate "${PREV_ID}"
    restore_headers
    pm2_apply || true
    health >/dev/null || warn "The previous release is not healthy either. See pm2 logs."
    rm -rf "${REL:?}"
    die "Release ${ID} failed its checks and was rolled back to ${PREV_ID}. Migrations it applied stay applied."
  fi
  die "Release ${ID} failed its checks and there is no previous release to switch back to. See pm2 logs."
fi

# Prune: keep the newest KEEP_RELEASES, always current and previous.
mapfile -t ALL < <(releases_sorted)
n=0
for ((i = ${#ALL[@]} - 1; i >= 0; i--)); do
  r="${ALL[i]}"
  n=$((n + 1))
  if [ "${n}" -gt "${KEEP_RELEASES}" ] && [ "${r}" != "${ID}" ] && [ "${r}" != "${PREV_ID}" ]; then rm -rf "${RELEASES:?}/${r}"; fi
done

pm2_list
echo "✓ Deployed ${ID}${PREV_ID:+ (previous: ${PREV_ID}; roll back with: deploy.sh --rollback)}"
