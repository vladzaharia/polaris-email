#!/usr/bin/env bash
# register-consumer.sh — admin-signed POST /v1/admin/webhook-subs. Prints the new signing secret.
# Usage:
#   bin/register-consumer.sh --name <label> --webhook-url <url> --kind external|tailnet|bridge --events <csv>
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

NAME=""; URL=""; KIND=""; EVENTS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)        NAME="$2"; shift 2 ;;
    --webhook-url) URL="$2";  shift 2 ;;
    --kind)        KIND="$2"; shift 2 ;;
    --events)      EVENTS="$2"; shift 2 ;;
    *) die "unknown arg: $1" ;;
  esac
done
[[ -n "$NAME"   ]] || die "missing --name"
[[ -n "$URL"    ]] || die "missing --webhook-url"
[[ -n "$KIND"   ]] || die "missing --kind"
[[ -n "$EVENTS" ]] || die "missing --events"
case "$KIND" in external|tailnet|bridge) : ;; *) die "--kind must be external|tailnet|bridge" ;; esac
[[ -f "$BOOTSTRAP_OUTPUT" ]] || die "no $BOOTSTRAP_OUTPUT — run \`make bootstrap\` first"

body="$(jq -nc \
  --arg name "$NAME" --arg url "$URL" --arg kind "$KIND" \
  --argjson events "$(jq -Rcn --arg v "$EVENTS" '$v | split(",") | map(select(length>0))')" \
  '{name:$name, webhook_url:$url, kind:$kind, events:$events}')"

resp="$(polaris_api_call POST /v1/admin/webhook-subs "$body" 1)"
sub_id="$(printf '%s' "$resp" | jq -r '.subscription_id // empty')"
secret="$(printf '%s' "$resp" | jq -r '.signing_secret // empty')"
if [[ -z "$sub_id" || -z "$secret" ]]; then
  echo "$resp" >&2
  die "register-consumer: server did not return subscription_id+signing_secret"
fi

cat <<EOF
============================================================
  Webhook subscription '$NAME' created — copy the signing secret now.
    SUBSCRIPTION_ID=$sub_id
    SIGNING_SECRET=$secret
  webhook url:  $URL
  kind:         $KIND
  events:       $EVENTS
============================================================
EOF
