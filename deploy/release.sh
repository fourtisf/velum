#!/usr/bin/env bash
# Release steps that run as an app user. deploy/deploy.sh calls this with a clean environment;
# it is not meant to be run by hand.
#
#   release.sh build   (app user) Inside a fresh release directory: install, build every app, run
#                      migrations, then make the files readable (never writable) for the web user.
#                      Writes nothing outside that directory, so a failure leaves the live site alone.
#   release.sh signer-build
#                      (signer user, on-chain audit M-2) Inside the signer's own copy of the same commit, in its own
#                      home (root exports it with git archive; the signer never runs a file the app user wrote):
#                      installs only the workers' dependencies without lifecycle scripts and builds them. The signer
#                      bundle (apps/workers/dist/signer.js) needs neither Prisma nor Redis.
#   release.sh pm2     Start or zero-downtime reload this user's PM2 apps from <base>/current with
#                      per-app env allowlists (deploy/ecosystem.config.cjs). Does a clean delete + start
#                      when the app definitions or env keys changed, or when a running app comes from
#                      another directory (an older layout), so removed secrets never linger.
#   release.sh status  One line per Velum app instance in this user's PM2: name, status, restarts.
#   release.sh save | kill | ls | delete NAME… | resurrect
#                      The pm2 command of the same name, for deploy.sh (never by hand).
#
# VELUM_PM2_SCOPE picks the apps: backend (api + workers, the app user), web (the web user), signer (the price
# relayer and the keeper, the signer user, from its own copy: <signer home>/current) or all (single-user setups).
# Needs VELUM_BASE (the directory holding .env, web.env, signer.env, releases/ and current).
# Optional for build: VELUM_PREVIOUS (previous release directory, to reuse its Next.js build cache).
# VELUM_PM2_SYSTEMD=1 (set by deploy.sh as root): the daemon runs under its systemd unit (pm2-<user>),
# which deploy.sh starts first; then no command here ever starts a daemon (audit I-2): status prints
# nothing and the others stop with an error when the daemon is not running.
set -euo pipefail
umask 027
REL="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${REL}/deploy/lib/common.sh"
BASE="${VELUM_BASE:?VELUM_BASE is required (run deploy/deploy.sh instead)}"
SCOPE="${VELUM_PM2_SCOPE:-all}"
case "${SCOPE}" in backend | all) ENV_FILE="${BASE}/.env" ;; web) ENV_FILE="${BASE}/web.env" ;; signer) ENV_FILE="${BASE}/signer.env" ;; *) die "VELUM_PM2_SCOPE must be backend, web, signer or all." ;; esac
export CHECKPOINT_DISABLE=1 NEXT_TELEMETRY_DISABLED=1
pm2_home="${PM2_HOME:-${HOME}/.pm2}"
SYSTEMD_DAEMON="${VELUM_PM2_SYSTEMD:-0}"
# The pm2 command runs under node --no-global-search-paths: Node then never loads modules from
# $HOME/.node_modules (PM2's ws dependency asks for the optional bufferutil, which a user could plant
# there), so a pm2 command deploy.sh runs as this user executes only PM2's own code (R3-01).
pm2_bin="$(readlink -f "$(command -v pm2)")" || die "pm2 is not installed."
pm2_cmd=(pm2)
if head -n1 "${pm2_bin}" 2>/dev/null | grep -q '^#!.*node'; then pm2_cmd=(node --no-global-search-paths "${pm2_bin}"); fi
# Never hand the caller's environment to PM2: reload merges the CLI's environment into every app. The signer's copy
# lives in its own home, so its settings file (in the base) is named explicitly.
pm2_extra=()
if [ "${SCOPE}" = signer ]; then
  # Also for the ecosystem file's --names/--fingerprint/--cwds below, which must see the same settings as PM2.
  export VELUM_ENV_FILE="${ENV_FILE}"
  pm2_extra=("VELUM_ENV_FILE=${ENV_FILE}")
