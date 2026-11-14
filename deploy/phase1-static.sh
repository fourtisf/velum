#!/usr/bin/env bash
# Phase 1: put the approved prototype live with HTTPS.
# Usage (on the VPS, from the repo root):
#   sudo DOMAIN=velum.example EMAIL=you@example.com bash deploy/phase1-static.sh
set -euo pipefail
: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=velum.example}"
: "${EMAIL:?Set EMAIL for SSL certificate notices}"
cd "$(dirname "$0")/.."

apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx ufw

mkdir -p /var/www/velum
cp prototype/index.html /var/www/velum/index.html
chown -R www-data:www-data /var/www/velum

sed "s/velum.example/${DOMAIN}/g" deploy/nginx/velum-static.conf > /etc/nginx/sites-available/velum.conf
ln -sf /etc/nginx/sites-available/velum.conf /etc/nginx/sites-enabled/velum.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

ufw allow OpenSSH || true
ufw allow 'Nginx Full' || true
ufw --force enable || true

certbot --nginx -d "${DOMAIN}" -d "www.${DOMAIN}" -m "${EMAIL}" --agree-tos --redirect -n

echo "✓ Live at https://${DOMAIN}"
