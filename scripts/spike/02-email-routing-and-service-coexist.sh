#!/usr/bin/env bash
# Spike 2: Can Email Routing (inbound MX) and Email Service (outbound) coexist on
# the same zone, including the cf-bounce MX?

source "$(dirname "$0")/_lib.sh"
require_jq
require_env CF_TEST_ZONE_ID
require_env CF_TEST_DOMAIN

echo "==> Inspecting Email Routing state for zone $CF_TEST_DOMAIN ($CF_TEST_ZONE_ID)"
echo

echo "--- Email Routing settings ---"
cf_get "/zones/$CF_TEST_ZONE_ID/email/routing" | jq .
echo

echo "--- Email Routing rules ---"
cf_get "/zones/$CF_TEST_ZONE_ID/email/routing/rules" | jq '.result[] | {tag, name, enabled, matchers, actions}'
echo

echo "--- DNS records (MX) ---"
cf_get "/zones/$CF_TEST_ZONE_ID/dns_records?type=MX" | jq '.result[] | {name, content, priority}'
echo

echo "--- DNS records (TXT for SPF/DMARC/DKIM) ---"
cf_get "/zones/$CF_TEST_ZONE_ID/dns_records?type=TXT" | jq '.result[] | {name, content}' | head -100
echo

echo "Expected coexistence pattern:"
echo "  - MX records: route1/2/3.mx.cloudflare.net (Email Routing) AND cf-bounce.* (Email Service)"
echo "  - The cf-bounce MX should be on a sibling subdomain or distinct priority"
echo
echo "If the MX records conflict (same hostname, both Email Routing and bounce), document it."

result "MANUAL" "Inspect MX list + Email Routing rule list; verify both can coexist without overwriting each other"
