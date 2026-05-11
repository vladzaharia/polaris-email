#!/usr/bin/env bash
# audit-write.sh — write a manual audit row (e.g. for control plane secret rotation).
# Requires POLARIS_ADMIN_KEY_ID + POLARIS_ADMIN_KEY_SECRET in env.
set -euo pipefail
ACTION="${1:-}"
TARGET="${2:-}"
[[ -n "$ACTION" && -n "$TARGET" ]] || { echo "usage: bin/audit-write.sh <action> <target>" >&2; exit 2; }
# We don't expose a public audit-write endpoint; rotations write themselves. This script
# exists as a placeholder for procedures that *should* be audited by direct D1 SQL via
# `wrangler d1 execute`, which itself goes through a controlled path with a hash-chain
# inserter (see services/api/src/audit.ts). For control-plane secret rotations:
echo "Issue an api_key.rotate against the control-plane key id $ACTION/$TARGET via the panel."
