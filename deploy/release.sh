#!/usr/bin/env bash
# Release steps that run as the app user. deploy/deploy.sh calls this with a clean environment;
# it is not meant to be run by hand.
#
#   release.sh build   Inside a fresh release directory: install, build every app, run migrations.
#                      Writes nothing outside that directory, so a failure leaves the live site alone.
#   release.sh pm2     Start or zero-downtime reload PM2 from <base>/current with per-app env
#                      allowlists (deploy/ecosystem.config.cjs). Does a clean delete + start when the
#                      app definitions or env keys changed, so removed secrets do not linger.
#
# Needs VELUM_BASE (the directory holding .env, releases/ and current). Optional for build:
# VELUM_PREVIOUS (previous release directory, to reuse its Next.js build cache).
set -euo pipefail
umask 027
REL="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${REL}/deploy/lib/common.sh"
BASE="${VELUM_BASE:?VELUM_BASE is required (run deploy/deploy.sh instead)}"
ENV_FILE="${BASE}/.env"
[ -r "${ENV_FILE}" ] || die "Cannot read ${ENV_FILE}."
export CHECKPOINT_DISABLE=1 NEXT_TELEMETRY_DISABLED=1

build() {
  cd "${REL}"
  local pnpm_version
  pnpm_version="$(node -p "require('./package.json').packageManager.split('@')[1]")"
  # The repo's pinned pnpm through npx, so a shared server's global pnpm is never touched.
  pnpm_() { npx -y "pnpm@${pnpm_version}" "$@"; }

  say "Installing dependencies (pnpm ${pnpm_version})"
  # NODE_ENV must not be production here, or pnpm skips the devDependencies the build needs.
  env -u NODE_ENV npx -y "pnpm@${pnpm_version}" install --frozen-lockfile

  if [ -n "${VELUM_PREVIOUS:-}" ] && [ -d "${VELUM_PREVIOUS}/apps/web/.next/cache" ]; then
    mkdir -p apps/web/.next
    cp -a "${VELUM_PREVIOUS}/apps/web/.next/cache" apps/web/.next/cache 2>/dev/null || rm -rf apps/web/.next/cache
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
  date -u +%Y-%m-%dT%H:%M:%SZ >"${REL}/.velum-release-ok"
}

pm2_apply() {
  local pm2_home="${PM2_HOME:-${HOME}/.pm2}" eco="${REL}/deploy/ecosystem.config.cjs" fp want have names online pid
  # Never hand the caller's environment to PM2: reload merges it into every app.
  pm2_() { env -i HOME="${HOME}" PATH="${PATH}" PM2_HOME="${pm2_home}" LANG="${LANG:-C.UTF-8}" pm2 "$@"; }
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

  want="$(node "${eco}" --fingerprint)"
  names="$(node "${eco}" --names)"
  fp="${pm2_home}/velum-apps.sha256"
  have="$(cat "${fp}" 2>/dev/null || true)"
  # Names of Velum apps with every instance online (jlist carries env values: parsed, never printed).
  online="$(pm2_ jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let list = []; try { list = JSON.parse(s); } catch {}
      const by = new Map();
      for (const p of list) { const st = by.get(p.name) ?? true; by.set(p.name, st && p.pm2_env?.status === "online"); }
      process.stdout.write(process.argv[1].split(" ").filter((n) => by.get(n)).join(" "));
    });' "${names}")"

  if [ "${want}" = "${have}" ] && [ "${online}" = "${names}" ]; then
    say "Reloading PM2 apps (zero downtime)"
    pm2_ reload "${eco}"
  else
    say "App definitions or env keys changed (or apps not all online): clean PM2 restart, so removed variables do not linger"
    # shellcheck disable=SC2086
    pm2_ delete ${names} >/dev/null 2>&1 || true
    pm2_ start "${eco}"
  fi
  pm2_ save >/dev/null
  printf '%s\n' "${want}" >"${fp}"
  chmod 600 "${fp}" "${pm2_home}/dump.pm2" 2>/dev/null || true
}

case "${1:-}" in
  build) build ;;
  pm2) pm2_apply ;;
  *) die "Usage: release.sh build|pm2 (called by deploy/deploy.sh)" ;;
esac
