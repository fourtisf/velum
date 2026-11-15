#!/usr/bin/env bash
# Mainnet-fork end-to-end run of the whole Velum stack: the owner's substitute for a testnet before the guarded
# mainnet beta (docs/07-mainnet-guarded-beta.md, "Rehearse on a fork").
#
#   bash apps/workers/e2e/fork/fork-e2e.sh            (from anywhere; pnpm install must have run)
#
# - anvil forks Robinhood Chain mainnet (FORK_URL, default the read-only public RPC) at its current head, with chain
#   id 31337 so the signer accepts the replayed quote feed (its SIGNER_TEST_* settings are refused on any real chain);
# - contracts/script/Deploy.s.sol deploys the full set GUARDED against the REAL mainnet USDG and Stock Tokens (a
#   scratch copy of contracts/; the repository's contracts/deployments is never written), with throwaway keys made
#   for this run (deployer, price relayer, keeper, guard admin, guardian, wallets) that hold nothing on the real chain;
# - apps/workers/e2e/fork/fork.e2e.ts funds the wallets by impersonating existing holders ON THE FORK, then runs the
#   API and the indexer (in-process), the signer as its own process (relayer + keeper, node dist/signer.js) and every
#   flow (guard, deposits, spot, offers, perps, liquidation, funding, forced exit, guardian, exits, guard wind-down);
# - with FORK_WEB=1 (default) the web is built with the fork's deployment file and web-check.cjs compares the oracle
#   price it shows for the uiMultiplier tokens with the chain.
# Own PostgreSQL (127.0.0.1, non-default port) and Redis (a unix socket, like Velum's own Redis) in a scratch directory
# under /var/tmp; nothing system-wide is touched; nothing is ever sent to the real chain (every RPC the stack uses is the
# local fork; the public RPC is only read, by anvil). The report (report.json, with fork transaction hashes and gas) is
# copied to FORK_REPORT_DIR (default: the scratchpad-free ${SCRATCH}/out, printed at the end).
#
# Time matters: the public RPC keeps state for only ~10-15 minutes, so the deployment and the runner's warm-up run right
# after the fork starts (the runner touches every real-token slot the run needs within a few minutes; anvil caches them).
#
# Settings: FOUNDRY_BIN (~/.foundry/bin), PG_BIN (/usr/lib/postgresql/16/bin), FORK_URL, FORK_BLOCK (default: the
# current head), FORK_QUOTES (the replay fixture, default quotes-2026-11-15.json), FORK_PG_PORT (5471),
# FORK_ANVIL_PORT (8745), FORK_API_PORT (4891), FORK_WEB_PORT (3891), FORK_WEB (1), E2E_SCRATCH, E2E_KEEP=1.
# As root, Postgres runs in a user namespace (it refuses to run as root).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
HERE="${ROOT}/apps/workers/e2e/fork"
FOUNDRY_BIN="${FOUNDRY_BIN:-${HOME}/.foundry/bin}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
FORK_URL="${FORK_URL:-https://rpc.mainnet.chain.robinhood.com}"
QUOTES="${FORK_QUOTES:-${HERE}/quotes-2026-11-15.json}"
PG_PORT="${FORK_PG_PORT:-5471}"
ANVIL_PORT="${FORK_ANVIL_PORT:-8745}"
API_PORT="${FORK_API_PORT:-4891}"
WEB_PORT="${FORK_WEB_PORT:-3891}"
WEB="${FORK_WEB:-1}"
SCRATCH="${E2E_SCRATCH:-$(mktemp -d /var/tmp/velum-fork-e2e.XXXXXX)}"
OUT="${FORK_REPORT_DIR:-${SCRATCH}/out}"
REDIS_PASSWORD="e2e-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
RPC="http://127.0.0.1:${ANVIL_PORT}"
CAST="${FOUNDRY_BIN}/cast"
ROLES="deployer relayer keeper admin guardian maker takerA takerC outsider web"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'fork-e2e: %s\n' "$*" >&2; exit 1; }
as_pg() { if [ "$(id -u)" = 0 ]; then unshare --user --map-user=1000 --map-group=1000 "$@"; else "$@"; fi; }

