#!/usr/bin/env bash
# bootstrap.sh — idempotent cold-start of a polaris-email installation.
# Requires: wrangler logged in to the target CF account, jq, openssl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }
}
need wrangler
need jq
need openssl
need pnpm

echo "==> 1/8 ensure pnpm install"
pnpm install --frozen-lockfile

echo "==> 2/8 build everything"
pnpm -r run build || true

echo "==> 3/8 D1 / R2 / KV / Queues"
wrangler d1 create polaris-email || true
wrangler r2 bucket create polaris-email --jurisdiction=eu || true
wrangler r2 bucket lock add polaris-email --retention-period=2160h --mode=compliance || true
for kv in polaris-email-nonce polaris-email-idempotency polaris-email-rate-limit polaris-email-key-cache; do
  wrangler kv namespace create "$kv" || true
done
for q in polaris-email-outbound polaris-email-inbound polaris-email-fanout \
         polaris-email-outbound-dlq polaris-email-fanout-dlq; do
  wrangler queues create "$q" || true
done

echo "==> 4/8 apply migrations"
wrangler d1 migrations apply polaris-email --remote || true

echo "==> 5/8 generate POLARIS_SECRET_A and forensic master key"
POL_A="$(openssl rand -base64 32 | tr -d '=' | tr '/+' '_-')"
FORENSIC_MASTER="$(openssl rand -base64 32 | tr -d '\n')"
ANCHOR_SIGN="$(openssl rand -base64 32 | tr -d '\n')"
ARGON_PEPPER="$(openssl rand -base64 32 | tr -d '\n')"

for svc in api out in fanout forensic synthetic janitor staleness anchor; do
  case "$svc" in
    api)        printf '%s' "$POL_A"          | (cd "services/$svc" && wrangler secret put POLARIS_SECRET_A) ;;
    api)        printf '%s' "$ARGON_PEPPER"   | (cd "services/$svc" && wrangler secret put ARGON2_PEPPER) ;;
    forensic)   printf '%s' "$FORENSIC_MASTER"| (cd "services/$svc" && wrangler secret put FORENSIC_MASTER_KEY) ;;
    anchor)     printf '%s' "$ANCHOR_SIGN"    | (cd "services/$svc" && wrangler secret put ANCHOR_SIGNING_KEY) ;;
  esac || true
done

echo "==> 6/8 deploy Workers"
for svc in api out in fanout forensic synthetic janitor staleness anchor; do
  (cd "services/$svc" && wrangler deploy) || true
done

echo "==> 7/8 seed the bootstrap admin key (one-time WebAuthn-gated URL)"
TS=$(date +%s)000
NONCE=$(openssl rand -hex 12)
BH=$(printf '%s' '{}' | openssl dgst -sha256 -hex | awk '{print $2}')
CANON="polaris-api.v1\nPOST\n/admin/bootstrap\n\n$TS\n$NONCE\n$BH"
SIG=$(printf "%b" "$CANON" | openssl dgst -sha256 -hmac "$POL_A" -hex | awk '{print $2}')
API_URL="$(jq -r '.vars.API_BASE_URL // empty' services/api/wrangler.jsonc 2>/dev/null || echo 'https://polaris-email-api.workers.dev')"
RESP=$(curl -sS -X POST "$API_URL/admin/bootstrap" \
  -H 'content-type: application/json' \
  -H "x-polaris-ts: $TS" -H "x-polaris-nonce: $NONCE" -H "x-polaris-sig: v1=$SIG" \
  -d '{}' || echo '{"error":"bootstrap_failed"}')
ADMIN_ID=$(echo "$RESP" | jq -r '.admin_key_id // empty')
ADMIN_SECRET=$(echo "$RESP" | jq -r '.admin_key_secret // empty')
if [[ -n "$ADMIN_ID" && -n "$ADMIN_SECRET" ]]; then
  cat <<EOF >&2

============================================================
  Bootstrap admin key — copy this once. It will NOT be shown again.

    POLARIS_EMAIL_KEY_ID=$ADMIN_ID
    POLARIS_EMAIL_KEY_SECRET=$ADMIN_SECRET

  Stash it in your password manager and use it to:
    - register your domains (POST /v1/admin/domains)
    - issue per-service API keys (POST /v1/admin/api-keys)
============================================================
EOF
else
  echo "$RESP" >&2
fi

echo "==> 8/8 next steps"
cat <<EOF
- Add DNS records (MX + DKIM CNAMEs + SPF + DMARC) for every domain you onboard.
- On the bridge host: cd apps/bridge && cp .env.example .env && docker compose up -d.
- Open the panel and run the Diagnostics page; all checks must be green.
EOF
