#!/usr/bin/env bash
# state-rebuild.sh — reconstruct .deploy-state.json from Cloudflare by listing live resources.
# Use for disaster recovery when the operator workstation lost its state file but the CF account
# still has the resources. Safe to run repeatedly: writes to .deploy-state.json.tmp, only swaps
# in on success.
#
# Usage: bin/state-rebuild.sh [--dry-run]
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

need wrangler
need jq

log "querying Cloudflare for live resources…"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf '{}\n' > "$tmp"

# Helper: jq-set on $tmp.
tset() {
  local expr="$1"; shift
  local args=()
  while [[ $# -gt 0 ]]; do args+=(--arg "$1" "$2"); shift 2; done
  local out="$tmp.next"
  jq "${args[@]}" "$expr" "$tmp" > "$out"
  mv "$out" "$tmp"
}

# D1 — `wrangler d1 list --json` is supported.
if d1_json="$(wrangler d1 list --json 2>/dev/null)"; then
  id="$(printf '%s' "$d1_json" | jq -r '.[] | select(.name=="polaris-email") | .uuid // .database_id // empty' | head -1)"
  [[ -n "$id" ]] && tset '.d1["polaris-email"] = {id: $id, recovered_at: $at}' id "$id" at "$(date -u +%FT%TZ)"
fi

# KV — `wrangler kv namespace list` supports JSON output.
if kv_json="$(wrangler kv namespace list 2>/dev/null)"; then
  for ns in polaris-email-nonce polaris-email-idempotency polaris-email-rate-limit polaris-email-key-cache; do
    id="$(printf '%s' "$kv_json" | jq -r --arg n "$ns" '.[] | select(.title==$n) | .id // empty' | head -1)"
    [[ -n "$id" ]] && tset --arg n "$ns" '.kv[$n] = {id: $id, recovered_at: $at}' id "$id" at "$(date -u +%FT%TZ)" || true
  done
fi

# Queues — `wrangler queues list` returns rich data.
if q_json="$(wrangler queues list 2>/dev/null)"; then
  for q in polaris-email-outbound polaris-email-inbound polaris-email-fanout polaris-email-outbound-dlq polaris-email-fanout-dlq; do
    found="$(printf '%s' "$q_json" | jq -r --arg n "$q" '.[] | select(.queue_name==$n or .name==$n) | .queue_id // .id // empty' | head -1)"
    [[ -n "$found" ]] && tset --arg n "$q" '.queues[$n] = {id: $id, recovered_at: $at}' id "$found" at "$(date -u +%FT%TZ)" || true
  done
fi

# R2 has no per-bucket id — record the name + jurisdiction we assume.
tset '.r2["polaris-email"] = {name: "polaris-email", jurisdiction: "eu", recovered_at: $at}' at "$(date -u +%FT%TZ)"

if [[ "$DRY" == "1" ]]; then
  log "dry-run — would write:"
  jq . "$tmp" >&2
  exit 0
fi

if [[ -f "$STATE_FILE" ]]; then
  cp "$STATE_FILE" "$STATE_FILE.bak.$(date -u +%FT%TZ)"
  log "existing state backed up to $STATE_FILE.bak.*"
fi
mv "$tmp" "$STATE_FILE"
trap - EXIT
log "wrote $STATE_FILE — review with: jq . $STATE_FILE"
log "next: run bin/render-wrangler-local.sh to regenerate wrangler.local.jsonc files."
