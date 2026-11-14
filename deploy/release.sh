#!/usr/bin/env bash
# Release steps that run as an app user. deploy/deploy.sh calls this with a clean environment;
# it is not meant to be run by hand.
#
#   release.sh build   (app user) Inside a fresh release directory: install, build every app, run
#                      migrations, then make the files readable (never writable) for the web user.
#                      Writes nothing outside that directory, so a failure leaves the live site alone.
#   release.sh pm2     Start or zero-downtime reload this user's PM2 apps from <base>/current with
#                      per-app env allowlists (deploy/ecosystem.config.cjs). Does a clean delete + start
#                      when the app definitions or env keys changed, or when a running app comes from
#                      another directory (an older layout), so removed secrets never linger.
#   release.sh status  One line per Velum app instance in this user's PM2: name, status, restarts.
#
# VELUM_PM2_SCOPE picks the apps: backend (api + workers, the app user), web (the web user) or all
# (single-user setups). Needs VELUM_BASE (the directory holding .env, web.env, releases/ and current).
# Optional for build: VELUM_PREVIOUS (previous release directory, to reuse its Next.js build cache).
set -euo pipefail
umask 027
REL="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${REL}/deploy/lib/common.sh"
BASE="${VELUM_BASE:?VELUM_BASE is required (run deploy/deploy.sh instead)}"
SCOPE="${VELUM_PM2_SCOPE:-all}"
case "${SCOPE}" in backend | all) ENV_FILE="${BASE}/.env" ;; web) ENV_FILE="${BASE}/web.env" ;; *) die "VELUM_PM2_SCOPE must be backend, web or all." ;; esac
export CHECKPOINT_DISABLE=1 NEXT_TELEMETRY_DISABLED=1
pm2_home="${PM2_HOME:-${HOME}/.pm2}"
# Never hand the caller's environment to PM2: reload merges the CLI's environment into every app.
pm2_() { env -i HOME="${HOME}" PATH="${PATH}" PM2_HOME="${pm2_home}" LANG="${LANG:-C.UTF-8}" VELUM_PM2_SCOPE="${SCOPE}" pm2 "$@"; }

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

# Velum app instances in this daemon as "name<TAB>status<TAB>restarts<TAB>cwd" lines (jlist carries
# env values: parsed here, never printed).
pm2_instances() {
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

  # A daemon started from a shell with .env exported (the old deploy.sh did that) holds every secret,
  # and Node's cluster.fork copies it into each cluster worker. Restart such a daemon once.
  if [ -r "${pm2_home}/pm2.pid" ]; then
    pid="$(tr -dc '0-9' <"${pm2_home}/pm2.pid")"
    if [ -n "${pid}" ] && [ -r "/proc/${pid}/environ" ] && tr '\0' '\n' <"/proc/${pid}/environ" | cut -d= -f1 | grep -Eq "${SECRET_ENV_NAMES}"; then
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

  if [ "${want}" != "${have}" ] || [ -n "${others}" ]; then
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
}

case "${1:-}" in
  build) build ;;
  pm2) pm2_apply ;;
  status) pm2_instances | cut -f1-3 ;;
  *) die "Usage: release.sh build|pm2|status (called by deploy/deploy.sh)" ;;
esac
