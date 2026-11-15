#!/usr/bin/env bash
# Mainnet-fork rehearsal with the REAL chain id (4663) and LIVE Robinhood quotes (docs/07-mainnet-guarded-beta.md,
# "Rehearse on a fork"). Complements fork-e2e.sh (every flow, replayed quotes, chain id 31337):
#
#   bash apps/workers/e2e/fork/fork-live.sh          (from anywhere; pnpm install must have run)
#
# 1. anvil forks Robinhood Chain mainnet at its head and KEEPS chain id 4663, so every mainnet rule applies;
# 2. contracts/script/Deploy.s.sol deploys through its guarded-mainnet path exactly as on the server, only
#    non-interactively and with throwaway keys: reference prices from Robinhood's quote API, the simulation (no
#    --broadcast, writes the plan), then the broadcast with VELUM_MAINNET_GUARDED_CONFIRM set to the phrase the
#    simulation printed;
# 3. live.e2e.ts funds wallets on the fork, then runs the production processes (dist/server.js, dist/index.js with
#    PRICE_SOURCE=robinhood, dist/signer.js with ONCHAIN_MAINNET_CONFIRMED=yes) for LIVE_MINUTES (default 4) against the
#    live quote API (read-only; the signer reads 10 quotes every 2 s, the workers every PRICE_POLL_MS=10 s). In an open
#    US-equity session the live prices must reach the oracle per token and a position opens and closes; with the
#    session closed nothing may be pushed.
# Nothing is ever sent to the real chain: every RPC the stack uses is the local fork. Own PostgreSQL and Redis under
# /var/tmp; the report is ${SCRATCH}/out/live-report.json.
#
# Settings: FOUNDRY_BIN, PG_BIN, FORK_URL, LIVE_MINUTES, FORK_PG_PORT (5472), FORK_ANVIL_PORT (8747), FORK_API_PORT
# (4893), E2E_SCRATCH, E2E_KEEP=1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
HERE="${ROOT}/apps/workers/e2e/fork"
FOUNDRY_BIN="${FOUNDRY_BIN:-${HOME}/.foundry/bin}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
FORK_URL="${FORK_URL:-https://rpc.mainnet.chain.robinhood.com}"
PG_PORT="${FORK_PG_PORT:-5472}"
ANVIL_PORT="${FORK_ANVIL_PORT:-8747}"
API_PORT="${FORK_API_PORT:-4893}"
SCRATCH="${E2E_SCRATCH:-$(mktemp -d /var/tmp/velum-fork-live.XXXXXX)}"
OUT="${SCRATCH}/out"
REDIS_PASSWORD="e2e-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
RPC="http://127.0.0.1:${ANVIL_PORT}"
CAST="${FOUNDRY_BIN}/cast"
STOCKS="TSLA AMZN PLTR NVDA NFLX AMD AAPL META MSFT COIN"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'fork-live: %s\n' "$*" >&2; exit 1; }
as_pg() { if [ "$(id -u)" = 0 ]; then unshare --user --map-user=1000 --map-group=1000 "$@"; else "$@"; fi; }
for port in "${PG_PORT}" "${ANVIL_PORT}" "${API_PORT}"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then die "port ${port} is in use"; fi
done
{ [ -x "${FOUNDRY_BIN}/forge" ] && [ -x "${FOUNDRY_BIN}/anvil" ]; } || die "forge and anvil not found in ${FOUNDRY_BIN}"
mkdir -p "${SCRATCH}"/{pg,redis,tree/packages} "${OUT}"
chmod 700 "${SCRATCH}"
REDIS_DIR="${SCRATCH}/redis"
if [ "${#REDIS_DIR}" -gt 80 ]; then REDIS_DIR="$(mktemp -d /tmp/velum-live-redis.XXXXXX)"; fi
REDIS_SOCK="${REDIS_DIR}/redis.sock"
PIDS=()
cleanup() {
  set +e
  for p in "${PIDS[@]}"; do kill -TERM "${p}" 2>/dev/null; done
  sleep 2
  if [ -f "${SCRATCH}/pg/data/postmaster.pid" ]; then kill -INT "$(head -1 "${SCRATCH}/pg/data/postmaster.pid")" 2>/dev/null; fi
  redis-cli -s "${REDIS_SOCK}" -a "${REDIS_PASSWORD}" --no-auth-warning shutdown nosave >/dev/null 2>&1
  sleep 1
  [ "${REDIS_DIR}" != "${SCRATCH}/redis" ] && rm -rf "${REDIS_DIR}"
  if [ "${E2E_KEEP:-0}" = 1 ]; then echo "kept ${SCRATCH}"; else rm -rf "${SCRATCH}/pg" "${SCRATCH}/redis" "${SCRATCH}/tree" "${SCRATCH}/signer-home"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

say "PostgreSQL, Redis (unix socket), builds"
as_pg "${PG_BIN}/initdb" -D "${SCRATCH}/pg/data" -U velum --auth=trust -E UTF8 >"${SCRATCH}/pg/initdb.log" 2>&1
as_pg "${PG_BIN}/pg_ctl" -D "${SCRATCH}/pg/data" -l "${SCRATCH}/pg/pg.log" -o "-p ${PG_PORT} -c unix_socket_directories='' -c listen_addresses=127.0.0.1" -w start >/dev/null || die "PostgreSQL did not start"
export DATABASE_URL="postgresql://velum@127.0.0.1:${PG_PORT}/postgres?schema=public"
redis-server --port 0 --unixsocket "${REDIS_SOCK}" --unixsocketperm 700 --dir "${REDIS_DIR}" --save "" --appendonly no \
  --requirepass "${REDIS_PASSWORD}" --daemonize yes --logfile "${REDIS_DIR}/redis.log"
for _ in $(seq 1 50); do [ -S "${REDIS_SOCK}" ] && break; sleep 0.1; done
export REDIS_URL="unix://:${REDIS_PASSWORD}@${REDIS_SOCK}"
(cd "${ROOT}/packages/db" && npx prisma migrate deploy >"${SCRATCH}/migrate.log" 2>&1) || die "migrate failed"
(cd "${ROOT}/apps/workers" && npx tsup >"${SCRATCH}/workers-build.log" 2>&1) || die "workers build failed"
(cd "${ROOT}/apps/api" && npx tsup >"${SCRATCH}/api-build.log" 2>&1) || die "api build failed"
cp -r "${ROOT}/contracts" "${SCRATCH}/tree/contracts"
cp -r "${ROOT}/packages/config" "${SCRATCH}/tree/packages/config"
rm -rf "${SCRATCH}/tree/contracts"/{out,cache,broadcast} "${SCRATCH}/tree/contracts/deployments"/*.json
(cd "${SCRATCH}/tree/contracts" && "${FOUNDRY_BIN}/forge" build --offline >"${SCRATCH}/forge-build.log" 2>&1) || die "forge build failed"

say "Throwaway keys"
(
  umask 077
  printf '{' >"${SCRATCH}/keys.json"
  sep=""
  for r in deployer relayer keeper admin maker taker; do
    "${CAST}" wallet new --json | python3 -I -c 'import json,sys; w=json.load(sys.stdin)[0]; sys.stdout.write("%s\"%s\": {\"address\": \"%s\", \"privateKey\": \"%s\"}" % (sys.argv[1], sys.argv[2], w["address"], w["private_key"]))' "${sep}" "${r}" >>"${SCRATCH}/keys.json"
    sep=", "
  done
  printf '}\n' >>"${SCRATCH}/keys.json"
)
key() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]][sys.argv[3]])' "${SCRATCH}/keys.json" "$1" "$2"; }

say "Reference prices from Robinhood's quote API (read-only)"
ref=()
for s in ${STOCKS}; do
  p="$(curl -fsS --max-time 10 -H 'accept: application/json' "https://api.robinhood.com/rhj/prices/${s}" | python3 -I -c '
import json, sys
from decimal import Decimal, ROUND_FLOOR
q = json.load(sys.stdin)["quotes"][0]
print(((Decimal(q["tokenBid"]) + Decimal(q["tokenAsk"])) / 2).quantize(Decimal("0.0001"), rounding=ROUND_FLOOR))')"
  ref+=("MAINNET_REF_PRICE_${s}=${p}")
  printf '  %s %s\n' "${s}" "${p}"
  sleep 0.2
done

BLOCK="$("${CAST}" block-number --rpc-url "${FORK_URL}")"
say "anvil forks Robinhood Chain mainnet at block ${BLOCK}, chain id kept (4663)"
"${FOUNDRY_BIN}/anvil" --fork-url "${FORK_URL}" --fork-block-number "${BLOCK}" --port "${ANVIL_PORT}" --no-storage-caching \
  --compute-units-per-second 300 --fork-retry-backoff 500 --retries 8 --timeout 45000 >"${SCRATCH}/anvil.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do "${CAST}" chain-id --rpc-url "${RPC}" >/dev/null 2>&1 && break; sleep 0.5; done
[ "$("${CAST}" chain-id --rpc-url "${RPC}")" = 4663 ] || die "the fork does not answer chain 4663"
"${CAST}" rpc anvil_setBalance "$(key deployer address)" 0x8AC7230489E80000 --rpc-url "${RPC}" >/dev/null

say "Deploy through Deploy.s.sol's guarded-mainnet path: simulation, then broadcast with the printed phrase"
caps=(GUARD_ACCOUNT_CAP_USDG=2000 GUARD_GLOBAL_CAP_USDG=50000)
for s in ${STOCKS}; do caps+=("GUARD_ACCOUNT_CAP_${s}=1" "GUARD_GLOBAL_CAP_${s}=25"); done
deploy() {
  (cd "${SCRATCH}/tree/contracts" && env "${caps[@]}" "${ref[@]}" GUARD_ADMIN="$(key admin address)" PRICE_RELAYER="$(key relayer address)" "$@")
}
deploy "${FOUNDRY_BIN}/forge" script script/Deploy.s.sol --offline --no-storage-caching --rpc-url "${RPC}" --private-key "$(key deployer privateKey)" >"${OUT}/simulate.log" 2>&1 \
  || { tail -30 "${OUT}/simulate.log"; die "simulation failed"; }
PHRASE="$(awk '/Broadcast confirmation phrase \(VELUM_MAINNET_GUARDED_CONFIRM\):/ { getline; sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); print; exit }' "${OUT}/simulate.log")"
{ [ -f "${SCRATCH}/tree/contracts/deployments/4663.plan.json" ] && [ -n "${PHRASE}" ]; } || die "no plan or phrase from the simulation"
echo "phrase: ${PHRASE}"
deploy env VELUM_MAINNET_GUARDED_CONFIRM="${PHRASE}" "${FOUNDRY_BIN}/forge" script script/Deploy.s.sol --offline --no-storage-caching --rpc-url "${RPC}" \
  --private-key "$(key deployer privateKey)" --broadcast --slow >"${OUT}/broadcast.log" 2>&1 || { tail -30 "${OUT}/broadcast.log"; die "broadcast failed"; }
cp "${SCRATCH}/tree/contracts/broadcast/Deploy.s.sol/4663/run-latest.json" "${OUT}/deploy-broadcast.json"
cat "${SCRATCH}/tree/contracts/deployments/4663.json"; echo

say "Production processes against the fork with live quotes for ${LIVE_MINUTES:-4} minutes"
FORK_RPC="${RPC}" FORK_DEPLOYMENTS="${SCRATCH}/tree/contracts/deployments" FORK_ARTIFACTS="${SCRATCH}/tree/contracts/out" \
  FORK_KEYS="${SCRATCH}/keys.json" FORK_OUT="${OUT}/live-report.json" FORK_SCRATCH="${SCRATCH}" FORK_API_PORT="${API_PORT}" \
  "${ROOT}/apps/workers/node_modules/.bin/tsx" "${HERE}/live.e2e.ts" 2>&1 | tee "${OUT}/live.log"
[ "${PIPESTATUS[0]}" = 0 ] || die "the live run failed (${OUT}/live-report.json)"
say "live rehearsal finished (report: ${OUT}/live-report.json)"
