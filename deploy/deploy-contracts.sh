#!/usr/bin/env bash
# Deploy the Velum contracts to Robinhood Chain MAINNET (4663) as the guarded beta, from the VPS, as root:
#   sudo bash /srv/velum/deploy/deploy-contracts.sh /etc/velum/mainnet-deploy.env
# docs/07-mainnet-guarded-beta.md is the runbook; this script is its "Deploy the contracts" step. Run it in tmux.
#
# Before it (the script checks each and stops with the instruction otherwise):
#   - deploy/set-network.sh mainnet ran (.env: VELUM_NETWORK=mainnet, CHAIN_ID=4663);
#   - the signer's two keys exist (deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY and KEEPER_PRIVATE_KEY) and a release with
#     ONCHAIN_WORKERS=true built the signer's own copy (it shows their addresses). The PRICE_RELAY key is fixed in the
#     oracle at deployment, so it must exist BEFORE this script runs; nothing is signed on mainnet until
#     ONCHAIN_MAINNET_CONFIRMED=yes, which comes after this script;
#   - the deployer, the price-relay and the keeper addresses hold ETH (docs/07, "ETH budget").
#
# What it does, in order:
#   1. checks: root, the base is safe (common.sh: root-owned, no symbolic links), the deploy lock (flock), no hot key in
#      .env, mainnet in .env, the RPC answers chain 4663, no deployment file for 4663 yet (unless REPLACE_DEPLOYMENT=yes
#      in the settings), no local changes to contracts/ or packages/config/ (it deploys the checked-out commit);
#   2. reads the settings file (KEY=VALUE, read as data and never sourced; root-owned, not a symbolic link, one hard
#      link, nobody else may write it, at most 64 KiB, only the keys listed under SETTINGS below);
#   3. installs Foundry v1.5.1 (forge and cast only) and solc 0.8.28 for root under VELUM_TOOLS (/opt/velum-tools)
#      when missing, from their GitHub releases, each pinned by SHA-256 (a present binary with another hash stops it);
#   4. the deployer key lives in an encrypted Foundry keystore, VELUM_ETC/keystore/<name> (root, 700/600). On first
#      use `cast wallet import --interactive` asks for the key and a new password at its own hidden prompts: the key is
#      never in a plain file, on a command line or in an environment. The keystore password is asked once and handed to
#      forge as a root-only file in a fresh 0700 directory under /run (tmpfs), removed on exit;
#   5. the price-relay and keeper addresses, derived as the signer user from its own build (like new-key.sh);
#   6. reference prices for the oracle-bounds check: the token's current price from Robinhood's public quote API
#      (tokenBid/tokenAsk midpoint, the exact mainnet token address checked), or MAINNET_REF_PRICE_<SYMBOL> from the
#      settings file;
#   7. step 1 of contracts/script/Deploy.s.sol, the simulation (forge script without --broadcast), in a root-only copy
#      of contracts/ and packages/config/ exported from the checked-out commit; forge runs detached from the terminal
#      with a clean environment, its output shown without control characters;
#   8. you type the confirmation phrase the simulation printed (it names the chain, the guard admin and the price
#      relayer); anything else stops here with nothing broadcast;
#   9. step 2, the broadcast (--broadcast --slow); then every receipt is checked, every contract must have code, and
#      the roles are read back from the chain (guard admin, guard on, price relayer, guardian);
#  10. installs the deployment file as <base>/deployments/4663.json (root:root 644, in root:root 755: readable by the
#      app, web and signer users, writable by root only) and sets DEPLOYMENTS_DIR in .env (backed up first); keeps the
#      run's logs and forge's broadcast record in <base>/backups/contracts-4663-<time>/ (root only);
#  11. prints the next steps: ONCHAIN_MAINNET_CONFIRMED=yes, deploy.sh, the health checks, allowlisting.
#
# SETTINGS (the file given as the argument; see docs/07 for a commented example):
#   GUARD_ADMIN                    the owner multisig (required: mainnet is the guarded beta only)
#   GUARD_ACCOUNT_CAP_<SYMBOL>     token amounts, for USDG and every stock: TSLA AMZN PLTR NVDA NFLX AMD AAPL META MSFT COIN
#   GUARD_GLOBAL_CAP_<SYMBOL>
#   GUARDIAN                       optional close-only switch (an owner key, never the relay or deployer key)
#   PRICE_MIN_USD PRICE_MAX_USD OI_CAP_TOKENS GUARD_ALLOW_SMALL_USDG_CAP   optional (contracts/script/Deploy.s.sol)
#   MAINNET_REF_PRICE_<SYMBOL>     optional: a reference price instead of the quote API's
#   PRICE_RELAYER                  optional: must equal the signer's PRICE_RELAY key address (a cross-check)
#   DEPLOY_RPC_URL                 optional: the endpoint to deploy through (default: RPC_URL of .env, else the official)
#   DEPLOYER_KEYSTORE              optional: the keystore name (default velum-deployer)
#   REPLACE_DEPLOYMENT=yes         optional: allow replacing an existing <base>/deployments/4663.json
# Test-only overrides (never needed on a server): VELUM_ETC (common.sh), VELUM_TOOLS.
# shellcheck disable=SC2015 # "A && B || die" is the intended idiom here: die exits.
set -euo pipefail
umask 077
# A dropped SSH session must not stop it halfway (R2-L6); run it in tmux anyway: it asks questions.
trap '' HUP
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
BASE="$(cd "$(dirname "${SELF}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${BASE}/deploy/lib/common.sh"

CHAIN=4663
STOCKS='TSLA AMZN PLTR NVDA NFLX AMD AAPL META MSFT COIN'
OFFICIAL_RPC=https://rpc.mainnet.chain.robinhood.com
QUOTES_URL=https://api.robinhood.com/rhj/prices
# Pinned tools (SHA-256 of the GitHub release assets, checked 2026-11-15; cross-check them on the release pages).
FOUNDRY_VERSION=v1.5.1
FOUNDRY_COMMIT=b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2
FOUNDRY_URL="https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz"
FOUNDRY_SHA256=73640b01bd9ed29fdb4965085099371f8cf0dbbec3e2086cf54564efc4dcfe88
FORGE_SHA256=a39fc1913b53dde6a35b603756f65d799e13817ef694107ec0d3704c20435cce
CAST_SHA256=7b25a9c61dac49a0718ba3c2d37ba638014f3baf35739777b2d809780914e91d
SOLC_VERSION=0.8.28
SOLC_URL="https://github.com/ethereum/solidity/releases/download/v${SOLC_VERSION}/solc-static-linux"
SOLC_SHA256=9a0fb7e0db2c0641dbae1c5cc645dc686820c83af516226abb1c0a2f76636f25
VELUM_TOOLS="${VELUM_TOOLS:-/opt/velum-tools}"

SETTINGS="${1:-}"
[ -n "${SETTINGS}" ] && [ $# -eq 1 ] || die "Usage: sudo bash deploy/deploy-contracts.sh /etc/velum/mainnet-deploy.env (docs/07-mainnet-guarded-beta.md)"
ENV_FILE="${BASE}/.env"
[ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE}."
velum_mode "${BASE}"
[ "${SEPARATE}" = 1 ] || die "Run as root: the deployment file and the keystore are root's, and the relay address is read as ${SIGNER_USER:-the signer user}."
lock_deploy "${BASE}"
[ -z "$(hot_keys_in "${ENV_FILE}")" ] || die "${ENV_FILE} still holds $(hot_keys_in "${ENV_FILE}" | tr '\n' ' ')(readable by ${APP_USER}). Run server-setup.sh first: it moves them into ${SIGNER_KEYS_FILE}. Nothing was changed."
[ -t 0 ] && [ -r /dev/tty ] || die "Run this in an interactive terminal (tmux): it asks for the keystore password and the confirmation phrase."
[ "$(uname -m)" = x86_64 ] || die "The pinned Foundry and solc builds are for x86_64 Linux; this machine is $(uname -m)."

# ── 1. The base and .env ──────────────────────────────────────────────────────
[ "$(env_get "${ENV_FILE}" CHAIN_ID)" = "${CHAIN}" ] && [ "$(env_get "${ENV_FILE}" VELUM_NETWORK)" = mainnet ] ||
  die "${ENV_FILE} is not on Robinhood Chain mainnet. Run: sudo bash ${BASE}/deploy/set-network.sh mainnet (then this again)."
dirty="$(root_git status --porcelain -- contracts packages/config)"
[ -z "${dirty}" ] || die "contracts/ or packages/config/ in ${BASE} differ from the checked-out commit; this script deploys only committed code:
${dirty}"
COMMIT="$(root_git rev-parse HEAD)"

# ── 2. The settings file, as data ─────────────────────────────────────────────
ALLOWED='GUARD_ADMIN GUARDIAN PRICE_MIN_USD PRICE_MAX_USD OI_CAP_TOKENS GUARD_ALLOW_SMALL_USDG_CAP PRICE_RELAYER DEPLOY_RPC_URL DEPLOYER_KEYSTORE REPLACE_DEPLOYMENT GUARD_ACCOUNT_CAP_USDG GUARD_GLOBAL_CAP_USDG'
for s in ${STOCKS}; do ALLOWED="${ALLOWED} GUARD_ACCOUNT_CAP_${s} GUARD_GLOBAL_CAP_${s} MAINNET_REF_PRICE_${s}"; done
[ ! -L "${SETTINGS}" ] && [ -f "${SETTINGS}" ] || die "${SETTINGS} must be a regular file (not a symbolic link)."
[ "$(stat -c %u "${SETTINGS}")" = 0 ] && [ "$(stat -c %h "${SETTINGS}")" = 1 ] && [ -z "$(find "${SETTINGS}" -maxdepth 0 -perm /0022)" ] ||
  die "${SETTINGS} must belong to root, have one hard link and be writable by root only (chown root:root, chmod 600)."
[ "$(stat -c %s "${SETTINGS}")" -le 65536 ] || die "${SETTINGS} is larger than 64 KiB."
bad="$(awk '{ sub(/\r$/, "") } /^[[:space:]]*(#|$)/ { next } !/^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ { print NR; exit }' "${SETTINGS}")"
[ -z "${bad}" ] || die "${SETTINGS}: line ${bad} is not KEY=VALUE, a comment or blank."
while IFS= read -r k; do
  case " ${ALLOWED} " in *" ${k} "*) ;; *) die "${SETTINGS}: ${k} is not a setting of this script (see the list at its top). Nothing was done." ;; esac
