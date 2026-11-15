#!/usr/bin/env bash
# Create a hot-wallet key for the signer without printing it; prints only the address. Run as root:
#   sudo bash /srv/velum/deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY      (or KEEPER_PRIVATE_KEY)
# The key goes into the signer's keys file (SIGNER_KEYS_FILE, default /etc/velum/signer-keys.env, root:<signer group>
# 640), never into .env: the app user (api + workers) can read .env, the signer user alone can read the keys file
# (on-chain audit M-2). Never replaces a value that is already there (a valid key is kept, anything else is refused),
# backs the file up before changing it (root:root 600) and writes it atomically (audit L3). Keep each hot wallet
# funded with only small amounts. Takes effect on the next release (deploy.sh restarts the signer).
# shellcheck disable=SC2015 # "A && B || die" is the intended idiom here: die exits.
set -euo pipefail
umask 077
# A dropped SSH session must not stop a rewrite of the keys file halfway (R2-L6).
trap '' HUP
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
BASE="$(cd "$(dirname "${SELF}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${BASE}/deploy/lib/common.sh"
VAR="${1:-}"
case " ${SIGNER_HOT_KEYS} " in
  *" ${VAR} "*) ;;
  *) die "Usage: sudo bash deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY|KEEPER_PRIVATE_KEY (the signer's two keys)" ;;
esac
ENV_FILE="${BASE}/.env"
[ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE}."
velum_mode "${BASE}"
[ "${SEPARATE}" = 1 ] || die "Run as root: the key goes into a file only root writes and only the signer user reads."
lock_deploy "${BASE}"
# A key still in .env (an older layout) is moved by server-setup.sh first; a second, different key would then conflict.
[ -z "$(hot_keys_in "${ENV_FILE}")" ] || die "${ENV_FILE} still holds $(hot_keys_in "${ENV_FILE}" | tr '\n' ' ')(readable by ${APP_USER}). Run server-setup.sh first: it moves them into ${SIGNER_KEYS_FILE}. Nothing was changed."
ensure_signer_keys_file

count="$(grep -c -E "^[[:space:]]*(export[[:space:]]+)?${VAR}[[:space:]]*=" "${SIGNER_KEYS_FILE}" || true)"
current="$(env_get "${SIGNER_KEYS_FILE}" "${VAR}")"
other=""
for k in ${SIGNER_HOT_KEYS}; do [ "${k}" = "${VAR}" ] || other="$(env_get "${SIGNER_KEYS_FILE}" "${k}")"; done
if [ "${count}" -gt 1 ]; then
  die "${VAR} is set on ${count} lines in ${SIGNER_KEYS_FILE}. Keep the one you want, delete the others by hand, then re-run. Nothing was changed."
elif [[ "${current}" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "${VAR} is already set in ${SIGNER_KEYS_FILE}; keeping it."
elif [ -n "${current}" ]; then
  die "${VAR} already has a value in ${SIGNER_KEYS_FILE} that is not a key (0x + 64 hex digits). Refusing to replace it: fix or empty it by hand. Nothing was changed."
else
  # 32 random bytes below the secp256k1 group order, from Node's CSPRNG (no third-party code as root).
  key="$(node -e '
    const { randomBytes } = require("crypto");
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    let k = 0n;
    while (k === 0n || k >= n) k = BigInt("0x" + randomBytes(32).toString("hex"));
    process.stdout.write("0x" + k.toString(16).padStart(64, "0"));')"
  [[ "${key}" =~ ^0x[0-9a-f]{64}$ ]] && [ "${key}" != "${other,,}" ] || die "Key generation failed. Nothing was changed."
  backup="$(env_backup "${SIGNER_KEYS_FILE}")"
  env_set "${SIGNER_KEYS_FILE}" "${VAR}" "${key}"
  [ "$(env_get "${SIGNER_KEYS_FILE}" "${VAR}")" = "${key}" ] || die "Writing ${SIGNER_KEYS_FILE} failed; restore ${backup}."
  unset key
  chown "root:${SIGNER_GROUP}" "${SIGNER_KEYS_FILE}"
  chmod 640 "${SIGNER_KEYS_FILE}"
  echo "Created ${VAR} in ${SIGNER_KEYS_FILE} (not shown; root:${SIGNER_GROUP} 640). Previous file kept as ${backup##*/} (root only)."
fi
unset other

# The address comes from viem in the signer's own build, run as the signer user (the key's only reader; never the app
# user, never root running third-party code). Before the first release with ONCHAIN_WORKERS=true there is no build yet.
dir="${SIGNER_HOME}/current/apps/workers"
if ! as_signer test -d "${dir}/node_modules/viem" >/dev/null 2>&1; then
  echo "Run a release with ONCHAIN_WORKERS=true (deploy.sh builds the signer's own copy), then run this again to see the address."
  exit 0
fi
env_get "${SIGNER_KEYS_FILE}" "${VAR}" | as_signer node -e '
  const { privateKeyToAccount } = require(require.resolve("viem/accounts", { paths: [process.argv[1]] }));
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    console.log(process.argv[2] + " address: " + privateKeyToAccount(s.trim()).address);
  });' "${dir}" "${VAR%_PRIVATE_KEY}"
