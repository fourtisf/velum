#!/usr/bin/env bash
# Create a hot-wallet key in .env without printing it; prints only the address. Run as root:
#   sudo bash /srv/velum/deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY
# Never replaces a value that is already there (a valid key is kept, anything else is refused),
# backs up .env before changing it, and writes it atomically (audit L3). Keep each hot wallet
# funded with only small amounts. Takes effect for the apps on the next release (deploy.sh).
set -euo pipefail
umask 077
# A dropped SSH session must not stop a rewrite of .env halfway (R2-L6).
trap '' HUP
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
BASE="$(cd "$(dirname "${SELF}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${BASE}/deploy/lib/common.sh"
VAR="${1:-}"
[[ "${VAR}" =~ ^[A-Z][A-Z0-9_]*_PRIVATE_KEY$ ]] || die "Usage: sudo bash deploy/new-key.sh NAME_PRIVATE_KEY (upper case, ending in _PRIVATE_KEY)"
ENV_FILE="${BASE}/.env"
[ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE}."
velum_mode "${BASE}"
lock_deploy "${BASE}"

count="$(grep -c -E "^[[:space:]]*(export[[:space:]]+)?${VAR}[[:space:]]*=" "${ENV_FILE}" || true)"
current="$(env_get "${ENV_FILE}" "${VAR}")"
if [ "${count}" -gt 1 ]; then
  die "${VAR} is set on ${count} lines in .env. Keep the one you want, delete the others by hand, then re-run. Nothing was changed."
elif [[ "${current}" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "${VAR} is already set; keeping it."
elif [ -n "${current}" ]; then
  die "${VAR} already has a value that is not a key (0x + 64 hex digits). Refusing to replace it: fix or empty it by hand. Nothing was changed."
else
  # 32 random bytes below the secp256k1 group order, from Node's CSPRNG (no third-party code as root).
  key="$(node -e '
    const { randomBytes } = require("crypto");
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    let k = 0n;
    while (k === 0n || k >= n) k = BigInt("0x" + randomBytes(32).toString("hex"));
    process.stdout.write("0x" + k.toString(16).padStart(64, "0"));')"
  [[ "${key}" =~ ^0x[0-9a-f]{64}$ ]] || die "Key generation failed. Nothing was changed."
  backup="$(env_backup "${ENV_FILE}")"
  env_set "${ENV_FILE}" "${VAR}" "${key}"
  [ "$(env_get "${ENV_FILE}" "${VAR}")" = "${key}" ] || die "Writing .env failed; restore ${backup}."
  unset key
  echo "Created ${VAR} in .env (not shown). Previous .env kept as ${backup##*/}."
fi

# The address comes from viem in the app's own install, run as the app user (root never runs it).
dir=""
for d in "${BASE}/current/apps/api" "${BASE}/apps/api"; do
  if [ -d "${d}/node_modules/viem" ]; then dir="${d}"; break; fi
done
if [ -z "${dir}" ]; then
  echo "Run a release (deploy.sh), then run this again to see the address."
  exit 0
fi
env_get "${ENV_FILE}" "${VAR}" | as_app node -e '
  const { privateKeyToAccount } = require(require.resolve("viem/accounts", { paths: [process.argv[1]] }));
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    console.log(process.argv[2] + " address: " + privateKeyToAccount(s.trim()).address);
  });' "${dir}" "${VAR%_PRIVATE_KEY}"
