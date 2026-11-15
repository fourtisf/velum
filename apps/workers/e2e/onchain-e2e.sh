#!/usr/bin/env bash
# End-to-end test of the Phase 3 on-chain workers (price relayer, keeper, indexer) and the API's Phase 3
# reads, against a local anvil (chain 31337) with their own PostgreSQL and Redis in a scratch directory on
# non-default ports. It never touches system services, public networks or real keys: anvil's public test
# accounts sign everything (the deployer through anvil's unlocked accounts, the workers with keys derived in
# the test from anvil's public test mnemonic).
#
#   bash apps/workers/e2e/onchain-e2e.sh        (from anywhere; pnpm install must have run)
#
# Steps: start Postgres, Redis and anvil; copy contracts/ to the scratch directory and deploy it there with
# `forge script script/Deploy.s.sol` (the repository's contracts/deployments is never written); migrate the
# scratch database and check the schema has no drift; run apps/workers/src/onchain/e2e.test.ts (relayer,
# keeper, indexer, reorg, stuck transaction, forced exit), then apps/api/src/onchain-e2e.test.ts (the API
# endpoints over the same index). Everything started is stopped and the scratch directory removed on exit.
#
# Settings: FOUNDRY_BIN (~/.foundry/bin), PG_BIN (/usr/lib/postgresql/16/bin), E2E_PG_PORT (5441),
# E2E_REDIS_PORT (6401), E2E_ANVIL_PORT (8645), E2E_SCRATCH (a new temporary directory), E2E_KEEP=1 to keep
# the scratch directory. As root, Postgres runs in a user namespace (it refuses to run as root).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FOUNDRY_BIN="${FOUNDRY_BIN:-${HOME}/.foundry/bin}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_PORT="${E2E_PG_PORT:-5441}"
REDIS_PORT="${E2E_REDIS_PORT:-6401}"
ANVIL_PORT="${E2E_ANVIL_PORT:-8645}"
SCRATCH="${E2E_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/velum-e2e.XXXXXX")}"
REDIS_PASSWORD="e2e-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
# anvil's first two public test accounts: the deployer (unlocked in anvil) and the price relayer.
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
RELAYER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

say() { printf '\n== %s\n' "$*"; }
die() { printf 'onchain-e2e: %s\n' "$*" >&2; exit 1; }
as_pg() { if [ "$(id -u)" = 0 ]; then unshare --user --map-user=1000 --map-group=1000 "$@"; else "$@"; fi; }

for port in "${PG_PORT}" "${REDIS_PORT}" "${ANVIL_PORT}"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then die "port ${port} is in use; choose others with E2E_PG_PORT, E2E_REDIS_PORT, E2E_ANVIL_PORT"; fi
done
[ -x "${FOUNDRY_BIN}/forge" ] && [ -x "${FOUNDRY_BIN}/anvil" ] || die "forge and anvil not found in ${FOUNDRY_BIN}"
[ -x "${PG_BIN}/initdb" ] || die "PostgreSQL server binaries not found in ${PG_BIN}"
command -v redis-server >/dev/null || die "redis-server not found"
mkdir -p "${SCRATCH}"/{pg,redis,tree/packages}

ANVIL_PID=""
cleanup() {
  set +e
  [ -n "${ANVIL_PID}" ] && kill "${ANVIL_PID}" 2>/dev/null
  if [ -f "${SCRATCH}/pg/data/postmaster.pid" ]; then kill -INT "$(head -1 "${SCRATCH}/pg/data/postmaster.pid")" 2>/dev/null; fi
  redis-cli -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" --no-auth-warning shutdown nosave >/dev/null 2>&1
  sleep 1
  if [ "${E2E_KEEP:-0}" = 1 ]; then echo "kept ${SCRATCH}"; else rm -rf "${SCRATCH}"; fi
}
trap cleanup EXIT

say "PostgreSQL on 127.0.0.1:${PG_PORT}"
as_pg "${PG_BIN}/initdb" -D "${SCRATCH}/pg/data" -U velum --auth=trust -E UTF8 >"${SCRATCH}/pg/initdb.log" 2>&1
# TCP on 127.0.0.1 only: no unix socket (a socket path in a deep scratch directory exceeds the 107-byte limit).
as_pg "${PG_BIN}/pg_ctl" -D "${SCRATCH}/pg/data" -l "${SCRATCH}/pg/pg.log" -o "-p ${PG_PORT} -c unix_socket_directories='' -c listen_addresses=127.0.0.1" -w start >/dev/null \
  || { tail -5 "${SCRATCH}/pg/pg.log"; die "PostgreSQL did not start"; }
