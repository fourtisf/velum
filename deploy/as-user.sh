#!/usr/bin/env bash
# Runs one command as another (non-root) user without handing it your terminal (audit R3-01). Use it
# instead of runuser, su or sudo -u for anything that runs as Velum's users, as root:
#   sudo bash /srv/velum/deploy/as-user.sh velum pm2 status
#   sudo bash /srv/velum/deploy/as-user.sh velum-web pm2 logs velum-web --lines 100 --nostream
# `runuser -u` alone keeps your session and controlling terminal, so any process of that user (and its
# own code runs inside every pm2 or node command: ~/.node_modules, ~/.npmrc, release files) could push
# keystrokes into your root shell (TIOCSTI). Here the command starts in a new session without a
# controlling terminal, from /, with a clean environment (HOME, PATH, LANG, PM2_HOME, TMPDIR=~/.tmp),
# stdin from /dev/null unless you pipe data in, and what it prints reaches your terminal without
# control characters. Output you redirect to a file or a pipe is passed through unchanged.
# shellcheck disable=SC2015 # "A && B || die" is the intended idiom here: die exits.
set -euo pipefail
trap '' HUP
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
BASE="$(cd "$(dirname "${SELF}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "${BASE}/deploy/lib/common.sh"
[ "$(id -u)" -eq 0 ] || die "Run as root (as yourself, just run the command)."
[ $# -ge 2 ] || die "Usage: sudo bash ${BASE}/deploy/as-user.sh USER COMMAND [ARGS…]"
U="$1"
shift
[[ "${U}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && id -u "${U}" >/dev/null 2>&1 && [ "$(id -u "${U}")" -ne 0 ] || die "${U} is not an existing user other than root."
VELUM_BASE_DIR="${BASE}"
SEPARATE=1
SCOPE=all
if [ "${U}" = "$(recorded_user "${BASE}" APP_USER)" ]; then SCOPE=backend; elif [ "${U}" = "$(recorded_user "${BASE}" WEB_USER)" ]; then SCOPE=web; fi
as_user "${U}" "$(user_home "${U}")" "${SCOPE}" "$@"
