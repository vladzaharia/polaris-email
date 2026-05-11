#!/usr/bin/env bash
# Flip a domain's MX records to a holding host (any host that 4xx-tempfails inbound).
set -euo pipefail
FROM_DOMAIN="${1:-}"
TO_HOLDING="${2:-}"
if [[ -z "$FROM_DOMAIN" || -z "$TO_HOLDING" ]]; then
  echo "usage: bin/killswitch-mx-flip.sh <from-domain> <to-holding-host>" >&2
  exit 2
fi
# Cloudflare DNS API: requires CF_API_TOKEN with Zone.DNS edit on the zone.
ZONE_ID=$(curl -sS -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=$FROM_DOMAIN" | jq -r '.result[0].id')
[[ -n "$ZONE_ID" && "$ZONE_ID" != "null" ]] || { echo "zone not found"; exit 1; }
# Delete existing MX records, then add a single MX pointing at the holding host with priority 10.
EXISTING=$(curl -sS -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?type=MX&name=$FROM_DOMAIN" | jq -r '.result[].id')
for id in $EXISTING; do
  curl -sS -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$id" >/dev/null
done
curl -sS -X POST -H "Authorization: Bearer $CF_API_TOKEN" -H 'content-type: application/json' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -d "$(jq -nc --arg n "$FROM_DOMAIN" --arg c "$TO_HOLDING" '{type:"MX",name:$n,content:$c,priority:10,ttl:60}')" >/dev/null
echo "MX for $FROM_DOMAIN now points at $TO_HOLDING (priority 10, TTL 60). Revert by re-applying your normal DNS."
