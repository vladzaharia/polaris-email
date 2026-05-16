#!/usr/bin/env bash
# backfill-mta-sts.sh — opt-in: enable MTA-STS (testing mode) + TLS-RPT for
# every verified, inbound-enabled domain that doesn't yet have MTA-STS
# published. Idempotent (the underlying enable endpoints are no-ops on
# already-provisioned records).
#
# Operator runs ONCE after rolling out Phase C. Re-runs are safe.
#
# Required env: POLARIS_API_HOSTNAME, POLARIS_ADMIN_KEY_ID,
# POLARIS_ADMIN_KEY_SECRET (loaded via _lib.sh from .env.deploy).
set -uo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT" || exit 1
load_env_deploy

domains_json="$(polaris_api_call GET /v1/admin/domains '' 1)"
total=$(printf '%s' "$domains_json" | jq '.data | length')
candidates=$(printf '%s' "$domains_json" | jq '[.data[] | select(.status == "verified" and .inbound_enabled == 1 and ((.mta_sts_mode // "none") == "none"))] | length')
echo "Backfill candidates: ${candidates} / ${total} domains"

if [[ "$candidates" -eq 0 ]]; then
  echo "Nothing to do. All eligible domains already have MTA-STS enabled."
  exit 0
fi

fail=0
while IFS=$'\t' read -r id name; do
  printf '  -> %-40s ' "$name"
  if polaris_api_call POST "/v1/admin/domains/${id}/mta-sts/enable" '{}' 1 >/dev/null; then
    printf 'mta-sts:ok '
  else
    printf 'mta-sts:FAIL '
    fail=1
  fi
  if polaris_api_call POST "/v1/admin/domains/${id}/tls-rpt/enable" '{}' 1 >/dev/null; then
    printf 'tls-rpt:ok\n'
  else
    printf 'tls-rpt:FAIL\n'
    fail=1
  fi
done < <(printf '%s' "$domains_json" | jq -r '
  .data[]
  | select(.status == "verified" and .inbound_enabled == 1 and ((.mta_sts_mode // "none") == "none"))
  | "\(.id)\t\(.name)"
')

if [[ "$fail" -ne 0 ]]; then
  echo "One or more enables failed. Inspect logs + re-run."
  exit 1
fi

echo "Done. Run \`make smoke\` or \`bin/smoke-mta-sts.sh\` to verify."
