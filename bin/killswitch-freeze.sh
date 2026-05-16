#!/usr/bin/env bash
# Freeze polaris-email-api into a maintenance handler.
# Pins the deploy to the operator's configured CF_ACCOUNT_ID so a workstation
# with multiple wrangler accounts can't accidentally freeze the wrong one.
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
load_env_deploy
[[ -n "${CF_ACCOUNT_ID:-}" ]] || die "CF_ACCOUNT_ID missing — run \`make configure\`"
cat <<'EOF' > /tmp/maintenance.ts
export default { async fetch() { return new Response(JSON.stringify({error:{code:'degraded',message:'killswitch active',retryable:true}}), { status: 503, headers: { 'content-type':'application/json' } }); } };
EOF
CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" wrangler deploy /tmp/maintenance.ts \
  --name polaris-email-api \
  --compatibility-date 2025-01-01
echo "API frozen on account $CF_ACCOUNT_ID. Unfreeze with: cd services/api && wrangler deploy"
