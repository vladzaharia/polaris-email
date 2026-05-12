#!/usr/bin/env bash
# rotate-secret.sh — two-phase rotation of POLARIS_SECRET_A using the B slot.
# Phase 1: generate new value, put as POLARIS_SECRET_B on all services, record start time.
# Phase 2 (>=24h after phase 1): promote B to A, clear B, write audit event.
# Usage:
#   bin/rotate-secret.sh --name POLARIS_SECRET_A [--force] [--check-only]
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

NAME=""; FORCE=0; CHECK_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)       NAME="$2"; shift 2 ;;
    --force)      FORCE=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    *) die "unknown arg: $1" ;;
  esac
done
[[ "$NAME" == "POLARIS_SECRET_A" ]] || die "only POLARIS_SECRET_A rotation is implemented (see RUNBOOKS/control-plane-rotation.md)"

state_init
phase1_at="$(state_get '.rotation["POLARIS_SECRET_A"].phase1_at')"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  if [[ -n "$phase1_at" ]]; then
    echo "rotation in progress: phase1 started at $phase1_at"
  else
    echo "no rotation in progress"
  fi
  exit 0
fi

# Smoke check before doing anything destructive.
if [[ "$FORCE" -ne 1 ]]; then
  log "running pre-rotation smoke check"
  "$ROOT/bin/smoke.sh" || die "smoke is red — refusing to advance rotation. Use --force to override."
fi

NOW="$(date -u +%FT%TZ)"

if [[ -z "$phase1_at" ]]; then
  ##############################################################################
  # Phase 1: seed POLARIS_SECRET_B
  ##############################################################################
  log "phase 1: generating new POLARIS_SECRET_B and putting it on every service"
  NEW="$(openssl rand -base64 32 | tr -d '\n=')"
  for svc in "${POLARIS_SERVICES[@]}"; do
    printf '%s' "$NEW" | (cd "services/$svc" && wrangler secret put POLARIS_SECRET_B >/dev/null) \
      || warn "put POLARIS_SECRET_B failed on $svc"
  done
  state_set '.rotation["POLARIS_SECRET_A"] = {phase1_at: $at}' at "$NOW"
  cat >&2 <<EOF
Phase 1 complete. POLARIS_SECRET_B is now active alongside A on every Worker.
Update panel deployments to use the new value (kept out of band — see your password manager).
Wait at least 24h of green telemetry, then re-run \`make rotate-secret NAME=POLARIS_SECRET_A\` to promote B -> A.
EOF
  exit 0
fi

##############################################################################
# Phase 2: promote B -> A, clear B, write audit
##############################################################################
# Refuse to advance if <24h have passed.
phase1_epoch="$(date -u -d "$phase1_at" +%s 2>/dev/null || gdate -u -d "$phase1_at" +%s 2>/dev/null || echo 0)"
if [[ "$phase1_epoch" -eq 0 ]]; then
  warn "could not parse phase1_at timestamp; assuming enough time has passed (use --force to silence)"
elif [[ "$FORCE" -ne 1 ]]; then
  now_epoch="$(date -u +%s)"
  delta=$(( now_epoch - phase1_epoch ))
  if [[ "$delta" -lt 86400 ]]; then
    die "phase 1 was only $delta seconds ago — wait until 86400s have passed, or pass --force"
  fi
fi

log "phase 2: promoting POLARIS_SECRET_B to POLARIS_SECRET_A on every service"
# We can't read the secret back from wrangler, so we require the operator to provide it via env.
if [[ -z "${POLARIS_SECRET_B_VALUE:-}" ]]; then
  die "phase 2 requires POLARIS_SECRET_B_VALUE env var (the new value generated in phase 1, from your password manager)"
fi

for svc in "${POLARIS_SERVICES[@]}"; do
  printf '%s' "$POLARIS_SECRET_B_VALUE" | (cd "services/$svc" && wrangler secret put POLARIS_SECRET_A >/dev/null) \
    || warn "promote POLARIS_SECRET_A failed on $svc"
  printf '' | (cd "services/$svc" && wrangler secret put POLARIS_SECRET_B >/dev/null) \
    || warn "clear POLARIS_SECRET_B failed on $svc"
done

# Audit row via existing helper.
if [[ -x "$ROOT/bin/audit-write.sh" ]]; then
  "$ROOT/bin/audit-write.sh" schema.migration control_plane_secret || warn "audit-write failed"
fi

state_set '.rotation["POLARIS_SECRET_A"] = {phase1_at: null, last_promoted_at: $at}' at "$NOW"
log "rotation complete — POLARIS_SECRET_A is now the value that was POLARIS_SECRET_B"
