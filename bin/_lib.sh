#!/usr/bin/env bash
# bin/_lib.sh — shared helpers for the polaris-email orchestration scripts.
# Source this; do not execute.

# Service list, in deploy order.
# `panel` lives under apps/ rather than services/; deploy.sh resolves the path
# via polaris_service_path().
# Note: `cron` + `fanout` were folded into `api` during phase B1; the api
# Worker now hosts the cron triggers and the FANOUT_QUEUE consumer.
POLARIS_SERVICES=(api out in panel)

# Resolve a service name to its on-disk path (services/<name> or apps/<name>).
polaris_service_path() {
  case "$1" in
    panel) echo "apps/panel" ;;
    *)     echo "services/$1" ;;
  esac
}

# Resolve the repo root from any cwd. Callers should `cd "$ROOT"`.
polaris_root() {
  # bin/_lib.sh lives in $ROOT/bin/.
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

ROOT="$(polaris_root)"
STATE_FILE="$ROOT/.deploy-state.json"
ENV_FILE="$ROOT/.env.deploy"
BOOTSTRAP_OUTPUT="$ROOT/.bootstrap-output.json"
SECRETS_CREATED="$ROOT/secrets.created.json"
LAST_SHA_FILE="$ROOT/.deploy-state.last-sha"

# Print to stderr, prefixed.
log()  { printf '[polaris] %s\n' "$*" >&2; }
warn() { printf '[polaris][warn] %s\n' "$*" >&2; }
die()  { printf '[polaris][error] %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"
}

# Ensure $STATE_FILE exists as a JSON object.
state_init() {
  if [[ ! -f "$STATE_FILE" ]]; then
    printf '{}\n' > "$STATE_FILE"
  fi
}

# state_get <jq-path-expression>  -> stdout (empty if absent)
state_get() {
  state_init
  jq -r "$1 // empty" "$STATE_FILE"
}

# state_set <jq-path-assignment-expression> using --arg/--argjson semantics: pass key=value pairs after.
# Example: state_set '.d1["polaris-email"] = {id: $id, created_at: $at}' id "abc" at "$(date -u +%FT%TZ)"
state_set() {
  state_init
  local expr="$1"; shift
  local tmp="$STATE_FILE.tmp"
  local args=()
  while [[ $# -gt 0 ]]; do
    args+=(--arg "$1" "$2")
    shift 2
  done
  jq "${args[@]}" "$expr" "$STATE_FILE" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

# Load .env.deploy values into the environment. Lines like KEY=VALUE; '#' comments.
load_env_deploy() {
  if [[ ! -f "$ENV_FILE" ]]; then
    die ".env.deploy missing. Run: make configure"
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

# polaris_api_call <method> <path> <body> [admin]   — admin=1 uses POLARIS_SECRET_A from bootstrap-output.
# Echoes the response body. Returns curl's exit code.
#
# Signing is delegated to `polaris-email auth sign` — the canonical HMAC scheme
# lives in one place (packages/sdk-go) and the shell only orchestrates curl.
polaris_api_call() {
  local method="$1" path="$2" body="${3:-}" use_admin="${4:-0}"
  local secret key_id base_url body_file
  load_env_deploy
  base_url="https://${POLARIS_API_HOSTNAME:-polaris-email-api.workers.dev}"
  if [[ "$use_admin" == "1" ]]; then
    [[ -f "$BOOTSTRAP_OUTPUT" ]] || die "bootstrap output missing: $BOOTSTRAP_OUTPUT"
    key_id="$(jq -r '.admin_key_id' "$BOOTSTRAP_OUTPUT")"
    secret="$(jq -r '.admin_key_secret' "$BOOTSTRAP_OUTPUT")"
  else
    die "polaris_api_call: only admin mode is implemented"
  fi
  body_file="$(mktemp -t polaris-body)"
  trap 'rm -f "$body_file"' RETURN
  printf '%s' "$body" > "$body_file"
  local headers ts nonce sig
  headers="$(POLARIS_SECRET="$secret" polaris-email auth sign \
    --method "$method" --path "$path" --body "$body_file")"
  ts="$(awk -F': ' '/^X-Polaris-Ts:/  {print $2}' <<<"$headers")"
  nonce="$(awk -F': ' '/^X-Polaris-Nonce:/ {print $2}' <<<"$headers")"
  sig="$(awk -F': ' '/^X-Polaris-Sig:/ {print $2}' <<<"$headers")"
  curl -sS -X "$method" "${base_url}${path}" \
    -H 'content-type: application/json' \
    -H "x-polaris-key-id: ${key_id}" \
    -H "x-polaris-ts: ${ts}" \
    -H "x-polaris-nonce: ${nonce}" \
    -H "x-polaris-sig: ${sig}" \
    --data "$body"
}

# Upsert a Cloudflare A record. Args: <zone_id> <name> <ipv4> [token]
# Token defaults to $CF_API_TOKEN. Returns the record ID on stdout.
cf_upsert_a_record() {
  local zone="$1" name="$2" ipv4="$3" token="${4:-${CF_API_TOKEN:-}}"
  [[ -n "$token" ]] || die "cf_upsert_a_record: CF_API_TOKEN required"
  local base="https://api.cloudflare.com/client/v4/zones/${zone}/dns_records"
  local existing
  existing="$(curl -sS -H "Authorization: Bearer ${token}" \
    "${base}?type=A&name=${name}" | jq -r '.result[0].id // empty')"
  local body
  body="$(jq -nc --arg n "$name" --arg c "$ipv4" '{type:"A", name:$n, content:$c, ttl:60, proxied:false}')"
  if [[ -n "$existing" ]]; then
    curl -sS -X PUT -H "Authorization: Bearer ${token}" -H 'content-type: application/json' \
      "${base}/${existing}" --data "$body" | jq -r '.result.id // empty'
  else
    curl -sS -X POST -H "Authorization: Bearer ${token}" -H 'content-type: application/json' \
      "${base}" --data "$body" | jq -r '.result.id // empty'
  fi
}

# Upsert a Cloudflare TXT record. Args: <zone_id> <name> <content> [token]
cf_upsert_txt_record() {
  local zone="$1" name="$2" content="$3" token="${4:-${CF_API_TOKEN:-}}"
  [[ -n "$token" ]] || die "cf_upsert_txt_record: CF_API_TOKEN required"
  local base="https://api.cloudflare.com/client/v4/zones/${zone}/dns_records"
  local existing
  existing="$(curl -sS -H "Authorization: Bearer ${token}" \
    "${base}?type=TXT&name=${name}" | jq -r '.result[0].id // empty')"
  local body
  body="$(jq -nc --arg n "$name" --arg c "$content" '{type:"TXT", name:$n, content:$c, ttl:60}')"
  if [[ -n "$existing" ]]; then
    curl -sS -X PUT -H "Authorization: Bearer ${token}" -H 'content-type: application/json' \
      "${base}/${existing}" --data "$body" | jq -r '.result.id // empty'
  else
    curl -sS -X POST -H "Authorization: Bearer ${token}" -H 'content-type: application/json' \
      "${base}" --data "$body" | jq -r '.result.id // empty'
  fi
}
