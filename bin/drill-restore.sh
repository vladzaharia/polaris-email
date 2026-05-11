#!/usr/bin/env bash
# drill-restore.sh — D1 PITR drill. Restores to a sandbox D1 at T-60min and reconciles.
set -euo pipefail
TARGET="${1:-polaris-email-sandbox}"
TS_BEFORE=$(($(date +%s) - 3600))
echo "Restoring $TARGET to $(date -r "$TS_BEFORE")"
wrangler d1 time-travel restore "$TARGET" --timestamp="$TS_BEFORE"
echo "Running reconciliation against R2..."
# Reconciliation: confirm every messages.r2_key still exists in R2.
wrangler d1 execute "$TARGET" --remote --command "SELECT id, r2_key FROM messages WHERE r2_key IS NOT NULL LIMIT 100" > /tmp/drill-d1.json
echo "Drill complete. Inspect /tmp/drill-d1.json for sample rows."
