#!/usr/bin/env bash
# W2 — backfill-postmaster-receivers.sh
#
# Creates the three RFC 2142 complaint receivers (postmaster, abuse,
# webmaster) for every onboarded domain that's missing them. Pointed at the
# platform-owned `polaris-platform-complaints` mailbox seeded by migration
# 0011. Idempotent — domains that already have the receivers are skipped.
#
# Run ONCE after migrating to schema 0011. Re-runs are safe.
#
# Required env: POLARIS_API_HOSTNAME, POLARIS_ADMIN_KEY_ID,
# POLARIS_ADMIN_KEY_SECRET (loaded via _lib.sh from .env.deploy).
set -uo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT" || exit 1
load_env_deploy

PLATFORM_MAILBOX_ID="01HXPLATFORMCOMPLAINTS0000"
PATTERNS=("postmaster@*" "abuse@*" "webmaster@*")

domains_json="$(polaris_api_call GET /v1/admin/domains '' 1)"
total=$(printf '%s' "$domains_json" | jq '.data | length')
echo "Scanning ${total} domains for missing complaint receivers..."

fail=0
created=0
skipped=0

while IFS=$'\t' read -r id name; do
  # Pull existing receivers for this domain pointed at the platform mailbox.
  existing="$(polaris_api_call GET "/v1/admin/mailboxes/${PLATFORM_MAILBOX_ID}/receivers?domain_id=${id}" '' 1 2>/dev/null || echo '{"data":[]}')"
  existing_patterns="$(printf '%s' "$existing" | jq -r '.data[]?.address_pattern' 2>/dev/null | sort -u)"

  missing=()
  for p in "${PATTERNS[@]}"; do
    if ! grep -qx "$p" <<<"$existing_patterns" 2>/dev/null; then
      missing+=("$p")
    fi
  done

  if [[ "${#missing[@]}" -eq 0 ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  printf '  -> %-40s missing=%s\n' "$name" "$(IFS=,; echo "${missing[*]}")"
  for p in "${missing[@]}"; do
    body=$(cat <<JSON
{
  "mailbox_id": "${PLATFORM_MAILBOX_ID}",
  "domain_id": "${id}",
  "priority": 10,
  "address_pattern": "${p}",
  "action": "webhook"
}
JSON
    )
    if polaris_api_call POST "/v1/admin/mailboxes/${PLATFORM_MAILBOX_ID}/receivers" "$body" 1 >/dev/null 2>&1; then
      created=$((created + 1))
    else
      printf '     FAIL: %s for domain %s\n' "$p" "$name" >&2
      fail=1
    fi
  done
done < <(printf '%s' "$domains_json" | jq -r '.data[] | "\(.id)\t\(.name)"')

echo ""
echo "Summary: created=${created} skipped=${skipped} domains failed=${fail}"

if [[ "$fail" -ne 0 ]]; then
  echo "One or more receiver creates failed. Inspect logs + re-run."
  exit 1
fi
