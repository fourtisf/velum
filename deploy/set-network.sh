#!/usr/bin/env bash
# Switch Velum between Robinhood Chain testnet and mainnet, then run a release. Run as root:
#   sudo bash /srv/velum/deploy/set-network.sh mainnet      (or testnet)
# Mainnet in Phase 2: real wallet, public balances and live Robinhood prices; trades simulated.
# This script never deploys contracts. Velum contracts stay off mainnet until the Phase 5 audit.
# Afterwards you may put a provider RPC (Alchemy, QuickNode, …) in RPC_URL / NEXT_PUBLIC_RPC_URL
# (edit .env as root) and run a release; the Content-Security-Policy follows NEXT_PUBLIC_RPC_URL.
# A failed release leaves the previous network in place: .env, web.env and the running release.
set -euo pipefail
umask 077
# A dropped SSH session must not stop a rewrite of .env halfway (R2-L6).
trap '' HUP
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
BASE="$(cd "$(dirname "${SELF}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${BASE}/deploy/lib/common.sh"
NET="${1:-}"
# Mainnet uses live official Robinhood quotes; testnet keeps simulated prices (PRICE_SOURCE=demo).
case "${NET}" in
  mainnet) CHAIN_ID=4663;  RPC=https://rpc.mainnet.chain.robinhood.com; EXPLORER=https://robinhoodchain.blockscout.com; SRC=robinhood ;;
  testnet) CHAIN_ID=46630; RPC=https://rpc.testnet.chain.robinhood.com; EXPLORER=https://explorer.testnet.chain.robinhood.com; SRC=demo ;;
  *) die "Usage: sudo bash deploy/set-network.sh mainnet|testnet" ;;
esac
ENV_FILE="${BASE}/.env"
[ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE}."
velum_mode "${BASE}"
# The same lock as deploy.sh, held through the release below (deploy.sh inherits it).
lock_deploy "${BASE}"
# A hot key still in .env (on-chain audit M-2): server-setup.sh moves it first. Checked before .env is touched, so the
# failure path below (restore_env_backup, which never brings a key back into .env) cannot drop it (final deploy audit S-1).
[ -z "$(hot_keys_in "${ENV_FILE}")" ] || die "${ENV_FILE} still holds $(hot_keys_in "${ENV_FILE}" | tr '\n' ' ')(readable by ${APP_USER}). Run server-setup.sh once: it moves them into ${SIGNER_KEYS_FILE}. Nothing was changed."

before="$(readlink "${BASE}/current" 2>/dev/null || true)"
backup="$(env_backup "${ENV_FILE}")"
# One atomic rewrite (temp file + rename, owner and mode kept); values are never parsed by sed.
env_set "${ENV_FILE}" \
  VELUM_NETWORK "${NET}" \
  NEXT_PUBLIC_VELUM_NETWORK "${NET}" \
  CHAIN_ID "${CHAIN_ID}" \
  NEXT_PUBLIC_CHAIN_ID "${CHAIN_ID}" \
  RPC_URL "${RPC}" \
  NEXT_PUBLIC_RPC_URL "${RPC}" \
  NEXT_PUBLIC_EXPLORER_URL "${EXPLORER}" \
  PRICE_SOURCE "${SRC}"
say ".env now targets ${NET} (chain ${CHAIN_ID}, prices: ${SRC}); previous file kept as ${backup##*/}"

# NEXT_PUBLIC_* values are compiled into the web build, so a release is required. If it fails, the
# running release must keep the .env it was built with (audit R3-04): deploy.sh puts this backup back
# before it switches back to the previous release, and if nothing was switched it is put back here.
if VELUM_ENV_RESTORE="${backup}" bash "${BASE}/deploy/deploy.sh"; then exit 0; fi
if [ "$(readlink "${BASE}/current" 2>/dev/null || true)" = "${before}" ]; then
  if ! cmp -s "${backup}" "${ENV_FILE}"; then
    restore_env_backup "${backup}"
    if [ "${SEPARATE}" = 1 ]; then
      render_web_env "${ENV_FILE}" | install_file "${BASE}/web.env" 640 "root:${WEB_GROUP}"
      render_signer_env "${ENV_FILE}" | install_file "${BASE}/signer.env" 640 "root:${SIGNER_GROUP}"
    fi
  fi
  die "Switching to ${NET} failed; ${ENV_FILE} is back to its previous network (${backup##*/}) and the running release is unchanged. See the messages above."
fi
die "Switching to ${NET} failed after the new release went live; see the messages above (deploy.sh says which release runs and with which settings)."
