#!/usr/bin/env bash
# Switch Velum between Robinhood Chain testnet and mainnet, then run a release. Run as root:
#   sudo bash /srv/velum/deploy/set-network.sh mainnet      (or testnet)
# Mainnet in Phase 2: real wallet, public balances and live Robinhood prices; trades simulated.
# This script never deploys contracts. Velum contracts stay off mainnet until the Phase 5 audit.
# Afterwards you may put a provider RPC (Alchemy, QuickNode, …) in RPC_URL / NEXT_PUBLIC_RPC_URL
# (edit .env as root) and run a release; the Content-Security-Policy follows NEXT_PUBLIC_RPC_URL.
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

# NEXT_PUBLIC_* values are compiled into the web build, so a release is required.
exec bash "${BASE}/deploy/deploy.sh"
