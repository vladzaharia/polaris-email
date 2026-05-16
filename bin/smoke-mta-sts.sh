#!/usr/bin/env bash
# smoke-mta-sts.sh — gated end-to-end probe. Requires SMOKE_MTA_STS_DOMAIN_ID
# pointing at a real, verified domain. Verifies MTA-STS + TLS-RPT records are
# present + match the stored policy_id/rua.
#
# Safe to run repeatedly. Designed for nightly CI on main.
set -uo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT" || exit 1
load_env_deploy

: "${SMOKE_MTA_STS_DOMAIN_ID:?set SMOKE_MTA_STS_DOMAIN_ID to a verified domain id}"

fail=0
pass() { printf '  PASS %s\n' "$*"; }
warn() { printf '  WARN %s\n' "$*"; }
err()  { printf '  FAIL %s\n' "$*"; fail=1; }

# Run the verify endpoint and inspect the returned checks.
resp="$(polaris_api_call POST "/v1/admin/domains/${SMOKE_MTA_STS_DOMAIN_ID}/verify" '' 1)"

# All MTA-STS sub-checks ok?
mta_ok=$(printf '%s' "$resp" | jq '[.checks[] | select(.name | startswith("mta-sts:"))] | (length > 0) and (all(.ok))')
if [[ "$mta_ok" == "true" ]]; then
  pass "all MTA-STS checks ok"
else
  err "MTA-STS verify checks failing"
  printf '%s' "$resp" | jq '.checks[] | select((.name | startswith("mta-sts:")) and (.ok == false))' >&2 || true
fi

# All TLS-RPT sub-checks ok?
tls_ok=$(printf '%s' "$resp" | jq '[.checks[] | select(.name | startswith("tls-rpt:"))] | (length > 0) and (all(.ok))')
if [[ "$tls_ok" == "true" ]]; then
  pass "all TLS-RPT checks ok"
else
  warn "TLS-RPT verify checks failing (non-fatal)"
  printf '%s' "$resp" | jq '.checks[] | select((.name | startswith("tls-rpt:")) and (.ok == false))' >&2 || true
fi

# Any operator-action hints?
ops=$(printf '%s' "$resp" | jq '[.checks[] | select(.name | contains(":operator-action:"))] | length')
if [[ "$ops" -ne 0 ]]; then
  err "${ops} operator-action hint(s) present - manual intervention required"
fi

exit $fail