done < <(env_keys "${SETTINGS}")
setting() { env_get "${SETTINGS}" "$1"; }
[ -n "$(setting GUARD_ADMIN)" ] || die "${SETTINGS}: GUARD_ADMIN is required: mainnet is deployed only as the guarded beta."
for s in USDG ${STOCKS}; do
  [ -n "$(setting "GUARD_ACCOUNT_CAP_${s}")" ] && [ -n "$(setting "GUARD_GLOBAL_CAP_${s}")" ] ||
    die "${SETTINGS}: GUARD_ACCOUNT_CAP_${s} and GUARD_GLOBAL_CAP_${s} are required (token amounts; 0 blocks the token)."
done
case "$(setting REPLACE_DEPLOYMENT)" in "" | yes) ;; *) die "${SETTINGS}: REPLACE_DEPLOYMENT must be yes or absent." ;; esac

DEP_DIR="${BASE}/deployments"
DEP_FILE="${DEP_DIR}/${CHAIN}.json"
[ ! -L "${DEP_DIR}" ] && [ ! -L "${DEP_FILE}" ] || die "${DEP_DIR} or ${DEP_FILE} is a symbolic link; refusing to use it."
if [ -e "${DEP_FILE}" ] && [ "$(setting REPLACE_DEPLOYMENT)" != yes ]; then
  die "${DEP_FILE} already exists (a deployment is live). A new deployment replaces it for every app; set REPLACE_DEPLOYMENT=yes in ${SETTINGS} if that is intended. Nothing was done."
