#!/usr/bin/env bash
# Copies the .env of an older in-place install into this fresh root-owned base, safely (audit R2-H2).
# Run as root from the new base, before server-setup.sh:
#   sudo bash /srv/velum/deploy/import-env.sh /opt/velum/.env
#
# The old tree belonged to the app user, who may be compromised, so the old file is treated as hostile:
#   - it is opened and read as the app user (never as root), with O_NOFOLLOW and O_NONBLOCK, so a
#     symbolic link or a FIFO planted in its place cannot make root read /etc/shadow or hang; that
#     process starts in a new session without this terminal (run_isolated, audit R3-01);
#   - the open file must be a regular file with exactly one link, owned by root or the app user, at
#     most 64 KiB;
#   - every line must be blank, a comment or KEY=VALUE (no control characters, no duplicate keys);
#     anything else is refused and the line numbers are printed (never the content);
#   - it is written atomically to <base>/.env as root:<app group> 640 and never executed or sourced.
# It then prints every key for review: secrets masked, other values shown. The old app user could
# have changed any value; check them before running server-setup.sh.
# shellcheck disable=SC2015,SC2016 # "A && B || die" is intended (die exits); the Node program is single-quoted on purpose.
set -euo pipefail
umask 077
trap '' HUP
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
BASE="$(cd "$(dirname "${SELF}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${BASE}/deploy/lib/common.sh"
SRC="${1:-}"
[ -n "${SRC}" ] && [ $# -eq 1 ] || die "Usage: sudo bash ${BASE}/deploy/import-env.sh /opt/velum/.env"
[[ "${SRC}" == /* ]] || die "Give the absolute path of the old .env."
[ "$(id -u)" -eq 0 ] || die "Run as root."
ENV_FILE="${BASE}/.env"
APP_USER="${APP_USER:-velum}"
id -u "${APP_USER}" >/dev/null 2>&1 || die "User ${APP_USER} does not exist; the old install ran as which user? Set APP_USER=…"
APP_GROUP="$(id -gn "${APP_USER}")"
VELUM_BASE_DIR="${BASE}"
assert_root_owned_tree "${BASE}"
lock_deploy "${BASE}"
if [ -e "${ENV_FILE}" ] || [ -L "${ENV_FILE}" ]; then
  [ "${FORCE:-}" = yes ] || die "${ENV_FILE} already exists. Re-run with FORCE=yes to replace it (it is backed up first)."
  [ ! -L "${ENV_FILE}" ] || die "${ENV_FILE} is a symbolic link."
fi

TMP="$(mktemp "${BASE}/.env.import.XXXXXX")"
trap 'rm -f "${TMP}"' EXIT
# Read as the app user: it can only read what it could read anyway. Node opens the path once with
# O_NOFOLLOW | O_NONBLOCK, checks the open file (fstat), then reads at most 64 KiB from that same fd.
# Node runs without global module paths, from a new session without this terminal (R3-01).
APP_HOME_DIR="$(getent passwd "${APP_USER}" | cut -d: -f6)"
if ! run_isolated runuser -u "${APP_USER}" -- env -i PATH="${PATH}" HOME="${APP_HOME_DIR:-/}" LANG=C.UTF-8 node --no-global-search-paths -e '
  const fs = require("fs");
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_NOCTTY } = fs.constants;
  const [path, appUid] = process.argv.slice(1);
  let fd;
  try { fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY); }
  catch (e) { console.error(e.code === "ELOOP" ? `${path} is a symbolic link: refused.` : `Cannot open ${path} as the app user (${e.code}).`); process.exit(2); }
  const st = fs.fstatSync(fd);
  const fail = (m) => { console.error(`${path}: ${m}: refused.`); process.exit(2); };
  if (!st.isFile()) fail("not a regular file");
  if (st.nlink !== 1) fail(`it has ${st.nlink} hard links`);
  if (st.uid !== 0 && st.uid !== Number(appUid)) fail(`owned by uid ${st.uid}, neither root nor the app user`);
  if (st.size > 65536) fail("larger than 64 KiB");
  const buf = Buffer.alloc(65537);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  if (n > 65536) fail("larger than 64 KiB");
  process.stdout.write(buf.subarray(0, n));
' "${SRC}" "$(id -u "${APP_USER}")" >"${TMP}"; then
  die "Nothing was imported. Copy the values into ${ENV_FILE} by hand (as root, mode 640, group ${APP_GROUP}) after checking them."
fi

# Line checks (as data, by awk): blank, comment, or KEY=VALUE without control characters; no duplicates.
BAD="$(LC_ALL=C awk '
  { sub(/\r$/, "") }
  /^[[:space:]]*$/ || /^[[:space:]]*#/ { next }
  {
    if ($0 ~ /[\001-\010\013-\037\177]/) { bad = bad " " NR " (control character)"; next }
    if ($0 !~ /^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) { bad = bad " " NR " (not KEY=VALUE)"; next }
    k = $0; sub(/^[[:space:]]*(export[[:space:]]+)?/, "", k); sub(/[[:space:]]*=.*/, "", k)
    if (k in seen) bad = bad " " NR " (" k " repeats line " seen[k] ")"; else seen[k] = NR
  }
  END { print substr(bad, 2) }' "${TMP}")"
[ -z "${BAD}" ] || die "The old file has lines Velum will not import: ${BAD}. Fix them in the old file (as root) or write ${ENV_FILE} by hand, then re-run. Nothing was imported."
grep -q '^[[:space:]]*\(export[[:space:]]\+\)\?DATABASE_URL[[:space:]]*=' "${TMP}" || die "The old file has no DATABASE_URL; is ${SRC} really Velum's .env? Nothing was imported."
# Normalise line endings, then put it in place: root:<app group> 640, atomically.
sed -i 's/\r$//' "${TMP}"
if [ -f "${ENV_FILE}" ]; then backup="$(env_backup "${ENV_FILE}")"; echo "Previous ${ENV_FILE} kept as ${backup##*/}."; fi
chown root:"${APP_GROUP}" "${TMP}"
chmod 640 "${TMP}"
mv -f "${TMP}" "${ENV_FILE}"
trap - EXIT

echo "Imported ${SRC} → ${ENV_FILE} (root:${APP_GROUP} 640). Review every value (secrets masked):"
while IFS= read -r k; do
  v="$(env_get "${ENV_FILE}" "${k}")"
  if [[ "${k}" =~ ^(DATABASE_URL|REDIS_URL)$ ]]; then
    # Host, port and database matter for the review; the user:password part is masked.
    printf '  %-34s %s\n' "${k}" "$(printf '%s' "${v}" | sed -E 's#^([a-z]+://).*@#\1***@#')"
  elif [[ "${k}" =~ ${SECRET_ENV_NAMES} ]] || [[ "${k}" =~ (KEY|TOKEN|PASS) ]]; then
    if [ -n "${v}" ]; then printf '  %-34s (set, %d characters)\n' "${k}" "${#v}"; else printf '  %-34s (empty)\n' "${k}"; fi
  else
    printf '  %-34s %s\n' "${k}" "${v}"
  fi
done < <(env_keys "${ENV_FILE}")
cat <<EOF
Check above all: DOMAIN, PUBLIC_SITE_URL, NEXT_PUBLIC_* (compiled into the web), RPC_URL, CORS_ORIGIN,
PORT_WEB/PORT_API (must match what the old apps use) and DATABASE_URL/REDIS_URL hosts. Edit as root:
  nano ${ENV_FILE}
If ${APP_USER} may have been compromised, rotating these secrets alone does not help: ${APP_USER} can read
this .env (and every new secret in it) as long as it exists. Follow docs/05-deploy-vps.md, "Compromise
suspected": stop and lock ${APP_USER}, install with new users, then rotate.
EOF
