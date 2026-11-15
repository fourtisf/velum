#!/usr/bin/env bash
# Writes a runnable Nginx config for the web's end-to-end tests from the repository's own
# deploy/nginx/velum.conf and the CSP that deploy/lib/common.sh renders for testnet, with one change: the
# local RPC origin (a loopback anvil) is added to connect-src, since a production CSP only allows https RPCs.
# Usage: nginx.sh <repo root> <nginx dir> <listen port> <web port> <api port> [local rpc origin]
# E2E_NETWORK=mainnet renders the mainnet CSP (with E2E_WC_PROJECT_ID, the WalletConnect hosts); E2E_API_HEADER
# adds one proxy_set_header line to API requests (the route sweep's stub API reads the network from it).
set -eu
R="$1"; N="$2"; LISTEN="$3"; WEBP="$4"; APIP="$5"; LOCAL_RPC="${6:-}"
mkdir -p "${N}"/{snippets,logs,cache,tmp}
# shellcheck source=/dev/null
. "${R}/deploy/lib/common.sh"
printf 'NEXT_PUBLIC_VELUM_NETWORK=%s\n' "${E2E_NETWORK:-testnet}" >"${N}/env"
[ -z "${E2E_WC_PROJECT_ID:-}" ] || printf 'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=%s\n' "${E2E_WC_PROJECT_ID}" >>"${N}/env"
render_security_headers "${N}/env" >"${N}/snippets/velum-security-headers.conf"
if [ -n "${LOCAL_RPC}" ]; then
  sed -i "s#connect-src 'self' #connect-src 'self' ${LOCAL_RPC} #" "${N}/snippets/velum-security-headers.conf"
fi
# Plain HTTP here: HSTS stays empty (the map in velum.conf), as on a server before Certbot.
printf 'proxy_set_header X-Velum-Proxy-Secret "%s";\n' 0123456789abcdef0123456789abcdef >"${N}/snippets/velum-proxy-secret.conf"
[ -z "${E2E_API_HEADER:-}" ] || printf 'proxy_set_header %s;\n' "${E2E_API_HEADER}" >>"${N}/snippets/velum-proxy-secret.conf"
printf 'server 127.0.0.1:%s;\n' "${APIP}" >"${N}/snippets/velum-api-upstream.conf"
sed -e "s#listen \[::\]:80;##" -e "s#listen 80;#listen 127.0.0.1:${LISTEN};#" \
    -e "s#server 127.0.0.1:3000;#server 127.0.0.1:${WEBP};#" \
    -e "s#/var/cache/nginx/velum#${N}/cache/velum#" \
    -e "s#include snippets/#include ${N}/snippets/#g" \
    "${R}/deploy/nginx/velum.conf" | sed "s/server_name velum.example;/server_name velum.example 127.0.0.1;/" >"${N}/velum.conf"
cat >"${N}/nginx.conf" <<CONF
worker_processes 1;
$( [ "$(id -u)" = 0 ] && echo 'user root;' )
pid ${N}/nginx.pid;
error_log ${N}/logs/error.log warn;
events { worker_connections 256; }
http {
  include /etc/nginx/mime.types;
  access_log ${N}/logs/access.log;
  client_body_temp_path ${N}/tmp/body; proxy_temp_path ${N}/tmp/proxy; fastcgi_temp_path ${N}/tmp/fcgi; uwsgi_temp_path ${N}/tmp/uwsgi; scgi_temp_path ${N}/tmp/scgi;
  include ${N}/velum.conf;
}
CONF
nginx -p "${N}" -c "${N}/nginx.conf" -t 2>&1 | tail -1
grep -o "connect-src[^;]*" "${N}/snippets/velum-security-headers.conf"