fi

RPC="$(setting DEPLOY_RPC_URL)"
[ -n "${RPC}" ] || RPC="$(env_get "${ENV_FILE}" RPC_URL)"
[ -n "${RPC}" ] || RPC="${OFFICIAL_RPC}"
[[ "${RPC}" =~ ^https?://[^[:space:]]+$ ]] || die "The RPC URL (DEPLOY_RPC_URL or RPC_URL) must be an http(s) URL."
RPC_SHOWN="$(printf '%s' "${RPC}" | sed -E 's#^(https?://)([^/@]*@)?([^/?\#]+).*#\1\3#')"

# ── 3. Pinned tools ───────────────────────────────────────────────────────────
# safe_dir DIR — DIR and every directory above it are real, root-owned and writable by root only (no link followed).
safe_dir() {
  local p="" part
  local IFS=/
  for part in $1; do
    [ -n "${part}" ] || continue
    p="${p}/${part}"
    [ -e "${p}" ] || return 0
    [ ! -L "${p}" ] && [ -d "${p}" ] && [ "$(stat -c %u "${p}")" = 0 ] || die "${p} must be a real root-owned directory (no symbolic link)."
    [ -z "$(find "${p}" -maxdepth 0 -perm /0022 ! -perm -1000)" ] || die "${p} is writable by others than root."
  done
}
sha_of() { sha256sum "$1" | cut -d' ' -f1; }
WORK=""
RUN_DIR=""
cleanup() {
  set +e
  if [ -n "${RUN_DIR}" ] && [ -d "${RUN_DIR}" ]; then
    [ -f "${RUN_DIR}/pw" ] && shred -u "${RUN_DIR}/pw" 2>/dev/null
    rm -rf --one-file-system -- "${RUN_DIR}"
  fi
  [ -n "${WORK}" ] && [ -d "${WORK}" ] && rm -rf --one-file-system -- "${WORK}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
WORK="$(mktemp -d /var/tmp/velum-contracts.XXXXXX)"
fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --max-time 300 -o "$2" "$1"; }

ensure_tools() {
  local fdir="${VELUM_TOOLS}/foundry-${FOUNDRY_VERSION}" sdir="${VELUM_TOOLS}/solc-${SOLC_VERSION}" t="${WORK}/download"
  safe_dir "${fdir}"
  safe_dir "${sdir}"
  if [ -e "${fdir}/forge" ] || [ -e "${fdir}/cast" ]; then
    [ "$(sha_of "${fdir}/forge")" = "${FORGE_SHA256}" ] && [ "$(sha_of "${fdir}/cast")" = "${CAST_SHA256}" ] ||
      die "${fdir} holds a forge or cast that is not the pinned ${FOUNDRY_VERSION} build (SHA-256 differs). Remove ${fdir} to reinstall it."
  else
    say "Installing Foundry ${FOUNDRY_VERSION} (forge, cast) for root in ${fdir} (pinned SHA-256)"
    mkdir -p "${t}"
    fetch "${FOUNDRY_URL}" "${t}/foundry.tar.gz" || die "Download of ${FOUNDRY_URL} failed."
    [ "$(sha_of "${t}/foundry.tar.gz")" = "${FOUNDRY_SHA256}" ] || die "The Foundry download has another SHA-256 than the pinned one; nothing installed."
    tar -xzf "${t}/foundry.tar.gz" -C "${t}" --no-same-owner --no-same-permissions forge cast || die "Cannot unpack the Foundry archive."
    [ "$(sha_of "${t}/forge")" = "${FORGE_SHA256}" ] && [ "$(sha_of "${t}/cast")" = "${CAST_SHA256}" ] || die "forge or cast in the archive has another SHA-256 than pinned; nothing installed."
    install -d -o root -g root -m 755 "${VELUM_TOOLS}" "${fdir}"
    install -o root -g root -m 755 "${t}/forge" "${t}/cast" "${fdir}/"
  fi
  if [ -e "${sdir}/solc" ]; then
    [ "$(sha_of "${sdir}/solc")" = "${SOLC_SHA256}" ] || die "${sdir}/solc is not the pinned solc ${SOLC_VERSION} (SHA-256 differs). Remove ${sdir} to reinstall it."
  else
    say "Installing solc ${SOLC_VERSION} for root in ${sdir} (pinned SHA-256)"
    mkdir -p "${t}"
    fetch "${SOLC_URL}" "${t}/solc" || die "Download of ${SOLC_URL} failed."
    [ "$(sha_of "${t}/solc")" = "${SOLC_SHA256}" ] || die "The solc download has another SHA-256 than the pinned one; nothing installed."
    install -d -o root -g root -m 755 "${VELUM_TOOLS}" "${sdir}"
    install -o root -g root -m 755 "${t}/solc" "${sdir}/solc"
  fi
  rm -rf "${t}"
  FORGE="${fdir}/forge"
  CAST="${fdir}/cast"
  SOLC="${sdir}/solc"
  local v
  v="$("${FORGE}" --version 2>/dev/null || true)"
  [[ "${v}" == *"Commit SHA: ${FOUNDRY_COMMIT}"* ]] || die "${FORGE} does not report commit ${FOUNDRY_COMMIT}."
}
ensure_tools

proxy_env=()
for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy SSL_CERT_FILE; do
  if [ -n "${!v:-}" ]; then proxy_env+=("${v}=${!v}"); fi
done
install -d -m 700 "${WORK}/home"
# clean_env NAME=VALUE… -- CMD… — runs CMD in a subshell whose environment is only PATH, HOME, LANG, the proxy settings
# and the given variables. Values are exported, never put on a command line: the RPC URL can carry a provider key, and
# every local user can read a process's arguments (/proc/<pid>/cmdline), not its environment.
clean_env() (
  local v
  while IFS= read -r v; do unset -v "${v}" 2>/dev/null || true; done < <(compgen -e)
  export PATH=/usr/bin:/bin HOME="${WORK}/home" LANG=C.UTF-8
  for v in "${proxy_env[@]}"; do export "${v?}"; done
  while [ $# -gt 0 ] && [ "$1" != -- ]; do export "${1?}"; shift; done
  shift
  "$@"
)
# cast_ro ARGS… — read-only cast calls against the RPC (ETH_RPC_URL), clean environment, no terminal.
cast_ro() { clean_env "ETH_RPC_URL=${RPC}" -- "${CAST}" "$@" </dev/null 2>/dev/null; }
chain="$(cast_ro chain-id || true)"
[ "${chain}" = "${CHAIN}" ] || die "The RPC at ${RPC_SHOWN} answers chain ${chain:-nothing}, not ${CHAIN}."

# ── 5. The signer's addresses (before any key is asked: the order of the runbook) ──
# signer_address VAR — VAR's address from the signer's keys file, derived as the signer user with viem from its own
# build (deploy/new-key.sh does the same); empty when the key or the build is missing.
signer_address() {
  local dir="${SIGNER_HOME}/current/apps/workers"
  [ -n "$(env_get "${SIGNER_KEYS_FILE}" "$1")" ] || return 0
  as_signer test -d "${dir}/node_modules/viem" >/dev/null 2>&1 || return 0
  env_get "${SIGNER_KEYS_FILE}" "$1" | as_signer node -e '
    const { privateKeyToAccount } = require(require.resolve("viem/accounts", { paths: [process.argv[1]] }));
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(privateKeyToAccount(s.trim()).address));' "${dir}" 2>/dev/null | tr -cd '0-9A-Za-z'
}
[ -f "${SIGNER_KEYS_FILE}" ] && [ ! -L "${SIGNER_KEYS_FILE}" ] || die "${SIGNER_KEYS_FILE} is missing. Create the keys first: sudo bash ${BASE}/deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY, then KEEPER_PRIVATE_KEY (docs/07, \"Keys\")."
RELAYER="$(signer_address PRICE_RELAY_PRIVATE_KEY || true)"
KEEPER="$(signer_address KEEPER_PRIVATE_KEY || true)"
[[ "${RELAYER}" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "No price-relay address: create the key (sudo bash ${BASE}/deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY), set ONCHAIN_WORKERS=true in .env and run deploy.sh once (it builds the signer's own copy, which derives the address), then run this again. The oracle's relayer is fixed at deployment, so this order matters (docs/07)."
[[ "${KEEPER}" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "No keeper address: create it (sudo bash ${BASE}/deploy/new-key.sh KEEPER_PRIVATE_KEY), then run this again."
[ "${RELAYER,,}" != "${KEEPER,,}" ] || die "The price-relay and keeper keys are the same address; they must be separate keys."
if [ -n "$(setting PRICE_RELAYER)" ] && [ "$(setting PRICE_RELAYER | tr '[:upper:]' '[:lower:]')" != "${RELAYER,,}" ]; then
  die "PRICE_RELAYER in ${SETTINGS} ($(setting PRICE_RELAYER)) is not the signer's PRICE_RELAY key (${RELAYER})."
fi

# ── 4. The deployer key: an encrypted keystore, its password in a root-only tmpfs file ──
KS_NAME="$(setting DEPLOYER_KEYSTORE)"
KS_NAME="${KS_NAME:-velum-deployer}"
[[ "${KS_NAME}" =~ ^[A-Za-z0-9._-]{1,64}$ ]] && [ "${KS_NAME}" != . ] && [ "${KS_NAME}" != .. ] || die "DEPLOYER_KEYSTORE must be a plain name."
KS_DIR="${VELUM_ETC}/keystore"
safe_dir "${VELUM_ETC}"
[ ! -L "${KS_DIR}" ] || die "${KS_DIR} is a symbolic link; refusing to use it."
install -d -o root -g root -m 755 "${VELUM_ETC}"
install -d -o root -g root -m 700 "${KS_DIR}"
KS="${KS_DIR}/${KS_NAME}"
[ ! -L "${KS}" ] || die "${KS} is a symbolic link; refusing to use it."
if [ ! -e "${KS}" ]; then
  say "No deployer keystore yet. cast asks for the deployer's private key and a new password (both hidden); it stores the key encrypted in ${KS}."
  say "Use a fresh key that holds only the ETH for this deployment; it has no role in the contracts afterwards."
  "${CAST}" wallet import "${KS_NAME}" --keystore-dir "${KS_DIR}" --interactive </dev/tty >/dev/tty 2>&1 || die "cast wallet import failed; nothing was done."
fi
[ -f "${KS}" ] && [ "$(stat -c %u "${KS}")" = 0 ] || die "${KS} is not a root-owned keystore file."
chmod 600 "${KS}"
RUN_DIR="$(mktemp -d /run/velum-deploy-contracts.XXXXXX)"
printf 'Keystore password for %s: ' "${KS_NAME}" >/dev/tty
IFS= read -rs PW </dev/tty
printf '\n' >/dev/tty
printf '%s' "${PW}" >"${RUN_DIR}/pw"
unset PW
PWF="${RUN_DIR}/pw"
DEPLOYER="$(clean_env -- "${CAST}" wallet address --keystore "${KS}" --password-file "${PWF}" </dev/null 2>/dev/null | tr -cd '0-9A-Za-z' || true)"
[[ "${DEPLOYER}" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "Could not open ${KS} with that password; nothing was done."
for a in "${RELAYER}" "${KEEPER}" "$(setting GUARD_ADMIN)"; do
  [ "${DEPLOYER,,}" != "${a,,}" ] || die "The deployer key ${DEPLOYER} is also the price relayer, the keeper or the guard admin; use a separate deployer key."
done

# ── 6. Reference prices for the oracle-bounds check ──────────────────────────
config_address() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["tokens"][sys.argv[2]]["address"])' "${BASE}/packages/config/robinhood-mainnet.json" "$1"; }
ref_env=()
for s in ${STOCKS}; do
  p="$(setting "MAINNET_REF_PRICE_${s}")"
  if [ -z "${p}" ]; then
    q="$(curl -fsS --proto '=https' --max-time 10 -H 'accept: application/json' "${QUOTES_URL}/${s}" || true)"
    p="$(printf '%s' "${q}" | python3 -I -c '
import json, sys
from decimal import Decimal, ROUND_FLOOR
sym, want = sys.argv[1], sys.argv[2].lower()
try:
    q = json.load(sys.stdin)["quotes"][0]
    ok = q.get("tokenSymbol") == sym and any(d.get("chainId") == 4663 and str(d.get("contractAddress", "")).lower() == want for d in q.get("deployments", []))
    b, a = Decimal(q["tokenBid"]), Decimal(q["tokenAsk"])
    if ok and 0 < b <= a:
        print(((b + a) / 2).quantize(Decimal("0.0001"), rounding=ROUND_FLOOR))
except Exception:
    pass' "${s}" "$(config_address "${s}")" || true)"
    [[ "${p}" =~ ^[0-9]{1,9}(\.[0-9]{1,4})?$ ]] || die "No usable quote for ${s} from ${QUOTES_URL}. Set MAINNET_REF_PRICE_${s} (its current price in USDG) in ${SETTINGS} and run this again."
  fi
  ref_env+=("MAINNET_REF_PRICE_${s}=${p}")
  printf '  %-5s reference price %s USDG\n' "${s}" "${p}"
done

# ── 7. The simulation ─────────────────────────────────────────────────────────
mkdir -p "${WORK}/src"
root_git archive --format=tar "${COMMIT}" contracts packages/config | tar -x -C "${WORK}/src" --no-same-owner
[ -f "${WORK}/src/contracts/script/Deploy.s.sol" ] || die "The commit has no contracts/script/Deploy.s.sol."
rm -rf "${WORK}/src/contracts/deployments"/*.json "${WORK}/src/contracts/broadcast" "${WORK}/src/contracts/out" "${WORK}/src/contracts/cache"
mkdir -p "${WORK}/src/contracts/deployments"
forge_env=()
for k in $(env_keys "${SETTINGS}"); do
  case "${k}" in DEPLOY_RPC_URL | DEPLOYER_KEYSTORE | REPLACE_DEPLOYMENT | MAINNET_REF_PRICE_* | PRICE_RELAYER) continue ;; esac
  forge_env+=("${k}=$(setting "${k}")")
done
forge_env+=("PRICE_RELAYER=${RELAYER}" "${ref_env[@]}")
# run_forge LOG [extra env…] -- [extra args…] — forge script, detached from the terminal, clean environment.
run_forge() {
  local log="$1" extra=()
  shift
  while [ $# -gt 0 ] && [ "$1" != -- ]; do extra+=("$1"); shift; done
  shift
  # The RPC URL reaches forge as FOUNDRY_ETH_RPC_URL (its eth_rpc_url setting), so it is on no command line.
  clean_env "FOUNDRY_ETH_RPC_URL=${RPC}" "${forge_env[@]}" "${extra[@]}" -- \
    run_isolated "${FORGE}" script "${WORK}/src/contracts/script/Deploy.s.sol" --root "${WORK}/src/contracts" --offline \
    --use "${SOLC}" --keystore "${KS}" --password-file "${PWF}" --sender "${DEPLOYER}" "$@" >"${log}" 2>&1
}
say "Step 1: simulation (nothing is broadcast) from commit ${COMMIT} through ${RPC_SHOWN}; compiling takes a minute"
if ! run_forge "${WORK}/simulate.log" --; then
  tty_sanitize <"${WORK}/simulate.log" | tail -60
  die "The simulation failed (above); nothing was broadcast."
fi
tty_sanitize <"${WORK}/simulate.log" | sed -n '/== Logs ==/,$p'
PHRASE="$(awk '/Broadcast confirmation phrase \(VELUM_MAINNET_GUARDED_CONFIRM\):/ { getline; sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); print; exit }' "${WORK}/simulate.log")"
[ -n "${PHRASE}" ] && [ -f "${WORK}/src/contracts/deployments/${CHAIN}.plan.json" ] || die "The simulation did not print a plan and a confirmation phrase; nothing was broadcast."

# ── 8. Confirmation ───────────────────────────────────────────────────────────
for a in "${DEPLOYER}" "${RELAYER}" "${KEEPER}"; do
  printf '  balance of %s: %s ETH\n' "${a}" "$(cast_ro balance --ether "${a}" || echo '?')"
done
cat >/dev/tty <<EOF

Check the summary above: the guard admin, the caps, the price relayer (${RELAYER}, the signer's key), the guardian, the
token list and the bounds. The contracts are UNAUDITED and immutable; the guard is the only protection until the audit.
To broadcast to Robinhood Chain MAINNET from ${DEPLOYER}, type the confirmation phrase exactly (anything else stops here):
  ${PHRASE}
EOF
printf '> ' >/dev/tty
IFS= read -r typed </dev/tty
[ "${typed}" = "${PHRASE}" ] || die "Not confirmed (the text differs from the phrase). Nothing was broadcast."

# ── 9. The broadcast and its checks ───────────────────────────────────────────
say "Step 2: broadcast to chain ${CHAIN} (one transaction at a time)"
if ! run_forge "${WORK}/broadcast.log" "VELUM_MAINNET_GUARDED_CONFIRM=${typed}" -- --broadcast --slow; then
  tty_sanitize <"${WORK}/broadcast.log" | tail -60
  ART="${BASE}/backups/contracts-${CHAIN}-failed-$(date -u +%Y%m%d%H%M%S)"
  install -d -o root -g root -m 700 "${BASE}/backups" "${ART}"
  cp -r "${WORK}/simulate.log" "${WORK}/broadcast.log" "${WORK}/src/contracts/broadcast" "${ART}/" 2>/dev/null || true
  die "The broadcast failed (above). Some transactions may have been sent: forge's record is in ${ART}. Nothing was installed; check the deployer's transactions on the explorer before trying again (a new simulation is needed)."
fi
tty_sanitize <"${WORK}/broadcast.log" | grep -E 'Velum deployed|mainnet broadcast run accepted|ONCHAIN EXECUTION|Error|FAIL' | tail -20 || true
NEW="${WORK}/src/contracts/deployments/${CHAIN}.json"
REC="${WORK}/src/contracts/broadcast/Deploy.s.sol/${CHAIN}/run-latest.json"
[ -f "${NEW}" ] && [ -f "${REC}" ] || die "forge did not write the deployment file or its broadcast record."
ART="${BASE}/backups/contracts-${CHAIN}-$(date -u +%Y%m%d%H%M%S)"
install -d -o root -g root -m 700 "${BASE}/backups" "${ART}"
cp "${WORK}/simulate.log" "${WORK}/broadcast.log" "${REC}" "${NEW}" "${ART}/"
printf 'commit=%s\nrpc=%s\ndeployer=%s\nprice_relayer=%s\nkeeper=%s\n' "${COMMIT}" "${RPC_SHOWN}" "${DEPLOYER}" "${RELAYER}" "${KEEPER}" >"${ART}/run.txt"
# Every receipt succeeded, every contract has code, the roles on chain are the ones asked for.
python3 -I - "${REC}" "${NEW}" "${CHAIN}" <<'EOF' || die "The broadcast record or the deployment file does not check out (above). Nothing was installed; the record is in ${ART}."
import json, sys
rec, dep, chain = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), int(sys.argv[3])
txs, rcpts = rec.get("transactions", []), rec.get("receipts", [])
assert dep.get("chainId") == chain, "deployment file chain"
assert txs and len(rcpts) == len(txs), f"{len(rcpts)} receipts for {len(txs)} transactions"
bad = [r["transactionHash"] for r in rcpts if r.get("status") not in ("0x1", 1, "1")]
assert not bad, f"failed transactions: {bad}"
print(f"{len(rcpts)} transactions, all succeeded")
EOF
jq_dep() { python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d[sys.argv[2]][sys.argv[3]] if len(sys.argv) > 3 else d[sys.argv[2]])' "${NEW}" "$@"; }
for c in vault oracle spotPools makerBook perpsMarkets; do
  a="$(jq_dep contracts "${c}")"
  [ "$(cast_ro codesize "${a}" || echo 0)" -gt 0 ] || die "${c} at ${a} has no code on chain ${CHAIN}. Nothing was installed; see ${ART}."
done
VAULT="$(jq_dep contracts vault)"
same() { [ "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" ]; }
same "$(cast_ro call "${VAULT}" 'guardAdmin()(address)')" "$(setting GUARD_ADMIN)" || die "The vault's guard admin is not GUARD_ADMIN. Nothing was installed; see ${ART}."
[ "$(cast_ro call "${VAULT}" 'allowlistActive()(bool)')" = true ] && [ "$(cast_ro call "${VAULT}" 'capsActive()(bool)')" = true ] ||
  die "The vault's launch guard is not fully on. Nothing was installed; see ${ART}."
same "$(cast_ro call "$(jq_dep contracts oracle)" 'relayer()(address)')" "${RELAYER}" || die "The oracle's relayer is not the signer's PRICE_RELAY key. Nothing was installed; see ${ART}."
guardian="$(setting GUARDIAN)"
same "$(cast_ro call "$(jq_dep contracts perpsMarkets)" 'guardian()(address)')" "${guardian:-0x0000000000000000000000000000000000000000}" || die "The perps guardian is not GUARDIAN. Nothing was installed; see ${ART}."

# ── 10. Install the deployment file and DEPLOYMENTS_DIR ──────────────────────
install -d -o root -g root -m 755 "${DEP_DIR}"
if [ -e "${DEP_FILE}" ]; then cp -p "${DEP_FILE}" "${ART}/replaced-${CHAIN}.json"; fi
install_file "${DEP_FILE}" 644 root:root <"${NEW}"
backup="$(env_backup "${ENV_FILE}")"
env_set "${ENV_FILE}" DEPLOYMENTS_DIR "${DEP_DIR}"
[ "$(deployments_dir "${ENV_FILE}")" = "${DEP_DIR}" ] || die "DEPLOYMENTS_DIR did not take; restore ${backup} and check ${DEP_DIR}."
say "Installed ${DEP_FILE} (root:root 644); DEPLOYMENTS_DIR=${DEP_DIR} in ${ENV_FILE} (previous file kept as ${backup##*/}); logs in ${ART}"

# ── 11. Next steps ────────────────────────────────────────────────────────────
cat <<EOF

Velum is deployed on Robinhood Chain mainnet (guarded beta). Vault ${VAULT}.
Next steps (docs/07-mainnet-guarded-beta.md, "After the deployment"):
  1. Check every address on https://robinhoodchain.blockscout.com and keep ${ART} (root only).
  2. The price relayer ${RELAYER} and the keeper ${KEEPER} pay gas: keep each above RELAYER_MIN_BALANCE_ETH /
     KEEPER_MIN_BALANCE_ETH (docs/07, "ETH budget"). The deployer ${DEPLOYER} has no role any more: move its remaining
     ETH away, then delete ${KS} once you no longer need it.
  3. Let the signer sign on mainnet: as root, edit ${ENV_FILE} (nano) so it has ONCHAIN_WORKERS=true and
     ONCHAIN_MAINNET_CONFIRMED=yes. (If new-key.sh created a key after the last release, it is picked up by the next.)
  4. sudo bash ${BASE}/deploy/deploy.sh      (builds the web with this deployment; the signer starts relaying prices)
  5. Verify:
       curl -s --unix-socket /run/velum-api/api.sock http://velum-api/v1/deployment | cat -v; echo
       curl -s --unix-socket /run/velum-api/api.sock http://velum-api/v1/health | cat -v; echo
     onchain.ok true, onchain.relayer.lastPush a few seconds old in market hours, the relayer and keeper addresses as above.
  6. From the guard admin (the owner multisig): raise the global caps for the allowlist you plan, then allowlist the
     testers (docs/07, "Allowlisting and caps").
EOF
