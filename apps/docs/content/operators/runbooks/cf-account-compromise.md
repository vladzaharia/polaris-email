---
title: Cloudflare account compromise
description: Time-to-contain target 15 minutes. Containment (kill switches), investigation (Logpush mirror), and recovery (secret rotation, D1 Time-Travel, synthetic) for a full CF-account compromise.
sidebar_label: CF account compromise
sidebar_position: 4
---

# Runbook: Cloudflare account compromise

Assume the polaris-email Cloudflare account has been (or is suspected of being) compromised. Time-to-contain target: 15 minutes.

## Threat model — single-account topology

Polaris-email runs on **one Cloudflare account** (`polaris-prod`). That
account hosts every runtime: Workers, D1, KV, R2, Queues, DNS, Email
Routing, Email Service, Access. A full compromise of the CF account
therefore has a wide blast radius — the attacker can mint Worker deploys,
read/write D1, read/write the `polaris-email` R2 bucket, redirect MX
records, and pull every Workers Secret (`POLARIS_SECRET_A`, the bcrypt
pepper, the bridge HMAC key, etc.).

The accepted trade-off (no defence against a fully-compromised CF root
token; D1 Time-Travel + the weekly D1 export to R2 are the recovery
surface) is documented in `SECURITY.md`. The defences:

- **`audit_log` chained-hash invariant.** Each row's `row_hash` is
  `SHA-256(prev_hash || canonical(row))`. An attacker who rewrites any
  row in-place breaks the chain for every later row — the `audit-verify`
  cron nightly walk surfaces the break. An attacker who fully owns the
  account can recompute the chain end-to-end, however; that's the
  scenario this runbook addresses.
- **Logpush mirror.** Worker logs (Workers Trace Events dataset) are
  shipped via Logpush to an external HTTP destination (Better Stack,
  Honeycomb, Datadog, …). The destination is out-of-CF and append-only,
  so historic Worker-execution evidence survives a CF-side compromise.
- **D1 Time-Travel.** ~30 days of point-in-time recovery for the live
  database. The bookmark mechanism is internal to D1, but a restore
  pre-compromise is the recovery surface for "audit_log was rewritten".
- **Weekly D1 export to R2** under `backups/d1/` with 12-week
  R2-lifecycle retention. Operator-owned R2 bucket; provides the
  destroyed-DB recovery surface (Time-Travel cannot resurrect a deleted
  database).

## Containment

1. **Revoke all CF API tokens** in the Cloudflare dashboard. Cannot be
   scripted (cannot revoke the credential one is authenticated with).
2. **Freeze D1 writes** by deploying the maintenance Worker:
   ```sh
   bin/killswitch-freeze.sh
   ```
   This redeploys `polaris-email-api` with a maintenance handler that returns
   `503 degraded` for every route except `/healthz` and `/admin/killswitch`.
3. **MX flip** to a holding domain that 4xx-tempfails inbound so no mail is
   lost:
   ```sh
   bin/killswitch-mx-flip.sh in.example.com hold.example.com
   ```
4. **R2 lifecycle pause** to prevent any retention deletes from racing the
   investigation:
   ```sh
   bin/killswitch-r2-pause.sh
   ```
   The `polaris-email` R2 bucket holds bodies, attachments, and the
   weekly D1 backups under `backups/d1/`. R2 Object Lock COMPLIANCE on
   `mime/` and `att/` prefixes prevents body-deletion even by the
   account owner; the kill switch additionally pauses lifecycle
   transitions.
5. **Panel offline**: scale `polaris-email-panel` to 0 / pause its
   container.
6. **Comms**: open internal + customer comms templates from the runbooks
   index.

## Investigation

- Pull the **Logpush mirror** at your external destination. Worker logs,
  D1 audit rows that were emitted via `console.log`, R2 access logs.
  Search for the suspected blast time window; look for unfamiliar
  `wrangler deploy` events, secret reads, or D1 statement bursts.
- **Walk the audit chain** from outside CF:
  ```sh
  polaris-email audit verify
  ```
  A break is the in-band tamper signal. If the chain verifies but you
  suspect rewrite, **do not trust** the verification — a full-account
  adversary can recompute it. Trust the Logpush mirror instead.
- Cross-check the **weekly D1 backup** in R2 against the live DB:
  ```sh
  wrangler r2 object get polaris-email/backups/d1/<YYYY-MM-DD>-... \
    --file pre-incident.sql
  diff <(wrangler d1 execute polaris-email --remote --command "SELECT ... FROM audit_log") \
       <(sqlite3 pre-incident.sql "SELECT ... FROM audit_log")
  ```
- Inspect Cloudflare's audit log (dashboard → My Profile → Audit Log) for
  recent API token creations, Worker deploys, and account-level setting
  changes.

## Recovery

1. **Rotate every secret** in emergency mode. API keys, IMAP/SMTPS
   passwords, webhook signing secrets, `POLARIS_SECRET_A`, `ARGON2_PEPPER`,
   `PEPPER_MASTER`, OIDC client secret. The polaris-cli `setup infra
secrets seed` re-mints generators and re-pushes via `wrangler secret
put`; for sources-only secrets (like the CF API token itself), mint
   manually and seed via .env.deploy.
2. **Redeploy from a clean source checkout** pinned to a git SHA known
   to predate the compromise. `polaris-email setup infra deploy all`
   ships every Worker.
3. **D1 Time-Travel restore** to a point before the compromise. See the
   [D1 recovery runbook](./d1-recovery.md) for the two-step copy-then-
   reconcile approach — never restore the live DB directly without first
   inspecting the rollback target in a copy.
4. Verify Logpush mirror integrity, confirm the post-restore `audit_log`
   head matches expectations from before the blast window.
5. **Unfreeze**: undo MX flip, undo killswitch deploy, restart panel.
6. Run the diagnostics page; confirm green ticks across `Audit chain`,
   `Cron health`, `Queue depth`.
7. Run the synthetic for 24 h before any real consumer is unfrozen.
