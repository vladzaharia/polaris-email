#!/usr/bin/env bash
# issue-key.sh — sign an admin call to POST /v1/admin/api-keys, print the new key once.
# Usage:
#   bin/issue-key.sh --name <label> --scopes <csv> [--sender-scopes <csv>] [--out file:path]
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

NAME=""; SCOPES=""; SENDER_SCOPES=""; OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)          NAME="$2"; shift 2 ;;
    --scopes)        SCOPES="$2"; shift 2 ;;
    --sender-scopes) SENDER_SCOPES="$2"; shift 2 ;;
    --out)           OUT="$2"; shift 2 ;;
    *) die "unknown arg: $1" ;;
  esac
done
[[ -n "$NAME"   ]] || die "missing --name"
[[ -n "$SCOPES" ]] || die "missing --scopes"
[[ -f "$BOOTSTRAP_OUTPUT" ]] || die "no $BOOTSTRAP_OUTPUT — run \`make bootstrap\` first"

# Build the request body. scopes/sender-scopes are CSV → JSON arrays.
csv_to_arr() {
  jq -Rcn --arg v "$1" '$v | split(",") | map(select(length>0))'
}
body="$(jq -nc \
  --arg name "$NAME" \
  --argjson scopes "$(csv_to_arr "$SCOPES")" \
  --argjson sender_scopes "$(csv_to_arr "$SENDER_SCOPES")" \
  '{name:$name, scopes:$scopes, sender_scopes:$sender_scopes}')"

resp="$(polaris_api_call POST /v1/admin/api-keys "$body" 1)"
kid="$(printf '%s' "$resp" | jq -r '.key_id // empty')"
ksec="$(printf '%s' "$resp" | jq -r '.key_secret // empty')"
if [[ -z "$kid" || -z "$ksec" ]]; then
  echo "$resp" >&2
  die "issue-key: server did not return key_id+key_secret"
fi

case "$OUT" in
  file:*)
    path="${OUT#file:}"
    umask 077
    printf '{"name":"%s","key_id":"%s","key_secret":"%s"}\n' "$NAME" "$kid" "$ksec" > "$path"
    log "wrote $path (mode 0600)"
    ;;
  1password://*)
    warn "1Password output not implemented in this script — printing to stdout instead"
    ;;
  "")
    : ;;
esac

cat <<EOF
============================================================
  API key '$NAME' — copy now, will not be shown again.
    KEY_ID=$kid
    KEY_SECRET=$ksec
  scopes:        $SCOPES
  sender_scopes: ${SENDER_SCOPES:-(none)}
============================================================
EOF
