#!/usr/bin/env bash
# Shared helpers for Phase −1 Cloudflare API spike scripts.

set -euo pipefail

require_env() {
  local var=$1
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: \$$var is required (see docs/spike/README.md)" >&2
    exit 64
  fi
}

require_env CF_API_TOKEN
require_env CF_ACCOUNT_ID

CF_API="https://api.cloudflare.com/client/v4"

cf_get() {
  curl -sS -H "Authorization: Bearer $CF_API_TOKEN" "$CF_API$1"
}

cf_post() {
  curl -sS -X POST -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" -d "$2" "$CF_API$1"
}

cf_put() {
  curl -sS -X PUT -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" -d "$2" "$CF_API$1"
}

cf_delete() {
  curl -sS -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" "$CF_API$1"
}

result() {
  echo
  echo "SPIKE_RESULT: $1 — ${2:-}"
}

require_jq() {
  if ! command -v jq &>/dev/null; then
    echo "ERROR: jq is required (brew install jq)" >&2
    exit 64
  fi
}
