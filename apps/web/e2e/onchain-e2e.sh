#!/usr/bin/env bash
# End-to-end test of the web's real (Phase 3) mode against a LOCAL stack, in a browser:
#   anvil (chain 31337) with the contracts deployed by `forge script contracts/script/Deploy.s.sol`, twice:
#   unguarded, then with the launch guard on; the API and the indexer from this tree (apps/web/e2e/stack.ts)
#   on their own PostgreSQL and Redis on non-default ports; the web built for the local chain with each
#   deployment (next build, DEPLOYMENTS_DIR); Nginx with the production CSP (plus the local RPC origin);
#   Playwright (pre-installed) with a mock EIP-6963 wallet that signs real transactions with throwaway keys.
# Nothing touches a system service, a public network or a real key. Everything started is stopped.
#
#   bash apps/web/e2e/onchain-e2e.sh            (pnpm install must have run)
#
# Settings: FOUNDRY_BIN (~/.foundry/bin), PG_BIN (/usr/lib/postgresql/16/bin), E2E_SCRATCH (a new directory
# under /var/tmp: PostgreSQL cannot run from every temporary directory), E2E_KEEP=1 keeps it, E2E_OUT (where
# screenshots and the report go, default <scratch>/out), E2E_PHASES (default "unguarded guarded").
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WEB="${ROOT}/apps/web"
E2E="${WEB}/e2e"
FOUNDRY_BIN="${FOUNDRY_BIN:-${HOME}/.foundry/bin}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_PORT="${E2E_PG_PORT:-5461}"
REDIS_PORT="${E2E_REDIS_PORT:-6421}"
ANVIL_PORT="${E2E_ANVIL_PORT:-8665}"
API_PORT="${E2E_API_PORT:-4791}"
CTL_PORT="${E2E_CTL_PORT:-4792}"
WEB_PORT="${E2E_WEB_PORT:-3791}"
PROXY_PORT="${E2E_PROXY_PORT:-8791}"
SCRATCH="${E2E_SCRATCH:-$(mktemp -d /var/tmp/velum-web-e2e.XXXXXX)}"
OUT="${E2E_OUT:-${SCRATCH}/out}"
PHASES="${E2E_PHASES:-unguarded guarded}"
REDIS_PASSWORD="e2e-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
RPC="http://127.0.0.1:${ANVIL_PORT}"
# anvil's public test accounts: 0 deployer, 1 price relayer, 9 guard admin (unlocked in anvil).
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
RELAYER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
GUARD_ADMIN=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
NODE_PATH_PW="$(npm root -g)"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'web onchain-e2e: %s\n' "$*" >&2; exit 1; }
as_pg() { if [ "$(id -u)" = 0 ]; then unshare --user --map-user=1000 --map-group=1000 "$@"; else "$@"; fi; }

for port in "${PG_PORT}" "${REDIS_PORT}" "${ANVIL_PORT}" "${API_PORT}" "${CTL_PORT}" "${WEB_PORT}" "${PROXY_PORT}"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then die "port ${port} is in use"; fi
done
[ -x "${FOUNDRY_BIN}/forge" ] && [ -x "${FOUNDRY_BIN}/anvil" ] || die "forge and anvil not found in ${FOUNDRY_BIN}"
[ -x "${PG_BIN}/initdb" ] || die "PostgreSQL server binaries not found in ${PG_BIN}"
command -v redis-server >/dev/null && command -v nginx >/dev/null || die "redis-server and nginx are required"
mkdir -p "${SCRATCH}"/{pg,redis,tree/packages,nginx/logs,nginx/tmp,nginx/snippets} "${OUT}"

