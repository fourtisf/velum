# shellcheck shell=bash disable=SC2015,SC2034 # "A && B || die" is intended (die exits); globals are read by the sourcing scripts.
# Shared helpers for the Velum deploy scripts. Sourced (never executed) by deploy.sh, release.sh,
# server-setup.sh, import-env.sh, set-network.sh and new-key.sh.
#
# .env format (audit L4): one KEY=VALUE per line, read as data and never evaluated by a shell.
#   - KEY is [A-Za-z_][A-Za-z0-9_]*, optionally prefixed by "export "; spaces around KEY are ignored.
#   - VALUE is everything after the first "=", verbatim: no $expansion, no escapes, no inline comments.
#     One pair of matching outer quotes ("…" or '…') is removed.
#   - Blank lines and lines starting with # are ignored. The last assignment of a key wins.
# deploy/ecosystem.config.cjs parses the file with the same rules.
#
# Who may do what (audit M4, R2-H1, R2-M3), when run as root:
#   - root runs only root-owned files from the base (git checkout), runs git with hooks and fsmonitor
#     disabled (root_git), and writes only paths it owns (the base, /etc/nginx, systemd units);
#   - the app user (APP_USER, default velum) builds releases and runs api + workers;
#   - the web user (WEB_USER, default velum-web) only runs the web, from read-only release files,
#     with a root-rendered web.env that holds no secret, in its own PM2 daemon;
#   - anything under a user's home, PM2 home or release directory is touched only as that user
#     (as_app / as_web), so a symbolic link planted there can never redirect a root write.

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
  [ -f "${file}" ] && [ ! -L "${file}" ] || die "${file} does not exist (or is a symbolic link)."
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

# env_backup FILE — copies FILE to FILE.bak.<UTC timestamp>, owner-only (root:root 600 as root), and
# keeps only the newest ENV_BACKUPS_KEEP (default 3) backups, fixing the mode of older ones too
# (audit R2-I3). Prints the path of the new backup.
env_backup() {
  local f="$1" dst keep="${ENV_BACKUPS_KEEP:-3}"
  [ -f "$f" ] && [ ! -L "$f" ] || die "$f does not exist (or is a symbolic link)."
  dst="$f.bak.$(date -u +%Y%m%d%H%M%S)"
  while [ -e "${dst}" ] || [ -L "${dst}" ]; do dst="${dst}x"; done
  (umask 077 && cp -- "$f" "${dst}")
  env_backups_tidy "$f" "${keep}"
  printf '%s' "${dst}"
}
# env_backups_tidy FILE [KEEP] — owner-only modes on FILE.bak.*, then removes all but the newest KEEP.
env_backups_tidy() {
  local f="$1" keep="${2:-${ENV_BACKUPS_KEEP:-3}}" dir name b
  dir="$(dirname "$f")"; name="$(basename "$f")"
  [[ "${keep}" =~ ^[0-9]+$ ]] && [ "${keep}" -ge 1 ] || keep=3
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    if [ "$(id -u)" -eq 0 ]; then chown root:root -- "${dir}/${b}"; fi
    chmod 600 -- "${dir}/${b}"
  done < <(find "${dir}" -maxdepth 1 -type f -name "${name}.bak.*" -printf '%f\n')
  while IFS= read -r b; do
    [ -n "$b" ] && rm -f -- "${dir:?}/${b}"
  done < <(find "${dir}" -maxdepth 1 -type f -name "${name}.bak.*" -printf '%f\n' | sort -r | tail -n +"$((keep + 1))")
}

