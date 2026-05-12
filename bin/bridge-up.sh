#!/usr/bin/env bash
# bridge-up.sh — bring the Mox + sidecar bridge up via docker compose.
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

need docker
need curl
load_env_deploy

for k in TS_AUTHKEY TS_TAILNET BRIDGE_HOST POLARIS_API_HOSTNAME; do
  if [[ -z "${!k:-}" ]]; then die "bridge-up: $k is required in .env.deploy"; fi
done

BRIDGE_DIR="$ROOT/apps/bridge"
[[ -d "$BRIDGE_DIR" ]] || die "no $BRIDGE_DIR — repo layout broken"

# Ensure we have a bridge API key. Reuse the one in $BOOTSTRAP_OUTPUT if it was issued for the bridge,
# otherwise issue a new one with bridge:read,bridge:write scopes.
ensure_bridge_key() {
  local key_id key_secret name="bridge-$(hostname -s 2>/dev/null || echo host)"
  if [[ -f "$BRIDGE_DIR/.bridge-key.json" ]]; then
    key_id="$(jq -r '.key_id' "$BRIDGE_DIR/.bridge-key.json")"
    key_secret="$(jq -r '.key_secret' "$BRIDGE_DIR/.bridge-key.json")"
  else
    log "issuing a bridge API key"
    [[ -f "$BOOTSTRAP_OUTPUT" ]] || die "no $BOOTSTRAP_OUTPUT — run \`make bootstrap\` first"
    body="$(jq -nc --arg name "$name" '{name:$name, scopes:["bridge:read","bridge:write"], sender_scopes:[]}')"
    resp="$(polaris_api_call POST /v1/admin/api-keys "$body" 1)"
    key_id="$(printf '%s' "$resp" | jq -r '.key_id // empty')"
    key_secret="$(printf '%s' "$resp" | jq -r '.key_secret // empty')"
    [[ -n "$key_id" && -n "$key_secret" ]] || { echo "$resp" >&2; die "bridge key issuance failed"; }
    umask 077
    printf '%s\n' "$resp" > "$BRIDGE_DIR/.bridge-key.json"
  fi
  printf '%s\n%s\n' "$key_id" "$key_secret"
}

# Render apps/bridge/.env if missing.
if [[ ! -f "$BRIDGE_DIR/.env" ]]; then
  log "rendering $BRIDGE_DIR/.env"
  bk="$(ensure_bridge_key)"
  bk_id="$(printf '%s' "$bk" | sed -n '1p')"
  bk_secret="$(printf '%s' "$bk" | sed -n '2p')"
  umask 077
  cat > "$BRIDGE_DIR/.env" <<EOF
TS_AUTHKEY=$TS_AUTHKEY
TS_TAILNET=$TS_TAILNET
POLARIS_EMAIL_URL=https://$POLARIS_API_HOSTNAME
POLARIS_BRIDGE_KEY_ID=$bk_id
POLARIS_BRIDGE_KEY_SECRET=$bk_secret
SIDECAR_TAG=${SIDECAR_TAG:-latest}
EOF
fi

cd "$BRIDGE_DIR"

log "docker compose pull"
docker compose pull

log "docker compose up -d ts"
docker compose up -d ts

log "waiting for tailscale to register..."
for i in $(seq 1 30); do
  if docker compose exec -T ts tailscale status >/dev/null 2>&1; then
    log "tailscale online after ${i}s"
    break
  fi
  sleep 2
done

log "docker compose up cert-init (one-shot)"
docker compose up cert-init || warn "cert-init returned nonzero — inspect logs if Mox TLS fails"

log "docker compose up -d mox sidecar"
docker compose up -d mox sidecar

log "polling bridge health at http://${BRIDGE_HOST}:8088/health"
for i in $(seq 1 30); do
  code="$(curl -sS -m 2 -o /dev/null -w '%{http_code}' "http://${BRIDGE_HOST}:8088/health" || echo 000)"
  if [[ "$code" == "200" ]]; then
    log "bridge healthy after ${i}*2s"
    exit 0
  fi
  sleep 2
done
die "bridge did not reach healthy state within 60s — check \`docker compose logs sidecar mox ts\`"
