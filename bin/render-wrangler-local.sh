#!/usr/bin/env bash
# render-wrangler-local.sh — materialize services/*/wrangler.local.jsonc by substituting
# ${VAR} placeholders in services/*/wrangler.local.template.jsonc using values from
# .deploy-state.json (resource IDs) and .env.deploy (config).
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

[[ -f "$ENV_FILE" ]]   || die ".env.deploy missing — run \`make configure\`"
[[ -f "$STATE_FILE" ]] || die ".deploy-state.json missing — run \`make bootstrap\` first"

# Load env config.
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# Pull resource IDs out of state into the environment for envsubst.
export D1_ID="$(state_get '.d1["polaris-email"].id')"
export KV_NONCE_ID="$(state_get '.kv["polaris-email-nonce"].id')"
export KV_IDEMPOTENCY_ID="$(state_get '.kv["polaris-email-idempotency"].id')"
export KV_RATE_LIMIT_ID="$(state_get '.kv["polaris-email-rate-limit"].id')"
export KV_KEY_CACHE_ID="$(state_get '.kv["polaris-email-key-cache"].id')"

missing=()
for v in CF_ACCOUNT_ID D1_ID KV_NONCE_ID KV_IDEMPOTENCY_ID KV_RATE_LIMIT_ID KV_KEY_CACHE_ID; do
  if [[ -z "${!v:-}" ]]; then missing+=("$v"); fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  die "missing values in state/env: ${missing[*]} — rerun \`make bootstrap\`"
fi

# Variables we will substitute. Anything not listed is left intact (a literal $VAR
# in the template will become empty if undeclared — that's why we require above).
VARS='${CF_ACCOUNT_ID} ${D1_ID} ${KV_NONCE_ID} ${KV_IDEMPOTENCY_ID} ${KV_RATE_LIMIT_ID} ${KV_KEY_CACHE_ID} ${POLARIS_API_HOSTNAME} ${BRIDGE_HOST} ${ALERT_WEBHOOK} ${SYNTHETIC_FROM} ${SYNTHETIC_TO} ${SYNTHETIC_MONITOR_DOMAIN}'

rendered=0
for svc in "${POLARIS_SERVICES[@]}"; do
  tpl="services/$svc/wrangler.local.template.jsonc"
  out="services/$svc/wrangler.local.jsonc"
  if [[ ! -f "$tpl" ]]; then
    warn "no template for services/$svc — skipping"
    continue
  fi
  # envsubst with explicit VARS list to avoid eating literal $ that might appear elsewhere.
  envsubst "$VARS" < "$tpl" > "$out.tmp"
  mv "$out.tmp" "$out"
  rendered=$((rendered + 1))
  log "rendered $out"
done
log "rendered $rendered wrangler.local.jsonc files"
