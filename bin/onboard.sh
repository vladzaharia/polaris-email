#!/usr/bin/env bash
# onboard.sh — converge outbound domains end-to-end.
#
# For each domain (or a single `--domain <name>`):
#   1. Resolve CF zone id (and cache to D1 via the admin API).
#   2. Read current zone DNS records.
#   3. Compute desired records (MX / SPF / DKIM CNAME / DMARC / mox._domainkey TXT).
#   4. Plan (create/update/delete) — only delete records tagged `comment="polaris-email"`.
#   5. Ensure Cloudflare Email Routing is enabled on the zone (idempotent).
#   6. Ensure a catch-all routing rule named `polaris-email-catchall` exists, pointing
#      at the `polaris-email-in` Worker.
#
# `--plan` prints the diff and exits 0 without writes.
# `--domain <name>` restricts to one domain (positional argument also accepted).
# `--create` (or `NEW=1` env) auto-creates the outbound_domain row if missing.
#
# Reads the admin API list via polaris_api_call (HMAC-signed). After successful
# convergence, calls bin/render-send-email-bindings.sh so services/out picks up new
# EMAIL_* bindings on the next deploy.
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

PLAN=0
DOMAIN=""
CREATE="${NEW:-0}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)           PLAN=1; shift ;;
    --apply)          PLAN=0; shift ;;
    --domain)         DOMAIN="$2"; shift 2 ;;
    --create|--new)   CREATE=1; shift ;;
    -h|--help)
      cat <<EOF
usage: bin/onboard.sh [--plan] [--domain <name>] [--create]

  --plan          Print the per-record diff and exit (no writes).
  --domain NAME   Restrict to a single outbound domain.
  --create        If --domain is set but no outbound_domain row exists, create one.

Without --domain, converges every outbound_domain in D1.
EOF
      exit 0 ;;
    -*) die "unknown flag: $1" ;;
    *)  DOMAIN="$1"; shift ;;
  esac
done

load_env_deploy
need jq
need curl
need openssl

[[ -n "${CF_API_TOKEN:-}"   ]] || die "CF_API_TOKEN missing in .env.deploy"
[[ -n "${CF_ACCOUNT_ID:-}"  ]] || die "CF_ACCOUNT_ID missing in .env.deploy"

CF_API="https://api.cloudflare.com/client/v4"
POLARIS_COMMENT="polaris-email"   # we only delete records carrying this comment

# cf_call <method> <path> [body]
cf_call() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" "${CF_API}${path}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H 'content-type: application/json')
  if [[ -n "$body" ]]; then
    args+=(--data "$body")
  fi
  curl "${args[@]}"
}

# Print a CF error envelope to stderr if .success != true; return 1 in that case.
cf_check() {
  local resp="$1" context="$2"
  if [[ "$(printf '%s' "$resp" | jq -r '.success // false')" != "true" ]]; then
    printf '[polaris][cf-error] %s\n%s\n' "$context" "$resp" >&2
    return 1
  fi
}

# Resolve a zone id by name. Cache to /tmp for the run.
declare -A ZONE_CACHE=()
resolve_zone_id() {
  local name="$1"
  if [[ -n "${ZONE_CACHE[$name]:-}" ]]; then
    printf '%s' "${ZONE_CACHE[$name]}"
    return 0
  fi
  local resp zid
  resp="$(cf_call GET "/zones?name=${name}&account.id=${CF_ACCOUNT_ID}&per_page=1")"
  cf_check "$resp" "list zones for $name" || return 1
  zid="$(printf '%s' "$resp" | jq -r '.result[0].id // empty')"
  [[ -n "$zid" ]] || { warn "no CF zone found for $name (operator must add it first)"; return 1; }
  ZONE_CACHE[$name]="$zid"
  printf '%s' "$zid"
}

# Fetch DKIM CNAME records that Cloudflare Email Routing wants on this zone.
# Returns JSONL: {name, content}. Falls back to placeholder if the API is unhelpful.
fetch_dkim_records() {
  local zid="$1" domain="$2"
  local resp
  resp="$(cf_call GET "/zones/${zid}/email/routing/dns")"
  if [[ "$(printf '%s' "$resp" | jq -r '.success // false')" != "true" ]]; then
    # Often returns success even when routing is disabled, with empty result.
    return 0
  fi
  printf '%s' "$resp" | jq -c '.result[]? | select(.type=="CNAME") | {name:.name, content:.content}'
  # The mox._domainkey TXT record value is unknown until Mox boots and generates its
  # private key. We DO NOT fabricate one here.
  # TODO: fetched from Mox after first start — render as TXT mox._domainkey.<domain>
}

