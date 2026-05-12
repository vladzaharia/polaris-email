#!/usr/bin/env bash
# bootstrap.sh — idempotent cold-start of a polaris-email installation.
# Phases:
#   1) pnpm install + build
#   2) Create CF resources (D1, R2, KV namespaces, Queues) and capture IDs into .deploy-state.json.
#   3) Render services/*/wrangler.local.jsonc from templates + state.
#   4) Apply D1 migrations.
#   5) Seed master secrets (POLARIS_SECRET_A, ARGON2_PEPPER, FORENSIC_MASTER_KEY, ANCHOR_SIGNING_KEY).
#   6) Deploy all Workers.
#   7) Mint the first admin key via signed POST /admin/bootstrap; save to .bootstrap-output.json.
#   8) Print remaining manual next steps.
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

need wrangler
need jq
need openssl
need pnpm
need curl
need envsubst

[[ -f "$ENV_FILE" ]] || die ".env.deploy missing — run \`make configure\` first"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

state_init
NOW="$(date -u +%FT%TZ)"

##############################################################################
# 1/8  install + build
##############################################################################
log "1/8 pnpm install + build"
pnpm install --frozen-lockfile
pnpm -r run build || warn "some workspaces have no build script — continuing"

##############################################################################
# 2/8  CF resources, capturing IDs into .deploy-state.json
##############################################################################
log "2/8 CF resources (D1, R2, KV, Queues)"

