#!/usr/bin/env bash
# Phase 1: put the approved prototype live with HTTPS.
# Usage (on the VPS, from the repo root):
#   sudo DOMAIN=velum.example EMAIL=you@example.com bash deploy/phase1-static.sh
# Optional: WWW=yes|no (default: auto, adds www.DOMAIN only if its DNS points at this server).
set -euo pipefail
: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=velum.example}"
: "${EMAIL:?Set EMAIL for SSL certificate notices}"
WWW="${WWW:-auto}"
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
cd "$(dirname "$0")/.."

echo "› Installing Nginx and Certbot"
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx dnsutils

# Something else (often Apache on VPS images) may already own port 80.
if ss -ltnp 'sport = :80' | grep -v -q -e nginx -e '^State'; then
  echo "Port 80 is used by another program:" >&2
  ss -ltnp 'sport = :80' >&2
  echo "Stop it first (for Apache: systemctl disable --now apache2), then run this again." >&2
  exit 1
fi

echo "› Copying the prototype"
mkdir -p /var/www/velum
cp prototype/index.html /var/www/velum/index.html
chown -R www-data:www-data /var/www/velum

echo "› Checking DNS"
SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
SERVER_IP="${SERVER_IP:-$(hostname -I | awk '{print $1}')}"
APEX_IP="$(dig +short A "${DOMAIN}" | tail -n1)"
WWW_IP="$(dig +short A "www.${DOMAIN}" | tail -n1)"
echo "  server ${SERVER_IP}, ${DOMAIN} → ${APEX_IP:-none}, www.${DOMAIN} → ${WWW_IP:-none}"
if [ "${APEX_IP}" != "${SERVER_IP}" ]; then
  echo "  Warning: ${DOMAIN} does not point at this server yet. Certbot will fail until the A record is updated." >&2
fi
DOMAINS=(-d "${DOMAIN}")
if [ "${WWW}" = "yes" ] || { [ "${WWW}" = "auto" ] && [ -n "${WWW_IP}" ] && [ "${WWW_IP}" = "${SERVER_IP}" ]; }; then
  DOMAINS+=(-d "www.${DOMAIN}")
else
  echo "  Skipping www.${DOMAIN} (no A record to this server). Add one and rerun with WWW=yes to include it."
fi

echo "› Configuring Nginx"
sed "s/velum.example/${DOMAIN}/g" deploy/nginx/velum-static.conf > /etc/nginx/sites-available/velum.conf
ln -sf /etc/nginx/sites-available/velum.conf /etc/nginx/sites-enabled/velum.conf
# Other sites (and the default site) are left alone; this server block only answers for DOMAIN.
nginx -t
systemctl enable --now nginx
systemctl reload nginx

# Firewall: only add rules if ufw is already on. Never switch it on here: on a shared server
# that could cut off ports other apps rely on.
if ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "› Firewall is on: allowing HTTP/HTTPS"
  ufw allow 'Nginx Full' || true
fi

echo "› Issuing the certificate"
certbot --nginx "${DOMAINS[@]}" -m "${EMAIL}" --agree-tos --redirect -n

echo "✓ Live at https://${DOMAIN}"
