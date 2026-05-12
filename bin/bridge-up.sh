#!/usr/bin/env bash
# bridge-up.sh — bring the Mox + sidecar bridge up via docker compose.
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

need docker
need curl
load_env_deploy

for k in TS_OAUTH_CLIENT_SECRET TS_TAILNET BRIDGE_HOST POLARIS_API_HOSTNAME MOX_ADMIN_PASSWORD CF_API_TOKEN; do
  if [[ -z "${!k:-}" ]]; then die "bridge-up: $k is required in .env.deploy"; fi
done

# Hard cutover from one-time auth keys to OAuth. The tskey-auth- format is rejected here
# rather than silently working, because OAuth-minted devices have a real provenance trail
# in the Tailscale admin and the OAuth client is rotateable in place.
if [[ "$TS_OAUTH_CLIENT_SECRET" != tskey-client-* ]]; then
  die "TS_OAUTH_CLIENT_SECRET must begin with 'tskey-client-' (OAuth client secret, not a one-time auth key). Create one at Tailscale admin → Settings → OAuth clients with scope 'devices:write' and tag 'tag:mail-bridge', then paste the secret via \`make configure\`."
fi

BRIDGE_DIR="$ROOT/apps/bridge"
[[ -d "$BRIDGE_DIR" ]] || die "no $BRIDGE_DIR — repo layout broken"

# Render mox.conf and adminpasswd from the template + .env.deploy.
# The template uses ${BRIDGE_HOST} substitution; we feed it through envsubst
# with an explicit allowlist so unrelated $... in the template never get
# touched (Mox config syntax has no $-references of its own, but defensive).
render_mox_conf() {
  local template="$BRIDGE_DIR/mox-config/mox.conf.template"
  local out="$BRIDGE_DIR/mox-config/mox.conf"
  [[ -f "$template" ]] || die "missing $template"
  # envsubst with allowlist; avoid GNU-vs-BSD differences by doing a
  # single-variable sed pass.
  sed "s|\${BRIDGE_HOST}|${BRIDGE_HOST}|g" "$template" > "$out"
  log "rendered $out"
}

# Generate the bcrypt hash for AdminPasswordFile. We try (in order):
#   1. htpasswd -bnB (bcrypt cost 5 default, set 10 explicitly)
#   2. python3 + bcrypt
# Both are common enough that one will be present on a bridge host.
render_adminpasswd() {
  local out="$BRIDGE_DIR/mox-config/adminpasswd"
  if command -v htpasswd >/dev/null 2>&1; then
    # htpasswd -bnB emits "name:hash"; strip the leading "x:".
    local line
    line="$(htpasswd -bnBC 10 "x" "$MOX_ADMIN_PASSWORD" 2>/dev/null | head -1)"
    [[ -n "$line" ]] || die "htpasswd produced no output"
    printf '%s\n' "${line#x:}" > "$out"
  elif command -v python3 >/dev/null 2>&1 && python3 -c 'import bcrypt' 2>/dev/null; then
    python3 - "$MOX_ADMIN_PASSWORD" > "$out" <<'PY'
import sys, bcrypt
pw = sys.argv[1].encode("utf-8")
print(bcrypt.hashpw(pw, bcrypt.gensalt(10)).decode("ascii"))
PY
  else
    die "need either 'htpasswd' (apt: apache2-utils, brew: httpd) or 'python3 + bcrypt' to hash MOX_ADMIN_PASSWORD"
  fi
  chmod 0600 "$out"
  log "rendered $out (bcrypt of MOX_ADMIN_PASSWORD)"
}

render_mox_conf
render_adminpasswd

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
  # The Tailscale container reads TS_AUTHKEY regardless of whether the value is an
  # auth-key or an OAuth client secret. We append ?preauthorized=true&ephemeral=false
  # so the device the OAuth client mints is non-ephemeral (survives container restart
  # via ts-state/) and doesn't require manual approval in the admin console.
  cat > "$BRIDGE_DIR/.env" <<EOF
TS_AUTHKEY=${TS_OAUTH_CLIENT_SECRET}?preauthorized=true&ephemeral=false
TS_TAILNET=$TS_TAILNET
BRIDGE_HOST=$BRIDGE_HOST
POLARIS_EMAIL_URL=https://$POLARIS_API_HOSTNAME
POLARIS_BRIDGE_KEY_ID=$bk_id
POLARIS_BRIDGE_KEY_SECRET=$bk_secret
MOX_ADMIN_PASSWORD=$MOX_ADMIN_PASSWORD
CF_API_TOKEN=$CF_API_TOKEN
CERT_EMAIL=${CERT_EMAIL:-postmaster@$BRIDGE_HOST}
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

# Capture the Tailnet IPv4 and upsert the A record for BRIDGE_HOST.
# This is the public hostname lego will issue a Let's Encrypt cert for;
# even though the IP is private (CGNAT 100.x), having an A record makes
# the cert-issuer's DNS-01 cleanup simpler and lets the bridge resolve
# from tailnet-joined clients.
if [[ -n "${BRIDGE_ZONE_ID:-}" ]]; then
  ts_ipv4="$(docker compose exec -T ts tailscale ip --4 2>/dev/null | tr -d '\r' | head -1)"
  if [[ -n "$ts_ipv4" ]]; then
    log "upserting A record ${BRIDGE_HOST} -> ${ts_ipv4} (zone ${BRIDGE_ZONE_ID})"
    cf_upsert_a_record "$BRIDGE_ZONE_ID" "$BRIDGE_HOST" "$ts_ipv4" >/dev/null || warn "cf_upsert_a_record failed"
  else
    warn "could not determine tailscale IPv4; skipping A record upsert"
  fi
else
  warn "BRIDGE_ZONE_ID not set; skipping A record upsert"
fi

# cert-init (tailscale cert) was removed: it issued certs for *.ts.net
# MagicDNS names which we don't use any more. Cert issuance is now the
# cert-issuer container's job (lego + Cloudflare DNS-01). It runs as a
# long-lived service and Mox reads /certs/<BRIDGE_HOST>.{crt,key} via
# KeyCerts. Mox loads KeyCerts eagerly at startup and does not watch the
# file; renewals require a Mox restart, scheduled by an out-of-band hook
# (the cert-issuer touches /certs/.renewed; an operator restarts Mox in
# a low-traffic window, see docs/DEPLOY.md).

log "docker compose up -d cert-issuer (lego DNS-01)"
docker compose up -d cert-issuer

log "waiting for first cert at /certs/${BRIDGE_HOST}.crt (up to 120s)"
for i in $(seq 1 60); do
  if docker compose exec -T cert-issuer test -f "/certs/${BRIDGE_HOST}.crt"; then
    log "cert present after ${i}*2s"
    break
  fi
  sleep 2
done

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