# install_file DST MODE OWNER:GROUP — replaces DST atomically with stdin (temp file in DST's
# directory, mode and owner set before the rename). Refuses a DST that is a symbolic link. Used only
# for root-managed paths (the base, /etc/nginx), never for paths another user can write.
install_file() {
  local dst="$1" mode="$2" owner="$3" tmp
  [ ! -L "${dst}" ] || die "${dst} is a symbolic link; refusing to write through it."
  tmp="$(mktemp "$(dirname "${dst}")/.$(basename "${dst}").XXXXXX")" || die "Cannot write next to ${dst}."
  if ! cat >"${tmp}"; then rm -f "${tmp}"; die "Could not write ${dst}."; fi
  chmod "${mode}" "${tmp}"
  if [ "$(id -u)" -eq 0 ]; then chown "${owner}" "${tmp}"; fi
  mv -f "${tmp}" "${dst}"
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

# Third-party hosts the wallet SDKs really use, read from the installed packages (audit R2-I2, N3).
# Re-check them when wagmi, @coinbase/wallet-sdk, @walletconnect/* or @reown/appkit* change version.
#  - Coinbase Wallet SDK 4.3.6 (wagmi coinbaseWallet, always offered; core/constants.js): WalletLink
#    relay https://www.walletlink.org (HTTP events) and wss://www.walletlink.org/rpc, wallet RPC
#    https://rpc.wallet.coinbase.com. keys.coinbase.com opens as a popup window, not a frame, and the
#    web turns telemetry off (no cca-lite/as.coinbase.com).
CSP_COINBASE_CONNECT='https://www.walletlink.org wss://www.walletlink.org https://rpc.wallet.coinbase.com'
#  - WalletConnect 2.21.1 (@walletconnect/core: relay, Verify API iframe + attestation fetch, pulse
#    events) and Reown AppKit 1.7.8, the QR modal (appkit-common ConstantsUtil: blockchain API,
#    api.web3modal.org wallet list and images fetched as blobs, secure.walletconnect.org W3mFrame;
#    appkit-ui ThemeUtil imports the Inter font from Google Fonts). Added only with a project ID.
CSP_WC_CONNECT='wss://relay.walletconnect.org https://rpc.walletconnect.org https://pulse.walletconnect.org https://api.web3modal.org https://verify.walletconnect.org https://verify.walletconnect.com'
CSP_WC_FRAME='https://verify.walletconnect.org https://verify.walletconnect.com https://secure.walletconnect.org'
CSP_WC_STYLE='https://fonts.googleapis.com'
CSP_WC_FONT='https://fonts.gstatic.com'
CSP_WC_IMG='blob:'

# render_security_headers ENV_FILE — prints the Nginx headers snippet for the full app (audit L10).
# connect-src follows the configured network and NEXT_PUBLIC_RPC_URL; WalletConnect hosts appear only
# when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set. Fails on an unusable RPC URL.
render_security_headers() {
  local env_file="$1" net rpc rpc_origin official origins connect frame="'none'" style="'self' 'unsafe-inline'" font="'self'" img="'self' data: https:"
  net="$(env_get "${env_file}" NEXT_PUBLIC_VELUM_NETWORK)"
  [ -n "${net}" ] || net="$(env_get "${env_file}" VELUM_NETWORK)"
  official="$(official_rpc "${net}")"
  rpc="$(env_get "${env_file}" NEXT_PUBLIC_RPC_URL)"
  origins="${official}"
  if [ -n "${rpc}" ] && [[ "${rpc}" != VERIFY* ]]; then
    rpc_origin="$(url_origin "${rpc}")" || { echo "NEXT_PUBLIC_RPC_URL must look like https://host[:port]/path (no user:password@, no spaces or quotes)." >&2; return 1; }
    [ "${rpc_origin}" = "${official}" ] || origins="${rpc_origin} ${official}"
  fi
  connect="'self' ${origins} ${CSP_COINBASE_CONNECT}"
  if [ -n "$(env_get "${env_file}" NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID)" ]; then
    connect="${connect} ${CSP_WC_CONNECT}"
    frame="${CSP_WC_FRAME}"
    style="${style} ${CSP_WC_STYLE}"
    font="${font} ${CSP_WC_FONT}"
    img="${img} ${CSP_WC_IMG}"
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
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src ${style}; img-src ${img}; font-src ${font}; connect-src ${connect}; frame-src ${frame}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
EOF
}

# proxy_secret_include VALUE / render_proxy_secret ENV_FILE — print the Nginx include that adds the
# proxy secret to requests proxied to the API (audit R2-I4). Root-only file (0600): the Nginx master
# reads its configuration as root.
proxy_secret_include() {
  [[ "$1" =~ ^[0-9a-fA-F]{32,128}$ ]] || { echo "PROXY_SECRET must be 32 to 128 hex characters (server-setup.sh generates it)." >&2; return 1; }
  printf '# Generated from .env (PROXY_SECRET) by deploy/deploy.sh and server-setup.sh. Root-only. Do not edit.\n'
  printf '# The API trusts X-Real-IP only on requests that carry this header (apps/api/src/lib/client-address.ts).\n'
  printf 'proxy_set_header X-Velum-Proxy-Secret "%s";\n' "$1"
}
render_proxy_secret() { proxy_secret_include "$(env_get "$1" PROXY_SECRET)"; }

# Variables the web may see (audit M5, R2-M3). Keep in sync with ALLOW['velum-web'] in
# deploy/ecosystem.config.cjs. None of them is a secret: NEXT_PUBLIC_* is compiled into the browser bundle.
WEB_ENV_KEYS='NODE_ENV PORT_WEB PUBLIC_SITE_URL'
WEB_ENV_PREFIX='NEXT_PUBLIC_'

# render_web_env ENV_FILE — prints the web's environment file (root renders it to <base>/web.env,
# root:<web group> 640; the web user cannot read .env). Every value is wrapped in double quotes, which
# the KEY=VALUE parser removes again, so values round-trip exactly.
render_web_env() {
  local env_file="$1" k v
  printf '# Generated from .env by deploy/deploy.sh (and server-setup.sh) for the web only. Do not edit.\n'
  while IFS= read -r k; do
    case " ${WEB_ENV_KEYS} " in
      *" ${k} "*) ;;
      *) [[ "${k}" == "${WEB_ENV_PREFIX}"* ]] || continue ;;
    esac
    v="$(env_get "${env_file}" "${k}")"
    [ -n "${v}" ] && printf '%s="%s"\n' "${k}" "${v}"
  done < <(env_keys "${env_file}")
}