# Build the desired record set as JSONL.
# Columns: type | name | content | priority(or "") | comment
desired_records_for() {
  local domain="$1" zid="$2" dmarc_policy="$3" dmarc_rua="$4"
  # MX
  printf 'MX\t%s\troute1.mx.cloudflare.net\t10\t%s\n' "$domain" "$POLARIS_COMMENT"
  printf 'MX\t%s\troute2.mx.cloudflare.net\t20\t%s\n' "$domain" "$POLARIS_COMMENT"
  printf 'MX\t%s\troute3.mx.cloudflare.net\t30\t%s\n' "$domain" "$POLARIS_COMMENT"
  # SPF (Cloudflare Email Routing only; relay.mailchannels.net was incorrect)
  printf 'TXT\t%s\t"v=spf1 include:_spf.mx.cloudflare.net -all"\t\t%s\n' "$domain" "$POLARIS_COMMENT"
  # DMARC
  printf 'TXT\t_dmarc.%s\t"v=DMARC1; p=%s; rua=%s; fo=1"\t\t%s\n' \
    "$domain" "$dmarc_policy" "$dmarc_rua" "$POLARIS_COMMENT"
  # DKIM CNAMEs (best effort)
  while IFS= read -r dkim; do
    [[ -z "$dkim" ]] && continue
    local n c
    n="$(printf '%s' "$dkim" | jq -r '.name')"
    c="$(printf '%s' "$dkim" | jq -r '.content')"
    printf 'CNAME\t%s\t%s\t\t%s\n' "$n" "$c" "$POLARIS_COMMENT"
  done < <(fetch_dkim_records "$zid" "$domain")
}

