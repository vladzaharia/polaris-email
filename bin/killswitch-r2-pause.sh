#!/usr/bin/env bash
# Pause R2 lifecycle so retention deletes can't race the investigation.
set -euo pipefail
wrangler r2 bucket lifecycle list polaris-email
echo "Disable any lifecycle rule that would delete or transition objects:"
echo "  wrangler r2 bucket lifecycle disable polaris-email --rule-id <id>"
