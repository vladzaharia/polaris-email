#!/usr/bin/env bash
# Spike 4: cf-bounce MX semantics — what data does our handler receive on
# hard bounce, soft bounce, complaint?

source "$(dirname "$0")/_lib.sh"
require_jq
require_env CF_TEST_ZONE_ID
require_env CF_TEST_DOMAIN

cat <<'EOF'
==> This is a multi-step manual spike.

1. Confirm cf-bounce MX is published for your test zone:
   dig +short MX cf-bounce.<test-domain>
   Expected: a Cloudflare-managed MX (e.g., bounce.mta.cloudflare.com or similar).

2. Send a test message via Email Service to a guaranteed-bounce address:
   - Hard bounce: bounce@simulator.amazonses.com (returns 5xx)
   - Soft bounce: ooto@simulator.amazonses.com (vacation autoreply)
   - Complaint:   complaint@simulator.amazonses.com (FBL)

3. Set up a Worker bound to handle inbound on the *@cf-bounce.<test-domain> route.
   Log every inbound message: from, to, subject, raw headers, body.

4. Wait 30s after each send; capture what arrives at the handler.

5. Document:
   - Does Cloudflare deliver DSN messages back via cf-bounce?
   - Are FBL complaints delivered, or silently consumed?
   - What's the format (DSN per RFC 3464? proprietary JSON envelope?)
   - Is there latency (sync, async, batched)?
   - Is there a per-message correlation header (Message-ID echo, custom X- header)?

If cf-bounce delivers DSN-shaped MIME, we can parse with `mailparser` style libs.
If proprietary, we need Cloudflare-specific parsing.

==> Document findings in docs/spike/results/04-cf-bounce-mx-semantics.md
EOF

result "MANUAL" "Multi-day observation; document all bounce/complaint shapes received"
