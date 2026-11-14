#!/usr/bin/env bash
# Release script (Phase 2+). Run on the VPS from /opt/velum:  bash deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "› Pulling latest"
git fetch --all --prune
git reset --hard "origin/${BRANCH:-main}"

echo "› Installing dependencies"
pnpm install --frozen-lockfile

echo "› Loading env"
set -a; source .env; set +a

echo "› Database migrations"
pnpm --filter @velum/db exec prisma migrate deploy
pnpm --filter @velum/db exec prisma generate

echo "› Building"
pnpm build

echo "› Reloading processes"
if pm2 describe velum-api >/dev/null 2>&1; then
  pm2 reload deploy/ecosystem.config.cjs --update-env
else
  pm2 start deploy/ecosystem.config.cjs
fi
pm2 save

echo "› Health check"
sleep 3
curl -fsS "http://127.0.0.1:4000/v1/health" && echo
curl -fsS -o /dev/null -w "web %{http_code}\n" "http://127.0.0.1:3000/"
echo "✓ Deployed"
