#!/usr/bin/env bash
# Dumps (or restores) Velum's database as Velum's own database role, never as the postgres superuser
# (audit I-3). Whoever owns the objects in a database (here that role, which a compromised app user can
# use) can make pg_dump or pg_restore run SQL with the privileges of the role running them
# (CVE-2024-7348 and the general "never restore untrusted dumps as a superuser" rule). As the owner
# role, that SQL can do nothing the role could not do anyway. Run as root:
#   sudo bash /srv/velum/deploy/backup-db.sh /var/backups/velum-$(date +%F).pgdump
#   sudo bash /srv/velum/deploy/backup-db.sh --restore /var/backups/velum-2026-11-14.pgdump
# Connection and password come from DATABASE_URL in <base>/.env. The password reaches pg_dump only
# through a temporary PGPASSFILE (root-only, in <base>/backups), never on a command line.
# shellcheck disable=SC2015 # "A && B || die" is the intended idiom here: die exits.
set -euo pipefail
umask 077
trap '' HUP
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
BASE="$(cd "$(dirname "${SELF}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${BASE}/deploy/lib/common.sh"
[ "$(id -u)" -eq 0 ] || die "Run as root."
MODE=dump
if [ "${1:-}" = --restore ]; then MODE=restore; shift; fi
OUT="${1:-}"
[ $# -eq 1 ] && [[ "${OUT}" == /* ]] || die "Usage: sudo bash ${BASE}/deploy/backup-db.sh [--restore] /absolute/path/velum.pgdump"
[ ! -L "${OUT}" ] || die "${OUT} is a symbolic link."
ENV_FILE="${BASE}/.env"
[ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE} (run deploy/import-env.sh or server-setup.sh first)."
command -v pg_dump >/dev/null || die "pg_dump is not installed."

# user, host, port, database and the decoded password, one per line (values via the environment).
mapfile -t DB < <(VELUM_V="$(env_get "${ENV_FILE}" DATABASE_URL)" node -e '
  try {
    const u = new URL(process.env.VELUM_V);
    if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error();
    const out = [decodeURIComponent(u.username), u.hostname || "127.0.0.1", u.port || "5432", decodeURIComponent(u.pathname.replace(/^\//, "")), decodeURIComponent(u.password)];
    if (out.some((v) => v.includes("\n"))) throw new Error();
    process.stdout.write(out.join("\n") + "\n");
  } catch { process.exit(1); }') || die "DATABASE_URL in ${ENV_FILE} is not a postgresql:// URL."
[ "${#DB[@]}" -eq 5 ] && [ -n "${DB[0]}" ] && [ -n "${DB[3]}" ] && [ -n "${DB[4]}" ] || die "DATABASE_URL in ${ENV_FILE} needs a user, a password and a database name."
[ "${DB[0]}" != postgres ] || die "DATABASE_URL uses the postgres superuser; Velum's own role is expected."
[[ "${DB[1]}" =~ ^[A-Za-z0-9.:-]+$ ]] && [[ "${DB[2]}" =~ ^[0-9]{1,5}$ ]] || die "DATABASE_URL has an unexpected host or port."

install -d -o root -g root -m 700 "${BASE}/backups"
PASSFILE="$(mktemp "${BASE}/backups/.pgpass.XXXXXX")"
trap 'rm -f "${PASSFILE}"' EXIT
esc() { printf '%s' "$1" | sed -e 's/[\\:]/\\&/g'; }
printf '%s:%s:%s:%s:%s\n' "$(esc "${DB[1]}")" "${DB[2]}" "$(esc "${DB[3]}")" "$(esc "${DB[0]}")" "$(esc "${DB[4]}")" >"${PASSFILE}"
pg() { env -i PATH="${PATH}" HOME=/root LANG=C.UTF-8 PGPASSFILE="${PASSFILE}" "$@" -h "${DB[1]}" -p "${DB[2]}" -U "${DB[0]}" --no-password; }

if [ "${MODE}" = dump ]; then
  pg pg_dump -Fc -f "${OUT}" -d "${DB[3]}" || { rm -f "${OUT}"; die "pg_dump failed; nothing was written."; }
  chmod 600 "${OUT}"
  echo "Dumped database ${DB[3]} as role ${DB[0]} to ${OUT} ($(stat -c %s "${OUT}") bytes, root-only)."
else
  [ -f "${OUT}" ] || die "${OUT} does not exist."
  # As the owner role: objects are recreated owned by it; nothing in the dump runs as a superuser.
  pg pg_restore --clean --if-exists --no-owner --no-privileges -d "${DB[3]}" "${OUT}" || die "pg_restore reported errors (above)."
  echo "Restored ${OUT} into database ${DB[3]} as role ${DB[0]}."
fi
