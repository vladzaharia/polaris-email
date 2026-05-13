#!/usr/bin/env bash
# Spike 3: Wildcard DKIM CNAME + wildcard Email Routing rule for subdomains.
#
# Strategy:
#   1. Add a wildcard DKIM CNAME (*._domainkey.<zone>) pointing to the parent's DKIM target.
#   2. Add an Email Routing catch-all rule scoped to *@*.<zone>.
#   3. Send a test message from noreply@spike.<zone> via Email Service (outbound) and
#      confirm DKIM=pass at the receiver (use Mailosaur or external "check my mail" service).
#   4. Send a test message TO test@spike.<zone> from outside and confirm Email Routing
#      delivers it via the wildcard rule.
#
# This script provisions the records; sending the test mails is manual.

source "$(dirname "$0")/_lib.sh"
require_jq
require_env CF_TEST_ZONE_ID
require_env CF_TEST_DOMAIN

PROBE_SUB="spike-$(date +%s)"
PROBE_FQDN="$PROBE_SUB.$CF_TEST_DOMAIN"

echo "==> Provisioning wildcard records on $CF_TEST_DOMAIN; subdomain probe = $PROBE_FQDN"
echo

# 1. Wildcard DKIM CNAME — adjust target to the actual selector your zone uses.
# For Cloudflare Email Service, the DKIM CNAME shape is typically:
#   <selector>._domainkey.<zone>  CNAME  <selector>.email-service.cloudflare.com
# We add a wildcard pointing to the same target, so subdomains inherit.
SELECTOR="cf2024-1"
DKIM_TARGET="${SELECTOR}.email-service.cloudflare.com"

echo "--- Adding wildcard DKIM CNAME ---"
DKIM_PAYLOAD=$(jq -n --arg name "*._domainkey.$CF_TEST_DOMAIN" --arg target "$DKIM_TARGET" \
  '{type: "CNAME", name: $name, content: $target, ttl: 300, proxied: false, comment: "polaris-email spike: wildcard DKIM"}')
cf_post "/zones/$CF_TEST_ZONE_ID/dns_records" "$DKIM_PAYLOAD" | jq '.success, .errors'

# 2. Wildcard Email Routing rule scoped to *@*.<zone>
echo
echo "--- Adding wildcard Email Routing rule ---"
RULE_PAYLOAD=$(jq -n --arg pattern "*@*.$CF_TEST_DOMAIN" \
  '{name: "polaris spike wildcard", enabled: true, matchers: [{type: "literal", field: "to", value: $pattern}], actions: [{type: "drop"}], priority: 100}')
cf_post "/zones/$CF_TEST_ZONE_ID/email/routing/rules" "$RULE_PAYLOAD" | jq .

echo
echo "==> Manual verification:"
echo "  1. From an external mailbox, send to test@$PROBE_FQDN — confirm Email Routing accepts (rule matched, then dropped)."
echo "  2. From the test Worker, EMAIL.send({from: 'noreply@$PROBE_FQDN', ...}) and confirm DKIM=pass at receiver."
echo "  3. If literal matcher rejects '*@*.<zone>', try matcher type 'all' (catch-all on the zone) — Cloudflare may not support glob-in-domain."
echo
echo "==> Cleanup hints:"
echo "  - List rules: cf_get \"/zones/$CF_TEST_ZONE_ID/email/routing/rules\""
echo "  - List DNS:   cf_get \"/zones/$CF_TEST_ZONE_ID/dns_records?name=*._domainkey.$CF_TEST_DOMAIN\""

result "MANUAL" "Send the two probes above; record DKIM=pass + rule-match observations in results.md"