# --- D1 ---
D1_NAME="polaris-email"
if [[ -n "$(state_get ".d1[\"$D1_NAME\"].id")" ]]; then
  log "  d1/$D1_NAME already in state — skipping create"
else
  log "  creating d1/$D1_NAME"
  out="$(wrangler d1 create "$D1_NAME" 2>&1 || true)"
  # Try JSON parse first (newer wrangler versions emit JSON to stdout). Fall back to grep.
  d1_id="$(printf '%s' "$out" | jq -r '.uuid // .id // empty' 2>/dev/null || true)"
  if [[ -z "$d1_id" ]]; then
    # Human output: look for "database_id = \"<uuid>\"" or "Created your new D1 database. ... <uuid>".
    d1_id="$(printf '%s' "$out" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
  fi
  if [[ -z "$d1_id" ]]; then
    # "already exists" path — query and pull from list.
    if printf '%s' "$out" | grep -qi 'already exists'; then
      log "  d1/$D1_NAME already exists on account, querying id..."
      d1_id="$(wrangler d1 list --json 2>/dev/null | jq -r ".[] | select(.name==\"$D1_NAME\") | .uuid // .id" | head -1 || true)"
    fi
  fi
  if [[ -z "$d1_id" ]]; then
    echo "$out" >&2
    die "failed to determine D1 id for $D1_NAME — see output above"
  fi
  state_set ".d1[\$name] = {id: \$id, created_at: \$at}" name "$D1_NAME" id "$d1_id" at "$NOW"
  log "  d1/$D1_NAME id=$d1_id"
fi

# --- R2 ---
R2_NAME="polaris-email"
if [[ -n "$(state_get ".r2[\"$R2_NAME\"].name")" ]]; then
  log "  r2/$R2_NAME already in state — skipping create"
else
  log "  creating r2/$R2_NAME (jurisdiction=eu)"
  if wrangler r2 bucket create "$R2_NAME" --jurisdiction=eu 2>&1 | tee /dev/stderr | grep -qi 'already exists\|Created'; then
    :
  fi
  # Object Lock retention — idempotent on the CF side.
  wrangler r2 bucket lock add "$R2_NAME" --retention-period=2160h --mode=compliance --jurisdiction=eu >/dev/null 2>&1 \
    || warn "r2 object-lock add returned nonzero — assuming already configured"
  state_set ".r2[\$name] = {name: \$name, jurisdiction: \"eu\", created_at: \$at}" name "$R2_NAME" at "$NOW"
fi

# --- KV namespaces ---
parse_kv_id() {
  local out="$1"
  # Newer wrangler emits JSON. Older emits a line like: id = "abc123..."
  local id
  id="$(printf '%s' "$out" | jq -r '.id // empty' 2>/dev/null || true)"
  if [[ -z "$id" ]]; then
    id="$(printf '%s' "$out" | grep -Eo 'id *= *"[0-9a-f]{16,}"' | head -1 | grep -Eo '[0-9a-f]{16,}' || true)"
  fi
  if [[ -z "$id" ]]; then
    # Sometimes printed as: "binding = ..., id = "xxx""
    id="$(printf '%s' "$out" | grep -Eo '[0-9a-f]{32}' | head -1 || true)"
  fi
  printf '%s' "$id"
}

for kv in polaris-email-nonce polaris-email-idempotency polaris-email-rate-limit polaris-email-key-cache; do
  if [[ -n "$(state_get ".kv[\"$kv\"].id")" ]]; then
    log "  kv/$kv already in state — skipping"
    continue
  fi
  log "  creating kv/$kv"
  out="$(wrangler kv namespace create "$kv" 2>&1 || true)"
  id="$(parse_kv_id "$out")"
  if [[ -z "$id" ]] && printf '%s' "$out" | grep -qi 'already exists'; then
    # Fall back to listing.
    id="$(wrangler kv namespace list 2>/dev/null | jq -r ".[] | select(.title==\"$kv\") | .id" | head -1 || true)"
  fi
  if [[ -z "$id" ]]; then
    echo "$out" >&2
    die "failed to determine KV id for $kv"
  fi
  state_set ".kv[\$name] = {id: \$id, created_at: \$at}" name "$kv" id "$id" at "$NOW"
  log "  kv/$kv id=$id"
done

# --- Queues ---
for q in polaris-email-outbound polaris-email-inbound polaris-email-fanout \
         polaris-email-outbound-dlq polaris-email-fanout-dlq; do
  if [[ -n "$(state_get ".queues[\"$q\"].name")" ]]; then
    log "  queue/$q already in state — skipping"
    continue
  fi
  log "  creating queue/$q"
  out="$(wrangler queues create "$q" 2>&1 || true)"
  if printf '%s' "$out" | grep -qi 'already exists\|created\|Successfully created'; then
    state_set ".queues[\$name] = {name: \$name, created_at: \$at}" name "$q" at "$NOW"
  else
    echo "$out" >&2
    die "failed to create queue $q"
  fi
done

##############################################################################
# 3/8  render local wrangler configs
##############################################################################
log "3/8 rendering services/*/wrangler.local.jsonc from templates"
"$ROOT/bin/render-wrangler-local.sh"

##############################################################################
# 4/8  migrations
##############################################################################
log "4/8 applying D1 migrations"
wrangler d1 migrations apply polaris-email --remote || warn "migrations apply nonzero — verify above"

##############################################################################
# 5/8  master secrets
##############################################################################
log "5/8 seeding master secrets (skipped per-secret if already recorded in secrets.created.json)"
[[ -f "$SECRETS_CREATED" ]] || echo '{}' > "$SECRETS_CREATED"

secret_seen() {
  jq -r --arg n "$1" '.[$n] // empty' "$SECRETS_CREATED"
}
secret_record() {
  local n="$1"
  local tmp; tmp="$(mktemp)"
  jq --arg n "$n" --arg at "$NOW" '.[$n] = {created_at: $at}' "$SECRETS_CREATED" > "$tmp"
  mv "$tmp" "$SECRETS_CREATED"
  chmod 0600 "$SECRETS_CREATED"
}

POL_A=""; ARGON_PEPPER=""; FORENSIC_MASTER=""; ANCHOR_SIGN=""
gen() { openssl rand -base64 32 | tr -d '\n='; }

put_secret() { # svc, name, value
  local svc="$1" name="$2" val="$3"
  printf '%s' "$val" | (cd "services/$svc" && wrangler secret put "$name" >/dev/null)
}

if [[ -z "$(secret_seen POLARIS_SECRET_A)" ]]; then
  POL_A="$(gen)"
  log "  seeding POLARIS_SECRET_A across all services"
  for svc in "${POLARIS_SERVICES[@]}"; do
    put_secret "$svc" POLARIS_SECRET_A "$POL_A" || warn "put POLARIS_SECRET_A failed on $svc"
  done
  secret_record POLARIS_SECRET_A
  # Stash in a transient file readable only to the user, so step 7 can sign.
  umask 077
  printf '%s' "$POL_A" > "$ROOT/.bootstrap-secret-a"
fi

if [[ -z "$(secret_seen ARGON2_PEPPER)" ]]; then
  ARGON_PEPPER="$(gen)"
  put_secret api ARGON2_PEPPER "$ARGON_PEPPER" || warn "put ARGON2_PEPPER failed on api"
  secret_record ARGON2_PEPPER
fi

if [[ -z "$(secret_seen FORENSIC_MASTER_KEY)" ]]; then
  FORENSIC_MASTER="$(gen)"
  put_secret forensic FORENSIC_MASTER_KEY "$FORENSIC_MASTER" || warn "put FORENSIC_MASTER_KEY failed on forensic"
  secret_record FORENSIC_MASTER_KEY
fi

if [[ -z "$(secret_seen ANCHOR_SIGNING_KEY)" ]]; then
  ANCHOR_SIGN="$(gen)"
  put_secret anchor ANCHOR_SIGNING_KEY "$ANCHOR_SIGN" || warn "put ANCHOR_SIGNING_KEY failed on anchor"
  secret_record ANCHOR_SIGNING_KEY
fi

##############################################################################
# 6/8  deploy Workers (forensic first because api binds it as a service)
##############################################################################
log "6/8 deploying all Workers"
"$ROOT/bin/deploy.sh" --all

##############################################################################
# 7/8  mint the first admin key
##############################################################################
log "7/8 minting the bootstrap admin key"
if [[ -f "$BOOTSTRAP_OUTPUT" ]]; then
  log "  $BOOTSTRAP_OUTPUT already exists — not re-bootstrapping admin key"
else
  if [[ -z "$POL_A" && -f "$ROOT/.bootstrap-secret-a" ]]; then
    POL_A="$(cat "$ROOT/.bootstrap-secret-a")"
  fi
  if [[ -z "$POL_A" ]]; then
    warn "POLARIS_SECRET_A unknown in this session — cannot mint admin key. Re-run with a fresh secret or restore from password manager."
  else
    triplet="$(polaris_sign "$POL_A" POST /admin/bootstrap '{}')"
    ts="$(awk '{print $1}' <<<"$triplet")"
    nonce="$(awk '{print $2}' <<<"$triplet")"
    sig="$(awk '{print $3}' <<<"$triplet")"
    API_URL="https://${POLARIS_API_HOSTNAME}"
    resp="$(curl -sS -X POST "$API_URL/admin/bootstrap" \
      -H 'content-type: application/json' \
      -H "x-polaris-ts: $ts" -H "x-polaris-nonce: $nonce" -H "x-polaris-sig: v1=$sig" \
      -d '{}' || echo '{"error":"bootstrap_failed"}')"
    admin_id="$(printf '%s' "$resp" | jq -r '.admin_key_id // empty')"
    admin_secret="$(printf '%s' "$resp" | jq -r '.admin_key_secret // empty')"
    if [[ -n "$admin_id" && -n "$admin_secret" ]]; then
      umask 077
      printf '{"admin_key_id":"%s","admin_key_secret":"%s","created_at":"%s"}\n' \
        "$admin_id" "$admin_secret" "$NOW" > "$BOOTSTRAP_OUTPUT"
      chmod 0600 "$BOOTSTRAP_OUTPUT"
      cat <<EOF >&2
============================================================
  Bootstrap admin key — copy this once. Also saved to $BOOTSTRAP_OUTPUT (mode 0600).

    POLARIS_EMAIL_KEY_ID=$admin_id
    POLARIS_EMAIL_KEY_SECRET=$admin_secret

============================================================
EOF
    else
      echo "$resp" >&2
      warn "admin bootstrap did not return a key — investigate the response above"
    fi
  fi
fi
# Clear the transient secret file.
rm -f "$ROOT/.bootstrap-secret-a"

##############################################################################
# 8/8  next steps
##############################################################################
log "8/8 next steps"
cat <<EOF
Remaining manual steps (see docs/DEPLOY.md):
  - Add DNS records for each sending domain:    make dns DOMAIN=$POLARIS_DOMAIN
  - (Optional) Stand up the bridge on Tailnet:  make bridge-up
  - Smoke test the stack:                       make smoke
  - Issue your first consumer key:              make issue-key NAME=acme SCOPES=mail:send
EOF
