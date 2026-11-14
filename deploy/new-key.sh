#!/usr/bin/env bash
# Create a hot-wallet key in .env without printing it; prints only the address.
#   runuser -u velum -- bash -lc 'cd /opt/velum && bash deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY'
# Never replaces an existing key. Keep each hot wallet funded with only small amounts.
set -euo pipefail
cd "$(dirname "$0")/.."
VAR="${1:?Usage: bash deploy/new-key.sh NAME_PRIVATE_KEY}"
case "${VAR}" in *_PRIVATE_KEY) ;; *) echo "The name must end with _PRIVATE_KEY" >&2; exit 1 ;; esac
[ -f .env ] || { echo "Missing .env" >&2; exit 1; }
VIEM="./apps/web/node_modules/viem/accounts"

if grep -qE "^${VAR}=0x[0-9a-fA-F]{64}$" .env; then
  echo "${VAR} is already set; keeping it."
else
  node -e '
    const { generatePrivateKey } = require(process.argv[2]);
    const fs = require("fs");
    const name = process.argv[1];
    const line = new RegExp("^" + name + "=.*$", "m");
    let s = fs.readFileSync(".env", "utf8");
    const entry = name + "=" + generatePrivateKey();
    s = line.test(s) ? s.replace(line, entry) : s.replace(/\n?$/, "\n") + entry + "\n";
    fs.writeFileSync(".env", s, { mode: 0o600 });
  ' "${VAR}" "${VIEM}"
  chmod 600 .env
  echo "Created ${VAR} in .env (not shown)."
fi
node -e '
  const { privateKeyToAccount } = require(process.argv[2]);
  const name = process.argv[1];
  const m = require("fs").readFileSync(".env", "utf8").match(new RegExp("^" + name + "=(0x[0-9a-fA-F]{64})$", "m"));
  console.log(name.replace(/_PRIVATE_KEY$/, "") + " address: " + privateKeyToAccount(m[1]).address);
' "${VAR}" "${VIEM}"
