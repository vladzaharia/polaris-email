---
title: Control-plane secret rotation
description: Rotating POLARIS_SECRET_A (the break-glass control-plane HMAC) using the A/B slot dance. Must be rotated at least every 365 days; the staleness cron pages at 330.
sidebar_label: Control-plane rotation
sidebar_position: 5
---

# Runbook: control-plane secret rotation

`POLARIS_SECRET_A` is the break-glass control-plane HMAC used **only** by the bootstrap endpoint and panel↔api admin calls. It must be rotated at least every 365 days. The staleness Cron pages at 330 days.

## Procedure

1. Pick a new 256-bit base32 secret: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
2. Update every Worker via `wrangler secret put POLARIS_SECRET_B <new>` first (B is the secondary slot).
3. Reload Workers so they accept either A or B.
4. Update every panel deployment env to use B.
5. After 24 h of green telemetry, `wrangler secret put POLARIS_SECRET_A <new>` (promote B to A).
6. Clear B: `wrangler secret put POLARIS_SECRET_B ''`.
7. The next genesis-seal-style admin operation that records to `audit_log`
   will reset the staleness window. There is no operator-driven
   audit-write surface today; the weekly `staleness` cron will eventually
   alert if 365 days pass without any `bootstrap.*` / `auth.*` activity,
   which is the expected backstop.

<!-- Verified against: docs/runbooks/control-plane-rotation.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