PIDS=()
cleanup() {
  set +e
  [ -f "${SCRATCH}/nginx/nginx.pid" ] && nginx -p "${SCRATCH}/nginx" -c "${SCRATCH}/nginx/nginx.conf" -s quit 2>/dev/null
  for p in "${PIDS[@]}"; do pkill -TERM -P "${p}" 2>/dev/null; kill "${p}" 2>/dev/null; done
  if [ -f "${SCRATCH}/pg/data/postmaster.pid" ]; then kill -INT "$(head -1 "${SCRATCH}/pg/data/postmaster.pid")" 2>/dev/null; fi
  redis-cli -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" --no-auth-warning shutdown nosave >/dev/null 2>&1
  sleep 1
  if [ "${E2E_KEEP:-0}" = 1 ]; then echo "kept ${SCRATCH}"; else rm -rf "${SCRATCH}/pg" "${SCRATCH}/redis" "${SCRATCH}/tree"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
wait_http() { for _ in $(seq 1 120); do curl -s -o /dev/null "$1" && return 0; sleep 0.5; done; die "$1 did not come up"; }

say "PostgreSQL 127.0.0.1:${PG_PORT}, Redis 127.0.0.1:${REDIS_PORT}, anvil 127.0.0.1:${ANVIL_PORT}"
as_pg "${PG_BIN}/initdb" -D "${SCRATCH}/pg/data" -U velum --auth=trust -E UTF8 >"${SCRATCH}/pg/initdb.log" 2>&1
as_pg "${PG_BIN}/pg_ctl" -D "${SCRATCH}/pg/data" -l "${SCRATCH}/pg/pg.log" -o "-p ${PG_PORT} -c unix_socket_directories='' -c listen_addresses=127.0.0.1" -w start >/dev/null \
  || { tail -5 "${SCRATCH}/pg/pg.log"; die "PostgreSQL did not start"; }
export DATABASE_URL="postgresql://velum@127.0.0.1:${PG_PORT}/postgres?schema=public"
redis-server --port "${REDIS_PORT}" --bind 127.0.0.1 --dir "${SCRATCH}/redis" --save "" --appendonly no \
  --requirepass "${REDIS_PASSWORD}" --daemonize yes --logfile "${SCRATCH}/redis/redis.log"
export REDIS_URL="redis://:${REDIS_PASSWORD}@127.0.0.1:${REDIS_PORT}/0"
"${FOUNDRY_BIN}/anvil" --port "${ANVIL_PORT}" --chain-id 31337 --silent >"${SCRATCH}/anvil.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 50); do "${FOUNDRY_BIN}/cast" chain-id --rpc-url "${RPC}" >/dev/null 2>&1 && break; sleep 0.2; done
[ "$("${FOUNDRY_BIN}/cast" chain-id --rpc-url "${RPC}")" = 31337 ] || die "anvil did not start"

say "Multicall3 at its canonical address (the web's balance reads use it, as on Robinhood Chain)"
node "${E2E}/multicall.cjs" "${RPC}"

say "Deploy the contracts twice with forge script (scratch copy): unguarded, then guarded"
cp -r "${ROOT}/contracts" "${SCRATCH}/tree/contracts"
cp -r "${ROOT}/packages/config" "${SCRATCH}/tree/packages/config"
rm -rf "${SCRATCH}/tree/contracts"/{out,cache,broadcast} "${SCRATCH}/tree/contracts/deployments"
mkdir -p "${SCRATCH}/tree/contracts/deployments" "${SCRATCH}/dep-unguarded" "${SCRATCH}/dep-guarded"
(
  cd "${SCRATCH}/tree/contracts"
  "${FOUNDRY_BIN}/forge" build --offline >"${SCRATCH}/forge-build.log" 2>&1 || "${FOUNDRY_BIN}/forge" build >>"${SCRATCH}/forge-build.log" 2>&1
  PRICE_RELAYER="${RELAYER}" timeout 300 "${FOUNDRY_BIN}/forge" script script/Deploy.s.sol --offline --rpc-url "${RPC}" --broadcast --slow \
    --unlocked --sender "${DEPLOYER}" >"${SCRATCH}/forge-deploy-unguarded.log" 2>&1
  cp deployments/31337.json "${SCRATCH}/dep-unguarded/31337.json"
  PRICE_RELAYER="${RELAYER}" GUARD_ADMIN="${GUARD_ADMIN}" \
    GUARD_ACCOUNT_CAP_USDG=100000 GUARD_GLOBAL_CAP_USDG=1000000 GUARD_ACCOUNT_CAP_TSLA=200 GUARD_GLOBAL_CAP_TSLA=2000 \
    GUARD_ACCOUNT_CAP_AMZN=200 GUARD_GLOBAL_CAP_AMZN=2000 \
    timeout 300 "${FOUNDRY_BIN}/forge" script script/Deploy.s.sol --offline --rpc-url "${RPC}" --broadcast --slow \
    --unlocked --sender "${DEPLOYER}" >"${SCRATCH}/forge-deploy-guarded.log" 2>&1
  cp deployments/31337.json "${SCRATCH}/dep-guarded/31337.json"
) || { tail -30 "${SCRATCH}"/forge-*.log; die "forge deploy failed"; }
cat "${SCRATCH}/dep-unguarded/31337.json" "${SCRATCH}/dep-guarded/31337.json"

say "Migrate the scratch database"
(cd "${ROOT}/packages/db" && npx prisma migrate deploy >"${SCRATCH}/migrate.log" 2>&1) || { cat "${SCRATCH}/migrate.log"; die "migrate failed"; }

say "Nginx with the production CSP for testnet, plus the local RPC origin (${RPC})"
bash "${E2E}/nginx.sh" "${ROOT}" "${SCRATCH}/nginx" "${PROXY_PORT}" "${WEB_PORT}" "${API_PORT}" "${RPC}"

for phase in ${PHASES}; do
  say "Phase ${phase}: build the web for the local chain with this deployment"
  (
    cd "${WEB}"
    NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_VELUM_NETWORK=testnet NEXT_PUBLIC_CHAIN_ID=31337 NEXT_PUBLIC_RPC_URL="${RPC}" \
      NEXT_PUBLIC_API_URL=/api NEXT_PUBLIC_SITE_URL="http://127.0.0.1:${PROXY_PORT}" DEPLOYMENTS_DIR="${SCRATCH}/dep-${phase}" \
      npx next build >"${SCRATCH}/web-build-${phase}.log" 2>&1
  ) || { tail -40 "${SCRATCH}/web-build-${phase}.log"; die "web build failed"; }

  say "Phase ${phase}: API + indexer + prices (stack.ts), next start, Nginx"
  E2E_RPC="${RPC}" E2E_DEPLOYMENTS="${SCRATCH}/dep-${phase}" E2E_API_PORT="${API_PORT}" E2E_CTL_PORT="${CTL_PORT}" \
    "${ROOT}/apps/workers/node_modules/.bin/tsx" "${E2E}/stack.ts" >"${SCRATCH}/stack-${phase}.log" 2>&1 &
  PIDS+=($!)
  STACK_PID=$!
  wait_http "http://127.0.0.1:${CTL_PORT}/info"
  (cd "${WEB}" && exec node_modules/.bin/next start -p "${WEB_PORT}" -H 127.0.0.1) >"${SCRATCH}/next-${phase}.log" 2>&1 &
  PIDS+=($!)
  NEXT_PID=$!
  wait_http "http://127.0.0.1:${WEB_PORT}/"
  nginx -p "${SCRATCH}/nginx" -c "${SCRATCH}/nginx/nginx.conf"
  wait_http "http://127.0.0.1:${PROXY_PORT}/"
  curl -s "http://127.0.0.1:${PROXY_PORT}/api/v1/deployment" | head -c 400; echo

  if [ "${E2E_HOLD:-0}" = 1 ]; then
    # Development: keep the stack up and run onchain.e2e.cjs by hand (the variables are in hold.env).
    printf 'export NODE_PATH=%q E2E_BASE=%q E2E_RPC=%q E2E_CTL=%q E2E_OUT=%q\n' "${NODE_PATH_PW}" "http://127.0.0.1:${PROXY_PORT}" "${RPC}" "http://127.0.0.1:${CTL_PORT}" "${OUT}" >"${SCRATCH}/hold.env"
    say "Holding phase ${phase} (source ${SCRATCH}/hold.env); stop with kill ${BASHPID}"
    while :; do sleep 5; done
  fi
  say "Phase ${phase}: Playwright"
  NODE_PATH="${NODE_PATH_PW}" E2E_BASE="http://127.0.0.1:${PROXY_PORT}" E2E_RPC="${RPC}" E2E_CTL="http://127.0.0.1:${CTL_PORT}" E2E_OUT="${OUT}" \
    node "${E2E}/onchain.e2e.cjs" "${phase}" 2>&1 | tee "${OUT}/report-${phase}.txt"
  [ "${PIPESTATUS[0]}" = 0 ] || { tail -30 "${SCRATCH}/stack-${phase}.log"; die "phase ${phase} failed"; }

  nginx -p "${SCRATCH}/nginx" -c "${SCRATCH}/nginx/nginx.conf" -s quit
  pkill -TERM -P "${NEXT_PID}" 2>/dev/null || true
  kill "${NEXT_PID}" "${STACK_PID}" 2>/dev/null || true
  for _ in $(seq 1 20); do (exec 3<>"/dev/tcp/127.0.0.1/${WEB_PORT}") 2>/dev/null || (exec 3<>"/dev/tcp/127.0.0.1/${CTL_PORT}") 2>/dev/null || break; sleep 0.5; done
done

say "web on-chain end-to-end test passed (screenshots and reports in ${OUT})"
