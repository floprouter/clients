#!/bin/sh
# Keeps the wallet's session-key grant alive without a human: renews it only when it is missing, revoked, expiring
# within the window, or nearly used up, signing with the wallet's own key file. Exits 0 when nothing was needed.
# Safe to run every hour. Cron (as the user that owns the key file, mode 600):
#
#   17 * * * *  FLOPROUTER_API_KEY=fr_... /path/to/keep-grant-alive.sh >> "$HOME/.floprouter-grant.log" 2>&1
#
# Env: FLOPROUTER_KEY_FILE (polkadot-js JSON) or FLOPROUTER_SEED_FILE (mnemonic file); FLOPROUTER_PASSWORD_FILE if the
# key file is encrypted; FLOPROUTER_API_KEY (or the key saved by `floprouter login`); RENEW_BEFORE (default 2d);
# FLOPROUTER_CLI to run a specific CLI (default: npx -y floprouter@latest).
set -eu
: "${FLOPROUTER_KEY_FILE:=}" "${FLOPROUTER_SEED_FILE:=}"
[ -n "$FLOPROUTER_KEY_FILE$FLOPROUTER_SEED_FILE" ] || { echo "set FLOPROUTER_KEY_FILE or FLOPROUTER_SEED_FILE" >&2; exit 2; }
set -- grant --auto-renew --renew-before "${RENEW_BEFORE:-2d}" --yes --json
[ -n "${FLOPROUTER_PASSWORD_FILE:-}" ] && set -- "$@" --password-file "$FLOPROUTER_PASSWORD_FILE"
printf '%s ' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# shellcheck disable=SC2086
exec ${FLOPROUTER_CLI:-npx -y floprouter@latest} "$@"