# Print the current record set we manage on this zone as JSONL of {id,type,name,content,priority,comment}.
current_managed_records() {
  local zid="$1"
  cf_call GET "/zones/${zid}/dns_records?per_page=500" \
    | jq -c --arg c "$POLARIS_COMMENT" \
        '.result[]
         | select((.comment // "") == $c)
         | {id, type, name, content, priority:(.priority // null)}'
}

# Diff desired vs current. Echoes change lines: "+ CREATE", "~ UPDATE", "- DELETE".
# When PLAN=0, performs the writes.
converge_domain() {
  local id="$1" domain="$2" zid="$3" dmarc_policy="$4" dmarc_rua="$5"
  log "==> $domain  (zone=$zid)"

  # Snapshot current managed records into a tmp file.
  local cur_file
  cur_file="$(mktemp -t polaris-cur.XXXXXX)"
  current_managed_records "$zid" > "$cur_file"

  # Snapshot desired records.
  local des_file
  des_file="$(mktemp -t polaris-des.XXXXXX)"
  desired_records_for "$domain" "$zid" "$dmarc_policy" "$dmarc_rua" > "$des_file"

  # Key on (type, name, content [, priority]) for set comparison.
  local cur_keys_file des_keys_file
  cur_keys_file="$(mktemp -t polaris-curk.XXXXXX)"
  des_keys_file="$(mktemp -t polaris-desk.XXXXXX)"
  jq -rs '.[] | "\(.type)|\(.name)|\(.content)|\(.priority // "")"' "$cur_file" \
    | sort > "$cur_keys_file" || true
  awk -F '\t' '{printf "%s|%s|%s|%s\n", $1, $2, $3, $4}' "$des_file" | sort > "$des_keys_file"

  local creates updates deletes
  creates="$(comm -13 "$cur_keys_file" "$des_keys_file" || true)"
  deletes="$(comm -23 "$cur_keys_file" "$des_keys_file" || true)"
  # We treat anything not in CREATE/DELETE as in-sync. No "updates" path needed at the
  # record level: CF doesn't allow editing type/name/content/priority in place anyway —
  # any drift becomes DELETE + CREATE on the right key. But we still print ~ when CF has
  # a record we recognise by (type, name) but the content drifted; in this script that
  # collapses to a delete+create pair which is the safe path.
  updates=""

  if [[ -z "$creates" && -z "$deletes" ]]; then
    log "    in sync"
  fi
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    printf '    + CREATE  %s\n' "$line"
  done <<< "${creates:-}"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    printf '    - DELETE  %s\n' "$line"
  done <<< "${deletes:-}"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    printf '    ~ UPDATE  %s\n' "$line"
  done <<< "${updates:-}"

  if [[ "$PLAN" -eq 1 ]]; then
    rm -f "$cur_file" "$des_file" "$cur_keys_file" "$des_keys_file"
    return 0
  fi

  # Apply DELETEs first (lets us re-create the same name without conflicts).
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    local rid
    rid="$(jq -rs --arg k "$key" \
            '.[] | select("\(.type)|\(.name)|\(.content)|\(.priority // "")" == $k) | .id' \
            "$cur_file" | head -1)"
    if [[ -n "$rid" ]]; then
      local resp
      resp="$(cf_call DELETE "/zones/${zid}/dns_records/${rid}")"
      if cf_check "$resp" "delete record $rid"; then
        printf '    OK delete %s\n' "$key"
      fi
    fi
  done <<< "${deletes:-}"

  # Apply CREATEs.
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    IFS='|' read -r rtype rname rcontent rprio <<< "$key"
    local body
    if [[ -n "$rprio" ]]; then
      body="$(jq -nc --arg t "$rtype" --arg n "$rname" --arg c "$rcontent" \
                  --argjson p "$rprio" --arg cm "$POLARIS_COMMENT" \
                  '{type:$t, name:$n, content:$c, priority:$p, ttl:1, proxied:false, comment:$cm}')"
    else
      body="$(jq -nc --arg t "$rtype" --arg n "$rname" --arg c "$rcontent" \
                  --arg cm "$POLARIS_COMMENT" \
                  '{type:$t, name:$n, content:$c, ttl:1, proxied:false, comment:$cm}')"
    fi
    local resp
    resp="$(cf_call POST "/zones/${zid}/dns_records" "$body")"
    if cf_check "$resp" "create $rtype $rname"; then
      printf '    OK create %s\n' "$key"
    fi
  done <<< "${creates:-}"

  rm -f "$cur_file" "$des_file" "$cur_keys_file" "$des_keys_file"

  # Email Routing zone-enable (idempotent — already-enabled returns success).
  local er_resp
  er_resp="$(cf_call POST "/zones/${zid}/email/routing/enable")"
  if cf_check "$er_resp" "enable email routing on $domain"; then
    log "    Email Routing enabled (or already on)"
  else
    warn "    Email Routing enable failed — check CF_API_TOKEN scopes"
  fi

  # Catch-all routing rule pointing at the polaris-email-in Worker.
  local rules_resp rule_id
  rules_resp="$(cf_call GET "/zones/${zid}/email/routing/rules?per_page=200")"
  rule_id="$(printf '%s' "$rules_resp" | jq -r '.result[]? | select(.name == "polaris-email-catchall") | .id' | head -1 || true)"
  local rule_body
  rule_body="$(jq -nc '{
    name: "polaris-email-catchall",
    enabled: true,
    matchers: [{ type: "all" }],
    actions: [{ type: "worker", value: ["polaris-email-in"] }]
  }')"
  if [[ -z "$rule_id" ]]; then
    local resp
    resp="$(cf_call POST "/zones/${zid}/email/routing/rules/catch_all" "$rule_body")"
    if cf_check "$resp" "create catch-all rule"; then
      log "    catch-all routing rule created"
    fi
  else
    # PUT to update if rule already exists (idempotent).
    local resp
    resp="$(cf_call PUT "/zones/${zid}/email/routing/rules/catch_all" "$rule_body")"
    if cf_check "$resp" "update catch-all rule"; then
      log "    catch-all routing rule in sync"
    fi
  fi

  # Cache zone id into D1 via admin API.
  local patch_body
  patch_body="$(jq -nc --arg z "$zid" '{cf_zone_id: $z}')"
  polaris_api_call PATCH "/v1/admin/outbound-domains/${id}" "$patch_body" 1 >/dev/null || \
    warn "    failed to cache cf_zone_id in D1 (admin API)"
}

# ------------------------- main -------------------------

# Pull the list of outbound_domains from the admin API.
list_resp="$(polaris_api_call GET "/v1/admin/outbound-domains" "" 1)"
all_rows="$(printf '%s' "$list_resp" | jq -c '.data[]?' || true)"

# Filter or create on demand.
selected_rows=""
if [[ -n "$DOMAIN" ]]; then
  match_row="$(printf '%s\n' "$all_rows" | jq -c --arg d "$DOMAIN" 'select(.domain == $d)' | head -1 || true)"
  if [[ -z "$match_row" ]]; then
    if [[ "$CREATE" == "1" ]]; then
      log "creating outbound_domains row for $DOMAIN"
      create_resp="$(polaris_api_call POST "/v1/admin/outbound-domains" \
        "$(jq -nc --arg d "$DOMAIN" '{domain:$d}')" 1)"
      new_id="$(printf '%s' "$create_resp" | jq -r '.id // empty')"
      [[ -n "$new_id" ]] || die "could not create outbound_domain row: $create_resp"
      # Re-fetch row.
      match_row="$(polaris_api_call GET "/v1/admin/outbound-domains/${new_id}" "" 1)"
    else
      die "no outbound_domain row for $DOMAIN. Re-run with --create or NEW=1."
    fi
  fi
  selected_rows="$match_row"
else
  selected_rows="$all_rows"
fi

if [[ -z "$selected_rows" ]]; then
  log "no outbound_domains configured. Use \`make onboard DOMAIN=<name> NEW=1\` to add the first."
  exit 0
fi

while IFS= read -r row; do
  [[ -z "$row" ]] && continue
  id="$(printf '%s' "$row" | jq -r '.id')"
  domain="$(printf '%s' "$row" | jq -r '.domain')"
  cached_zid="$(printf '%s' "$row" | jq -r '.cf_zone_id // empty')"
  dmarc_policy="$(printf '%s' "$row" | jq -r '.dmarc_policy // "none"')"
  dmarc_rua="$(printf '%s' "$row" | jq -r '.dmarc_rua // empty')"
  [[ -n "$dmarc_rua" ]] || dmarc_rua="mailto:postmaster@${domain}"

  zid=""
  if [[ -n "$cached_zid" ]]; then
    zid="$cached_zid"
  else
    zid="$(resolve_zone_id "$domain")" || { warn "skipping $domain (no zone)"; continue; }
  fi

  converge_domain "$id" "$domain" "$zid" "$dmarc_policy" "$dmarc_rua"

  # After applying records, call the admin API's /verify endpoint to run the
  # real DoH-backed checks (DKIM CNAME + MX). Report per-check status to the
  # operator. We skip in --plan mode since no records were written.
  if [[ "$PLAN" -eq 0 ]]; then
    verify_resp="$(polaris_api_call POST "/v1/admin/outbound-domains/${id}/verify" '{}' 1 || true)"
    if [[ -n "$verify_resp" ]]; then
      v_status="$(printf '%s' "$verify_resp" | jq -r '.status // "unknown"')"
      log "    verify status: $v_status"
      # Per-check breakdown.
      while IFS= read -r chk; do
        [[ -z "$chk" ]] && continue
        ok="$(printf '%s' "$chk" | jq -r '.ok')"
        name="$(printf '%s' "$chk" | jq -r '.name')"
        if [[ "$ok" == "true" ]]; then
          printf '      OK  %s\n' "$name"
        else
          exp="$(printf '%s' "$chk" | jq -r '.expected // ""')"
          act="$(printf '%s' "$chk" | jq -r '.actual // ""')"
          printf '      FAIL %s  expected=%s  actual=%s\n' "$name" "$exp" "$act"
        fi
      done < <(printf '%s' "$verify_resp" | jq -c '.checks[]?' 2>/dev/null || true)
      v_msg="$(printf '%s' "$verify_resp" | jq -r '.message // empty')"
      [[ -n "$v_msg" ]] && warn "    $v_msg"
    fi
  fi
done <<< "$selected_rows"

# Re-render the send_email bindings now that the D1 list is the source of truth.
if [[ "$PLAN" -eq 0 && -x "$ROOT/bin/render-send-email-bindings.sh" ]]; then
  log "re-rendering services/out send_email bindings"
  "$ROOT/bin/render-send-email-bindings.sh"
fi

if [[ "$PLAN" -eq 1 ]]; then
  log "plan complete (no writes performed)"
else
  log "onboard complete"
fi
