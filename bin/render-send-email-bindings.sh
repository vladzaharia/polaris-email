#!/usr/bin/env bash
# render-send-email-bindings.sh — write services/out/wrangler.local.jsonc with one
# send_email binding per (verified) outbound domain, derived from D1 via the admin API.
#
# Binding naming: EMAIL_DEFAULT (always first) → EMAIL_<DOMAIN_TAG> for each domain,
# where DOMAIN_TAG is the upper-cased domain with non-alphanumerics turned to underscores
# (e.g. plrs.im → PLRS_IM, polaris.video → POLARIS_VIDEO). Operator-supplied
# `binding_tag` overrides the derivation.
#
# Idempotent. Re-runs replace the file in place.
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

load_env_deploy
need jq

OUT_TEMPLATE="services/out/wrangler.local.template.jsonc"
OUT_FILE="services/out/wrangler.local.jsonc"

[[ -f "$OUT_TEMPLATE" ]] || die "missing $OUT_TEMPLATE"

list_resp="$(polaris_api_call GET "/v1/admin/outbound-domains" "" 1 || true)"
rows="$(printf '%s' "$list_resp" | jq -c '.data[]? | select((.disabled_at // null) == null)' 2>/dev/null || true)"

# Build the bindings array.
# - EMAIL_DEFAULT always present, pointing at the is_default=1 domain's primary sender
#   (if known) or just declared without a destination_address so wrangler accepts it
#   for catch-all use.
# - One EMAIL_<TAG> per domain.
default_domain=""
default_addr=""
binding_entries=""

derive_tag() {
  printf '%s' "$1" | awk '{ s=toupper($0); gsub(/[^A-Z0-9]+/, "_", s); print s }'
}

while IFS= read -r row; do
  [[ -z "$row" ]] && continue
  domain="$(printf '%s' "$row" | jq -r '.domain')"
  is_default="$(printf '%s' "$row" | jq -r '.is_default // 0')"
  override_tag="$(printf '%s' "$row" | jq -r '.binding_tag // empty')"
  tag="${override_tag:-$(derive_tag "$domain")}"
  if [[ "$is_default" == "1" ]]; then
    default_domain="$domain"
    default_addr="postmaster@${domain}"
  fi
  entry="$(jq -nc --arg name "EMAIL_${tag}" --arg addr "postmaster@${domain}" \
            '{name:$name, destination_address:$addr}')"
  if [[ -z "$binding_entries" ]]; then
    binding_entries="$entry"
  else
    binding_entries="${binding_entries},${entry}"
  fi
done <<< "$rows"

# EMAIL_DEFAULT goes first.
if [[ -n "$default_addr" ]]; then
  default_entry="$(jq -nc --arg addr "$default_addr" '{name:"EMAIL_DEFAULT", destination_address:$addr}')"
else
  default_entry='{"name":"EMAIL_DEFAULT"}'
fi
if [[ -z "$binding_entries" ]]; then
  send_email_arr="[${default_entry}]"
else
  send_email_arr="[${default_entry},${binding_entries}]"
fi

# Pretty-print the array so the diff is reviewable.
pretty_arr="$(printf '%s' "$send_email_arr" | jq .)"

# Render the template normally (so all ${VAR} placeholders get substituted), then
# splice in our send_email array. We rely on render-wrangler-local.sh having run
# already (it writes the file from the template); if it hasn't, do the substitution
# inline using envsubst.
if [[ ! -f "$OUT_FILE" || "$OUT_TEMPLATE" -nt "$OUT_FILE" ]]; then
  log "$OUT_FILE missing or stale — rendering from template first"
  D1_ID="$(state_get '.d1["polaris-email"].id')"
  export D1_ID
  # shellcheck disable=SC2016  # envsubst placeholder list must remain literal $VAR
  VARS='${CF_ACCOUNT_ID} ${D1_ID}'
  envsubst "$VARS" < "$OUT_TEMPLATE" > "$OUT_FILE.tmp"
  mv "$OUT_FILE.tmp" "$OUT_FILE"
fi

# Splice: replace the send_email array in $OUT_FILE.
# The file is JSONC (allows comments); we use a simple sentinel-anchored awk replace
# rather than a JSON parser, to preserve comments.
tmp_out="$(mktemp -t polaris-out.XXXXXX)"
python3 - "$OUT_FILE" "$pretty_arr" "$tmp_out" <<'PY'
import json, re, sys
src_path, arr_json, dst_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src_path) as f:
    text = f.read()
# Find `"send_email"\s*:\s*\[ ... \]`. The template's array is on one line; we
# match across newlines and balance brackets manually.
m = re.search(r'"send_email"\s*:\s*\[', text)
if not m:
    sys.stderr.write("send_email key not found in " + src_path + "\n")
    sys.exit(1)
start = m.end() - 1  # at '['
depth = 0
i = start
while i < len(text):
    ch = text[i]
    if ch == '[':
        depth += 1
    elif ch == ']':
        depth -= 1
        if depth == 0:
            end = i + 1
            break
    i += 1
else:
    sys.stderr.write("unbalanced send_email array in " + src_path + "\n")
    sys.exit(1)
new = text[:start] + arr_json + text[end:]
with open(dst_path, "w") as f:
    f.write(new)
PY
mv "$tmp_out" "$OUT_FILE"

log "rendered send_email bindings in $OUT_FILE"
log "  domains: $(printf '%s' "$rows" | jq -r '.domain' | tr '\n' ' ')"
[[ -n "$default_domain" ]] && log "  default: $default_domain"