fi
pm2_() { env -i HOME="${HOME}" PATH="${PATH}" PM2_HOME="${pm2_home}" LANG="${LANG:-C.UTF-8}" VELUM_PM2_SCOPE="${SCOPE}" "${pm2_extra[@]}" "${pm2_cmd[@]}" "$@"; }
# True when this user's PM2 daemon runs (its PID file names a live PM2 daemon of this user).
daemon_alive() {
  local pid
  pid="$(tr -dc '0-9' <"${pm2_home}/pm2.pid" 2>/dev/null || true)"
  [ -n "${pid}" ] && [ -O "/proc/${pid}" ] && tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null | grep -q '^PM2 v[0-9.]*: God Daemon'
}
# need_daemon — with VELUM_PM2_SYSTEMD=1, refuse to let the pm2 command start a daemon of its own.
need_daemon() {
  [ "${SYSTEMD_DAEMON}" = 1 ] || return 0
  daemon_alive || die "The PM2 daemon of $(id -un) is not running. deploy.sh starts it with its systemd unit (pm2-$(id -un)) first."
}

build() {
  [ -r "${ENV_FILE}" ] || die "Cannot read ${ENV_FILE}."
  cd "${REL}"
  local pnpm_version
  pnpm_version="$(node -p "require('./package.json').packageManager.split('@')[1]")"
  # The repo's pinned pnpm through npx, so a shared server's global pnpm is never touched.
  pnpm_() { npx -y "pnpm@${pnpm_version}" "$@"; }

  say "Installing dependencies (pnpm ${pnpm_version})"
  # NODE_ENV must not be production here, or pnpm skips the devDependencies the build needs.
  env -u NODE_ENV npx -y "pnpm@${pnpm_version}" install --frozen-lockfile

  # Reuse the previous release's Next.js build cache, but only a real directory inside that release
  # (no symbolic links anywhere on the way or inside), so an odd previous release cannot break this build.
  local prev_cache=""
  if [ -n "${VELUM_PREVIOUS:-}" ]; then prev_cache="$(readlink -f "${VELUM_PREVIOUS}/apps/web/.next/cache" 2>/dev/null || true)"; fi
  if [ -n "${prev_cache}" ] && [ "${prev_cache}" = "$(readlink -f "${VELUM_PREVIOUS}")/apps/web/.next/cache" ] && [ -d "${prev_cache}" ]; then
    mkdir -p apps/web/.next
    if cp -a "${prev_cache}" apps/web/.next/cache 2>/dev/null; then find apps/web/.next/cache -type l -delete; else rm -rf apps/web/.next/cache; fi
  fi

  say "Building (the web build sees only NEXT_PUBLIC_* and PUBLIC_SITE_URL from .env)"
  (
    env_export "${ENV_FILE}" 'NEXT_PUBLIC_*' PUBLIC_SITE_URL
    export NODE_ENV=production
    pnpm_ -r build
  )
  local f
  for f in apps/web/.next/BUILD_ID apps/api/dist/server.js apps/workers/dist/index.js packages/db/generated/client/index.js; do
    [ -s "${f}" ] || die "Build output ${f} is missing."
  done

  say "Database migrations"
  (
    DATABASE_URL="$(env_get "${ENV_FILE}" DATABASE_URL)"
    [ -n "${DATABASE_URL}" ] || die "DATABASE_URL is not set in ${ENV_FILE}."
    export DATABASE_URL
    pnpm_ --filter @velum/db exec prisma migrate deploy
  )

  # The web user runs from this directory (audit R2-M3): it reaches it through the directory's group
  # (deploy.sh creates it <app user>:<web group> 2750) and needs read access to every file, including
  # node_modules files hard-linked from the app user's pnpm store. Nobody but the owner may write.
  # chmod never follows symbolic links met while recursing. The release directory itself keeps 2750.
  find "${REL}" -xdev -mindepth 1 ! -type l \( ! -perm -0044 -o -perm /0022 \) -exec chmod go+rX,go-w {} +
  date -u +%Y-%m-%dT%H:%M:%SZ >"${REL}/.velum-release-ok"
  chmod 644 "${REL}/.velum-release-ok"
}

