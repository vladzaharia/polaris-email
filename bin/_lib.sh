#!/usr/bin/env bash
# bin/_lib.sh — shared helpers for the polaris-email orchestration scripts.
# Source this; do not execute.

# Service list, in deploy order (forensic first because api depends on it).
POLARIS_SERVICES=(forensic api out in fanout synthetic janitor staleness anchor)

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

# HMAC-sign a request and emit the three headers (TS NONCE SIG) on stdout space-separated.
# Args: <secret> <method> <path> <body-string>
# Uses the same canonical string as bin/bootstrap.sh: polaris-api.v1\n<METHOD>\n<PATH>\n\n<TS>\n<NONCE>\n<BH>
polaris_sign() {
  local secret="$1" method="$2" path="$3" body="${4:-}"
  local ts nonce bh sig canon
  ts="$(date +%s)000"
  nonce="$(openssl rand -hex 12)"
  bh="$(printf '%s' "$body" | openssl dgst -sha256 -hex | awk '{print $2}')"
  canon="polaris-api.v1\n${method}\n${path}\n\n${ts}\n${nonce}\n${bh}"
  sig="$(printf '%b' "$canon" | openssl dgst -sha256 -hmac "$secret" -hex | awk '{print $2}')"
  printf '%s %s %s\n' "$ts" "$nonce" "$sig"
}

# polaris_api_call <method> <path> <body> [admin]   — admin=1 uses POLARIS_SECRET_A from bootstrap-output.
# Echoes the response body. Returns curl's exit code.
polaris_api_call() {
  local method="$1" path="$2" body="${3:-}" use_admin="${4:-0}"
  local secret key_id base_url
  load_env_deploy
  base_url="https://${POLARIS_API_HOSTNAME:-polaris-email-api.workers.dev}"
  if [[ "$use_admin" == "1" ]]; then
    [[ -f "$BOOTSTRAP_OUTPUT" ]] || die "bootstrap output missing: $BOOTSTRAP_OUTPUT"
    key_id="$(jq -r '.admin_key_id' "$BOOTSTRAP_OUTPUT")"
    secret="$(jq -r '.admin_key_secret' "$BOOTSTRAP_OUTPUT")"
  else
    die "polaris_api_call: only admin mode is implemented"
  fi
  local triplet ts nonce sig
  triplet="$(polaris_sign "$secret" "$method" "$path" "$body")"
  ts="$(awk '{print $1}' <<<"$triplet")"
  nonce="$(awk '{print $2}' <<<"$triplet")"
  sig="$(awk '{print $3}' <<<"$triplet")"
  curl -sS -X "$method" "${base_url}${path}" \
    -H 'content-type: application/json' \
    -H "x-polaris-key-id: ${key_id}" \
    -H "x-polaris-ts: ${ts}" \
    -H "x-polaris-nonce: ${nonce}" \
    -H "x-polaris-sig: v1=${sig}" \
    --data "$body"
}
