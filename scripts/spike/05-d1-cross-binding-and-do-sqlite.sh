#!/usr/bin/env bash
# Spike 5: Multi-D1 binding from a single Worker + Durable Objects with SQLite.
#
# Strategy: provision two D1 databases and one Durable Object class, deploy a
# trivial Worker that reads/writes both D1s and the DO, and confirm:
#   - Multiple D1 bindings work
#   - DO-SQLite is available on this account
#   - Cross-DB query latency is acceptable for our hot path

source "$(dirname "$0")/_lib.sh"
require_jq

cat <<'INNER_EOF'
==> This spike is best done via wrangler, not raw API. Run from the spike directory:

   cd scripts/spike/d1-do-spike
   wrangler d1 create polaris-spike-control
   wrangler d1 create polaris-spike-messages
   wrangler deploy

The spike Worker exercises:
   - Two D1 reads in parallel (env.CONTROL, env.MESSAGES)
   - One DO instance with SQLite via state.storage.sql
   - A timing report

Hit the deployed URL and inspect the JSON response; document timing in results.md.
INNER_EOF

result "MANUAL" "Run wrangler commands; capture JSON response"
