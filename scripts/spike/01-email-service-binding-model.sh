#!/usr/bin/env bash
# Spike 1: Is the EMAIL binding account-level or per-domain?
#
# Strategy: list account-level Email Service onboarding state. If the API exposes
# a single binding shape that takes `from` per-call (account-level), we're good.
# If onboarding produces a per-domain binding token / handle, the design needs
# rework.
#
# The current Cloudflare docs as of May 2026 are ambiguous on this; this spike
# is the authoritative answer.

source "$(dirname "$0")/_lib.sh"
require_jq

echo "==> Checking Email Service availability on account $CF_ACCOUNT_ID"
echo

# 1. Is Email Service enabled? Endpoint may differ; try documented + plausible variants.
echo "--- GET /accounts/{id}/email-service (documented) ---"
RESP1=$(cf_get "/accounts/$CF_ACCOUNT_ID/email-service" || true)
echo "$RESP1" | jq . 2>/dev/null || echo "$RESP1"
echo

echo "--- GET /accounts/{id}/email/service (alternate) ---"
RESP2=$(cf_get "/accounts/$CF_ACCOUNT_ID/email/service" || true)
echo "$RESP2" | jq . 2>/dev/null || echo "$RESP2"
echo

# 2. Inspect a sample wrangler.toml binding for an existing Worker. If the binding
#    declaration doesn't include a domain, it's account-level.
echo "Inspect your current wrangler.local.jsonc files for an [[email]] or"
echo "[[send_email]] binding stanza. Account-level looks like:"
echo
echo "  [[send_email]]"
echo "  name = \"EMAIL\""
echo
echo "Per-domain looks like:"
echo
echo "  [[send_email]]"
echo "  name = \"EMAIL_ACME_COM\""
echo "  destination_address = \"verified@acme.com\""
echo
echo "If the binding omits destination_address, it's account-level."

# 3. Check the existing services/out wrangler config.
LOCAL_WRANGLER=$(find ../../../../services/out -name "wrangler*.jsonc" -o -name "wrangler*.toml" 2>/dev/null | head -1 || true)
if [[ -n "$LOCAL_WRANGLER" ]]; then
  echo
  echo "--- Existing services/out binding ---"
  cat "$LOCAL_WRANGLER"
fi

result "MANUAL" "Inspect responses above + existing wrangler config; document conclusion in docs/spike/results.md"
