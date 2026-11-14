#!/usr/bin/env bash
# Release script (Phase 2+). Run on the VPS from /opt/velum as the app user:  bash deploy/deploy.sh
# BRANCH=<name> deploys another branch (default: the branch this checkout is on).
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

[ -f .env ] || { echo "Missing .env. Copy .env.example to .env and fill it (or run deploy/server-setup.sh)." >&2; exit 1; }

if [ -z "${VELUM_DEPLOY_PULLED:-}" ]; then
  echo "› Pulling latest (${BRANCH})"
  git fetch origin "${BRANCH}" --prune
  git reset --hard "origin/${BRANCH}"
  # Re-run the freshly pulled copy of this script (bash reads scripts as it goes).
  VELUM_DEPLOY_PULLED=1 BRANCH="${BRANCH}" exec bash "$0" "$@"
fi

echo "› Loading env"
set -a; source .env; set +a

echo "› Installing dependencies"
pnpm install --frozen-lockfile

echo "› Database migrations"
pnpm --filter @velum/db exec prisma migrate deploy
pnpm --filter @velum/db exec prisma generate

echo "› Building"
NEXT_TELEMETRY_DISABLED=1 pnpm build

echo "› Reloading processes"
if pm2 describe velum-api >/dev/null 2>&1; then
  pm2 reload deploy/ecosystem.config.cjs --update-env
else
  pm2 start deploy/ecosystem.config.cjs
fi
pm2 save

echo "› Health check"
ok=""
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT_API:-4000}/v1/health"; then ok=1; echo; break; fi
  sleep 2
done
[ -n "${ok}" ] || { echo "API health check failed. See: pm2 logs velum-api --lines 100" >&2; exit 1; }
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT_WEB:-3000}/" || true)"
  [ "${code}" = "200" ] && break
  sleep 2
done
echo "web ${code}"
[ "${code}" = "200" ] || { echo "Web check failed. See: pm2 logs velum-web --lines 100" >&2; exit 1; }
pm2 ls
echo "✓ Deployed"
