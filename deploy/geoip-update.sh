#!/usr/bin/env bash
# Downloads DB-IP's free "IP to Country Lite" database (mmdb, CC BY 4.0; https://db-ip.com/db/lite) for the API's perps
# geoblock (GEOIP_DB in .env, apps/api/src/lib/geo.ts). The API re-reads the file when it changes, so no restart.
# Run as root once, then monthly from cron (it installs the cron entry itself with --install-cron):
#   sudo bash /srv/velum/deploy/geoip-update.sh --install-cron
# Attribution: the Terms and Risk pages credit "IP Geolocation by DB-IP", as the licence asks.
set -euo pipefail

DEST="${GEOIP_DB:-/var/lib/velum/dbip-country.mmdb}"
APP_USER="${APP_USER:-velum}"
BASE_URL="https://download.db-ip.com/free"

if [ "${1:-}" = "--install-cron" ]; then
  self="$(readlink -f "$0")"
  line="17 4 3 * * root GEOIP_DB=${DEST} bash ${self} >/var/log/velum-geoip.log 2>&1"
  printf '%s\n' "# Velum: monthly DB-IP country database for the perps geoblock" "${line}" > /etc/cron.d/velum-geoip
  chmod 644 /etc/cron.d/velum-geoip
  echo "Cron installed: /etc/cron.d/velum-geoip (03rd of each month, 04:17)."
fi

mkdir -p "$(dirname "${DEST}")"
tmp="$(mktemp -d)"
trap 'rm -rf -- "${tmp}"' EXIT
# This month's file, or last month's early in the month before DB-IP publishes the new one.
for month in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-01) -1 day" +%Y-%m)"; do
  url="${BASE_URL}/dbip-country-lite-${month}.mmdb.gz"
  if curl -fsSL --retry 3 --max-time 120 -o "${tmp}/db.mmdb.gz" "${url}"; then
    gunzip -c "${tmp}/db.mmdb.gz" > "${tmp}/db.mmdb"
    size=$(stat -c %s "${tmp}/db.mmdb")
    # A country database is several MB; anything tiny is an error page.
    if [ "${size}" -lt 1000000 ]; then echo "Downloaded file is too small (${size} bytes): not replacing ${DEST}." >&2; exit 1; fi
    install -m 644 "${tmp}/db.mmdb" "${DEST}.new"
    mv -f "${DEST}.new" "${DEST}"
    id "${APP_USER}" >/dev/null 2>&1 && chown "${APP_USER}:" "${DEST}" || true
    echo "Installed ${url} -> ${DEST} (${size} bytes)."
    exit 0
  fi
done
echo "Could not download the DB-IP country database. The API keeps the previous file (or reports the country as unknown)." >&2
exit 1
