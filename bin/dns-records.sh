#!/usr/bin/env bash
# dns-records.sh — DEPRECATED compatibility shim. The unified converge command
# is bin/onboard.sh (see `make onboard` / `make onboard-plan`). This wrapper
# forwards to `onboard.sh --plan --domain <name>` so existing callers don't break.
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

warn "bin/dns-records.sh is deprecated; use 'make onboard' or 'make onboard-plan' instead"

DOMAIN=""
APPLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    -*)      warn "ignoring unknown flag for compat: $1"; shift ;;
    *)       DOMAIN="$1"; shift ;;
  esac
done

[[ -n "$DOMAIN" ]] || die "usage: bin/dns-records.sh [--apply] <domain>"

if [[ "$APPLY" -eq 1 ]]; then
  warn "--apply on dns-records.sh is no longer supported; running plan mode"
fi

exec "$ROOT/bin/onboard.sh" --plan --domain "$DOMAIN"
