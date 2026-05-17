#!/usr/bin/env bash
# render-wrangler-local.sh — materialize services/*/wrangler.local.jsonc by
# expanding services/*/wrangler.local.template.jsonc with values from
# .deploy-state.json (resource IDs) and .env.deploy (config).
#
# PR 4 introduced a Go-native renderer (apps/polaris-cli/internal/setup/
# wranglercfg) that this script now prefers. The legacy envsubst path
# remains as a fallback so a partial install can still render — but note:
# the four service templates have been migrated to Go text/template
# syntax (`{{ .X.Y }}`), so the envsubst path no longer produces correct
# output for them. The fallback is genuinely only useful if either
# (a) someone reverted the templates locally or
# (b) the polaris-email binary is missing from PATH on a fresh checkout.
# PR 14 retires the fallback once the Go path has soaked.
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

[[ -f "$ENV_FILE" ]]   || die ".env.deploy missing — run \`make configure\`"
[[ -f "$STATE_FILE" ]] || die ".deploy-state.json missing — run \`make bootstrap\` first"

# --- Go-native renderer (preferred path) ----------------------------------
# Look for the binary in PATH first (operator install) then fall back to
# the in-repo build output, so a fresh `make build` is enough to enable it.
GO_RENDERER=""
if command -v polaris-email >/dev/null 2>&1; then
  GO_RENDERER="$(command -v polaris-email)"
elif [[ -x "$ROOT/apps/polaris-cli/bin/polaris-email" ]]; then
  GO_RENDERER="$ROOT/apps/polaris-cli/bin/polaris-email"
fi

if [[ -n "$GO_RENDERER" ]]; then
  if "$GO_RENDERER" setup infra render \
       --state-path "$STATE_FILE" \
       --env-path "$ENV_FILE"; then
    log "rendered via Go: $GO_RENDERER"
    exit 0
  fi
  warn "Go renderer failed; falling back to envsubst (template syntax mismatch likely — see render-wrangler-local.sh)"
fi

# --- envsubst fallback ----------------------------------------------------
# Load env config.
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# Pull resource IDs out of state into the environment for envsubst.
export D1_ID="$(state_get '.d1["polaris-email"].id')"
export KV_NONCE_ID="$(state_get '.kv["polaris-email-nonce"].id')"
export KV_IDEMPOTENCY_ID="$(state_get '.kv["polaris-email-idempotency"].id')"
export KV_RATE_LIMIT_ID="$(state_get '.kv["polaris-email-rate-limit"].id')"
export KV_KEY_CACHE_ID="$(state_get '.kv["polaris-email-key-cache"].id')"
export KV_REVOCATIONS_ID="$(state_get '.kv["polaris-email-revocations"].id')"

missing=()
for v in CF_ACCOUNT_ID D1_ID KV_NONCE_ID KV_IDEMPOTENCY_ID KV_RATE_LIMIT_ID KV_KEY_CACHE_ID KV_REVOCATIONS_ID; do
  if [[ -z "${!v:-}" ]]; then missing+=("$v"); fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  die "missing values in state/env: ${missing[*]} — rerun \`make bootstrap\`"
fi

# Variables we will substitute. Anything not listed is left intact (a literal $VAR
# in the template will become empty if undeclared — that's why we require above).
VARS='${CF_ACCOUNT_ID} ${D1_ID} ${KV_NONCE_ID} ${KV_IDEMPOTENCY_ID} ${KV_RATE_LIMIT_ID} ${KV_KEY_CACHE_ID} ${KV_REVOCATIONS_ID} ${POLARIS_API_HOSTNAME} ${BRIDGE_HOST} ${R2_PUBLIC_HOST} ${ALERT_WEBHOOK} ${SYNTHETIC_FROM} ${SYNTHETIC_TO} ${SYNTHETIC_MONITOR_DOMAIN} ${ANCHOR_S3_ENDPOINT} ${ANCHOR_S3_BUCKET} ${ANCHOR_S3_REGION} ${OIDC_ISSUER} ${OIDC_CLIENT_ID}'

rendered=0
for svc in "${POLARIS_SERVICES[@]}"; do
  base="$(polaris_service_path "$svc")"
  tpl="$base/wrangler.local.template.jsonc"
  out="$base/wrangler.local.jsonc"
  if [[ ! -f "$tpl" ]]; then
    warn "no template for $base — skipping"
    continue
  fi
  # envsubst with explicit VARS list to avoid eating literal $ that might appear elsewhere.
  envsubst "$VARS" < "$tpl" > "$out.tmp"
  mv "$out.tmp" "$out"
  rendered=$((rendered + 1))
  log "rendered $out"
done
log "rendered $rendered wrangler.local.jsonc files (envsubst fallback)"
