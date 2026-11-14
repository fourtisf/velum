#!/usr/bin/env bash
# Switch Velum between Robinhood Chain testnet and mainnet, then rebuild and reload.
#   runuser -u velum -- bash -lc 'cd /opt/velum && bash deploy/set-network.sh mainnet'
# Mainnet in Phase 2: real wallet, public balances and live Robinhood prices; trades simulated.
# This script never deploys contracts. Velum contracts stay off mainnet until the Phase 5 audit.
# Afterwards you may put a provider RPC (Alchemy, QuickNode, …) in RPC_URL / NEXT_PUBLIC_RPC_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
NET="${1:-}"
# Mainnet uses live official Robinhood quotes; testnet keeps simulated prices (PRICE_SOURCE=demo).
case "${NET}" in
  mainnet) CHAIN_ID=4663;  RPC=https://rpc.mainnet.chain.robinhood.com; EXPLORER=https://robinhoodchain.blockscout.com; SRC=robinhood ;;
  testnet) CHAIN_ID=46630; RPC=https://rpc.testnet.chain.robinhood.com; EXPLORER=https://explorer.testnet.chain.robinhood.com; SRC=demo ;;
  *) echo "Usage: bash deploy/set-network.sh mainnet|testnet" >&2; exit 1 ;;
esac
[ -f .env ] || { echo "Missing .env" >&2; exit 1; }

set_key() {
  if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
set_key VELUM_NETWORK "${NET}"
set_key NEXT_PUBLIC_VELUM_NETWORK "${NET}"
set_key CHAIN_ID "${CHAIN_ID}"
set_key NEXT_PUBLIC_CHAIN_ID "${CHAIN_ID}"
set_key RPC_URL "${RPC}"
set_key NEXT_PUBLIC_RPC_URL "${RPC}"
set_key NEXT_PUBLIC_EXPLORER_URL "${EXPLORER}"
set_key PRICE_SOURCE "${SRC}"
chmod 600 .env
echo "› .env now targets ${NET} (chain ${CHAIN_ID}, prices: ${SRC}); previous file kept as .env.bak.*"

# NEXT_PUBLIC_* values are compiled into the web build, so a release is required.
bash deploy/deploy.sh
