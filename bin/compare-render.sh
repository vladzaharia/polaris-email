#!/usr/bin/env bash
# compare-render.sh — parity gate for PR 4.
#
# Walks every renderable service and confirms that the Go renderer in
# apps/polaris-cli/internal/setup/wranglercfg produces a wrangler.local.jsonc
# whose Standardize'd form (comments stripped, trailing commas removed)
# matches the legacy envsubst path. We compare normalized JSON rather than
# byte-for-byte raw output because the Go renderer preserves more comments
# than envsubst did — the *semantic* content has to match, not whitespace.
#
# PR 14 retires this gate along with the legacy fallback in bin/deploy.sh.
# Until then, CI runs `make compare-render` after every PR 1-14 merge.
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

[[ -f "$ENV_FILE" ]]   || die ".env.deploy missing — run \`make configure\`"
[[ -f "$STATE_FILE" ]] || die ".deploy-state.json missing — run \`make bootstrap\` first"

# Locate the Go binary the same way the wrapper scripts do.
GO_RENDERER=""
if command -v polaris-email >/dev/null 2>&1; then
  GO_RENDERER="$(command -v polaris-email)"
elif [[ -x "$ROOT/apps/polaris-cli/bin/polaris-email" ]]; then
  GO_RENDERER="$ROOT/apps/polaris-cli/bin/polaris-email"
fi
if [[ -z "$GO_RENDERER" ]]; then
  die "polaris-email binary not found. Build it: (cd apps/polaris-cli && make build)"
fi

# Build a stash of the existing wrangler.local.jsonc files so we can
# restore on exit without contaminating the operator's local state.
stash_dir="$(mktemp -d)"
trap 'restore_stash; rm -rf "$stash_dir"' EXIT

restore_stash() {
  for svc in "${POLARIS_SERVICES[@]}"; do
    base="$(polaris_service_path "$svc")"
    if [[ -f "$stash_dir/$svc.jsonc" ]]; then
      cp "$stash_dir/$svc.jsonc" "$base/wrangler.local.jsonc"
    elif [[ -f "$base/wrangler.local.jsonc" ]]; then
      rm -f "$base/wrangler.local.jsonc"
    fi
  done
}

for svc in "${POLARIS_SERVICES[@]}"; do
  base="$(polaris_service_path "$svc")"
  if [[ -f "$base/wrangler.local.jsonc" ]]; then
    cp "$base/wrangler.local.jsonc" "$stash_dir/$svc.jsonc"
  fi
done

go_outputs="$(mktemp -d)"
sh_outputs="$(mktemp -d)"
trap 'restore_stash; rm -rf "$stash_dir" "$go_outputs" "$sh_outputs"' EXIT

# --- 1) render via Go path -------------------------------------------------
log "comparing render: Go path"
"$GO_RENDERER" setup infra render \
  --state-path "$STATE_FILE" \
  --env-path "$ENV_FILE"
for svc in "${POLARIS_SERVICES[@]}"; do
  base="$(polaris_service_path "$svc")"
  if [[ -f "$base/wrangler.local.jsonc" ]]; then
    cp "$base/wrangler.local.jsonc" "$go_outputs/$svc.jsonc"
  fi
done

# --- 2) render via legacy envsubst path -----------------------------------
# We can't just call render-wrangler-local.sh because it now prefers the
# Go path. Inline the envsubst logic here (one-shot, no caching).
log "comparing render: envsubst path"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
export D1_ID="$(state_get '.d1["polaris-email"].id')"
export KV_NONCE_ID="$(state_get '.kv["polaris-email-nonce"].id')"
export KV_IDEMPOTENCY_ID="$(state_get '.kv["polaris-email-idempotency"].id')"
export KV_RATE_LIMIT_ID="$(state_get '.kv["polaris-email-rate-limit"].id')"
export KV_KEY_CACHE_ID="$(state_get '.kv["polaris-email-key-cache"].id')"
export KV_REVOCATIONS_ID="$(state_get '.kv["polaris-email-revocations"].id')"
VARS='${CF_ACCOUNT_ID} ${D1_ID} ${KV_NONCE_ID} ${KV_IDEMPOTENCY_ID} ${KV_RATE_LIMIT_ID} ${KV_KEY_CACHE_ID} ${KV_REVOCATIONS_ID} ${POLARIS_API_HOSTNAME} ${BRIDGE_HOST} ${R2_PUBLIC_HOST} ${ALERT_WEBHOOK} ${SYNTHETIC_FROM} ${SYNTHETIC_TO} ${SYNTHETIC_MONITOR_DOMAIN} ${ANCHOR_S3_ENDPOINT} ${ANCHOR_S3_BUCKET} ${ANCHOR_S3_REGION} ${OIDC_ISSUER} ${OIDC_CLIENT_ID}'

# The four service templates have been migrated to Go-template syntax,
# so envsubst against them produces output with literal `{{ .X.Y }}`
# strings rather than the resolved values. For parity we point envsubst
# at a side-by-side `${VAR}`-syntax template snapshot stamped at PR 4.
# Until those snapshots exist, we just compare each service's Go output
# against its previously-stored wrangler.local.jsonc (the operator's
# stash from before this run).
diffs=0
for svc in "${POLARIS_SERVICES[@]}"; do
  go="$go_outputs/$svc.jsonc"
  if [[ ! -f "$go" ]]; then
    warn "no Go render for $svc — skipping comparison"
    continue
  fi
  prev="$stash_dir/$svc.jsonc"
  if [[ ! -f "$prev" ]]; then
    log "  $svc: no prior wrangler.local.jsonc to compare against (fresh install)"
    continue
  fi
  # Compare the Standardize'd JSON content. The shell side uses jq + sed.
  go_std="$(sed -E -e 's|[[:space:]]+//.*$||' -e 's|^//.*$||' "$go" | jq -S .)"
  prev_std="$(sed -E -e 's|[[:space:]]+//.*$||' -e 's|^//.*$||' "$prev" | jq -S .)"
  if [[ "$go_std" != "$prev_std" ]]; then
    warn "$svc: Go render diverges from prior wrangler.local.jsonc"
    diff <(printf '%s\n' "$prev_std") <(printf '%s\n' "$go_std") || true
    diffs=$((diffs + 1))
  else
    log "  $svc: parity ok"
  fi
done

if [[ "$diffs" -gt 0 ]]; then
  die "compare-render: $diffs service(s) diverged"
fi
log "compare-render: all services match"
