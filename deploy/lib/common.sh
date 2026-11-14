# Shared helpers for the Velum deploy scripts. Sourced (never executed) by deploy.sh, release.sh,
# server-setup.sh, set-network.sh and new-key.sh.
#
# .env format (audit L4): one KEY=VALUE per line, read as data and never evaluated by a shell.
#   - KEY is [A-Za-z_][A-Za-z0-9_]*, optionally prefixed by "export "; spaces around KEY are ignored.
#   - VALUE is everything after the first "=", verbatim: no $expansion, no escapes, no inline comments.
#     One pair of matching outer quotes ("…" or '…') is removed.
#   - Blank lines and lines starting with # are ignored. The last assignment of a key wins.
# deploy/ecosystem.config.cjs parses the file with the same rules.

say() { printf '› %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# env_get FILE KEY — prints the value of KEY (nothing when missing). Always returns 0.
env_get() {
  [ -r "$1" ] || return 0
  KEY="$2" awk '
    { sub(/\r$/, "") }
    /^[[:space:]]*#/ { next }
    {
      line = $0
      sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
      i = index(line, "=")
      if (i < 2) next
      k = substr(line, 1, i - 1)
      sub(/[[:space:]]+$/, "", k)
      if (k == ENVIRON["KEY"]) { v = substr(line, i + 1); found = 1 }
    }
    END {
      if (!found) exit 0
      n = length(v)
      if (n >= 2) {
        f = substr(v, 1, 1); l = substr(v, n, 1)
        if ((f == "\"" && l == "\"") || (f == "\047" && l == "\047")) v = substr(v, 2, n - 2)
      }
      printf "%s", v
    }' "$1"
}

# env_keys FILE — prints the valid key names assigned in FILE, one per line.
env_keys() {
  [ -r "$1" ] || return 0
  awk '
    { sub(/\r$/, "") }
    /^[[:space:]]*#/ { next }
    {
      line = $0
      sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
      i = index(line, "=")
      if (i < 2) next
      k = substr(line, 1, i - 1)
      sub(/[[:space:]]+$/, "", k)
      if (k ~ /^[A-Za-z_][A-Za-z0-9_]*$/ && !(k in seen)) { seen[k] = 1; print k }
    }' "$1"
}

# env_export FILE PATTERN... — exports only the keys matching a pattern ("NAME" or "PREFIX_*").
# Empty values are skipped. Nothing is evaluated: values are assigned literally.
env_export() {
  local file="$1" key pat v
  shift
  while IFS= read -r key; do
    for pat in "$@"; do
      # shellcheck disable=SC2254
      case "${key}" in
        ${pat})
          v="$(env_get "${file}" "${key}")"
          [ -n "${v}" ] && export "${key}=${v}"
          break
          ;;
      esac
    done
  done < <(env_keys "${file}")
}

