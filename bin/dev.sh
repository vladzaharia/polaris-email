#!/usr/bin/env bash
# dev.sh — convenience wrapper for `pnpm test:integration --watch`.
#
# Defaults to running the three pool-workers projects (in-workers,
# out-workers, api-workers) in watch mode. Pass `--project <name>` to
# scope to a single service (forwarded verbatim to vitest).
#
# Examples:
#   bin/dev.sh                          # watch all three services
#   bin/dev.sh --project in-workers     # watch only services/in
set -uo pipefail

# Source shared helpers if present, but don't fail in trimmed checkouts.
LIB="$(dirname "$0")/_lib.sh"
if [[ -f "$LIB" ]]; then
  # shellcheck source=bin/_lib.sh
  source "$LIB"
  cd "$ROOT" || exit 1
else
  cd "$(dirname "$0")/.." || exit 1
fi

# If the caller passed --project, forward as-is; otherwise default to all three.
if [[ "$#" -gt 0 ]]; then
  exec pnpm exec vitest --watch "$@"
fi
exec pnpm exec vitest --watch \
  --project in-workers \
  --project out-workers \
  --project api-workers
