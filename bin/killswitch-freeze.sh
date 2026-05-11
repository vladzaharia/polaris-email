#!/usr/bin/env bash
# Freeze polaris-email-api into a maintenance handler.
set -euo pipefail
cat <<'EOF' > /tmp/maintenance.ts
export default { async fetch() { return new Response(JSON.stringify({error:{code:'degraded',message:'killswitch active',retryable:true}}), { status: 503, headers: { 'content-type':'application/json' } }); } };
EOF
wrangler deploy /tmp/maintenance.ts --name polaris-email-api --compatibility-date 2025-01-01
echo "API frozen. Unfreeze with: cd services/api && wrangler deploy"
