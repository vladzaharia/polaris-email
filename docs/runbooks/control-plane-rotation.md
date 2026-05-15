# Runbook: control-plane secret rotation

`POLARIS_SECRET_A` is the break-glass control-plane HMAC used **only** by the bootstrap endpoint and panel↔api admin calls. It must be rotated at least every 365 days. The staleness Cron pages at 330 days.

## Procedure

1. Pick a new 256-bit base32 secret: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
2. Update every Worker via `wrangler secret put POLARIS_SECRET_B <new>` first (B is the secondary slot).
3. Reload Workers so they accept either A or B.
4. Update every panel deployment env to use B.
5. After 24 h of green telemetry, `wrangler secret put POLARIS_SECRET_A <new>` (promote B to A).
6. Clear B: `wrangler secret put POLARIS_SECRET_B ''`.
7. Write an audit row:
   ```sh
   bin/audit-write.sh schema.migration control_plane_secret
   ```
   The staleness Cron looks at `audit_log.action='schema.migration' AND target='control_plane_secret'` to compute age.