# user_home USER — prints USER's home directory after checking it is an absolute, real (not a
# symbolic link) directory owned by USER. Root never writes inside it; it only passes it as HOME.
user_home() {
  local u="$1" h
  h="$(getent passwd "${u}" | cut -d: -f6)"
  [[ "${h}" == /?* ]] || die "User ${u} has no usable home directory (${h:-none})."
  [ -d "${h}" ] && [ ! -L "${h}" ] || die "The home directory ${h} of ${u} is missing or is a symbolic link."
  [ "$(stat -c %u "${h}")" = "$(id -u "${u}")" ] || die "The home directory ${h} is not owned by ${u}."
  printf '%s' "${h}"
}

# velum_mode BASE — decides who runs what. Sets APP_USER/APP_GROUP/APP_HOME/PM2_DIR, WEB_USER/WEB_HOME,
# APP_SCOPE, SEPARATE and VELUM_BASE_DIR.
# As root: velum builds and runs api + workers, velum-web runs the web (audit R2-M3); root only runs git
# and the root-owned scripts, and refuses to start if the base is not safe (assert_root_owned_tree).
# Not root: allowed only on a checkout you own (local or single-user setups); everything runs as you.
velum_mode() {
  local base="$1" owner
  VELUM_BASE_DIR="${base}"
  if [ "$(id -u)" -eq 0 ]; then
    APP_USER="${APP_USER:-velum}"
    WEB_USER="${WEB_USER:-velum-web}"
    [ "${APP_USER}" != root ] && [ "${WEB_USER}" != root ] || die "APP_USER and WEB_USER must not be root."
    [ "${APP_USER}" != "${WEB_USER}" ] || die "APP_USER and WEB_USER must be different users."
    SEPARATE=1
    APP_SCOPE=backend
    assert_root_owned_tree "${base}"
  else
    owner="$(stat -c %U "${base}")"
    [ "${owner}" = "$(id -un)" ] || die "This checkout belongs to ${owner}. Run as root: sudo bash ${base}/deploy/$(basename "$0") … (it builds and runs the apps as the app users)."
    [ -z "${APP_USER:-}" ] || [ "${APP_USER}" = "$(id -un)" ] || die "Only root can act as another user."
    APP_USER="$(id -un)"
    WEB_USER="${APP_USER}"
    SEPARATE=0
    APP_SCOPE=all
  fi
  id -u "${APP_USER}" >/dev/null 2>&1 || die "User ${APP_USER} does not exist (deploy/server-setup.sh creates it)."
  id -u "${WEB_USER}" >/dev/null 2>&1 || die "User ${WEB_USER} does not exist (deploy/server-setup.sh creates it)."
  APP_GROUP="$(id -gn "${APP_USER}")"
  WEB_GROUP="$(id -gn "${WEB_USER}")"
  APP_HOME="$(user_home "${APP_USER}")"
  WEB_HOME="$(user_home "${WEB_USER}")"
  PM2_DIR="${APP_HOME}/.pm2"
  WEB_PM2_DIR="${WEB_HOME}/.pm2"
  if [ "${SEPARATE}" = 1 ]; then
    # The web user must not share the app group: that group can read .env (audit R2-M3).
    if id -nG "${WEB_USER}" | tr ' ' '\n' | grep -qxF "${APP_GROUP}"; then die "${WEB_USER} is in group ${APP_GROUP}, which can read .env. Remove it: gpasswd -d ${WEB_USER} ${APP_GROUP}"; fi
  fi
}