# signer_build — in the signer's own copy (on-chain audit M-2): the workers' dependencies only, no lifecycle scripts
# (no Prisma engine download, no generated client: the signer bundle never loads @velum/db), then the workers' build.
signer_build() {
  [ "${SCOPE}" = signer ] || die "signer-build runs only as the signer user, in its own copy (VELUM_PM2_SCOPE=signer)."
  cd "${REL}"
  local pnpm_version
  pnpm_version="$(node -p "require('./package.json').packageManager.split('@')[1]")"
  say "Installing the signer's dependencies (pnpm ${pnpm_version}, @velum/workers only, no lifecycle scripts)"
  env -u NODE_ENV npx -y "pnpm@${pnpm_version}" install --frozen-lockfile --filter '@velum/workers...' --ignore-scripts
  say "Building the signer (apps/workers)"
  NODE_ENV=production npx -y "pnpm@${pnpm_version}" --filter @velum/workers run build
  [ -s apps/workers/dist/signer.js ] || die "Build output apps/workers/dist/signer.js is missing."
  date -u +%Y-%m-%dT%H:%M:%SZ >"${REL}/.velum-signer-ok"
}

# scrub_dumps — PM2's saved process lists hold each app's environment. After a release no app gets a hot key (on-chain
# audit M-2), so a list that still names one is the previous one (dump.pm2.bak, kept by `pm2 save`) from before the keys
# moved: it is removed. The current list holding one would mean a running app still has a key: that stops the release.
scrub_dumps() {
  local re='"[A-Z0-9_]*_PRIVATE_KEY"[[:space:]]*:'
  if [ -f "${pm2_home}/dump.pm2.bak" ] && grep -Eq "${re}" "${pm2_home}/dump.pm2.bak"; then
    rm -f "${pm2_home}/dump.pm2.bak"
    say "Removed the previous PM2 process list (dump.pm2.bak): it held a hot key from before the keys moved to the signer"
  fi
  if [ -f "${pm2_home}/dump.pm2" ] && grep -Eq "${re}" "${pm2_home}/dump.pm2"; then
    die "PM2's process list of $(id -un) still holds a hot key in an app's environment; no app may have one (the signer reads its keys file). Run deploy.sh again; if it persists, see docs/05-deploy-vps.md (\"Upgrading to the separate signer\")."
  fi
}

# Velum app instances in this daemon as "name<TAB>status<TAB>restarts<TAB>cwd" lines (jlist carries
# env values: parsed here, never printed).
pm2_instances() {
  if [ "${SYSTEMD_DAEMON}" = 1 ] && ! daemon_alive; then return 0; fi
  pm2_ jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let list = []; try { list = JSON.parse(s); } catch {}
      for (const p of Array.isArray(list) ? list : []) {
        const e = p.pm2_env || {};
        if (typeof p.name !== "string" || !/^velum-[a-z]+$/.test(p.name)) continue;
        console.log([p.name, e.status || "unknown", Number(e.restart_time) || 0, e.pm_cwd || ""].join("\t"));
      }
    });'
}

