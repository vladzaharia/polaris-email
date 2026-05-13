#!/usr/bin/env bash
# smoke.sh — end-to-end health probe. Returns nonzero on any FAIL.
set -uo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT" || exit 1

load_env_deploy

FAIL=0
pass() { printf '  PASS %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; FAIL=1; }

API_URL="https://${POLARIS_API_HOSTNAME}"

echo "polaris-email smoke against $API_URL"

# 1) /healthz on api
code="$(curl -sS -o /tmp/polaris-smoke-health.$$ -w '%{http_code}' "$API_URL/healthz" || echo 000)"
if [[ "$code" == "200" ]]; then
  pass "GET /healthz -> 200"
else
  fail "GET /healthz -> $code"
  cat /tmp/polaris-smoke-health.$$ >&2 || true
fi
rm -f /tmp/polaris-smoke-health.$$

# 2) Signed admin diagnostics — exercises D1, R2, KV, queue write.
if [[ -f "$BOOTSTRAP_OUTPUT" ]]; then
  resp="$(polaris_api_call GET /v1/admin/diagnostics '' 1 || true)"
  if printf '%s' "$resp" | jq -e '.ok == true' >/dev/null 2>&1; then
    pass "signed /v1/admin/diagnostics -> ok"
  else
    fail "signed /v1/admin/diagnostics: $resp"
  fi
else
  fail "no .bootstrap-output.json — cannot run signed diagnostics"
fi

# 3) Enqueue a synthetic outbound and poll for delivery.
if [[ -f "$BOOTSTRAP_OUTPUT" && -n "${SYNTHETIC_FROM:-}" && -n "${SYNTHETIC_TO:-}" ]]; then
  msg_id="smoke-$(date +%s)-$$"
  body="$(jq -nc --arg from "$SYNTHETIC_FROM" --arg to "$SYNTHETIC_TO" --arg id "$msg_id" \
    '{from:$from, to:[$to], subject:"polaris smoke", text:"smoke", idempotency_key:$id}')"
  resp="$(polaris_api_call POST /v1/messages "$body" 1 || true)"
  if printf '%s' "$resp" | jq -e '.message_id' >/dev/null 2>&1; then
    mid="$(printf '%s' "$resp" | jq -r '.message_id')"
    pass "enqueued synthetic outbound: $mid"
    # Poll for status up to 60s.
    delivered=0
    for _ in $(seq 1 12); do
      sleep 5
      status_resp="$(polaris_api_call GET "/v1/messages/$mid" '' 1 || true)"
      st="$(printf '%s' "$status_resp" | jq -r '.status // empty')"
      if [[ "$st" == "delivered" ]]; then delivered=1; break; fi
      if [[ "$st" == "bounced" || "$st" == "failed" ]]; then
        fail "synthetic message $mid status=$st"
        break
      fi
    done
    if [[ "$delivered" -eq 1 ]]; then
      pass "synthetic message $mid delivered within 60s"
    elif [[ "$FAIL" -eq 0 ]]; then
      fail "synthetic message $mid did not reach delivered within 60s"
    fi
  else
    fail "could not enqueue synthetic outbound: $resp"
  fi
else
  echo "  skip synthetic enqueue (no admin key or SYNTHETIC_FROM/TO unset)"
fi

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "smoke: all checks passed"
  exit 0
fi
echo "smoke: one or more checks failed" >&2
exit 1