# Symbolic links allowed in the base: the release pointers deploy.sh switches (and their temp names).
VELUM_LINKS='current previous .current.new .previous.new'

# assert_root_owned_tree DIR — refuses when anything root runs or reads from DIR could be changed by
# another user (audit M4, R2-H2): every file must be owned by root and not writable by group (unless
# group root) or others; there must be no symbolic link except the release pointers (which must point
# at releases/<name>); releases/ must be a real root-owned directory; .git must be a real directory
# whose config passes assert_git_config. releases/<name>/ (app-owned builds root never runs) is skipped.
assert_root_owned_tree() {
  local dir="$1" bad l p t prune=()
  [ -d "${dir}" ] && [ ! -L "${dir}" ] || die "${dir} must be a real directory."
  prune=(-path "${dir}/releases")
  for l in ${VELUM_LINKS}; do prune+=(-o -path "${dir}/${l}"); done
  bad="$(find "${dir}" -xdev \( "${prune[@]}" \) -prune -o -type l -print -quit)"
  [ -z "${bad}" ] || die "${bad} is a symbolic link. Root does not follow links in ${dir} (audit R2-H2). $(fresh_clone_hint "${dir}")"
  bad="$(find "${dir}" -xdev \( "${prune[@]}" \) -prune -o \( ! -user root -o -perm -0002 -o \( -perm -0020 ! -group root \) \) -print -quit)"
  [ -z "${bad}" ] || die "${bad} is not root-owned (or is writable by others). Root must not run files another user can change (audit M4). $(fresh_clone_hint "${dir}")"
  if [ -e "${dir}/releases" ] || [ -L "${dir}/releases" ]; then
    p="${dir}/releases"
    [ -d "${p}" ] && [ ! -L "${p}" ] && [ "$(stat -c %u "${p}")" = 0 ] && [ -z "$(find "${p}" -maxdepth 0 \( -perm -0002 -o \( -perm -0020 ! -group root \) \))" ] ||
      die "${p} must be a real root-owned directory that only root can write."
  fi
  for l in ${VELUM_LINKS}; do
    p="${dir}/${l}"
    if [ -e "${p}" ] || [ -L "${p}" ]; then
      [ -L "${p}" ] && [ "$(stat -c %u "${p}")" = 0 ] || die "${p} must be a root-owned symbolic link made by deploy.sh."
      t="$(readlink "${p}")"
      [[ "${t}" =~ ^releases/[A-Za-z0-9._-]+$ ]] || die "${p} points at ${t}; it may only point at releases/<name>."
    fi
  done
  assert_git_config "${dir}"
}