pm2_apply() {
  [ -r "${ENV_FILE}" ] || die "Cannot read ${ENV_FILE}."
  local eco="${REL}/deploy/ecosystem.config.cjs" fp want have names wanted_cwds pid running others n cwd good="" bad=""
  mkdir -p "${pm2_home}"
  chmod 700 "${pm2_home}"
  need_daemon

  # A daemon started from a shell with .env exported (the old deploy.sh did that) holds every secret,
  # and Node's cluster.fork copies it into each cluster worker. Restart such a daemon once (under
  # systemd, deploy.sh restarts the unit before it gets here).
  if [ -r "${pm2_home}/pm2.pid" ]; then
    pid="$(tr -dc '0-9' <"${pm2_home}/pm2.pid")"
    if [ -n "${pid}" ] && [ -r "/proc/${pid}/environ" ] && tr '\0' '\n' <"/proc/${pid}/environ" | cut -d= -f1 | grep -Eq "${SECRET_ENV_NAMES}"; then
      [ "${SYSTEMD_DAEMON}" != 1 ] || die "The PM2 daemon has secrets in its own environment; restart pm2-$(id -un) (deploy.sh does)."
      say "The PM2 daemon has secrets in its own environment; restarting it with a clean one"
      pm2_ kill >/dev/null
    fi
  fi

  want="$(VELUM_PM2_SCOPE="${SCOPE}" node "${eco}" --fingerprint)"
  names="$(VELUM_PM2_SCOPE="${SCOPE}" node "${eco}" --names)"
  wanted_cwds="$(VELUM_PM2_SCOPE="${SCOPE}" node "${eco}" --cwds)"
  fp="${pm2_home}/velum-apps.sha256"
  have="$(cat "${fp}" 2>/dev/null || true)"
  running="$(pm2_instances)"
  # Velum apps in this daemon that this scope no longer runs (velum-web moved to its own user).
  others="$(printf '%s\n' "${running}" | awk -F'\t' -v keep=" ${names} " 'NF && index(keep, " " $1 " ") == 0 { print $1 }' | sort -u | tr '\n' ' ')"
  others="${others% }"

  if [ -z "${names}" ]; then
    # This scope runs nothing now (the signer without ONCHAIN_WORKERS=true): remove what it ran.
    if [ -n "${others}" ]; then
      say "Removing ${others// /, } (this scope runs no app now)"
      # shellcheck disable=SC2086
      pm2_ delete ${others} >/dev/null 2>&1 || true
    fi
  elif [ "${want}" != "${have}" ] || [ -n "${others}" ]; then
    say "Clean PM2 restart of ${names// /, }${others:+ (and removing ${others})}: app definitions or env keys changed${others:+, or this daemon runs Velum apps it should not}, so removed variables do not linger"
    # shellcheck disable=SC2086
    pm2_ delete ${names} ${others} >/dev/null 2>&1 || true
    pm2_ start "${eco}"
  else
    # Per app: reload in place (zero downtime) when every instance is online and runs from the
    # directory this release wants; otherwise delete and start just that app (a reload keeps the old
    # script and cwd of an app started elsewhere, and cannot revive an errored one). One broken app
    # (e.g. crash-looping workers) never takes the healthy ones down.
    for n in ${names}; do
      cwd="$(printf '%s\n' "${wanted_cwds}" | tr ' ' '\n' | sed -n "s|^${n}=||p")"
      if printf '%s\n' "${running}" | awk -F'\t' -v n="${n}" -v cwd="${cwd}" '$1 == n { seen = 1; if ($2 != "online" || $4 != cwd) bad = 1 } END { exit (seen && !bad) ? 0 : 1 }'; then
        good="${good} ${n}"
      else
        bad="${bad} ${n}"
      fi
    done
    good="${good# }"
    bad="${bad# }"
    if [ -n "${good}" ]; then
      say "Reloading PM2 apps (${good// /, }) with zero downtime"
      pm2_ reload "${eco}" --only "${good// /,}"
    fi
    if [ -n "${bad}" ]; then
      say "Restarting ${bad// /, } cleanly (not running, not online, or started from another directory)"
      # shellcheck disable=SC2086
      pm2_ delete ${bad} >/dev/null 2>&1 || true
      pm2_ start "${eco}" --only "${bad// /,}"
    fi
  fi
  pm2_ save --force >/dev/null
  printf '%s\n' "${want}" >"${fp}"
  # dump.pm2 holds each app's environment; PM2 keeps the previous one as dump.pm2.bak (audit R2-I3).
  chmod 600 "${fp}" "${pm2_home}/dump.pm2" "${pm2_home}/dump.pm2.bak" 2>/dev/null || true
  scrub_dumps
}

case "${1:-}" in
  build) build ;;
  signer-build) signer_build ;;
  pm2) pm2_apply ;;
  status) pm2_instances | cut -f1-3 ;;
  ls) if [ "${SYSTEMD_DAEMON}" != 1 ] || daemon_alive; then pm2_ ls; fi ;;
  save) need_daemon; pm2_ save --force ;;
  kill) need_daemon; pm2_ kill ;;
  delete)
    shift
    need_daemon
    for n in "$@"; do
      [[ "${n}" =~ ^velum-[a-z]+$ ]] || die "delete: ${n} is not a Velum app."
      pm2_ delete "${n}" >/dev/null 2>&1 || true
    done
    ;;
  resurrect) [ "${SYSTEMD_DAEMON}" != 1 ] || die "resurrect: restart pm2-$(id -un) instead."; pm2_ resurrect ;;
  *) die "Usage: release.sh build|signer-build|pm2|status|ls|save|kill|delete|resurrect (called by deploy/deploy.sh)" ;;
esac
