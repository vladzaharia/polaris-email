# Runbook: Cloudflare account compromise

Assume the polaris-email Cloudflare account has been (or is suspected of being) compromised. Time-to-contain target: 15 minutes.

## Containment

1. **Revoke all CF API tokens** in the Cloudflare dashboard. Cannot be scripted (cannot revoke the credential one is authenticated with).
2. **Freeze D1 writes** by deploying the maintenance Worker:
   ```sh
   bin/killswitch-freeze.sh
   ```
   This redeploys `polaris-email-api` with a maintenance handler that returns `503 degraded` for every route except `/healthz` and `/admin/killswitch`.
3. **MX flip** to a holding domain that 4xx-tempfails inbound so no mail is lost:
   ```sh
   bin/killswitch-mx-flip.sh in.example.com hold.example.com
   ```
4. **R2 lifecycle pause** to prevent any retention deletes from racing the investigation:
   ```sh
   bin/killswitch-r2-pause.sh
   ```
   Verify Object Lock is still in compliance mode.
5. **Panel offline**: scale `polaris-email-panel` to 0 / pause its container.
6. **Comms**: open `RUNBOOKS/comms/breach-internal.md` and `breach-customers.md`.

## Investigation

- Pull the **Logpush mirror** (external append-only store). Worker logs, D1 audit rows, R2 access logs.
- **Verify the audit chain** using `bin/audit-verify.sh` and the latest `audit_anchors` row vs the off-platform anchor in the mirror. Any divergence is the tamper-evidence signal.
- Diff D1 head's `row_hash` against the most recent anchor signature recovered from outside CF.

## Recovery

1. Rotate every secret (every API key, IMAP/SMTPS password, webhook secret, `POLARIS_SECRET_A`, anchor signing key). All emergency-mode.
2. Redeploy from a clean source checkout pinned to a digest known to predate the compromise.
3. Restore D1 from PITR to a point before the compromise; reconcile against R2 (which is append-only / locked).
4. Verify Logpush mirror integrity, confirm audit-chain anchors line up.
5. Unfreeze: undo MX flip, undo killswitch deploy, restart panel.
6. Run the diagnostics page; confirm green ticks.
7. Run the synthetic for 24 h before any real consumer is unfrozen.