fresh_clone_hint() { printf 'Make a fresh root-owned clone instead of repairing this tree (docs/05-deploy-vps.md, "Upgrading").'; }

# valid_branch NAME / valid_repo_url URL — strict shapes for what may appear in .git/config.
valid_branch() { [[ "$1" =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ ]] && [[ "$1" != *..* ]]; }
valid_repo_url() {
  [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._~/-]+$ ]] ||
    [[ "$1" =~ ^ssh://[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._~/-]+$ ]] ||
    [[ "$1" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~][A-Za-z0-9._~/-]*$ ]] ||
    [[ "$1" =~ ^/[A-Za-z0-9._~/-]+$ ]]
}

# assert_git_config DIR — .git must be a real directory (not a link or a "gitdir:" file) whose config
# holds exactly what `git clone` writes and nothing else (audit R2-H2): core.repositoryformatversion=0,
# core.filemode=true, core.bare=false, core.logallrefupdates=true, one remote.origin.url (https without
# credentials, ssh, or a local path), remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*, and
# branch.<B>.remote=origin / branch.<B>.merge=refs/heads/<B>. Includes, hooksPath, fsmonitor,
# sshCommand, insteadOf, filters, helpers… are all refused because they are not on the list.
assert_git_config() {
  local dir="$1" cfg="$1/.git/config" tmp rec key val b f urls=0 fetches=0 ok bad=""
  [ -d "${dir}/.git" ] && [ ! -L "${dir}/.git" ] || die "${dir}/.git must be a real directory (a clone made by root), not a file or a link. $(fresh_clone_hint)"
  [ -f "${cfg}" ] && [ ! -L "${cfg}" ] || die "${cfg} is missing or not a regular file."
  for f in commondir objects/info/alternates; do
    [ ! -e "${dir}/.git/${f}" ] || die "${dir}/.git/${f} points git at another directory; root will not use this clone. $(fresh_clone_hint)"
  done
  tmp="$(mktemp)"
  if ! git config -z --file "${cfg}" --no-includes --list >"${tmp}" 2>/dev/null; then rm -f "${tmp}"; die "${cfg} cannot be parsed. $(fresh_clone_hint)"; fi
  while IFS= read -r -d '' rec; do
    key="${rec%%$'\n'*}"
    if [[ "${rec}" == *$'\n'* ]]; then val="${rec#*$'\n'}"; else val=$'\001'; fi
    ok=0
    case "${key}" in
      core.repositoryformatversion) [ "${val}" = 0 ] && ok=1 ;;
      core.filemode) [ "${val}" = true ] && ok=1 ;;
      core.bare) [ "${val}" = false ] && ok=1 ;;
      core.logallrefupdates) [ "${val}" = true ] && ok=1 ;;
      remote.origin.url) urls=$((urls + 1)); valid_repo_url "${val}" && ok=1 ;;
      remote.origin.fetch) fetches=$((fetches + 1)); [ "${val}" = '+refs/heads/*:refs/remotes/origin/*' ] && ok=1 ;;
      branch.*.remote) b="${key#branch.}"; b="${b%.remote}"; valid_branch "${b}" && [ "${val}" = origin ] && ok=1 ;;
      branch.*.merge) b="${key#branch.}"; b="${b%.merge}"; valid_branch "${b}" && [ "${val}" = "refs/heads/${b}" ] && ok=1 ;;
    esac
    if [ "${ok}" != 1 ]; then bad="${key}"; break; fi
  done <"${tmp}"
  rm -f "${tmp}"
  [ -z "${bad}" ] || die "${cfg}: the setting '${bad}' (or its value) is not allowed. Root runs git here, so its config may hold only what git clone writes (audit R2-H2). For SSH deploy keys use /root/.ssh/config."
  [ "${urls}" = 1 ] && [ "${fetches}" = 1 ] || die "${cfg} must have exactly one remote.origin.url and one remote.origin.fetch."
}