# env_set FILE KEY VALUE [KEY VALUE …] — rewrites FILE atomically (temp file in the same
# directory, same owner and mode, then rename). The first line of each key is replaced and later
# duplicates dropped; missing keys are appended. Values pass through the environment (awk ENVIRON),
# never through a regex or the command line, so any character except a newline is safe.
env_set() {
  local file="$1" k v tmp keys=() i=0
  shift
  [ -f "${file}" ] || die "${file} does not exist."
  while [ $# -gt 0 ]; do
    k="$1"; v="${2-}"
    shift 2 || die "env_set: missing value for ${k}"
    [[ "${k}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "env_set: invalid key name ${k}"
    case "${v}" in *$'\n'* | *$'\r'*) die "The value for ${k} contains a line break." ;; esac
    export "__VELUM_SET_${i}=${v}"
    keys+=("${k}")
    i=$((i + 1))
  done
  tmp="$(mktemp "${file}.tmp.XXXXXX")"
  if ! VELUM_SET_KEYS="${keys[*]}" awk '
      BEGIN { n = split(ENVIRON["VELUM_SET_KEYS"], ks, " "); for (j = 1; j <= n; j++) idx[ks[j]] = j - 1 }
      {
        line = $0
        sub(/\r$/, "", line)
        if (line !~ /^[[:space:]]*#/) {
          k = line
          sub(/^[[:space:]]*(export[[:space:]]+)?/, "", k)
          p = index(k, "=")
          if (p > 1) {
            k = substr(k, 1, p - 1)
            sub(/[[:space:]]+$/, "", k)
            if (k in idx) {
              if (!(k in done)) { print k "=" ENVIRON["__VELUM_SET_" idx[k]]; done[k] = 1 }
              next
            }
          }
        }
        print $0
      }
      END { for (j = 1; j <= n; j++) if (!(ks[j] in done)) print ks[j] "=" ENVIRON["__VELUM_SET_" (j - 1)] }
    ' "${file}" >"${tmp}"; then
    rm -f "${tmp}"
    die "Could not rewrite ${file}."
  fi
  for ((i = 0; i < ${#keys[@]}; i++)); do unset "__VELUM_SET_${i}"; done
  chmod --reference="${file}" "${tmp}"
  chown --reference="${file}" "${tmp}" 2>/dev/null || true
  mv -f "${tmp}" "${file}"
}

# env_backup FILE — copies FILE to FILE.bak.<UTC timestamp> with the same owner and mode; prints the path.
env_backup() {
  local dst
  dst="$1.bak.$(date -u +%Y%m%d%H%M%S)"
  while [ -e "${dst}" ]; do dst="${dst}x"; done
  cp -p "$1" "${dst}"
  printf '%s' "${dst}"
}

# valid_port VALUE — true for an integer 1..65535.
valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

# url_origin URL — prints scheme://host[:port] for an https:// or wss:// URL without credentials;
# returns 1 for anything else (used for the Content-Security-Policy, so it must be strict).
url_origin() {
  [[ "$1" =~ ^(https|wss)://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?)(/[^[:space:]\"\';]*)?$ ]] || return 1
  printf '%s://%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
}

# official_rpc NETWORK — the official public RPC origin for testnet or mainnet.
official_rpc() {
  case "$1" in
    mainnet) printf 'https://rpc.mainnet.chain.robinhood.com' ;;
    *) printf 'https://rpc.testnet.chain.robinhood.com' ;;
  esac
}

# render_security_headers ENV_FILE — prints the Nginx headers snippet for the full app (audit L10).
# connect-src follows the configured network and NEXT_PUBLIC_RPC_URL. Fails on an unusable RPC URL.
render_security_headers() {
  local env_file="$1" net rpc rpc_origin official origins
  net="$(env_get "${env_file}" NEXT_PUBLIC_VELUM_NETWORK)"
  [ -n "${net}" ] || net="$(env_get "${env_file}" VELUM_NETWORK)"
  official="$(official_rpc "${net}")"
  rpc="$(env_get "${env_file}" NEXT_PUBLIC_RPC_URL)"
  origins="${official}"
  if [ -n "${rpc}" ] && [[ "${rpc}" != VERIFY* ]]; then
    rpc_origin="$(url_origin "${rpc}")" || { echo "NEXT_PUBLIC_RPC_URL must look like https://host[:port]/path (no user:password@, no spaces or quotes)." >&2; return 1; }
    [ "${rpc_origin}" = "${official}" ] || origins="${rpc_origin} ${official}"
  fi
  cat <<EOF
# Generated from .env by deploy/deploy.sh (and server-setup.sh). Do not edit: rewritten on every release.
# Included at server level and in every location that sets its own headers (add_header inheritance).
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
add_header X-Frame-Options DENY always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=(), browsing-topics=()" always;
# Empty (so not sent) over plain HTTP; see the map in velum.conf.
add_header Strict-Transport-Security \$velum_hsts always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' ${origins} https://*.walletconnect.org wss://*.walletconnect.org https://*.walletconnect.com wss://*.walletconnect.com https://api.web3modal.org https://*.coinbase.com; frame-src https://verify.walletconnect.org https://verify.walletconnect.com https://keys.coinbase.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
EOF
}

# velum_mode BASE — decides who runs what and sets APP_USER, APP_GROUP, APP_HOME, PM2_DIR, SEPARATE.
# As root: the app user (APP_USER, default velum) builds and runs the apps; root only runs git and
# the root-owned scripts, and refuses to start if the checkout is not root-owned (audit M4).
# Not root: allowed only on a checkout you own (local or single-user setups); everything runs as you.
velum_mode() {
  local base="$1" owner
  if [ "$(id -u)" -eq 0 ]; then
    APP_USER="${APP_USER:-velum}"
  else
    owner="$(stat -c %U "${base}")"
    [ "${owner}" = "$(id -un)" ] || die "This checkout belongs to ${owner}. Run as root: sudo bash ${base}/deploy/$(basename "$0") … (it builds and runs the apps as the app user)."
    [ -z "${APP_USER:-}" ] || [ "${APP_USER}" = "$(id -un)" ] || die "Only root can act as another user."
    APP_USER="$(id -un)"
  fi
  id -u "${APP_USER}" >/dev/null 2>&1 || die "User ${APP_USER} does not exist (deploy/server-setup.sh creates it)."
  APP_GROUP="$(id -gn "${APP_USER}")"
  APP_HOME="${APP_HOME:-$(getent passwd "${APP_USER}" | cut -d: -f6)}"
  [ -n "${APP_HOME}" ] || die "No home directory for ${APP_USER}."
  PM2_DIR="${APP_HOME}/.pm2"
  VELUM_BASE_DIR="${base}"
  SEPARATE=0
  if [ "$(id -u)" -eq 0 ] && [ "${APP_USER}" != "root" ]; then SEPARATE=1; fi
  if [ "$(id -u)" -eq 0 ]; then assert_root_owned_tree "${base}"; fi
}

# assert_root_owned_tree DIR — refuses when anything root runs from DIR could be changed by another
# user: every file must be owned by root and not writable by group (unless group root) or others.
# releases/ (app-owned builds root never runs), .env and its backups, and the lock file are skipped.
assert_root_owned_tree() {
  local dir="$1" bad
  bad="$(find "${dir}" -xdev \( -path "${dir}/releases" -o -path "${dir}/.env" -o -path "${dir}/.deploy.lock" -o -name '.env.bak.*' -o -name '.env.tmp*' \) -prune -o \
    ! -type l \( ! -user root -o -perm -0002 -o \( -perm -0020 ! -group root \) \) -print -quit)"
  [ -z "${bad}" ] || die "${bad} is not root-owned (or is writable by others). Root must not run files another user can change (audit M4).
  Fix: chown -R root:root ${dir}; chown root:<app group> ${dir}/.env; chmod 640 ${dir}/.env; then review git as in docs/05-deploy-vps.md (Upgrading)."
}

# as_app CMD… — runs CMD as the app user (or as you, without root) with a clean environment: nothing
# from the caller's shell, and nothing from .env, leaks into builds or PM2. Needs velum_mode first.
# VELUM_BASE tells release.sh where .env, releases/ and current live.
as_app() {
  local v app_env=("HOME=${APP_HOME}" "PATH=${PATH}" "LANG=${LANG:-C.UTF-8}" "PM2_HOME=${PM2_DIR}" "VELUM_BASE=${VELUM_BASE_DIR:-}")
  for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE \
    npm_config_registry npm_config_cafile npm_config_proxy npm_config_https_proxy npm_config_noproxy; do
    if [ -n "${!v:-}" ]; then app_env+=("${v}=${!v}"); fi
  done
  if [ "${SEPARATE}" = "1" ]; then
    (umask 027 && cd / && runuser -u "${APP_USER}" -- env -i "${app_env[@]}" "$@")
  else
    (umask 027 && env -i "${app_env[@]}" "$@")
  fi
}

# lock_deploy BASE — one deploy/set-network/new-key at a time (flock on fd 9). A child started with
# the lock already held (set-network.sh → deploy.sh, or deploy.sh re-running itself) reuses it.
lock_deploy() {
  local lock="$1/.deploy.lock"
  if [ "$(readlink "/proc/$$/fd/9" 2>/dev/null || true)" != "${lock}" ]; then
    (umask 077 && : >>"${lock}")
    exec 9>>"${lock}"
    flock -n 9 || die "Another deploy, set-network.sh or new-key.sh is running. Try again when it has finished."
  fi
}

# Environment variable names that must never sit in the PM2 daemon's own environment: PM2 cluster
# workers inherit it (Node's cluster.fork merges the primary's process.env).
SECRET_ENV_NAMES='^(DATABASE_URL|REDIS_URL|[A-Z0-9_]*_PRIVATE_KEY|[A-Z0-9_]*PASSWORD[A-Z0-9_]*|[A-Z0-9_]*SECRET[A-Z0-9_]*|ALERT_WEBHOOK_URL)$'