DATABASE_URL="postgresql://velum@127.0.0.1:${PG_PORT}/postgres?schema=public"

say "Redis on 127.0.0.1:${REDIS_PORT}"
redis-server --port "${REDIS_PORT}" --bind 127.0.0.1 --dir "${SCRATCH}/redis" --save "" --appendonly no \
  --requirepass "${REDIS_PASSWORD}" --daemonize yes --logfile "${SCRATCH}/redis/redis.log"
REDIS_URL="redis://:${REDIS_PASSWORD}@127.0.0.1:${REDIS_PORT}/0"

say "anvil on 127.0.0.1:${ANVIL_PORT} (chain 31337)"
"${FOUNDRY_BIN}/anvil" --port "${ANVIL_PORT}" --chain-id 31337 --silent >"${SCRATCH}/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 50); do
  "${FOUNDRY_BIN}/cast" chain-id --rpc-url "http://127.0.0.1:${ANVIL_PORT}" >/dev/null 2>&1 && break
  sleep 0.2
done
RPC="http://127.0.0.1:${ANVIL_PORT}"
[ "$("${FOUNDRY_BIN}/cast" chain-id --rpc-url "${RPC}")" = 31337 ] || die "anvil did not start"

say "Deploy the contracts (scratch copy, forge script)"
cp -r "${ROOT}/contracts" "${SCRATCH}/tree/contracts"
cp -r "${ROOT}/packages/config" "${SCRATCH}/tree/packages/config"
rm -rf "${SCRATCH}/tree/contracts"/{out,cache,broadcast}
mkdir -p "${SCRATCH}/tree/contracts/deployments"
rm -f "${SCRATCH}/tree/contracts/deployments"/*.json
(
  cd "${SCRATCH}/tree/contracts"
  "${FOUNDRY_BIN}/forge" build --offline >"${SCRATCH}/forge-build.log" 2>&1 || "${FOUNDRY_BIN}/forge" build >>"${SCRATCH}/forge-build.log" 2>&1
  # --slow: one transaction at a time (a parallel broadcast with unlocked accounts can leave a nonce gap).
  PRICE_RELAYER="${RELAYER}" timeout 300 "${FOUNDRY_BIN}/forge" script script/Deploy.s.sol --offline --rpc-url "${RPC}" --broadcast --slow \
    --unlocked --sender "${DEPLOYER}" >"${SCRATCH}/forge-deploy.log" 2>&1
) || { tail -30 "${SCRATCH}/forge-deploy.log" "${SCRATCH}/forge-build.log" 2>/dev/null; die "forge deploy failed"; }
cat "${SCRATCH}/tree/contracts/deployments/31337.json"

say "Migrate the scratch database and check for drift"
(
  cd "${ROOT}/packages/db"
  DATABASE_URL="${DATABASE_URL}" npx prisma migrate deploy >"${SCRATCH}/migrate.log" 2>&1 || { cat "${SCRATCH}/migrate.log"; exit 1; }
  DATABASE_URL="${DATABASE_URL}" npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --exit-code
)

export VELUM_E2E_RPC="${RPC}"
export VELUM_E2E_DEPLOYMENTS="${SCRATCH}/tree/contracts/deployments"
export VELUM_E2E_ARTIFACTS="${SCRATCH}/tree/contracts/out"
export VELUM_E2E_OUT="${SCRATCH}/result.json"
export TEST_DATABASE_URL="${DATABASE_URL}"
export TEST_REDIS_URL="${REDIS_URL}"
export LOG_LEVEL="${LOG_LEVEL:-warn}"

say "Workers end to end (relayer, keeper, indexer)"
(cd "${ROOT}/apps/workers" && npx vitest run src/onchain/e2e.test.ts)

say "API end to end (Phase 3 reads over the same index)"
(cd "${ROOT}/apps/api" && npx vitest run src/onchain-e2e.test.ts)

say "on-chain end-to-end test passed"
