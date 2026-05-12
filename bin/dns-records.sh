#!/usr/bin/env bash
# dns-records.sh — print (or with --apply, push) the DNS records polaris-email needs for a domain.
# Usage:
#   bin/dns-records.sh example.com           # print only
#   bin/dns-records.sh --apply example.com   # push via CF API (requires CF_API_TOKEN + CF_ZONE_ID)
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

APPLY=0
DOMAIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    -*)      die "unknown flag: $1" ;;
    *)       DOMAIN="$1"; shift ;;
  esac
done
[[ -n "$DOMAIN" ]] || die "usage: bin/dns-records.sh [--apply] <domain>"

load_env_deploy

# DKIM CNAME targets come from Cloudflare Email Routing. Try to fetch real values; fall back to placeholders.
DKIM_OUT="$(wrangler email routing dns "$DOMAIN" --jurisdiction default 2>/dev/null || true)"
echo "# polaris-email DNS records for $DOMAIN"
echo "# Add these at your authoritative DNS host (Cloudflare DNS recommended)."
echo

cat <<EOF
# 1. Inbound MX — Email Routing
$DOMAIN.   IN   MX 10   route1.mx.cloudflare.net.
$DOMAIN.   IN   MX 20   route2.mx.cloudflare.net.
$DOMAIN.   IN   MX 30   route3.mx.cloudflare.net.

# 2. SPF — authorize Cloudflare Email + polaris-email-out Worker
$DOMAIN.   IN   TXT   "v=spf1 include:_spf.mx.cloudflare.net include:relay.mailchannels.net -all"

# 3. DKIM — from \`wrangler email routing dns $DOMAIN\` (selector cf2024-1 by default)
EOF

if [[ -n "$DKIM_OUT" ]]; then
  printf '%s\n' "$DKIM_OUT"
else
  cat <<EOF
# (run \`wrangler email routing dns $DOMAIN\` once routing is enabled in the dashboard
#  to get the exact selector/CNAME values, then re-run this command.)
cf2024-1._domainkey.$DOMAIN. IN CNAME cf2024-1._domainkey.<your-zone>.cf-email-routing.com.
EOF
fi

cat <<EOF

# 4. DMARC — start at p=none, raise once monitoring is green
_dmarc.$DOMAIN.   IN   TXT   "v=DMARC1; p=none; rua=mailto:postmaster@$DOMAIN; ruf=mailto:postmaster@$DOMAIN; fo=1"

# 5. (Optional) API hostname CNAME, if you front the API on your domain
${POLARIS_API_HOSTNAME:-api.$DOMAIN}.   IN   CNAME   polaris-email-api.workers.dev.
EOF

if [[ "$APPLY" -eq 1 ]]; then
  [[ -n "${CF_API_TOKEN:-}" ]] || die "--apply requires CF_API_TOKEN in .env.deploy"
  [[ -n "${CF_ZONE_ID:-}"   ]] || die "--apply requires CF_ZONE_ID in .env.deploy"
  log "applying records via Cloudflare API (zone $CF_ZONE_ID)"
  cf_create() { # type name content priority
    local type="$1" name="$2" content="$3" prio="${4:-}"
    local body
    if [[ -n "$prio" ]]; then
      body="$(jq -nc --arg t "$type" --arg n "$name" --arg c "$content" --argjson p "$prio" \
        '{type:$t,name:$n,content:$c,priority:$p,proxied:false,ttl:1}')"
    else
      body="$(jq -nc --arg t "$type" --arg n "$name" --arg c "$content" \
        '{type:$t,name:$n,content:$c,proxied:false,ttl:1}')"
    fi
    curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
      -H "Authorization: Bearer $CF_API_TOKEN" \
      -H 'content-type: application/json' \
      --data "$body" | jq -c '{ok:.success, errors:.errors}'
  }
  cf_create MX  "$DOMAIN" route1.mx.cloudflare.net 10
  cf_create MX  "$DOMAIN" route2.mx.cloudflare.net 20
  cf_create MX  "$DOMAIN" route3.mx.cloudflare.net 30
  cf_create TXT "$DOMAIN" '"v=spf1 include:_spf.mx.cloudflare.net include:relay.mailchannels.net -all"'
  cf_create TXT "_dmarc.$DOMAIN" "\"v=DMARC1; p=none; rua=mailto:postmaster@$DOMAIN; fo=1\""
  log "MX/SPF/DMARC pushed. DKIM CNAMEs must be created in the CF Email Routing dashboard (account-scoped)."
fi