for port in "${PG_PORT}" "${ANVIL_PORT}" "${API_PORT}" "${WEB_PORT}"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then die "port ${port} is in use"; fi
done
{ [ -x "${FOUNDRY_BIN}/forge" ] && [ -x "${FOUNDRY_BIN}/anvil" ]; } || die "forge and anvil not found in ${FOUNDRY_BIN}"
[ -x "${PG_BIN}/initdb" ] || die "PostgreSQL server binaries not found in ${PG_BIN}"
command -v redis-server >/dev/null || die "redis-server not found"
[ -f "${QUOTES}" ] || die "quote fixture ${QUOTES} not found"
mkdir -p "${SCRATCH}"/{pg,redis,tree/packages} "${OUT}"
chmod 700 "${SCRATCH}"
REDIS_DIR="${SCRATCH}/redis"
if [ "${#REDIS_DIR}" -gt 80 ]; then REDIS_DIR="$(mktemp -d /tmp/velum-fork-redis.XXXXXX)"; fi
REDIS_SOCK="${REDIS_DIR}/redis.sock"

NEXT_EXISTED=0
[ -e "${ROOT}/apps/web/.next" ] && NEXT_EXISTED=1
PIDS=()
cleanup() {
  set +e
  for p in "${PIDS[@]}"; do
    kill -TERM "${p}" $(pgrep -P "${p}" 2>/dev/null) 2>/dev/null
  done
  sleep 2
  for p in "${PIDS[@]}"; do kill -KILL "${p}" 2>/dev/null; done
  if [ -f "${SCRATCH}/pg/data/postmaster.pid" ]; then kill -INT "$(head -1 "${SCRATCH}/pg/data/postmaster.pid")" 2>/dev/null; fi
  redis-cli -s "${REDIS_SOCK}" -a "${REDIS_PASSWORD}" --no-auth-warning shutdown nosave >/dev/null 2>&1
  sleep 1
  [ "${REDIS_DIR}" != "${SCRATCH}/redis" ] && rm -rf "${REDIS_DIR}"
  # The web build of this run (apps/web/.next), unless one was there before.
  [ "${NEXT_EXISTED}" = 1 ] || rm -rf "${ROOT}/apps/web/.next"
  if [ "${E2E_KEEP:-0}" = 1 ]; then echo "kept ${SCRATCH}"; else rm -rf "${SCRATCH}/pg" "${SCRATCH}/redis" "${SCRATCH}/tree" "${SCRATCH}/signer-home" "${SCRATCH}"/*.hex; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

say "PostgreSQL 127.0.0.1:${PG_PORT}, Redis on ${REDIS_SOCK} (no TCP)"
as_pg "${PG_BIN}/initdb" -D "${SCRATCH}/pg/data" -U velum --auth=trust -E UTF8 >"${SCRATCH}/pg/initdb.log" 2>&1
as_pg "${PG_BIN}/pg_ctl" -D "${SCRATCH}/pg/data" -l "${SCRATCH}/pg/pg.log" -o "-p ${PG_PORT} -c unix_socket_directories='' -c listen_addresses=127.0.0.1" -w start >/dev/null \
  || { tail -5 "${SCRATCH}/pg/pg.log"; die "PostgreSQL did not start"; }
export DATABASE_URL="postgresql://velum@127.0.0.1:${PG_PORT}/postgres?schema=public"
redis-server --port 0 --unixsocket "${REDIS_SOCK}" --unixsocketperm 700 --dir "${REDIS_DIR}" --save "" --appendonly no \
  --requirepass "${REDIS_PASSWORD}" --daemonize yes --logfile "${REDIS_DIR}/redis.log"
for _ in $(seq 1 50); do [ -S "${REDIS_SOCK}" ] && break; sleep 0.1; done
[ -S "${REDIS_SOCK}" ] || die "Redis did not start"
export REDIS_URL="unix://:${REDIS_PASSWORD}@${REDIS_SOCK}"
(cd "${ROOT}/packages/db" && npx prisma migrate deploy >"${SCRATCH}/migrate.log" 2>&1) || { cat "${SCRATCH}/migrate.log"; die "migrate failed"; }

say "Build apps/workers (dist/signer.js) and the contracts (scratch copy)"
(cd "${ROOT}/apps/workers" && npx tsup >"${SCRATCH}/workers-build.log" 2>&1) || { tail -20 "${SCRATCH}/workers-build.log"; die "workers build failed"; }
cp -r "${ROOT}/contracts" "${SCRATCH}/tree/contracts"
cp -r "${ROOT}/packages/config" "${SCRATCH}/tree/packages/config"
rm -rf "${SCRATCH}/tree/contracts"/{out,cache,broadcast}
mkdir -p "${SCRATCH}/tree/contracts/deployments"
rm -f "${SCRATCH}/tree/contracts/deployments"/*.json
(cd "${SCRATCH}/tree/contracts" && "${FOUNDRY_BIN}/forge" build --offline >"${SCRATCH}/forge-build.log" 2>&1 || "${FOUNDRY_BIN}/forge" build >>"${SCRATCH}/forge-build.log" 2>&1) \
  || { tail -20 "${SCRATCH}/forge-build.log"; die "forge build failed"; }

say "Throwaway keys for this run (they hold nothing on the real chain)"
(
  umask 077
  printf '{' >"${SCRATCH}/keys.json"
  sep=""
  for r in ${ROLES}; do
    "${CAST}" wallet new --json | python3 -I -c 'import json,sys; w=json.load(sys.stdin)[0]; sys.stdout.write("%s\"%s\": {\"address\": \"%s\", \"privateKey\": \"%s\"}" % (sys.argv[1], sys.argv[2], w["address"], w["private_key"]))' "${sep}" "${r}" >>"${SCRATCH}/keys.json"
    sep=", "
  done
  printf '}\n' >>"${SCRATCH}/keys.json"
)
key() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]][sys.argv[3]])' "${SCRATCH}/keys.json" "$1" "$2"; }

BLOCK="${FORK_BLOCK:-$("${CAST}" block-number --rpc-url "${FORK_URL}")}"
say "anvil forks Robinhood Chain mainnet at block ${BLOCK} (chain id 31337 on the fork)"
"${FOUNDRY_BIN}/anvil" --fork-url "${FORK_URL}" --fork-block-number "${BLOCK}" --chain-id 31337 --port "${ANVIL_PORT}" \
  --no-storage-caching --compute-units-per-second 300 --fork-retry-backoff 500 --retries 8 --timeout 45000 >"${SCRATCH}/anvil.log" 2>&1 &
PIDS+=($!)
FORK_STARTED=$(date +%s)
for _ in $(seq 1 60); do "${CAST}" chain-id --rpc-url "${RPC}" >/dev/null 2>&1 && break; sleep 0.5; done
[ "$("${CAST}" chain-id --rpc-url "${RPC}")" = 31337 ] || { tail -5 "${SCRATCH}/anvil.log"; die "anvil did not start"; }

say "Deploy GUARDED against the real mainnet tokens (forge script, scratch copy)"
"${CAST}" rpc anvil_setBalance "$(key deployer address)" 0x56BC75E2D63100000 --rpc-url "${RPC}" >/dev/null
TOKENS_JSON="$(python3 -I -c 'import json,sys; t=json.load(open(sys.argv[1]))["tokens"]; print(json.dumps({k: v["address"] for k, v in t.items()}))' "${ROOT}/packages/config/robinhood-mainnet.json")"
STOCK_SYMBOLS="TSLA,AMZN,PLTR,NVDA,NFLX,AMD,AAPL,META,MSFT,COIN"
STOCK_ADDRESSES="$(python3 -I -c 'import json,sys; t=json.loads(sys.argv[1]); print(",".join(t[s] for s in sys.argv[2].split(",")))' "${TOKENS_JSON}" "${STOCK_SYMBOLS}")"
caps=(GUARD_ACCOUNT_CAP_USDG=60000 GUARD_GLOBAL_CAP_USDG=120000 GUARD_ACCOUNT_CAP_TSLA=40 GUARD_GLOBAL_CAP_TSLA=80 GUARD_ACCOUNT_CAP_NVDA=60 GUARD_GLOBAL_CAP_NVDA=120)
for s in AMZN PLTR NFLX AMD AAPL META MSFT COIN; do caps+=("GUARD_ACCOUNT_CAP_${s}=1" "GUARD_GLOBAL_CAP_${s}=2"); done
(
  cd "${SCRATCH}/tree/contracts"
  env "${caps[@]}" PRICE_RELAYER="$(key relayer address)" GUARD_ADMIN="$(key admin address)" GUARDIAN="$(key guardian address)" \
    USDG_ADDRESS="$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["USDG"])' "${TOKENS_JSON}")" \
    STOCK_ADDRESSES="${STOCK_ADDRESSES}" STOCK_SYMBOLS="${STOCK_SYMBOLS}" \
    timeout 600 "${FOUNDRY_BIN}/forge" script script/Deploy.s.sol --offline --no-storage-caching --rpc-url "${RPC}" --broadcast --slow \
    --private-key "$(key deployer privateKey)" >"${SCRATCH}/forge-deploy.log" 2>&1
) || { tail -40 "${SCRATCH}/forge-deploy.log"; die "forge deploy failed"; }
cp "${SCRATCH}/tree/contracts/broadcast/Deploy.s.sol/31337/run-latest.json" "${OUT}/deploy-broadcast.json"
DEP_DIR="${SCRATCH}/tree/contracts/deployments"
cat "${DEP_DIR}/31337.json"; echo
echo "deployed $(( $(date +%s) - FORK_STARTED )) s after the fork started"

say "Runner: warm-up and funding first, then the stack and every flow"
export FORK_RPC="${RPC}" FORK_DEPLOYMENTS="${DEP_DIR}" FORK_ARTIFACTS="${SCRATCH}/tree/contracts/out" FORK_KEYS="${SCRATCH}/keys.json" \
  FORK_OUT="${OUT}/report.json" FORK_QUOTES="${QUOTES}" FORK_SCRATCH="${SCRATCH}" FORK_API_PORT="${API_PORT}" FORK_BLOCK="${BLOCK}" \
  FORK_HOLD="${WEB}" LOG_LEVEL=warn
"${ROOT}/apps/workers/node_modules/.bin/tsx" "${HERE}/fork.e2e.ts" > >(tee "${OUT}/runner.log") 2>&1 &
RUNNER=$!
PIDS+=("${RUNNER}")

WEB_BUILD=""
if [ "${WEB}" = 1 ]; then
  for _ in $(seq 1 900); do [ -f "${SCRATCH}/warmup.done" ] && break; kill -0 "${RUNNER}" 2>/dev/null || break; sleep 1; done
  if [ -f "${SCRATCH}/warmup.done" ]; then
    say "Build the web with the fork's deployment file (in the background while the flows run)"
    (
      cd "${ROOT}/apps/web"
      NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_VELUM_NETWORK=testnet NEXT_PUBLIC_CHAIN_ID=31337 NEXT_PUBLIC_RPC_URL="${RPC}" \
        NEXT_PUBLIC_API_URL=/api NEXT_PUBLIC_SITE_URL="http://127.0.0.1:${WEB_PORT}" DEPLOYMENTS_DIR="${DEP_DIR}" \
        API_PROXY_TARGET="http://127.0.0.1:${API_PORT}" \
        nice -n 10 npx next build >"${SCRATCH}/web-build.log" 2>&1
    ) &
    WEB_BUILD=$!
    PIDS+=("${WEB_BUILD}")
  fi
fi

# Wait for the flows (or the runner's failure).
while kill -0 "${RUNNER}" 2>/dev/null && [ ! -f "${SCRATCH}/flows.done" ]; do sleep 2; done
if [ ! -f "${SCRATCH}/flows.done" ]; then
  wait "${RUNNER}" || { tail -30 "${OUT}/runner.log"; die "the runner failed (report: ${OUT}/report.json)"; }
fi

if [ "${WEB}" = 1 ] && [ -n "${WEB_BUILD}" ]; then
  say "Web: wait for the build, start it, compare the oracle price it shows with the chain"
  wait "${WEB_BUILD}" || { tail -40 "${SCRATCH}/web-build.log"; die "web build failed"; }
  (cd "${ROOT}/apps/web" && exec node_modules/.bin/next start -p "${WEB_PORT}" -H 127.0.0.1) >"${SCRATCH}/next.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 120); do curl -s -m 5 -o /dev/null "http://127.0.0.1:${WEB_PORT}/" && break; sleep 0.5; done
  WEB_OK=0
  NODE_PATH="$(npm root -g)" WEB="http://127.0.0.1:${WEB_PORT}" RPC="${RPC}" ORACLE="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["contracts"]["oracle"])' "${DEP_DIR}/31337.json")" \
    TOKENS="$(python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["tokens"]))' "${DEP_DIR}/31337.json")" OUT="${OUT}" \
    node "${HERE}/web-check.cjs" && WEB_OK=1
  rm -f "${SCRATCH}/flows.done"
  wait "${RUNNER}" || true
  [ "${WEB_OK}" = 1 ] || die "web check failed (${OUT}/web-check.json)"
fi

say "Gas of the deployment transactions"
python3 -I - "${OUT}/deploy-broadcast.json" <<'EOF' | tee "${OUT}/deploy-gas.txt"
import json, sys
b = json.load(open(sys.argv[1]))
total = 0
for tx, r in zip(b["transactions"], b["receipts"]):
    g = int(r["gasUsed"], 16)
    total += g
    what = tx.get("contractName") or ""
    fn = tx.get("function") or ("create" if tx.get("transactionType") == "CREATE" else "")
    print(f'{g:>10}  {tx["transactionType"]:<6} {what:<14} {fn or ""}  {r["transactionHash"]}')
print(f'{total:>10}  total over {len(b["receipts"])} transactions')
EOF
python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("report ok:", r.get("ok"), "| steps:", len(r["steps"]))' "${OUT}/report.json"
say "mainnet-fork end-to-end run passed (report: ${OUT})"