# root_git ARGS… — git in the base with hooks and fsmonitor disabled and no GIT_* variables from the
# caller (audit R2-H2). Every git command root runs goes through here.
root_git() {
  local v unset=()
  while IFS= read -r v; do [ -n "${v}" ] && unset+=(-u "${v}"); done < <(compgen -e | grep '^GIT_' || true)
  env "${unset[@]}" git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "${VELUM_BASE_DIR:?}" "$@"
}

# as_user USER HOME SCOPE CMD… — runs CMD as USER (or as you, without root) with a clean environment:
# nothing from the caller's shell and nothing from .env leaks into builds or PM2. SCOPE tells
# release.sh and ecosystem.config.cjs which apps this user's PM2 runs (backend, web or all).
as_user() {
  local user="$1" home="$2" scope="$3" v
  shift 3
  local app_env=("HOME=${home}" "PATH=${PATH}" "LANG=${LANG:-C.UTF-8}" "PM2_HOME=${home}/.pm2" "VELUM_BASE=${VELUM_BASE_DIR:-}" "VELUM_PM2_SCOPE=${scope}")
  for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE \
    npm_config_registry npm_config_cafile npm_config_proxy npm_config_https_proxy npm_config_noproxy; do
    if [ -n "${!v:-}" ]; then app_env+=("${v}=${!v}"); fi
  done
  if [ "${SEPARATE}" = "1" ]; then
    (umask 027 && cd / && runuser -u "${user}" -- env -i "${app_env[@]}" "$@")
  else
    (umask 027 && env -i "${app_env[@]}" "$@")
  fi
}
# as_app CMD… — as the app user (builds, migrations, api + workers PM2). Needs velum_mode first.
as_app() { as_user "${APP_USER}" "${APP_HOME}" "${APP_SCOPE}" "$@"; }
# as_web CMD… — as the web user (web PM2 only). Same as as_app without root.
as_web() { if [ "${SEPARATE}" = "1" ]; then as_user "${WEB_USER}" "${WEB_HOME}" web "$@"; else as_app "$@"; fi; }

# remove_release DIR — deletes an app-owned release directory: its contents as the app user (so root
# never walks a tree another user controls), then the now empty directory as root (releases/ is
# root-owned). rm never follows links, so the root fallback stays inside DIR.
remove_release() {
  local d="$1"
  [ -n "${d}" ] || return 0
  case "${d}" in "${VELUM_BASE_DIR:?}/releases/"?*) ;; *) die "remove_release: refusing to remove ${d}." ;; esac
  [ -d "${d}" ] && [ ! -L "${d}" ] || return 0
  if [ "${SEPARATE}" = "1" ]; then
    as_app find "${d}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true
    rmdir -- "${d}" 2>/dev/null || { warn "${d} kept files the app user could not delete; removing them as root."; rm -rf --one-file-system -- "${d}"; }
  else
    rm -rf -- "${d}"
  fi
}

# lock_deploy BASE — one deploy/server-setup/set-network/new-key/import-env at a time (flock on fd 9).
# A child started with the lock already held (server-setup.sh or set-network.sh → deploy.sh, or
# deploy.sh re-running itself) reuses it.
lock_deploy() {
  local lock="$1/.deploy.lock"
  if [ "$(readlink "/proc/$$/fd/9" 2>/dev/null || true)" != "${lock}" ]; then
    [ ! -L "${lock}" ] || die "${lock} is a symbolic link."
    (umask 077 && : >>"${lock}")
    exec 9>>"${lock}"
    flock -n 9 || die "Another deploy, server-setup.sh, set-network.sh, new-key.sh or import-env.sh is running. Try again when it has finished."
  fi
}

# Environment variable names that must never sit in a PM2 daemon's own environment: PM2 cluster
# workers inherit it (Node's cluster.fork merges the primary's process.env).
SECRET_ENV_NAMES='^(DATABASE_URL|REDIS_URL|[A-Z0-9_]*_PRIVATE_KEY|[A-Z0-9_]*PASSWORD[A-Z0-9_]*|[A-Z0-9_]*SECRET[A-Z0-9_]*|ALERT_WEBHOOK_URL)$'
