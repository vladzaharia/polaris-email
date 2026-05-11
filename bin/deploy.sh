#!/usr/bin/env bash
# deploy.sh — deploy one Worker. Merges wrangler.jsonc + wrangler.local.jsonc with jq.
set -euo pipefail

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
  echo "usage: bin/deploy.sh <services/api|services/out|...|apps/panel>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/$SERVICE"
[[ -d "$DIR" ]] || { echo "no such dir: $DIR" >&2; exit 2; }

cd "$DIR"

if [[ -f wrangler.jsonc && -f wrangler.local.jsonc ]]; then
  # Strip // comments before jq.
  PUB=$(sed 's|//.*$||' wrangler.jsonc)
  LOCAL=$(sed 's|//.*$||' wrangler.local.jsonc)
  echo "$PUB" "$LOCAL" | jq -s '.[0] * .[1]' > .wrangler.merged.json
  wrangler deploy --config .wrangler.merged.json
  rm -f .wrangler.merged.json
else
  wrangler deploy
fi
