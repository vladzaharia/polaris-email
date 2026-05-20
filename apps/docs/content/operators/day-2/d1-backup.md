---
title: D1 backup hygiene
sidebar_position: 11
---

# D1 backup hygiene

Weekly export of the `polaris-email` D1 database to R2. Acts as a safety net
**beyond** D1 Time-Travel: Time-Travel covers point-in-time recovery for the
live database, but cannot resurrect a database that's been deleted. The
weekly export gives you a portable `.sql` dump you can restore into a fresh
D1 instance for incident drills, forensic snapshots, and worst-case recovery.

## What runs automatically

A scheduled handler in `services/api` runs every Sunday at **06:00 UTC**:

- Cron: `0 6 * * 7` (registered in `services/api/wrangler.jsonc`)
- Handler: `services/api/src/scheduled/d1-backup.ts`
- Output: `r2://polaris-email/backups/d1/YYYY-MM-DD-<filename>.sql`
- Telemetry: row in `cron_runs` with `job_name = 'd1-backup'`

It calls the Cloudflare D1 polling export API
(`POST /accounts/{id}/d1/database/{db}/export`), polls until complete
(~seconds for a polaris-email-sized DB, hard timeout 60s), then streams
the signed URL straight into R2 without buffering the whole dump in
memory.

Retention: 12 weeks, enforced by R2 lifecycle (see
[R2 lifecycle](#r2-lifecycle) below).

## Prerequisites

Two wrangler secrets must be set on `services/api`:

- `CF_API_TOKEN` — already set as part of standard deploy; the token's
  permissions must include `Account.D1: Read` and `Account.D1: Edit`.
  (Edit isn't strictly needed for export — Read is — but the existing
  token usually has both.)
- `CF_ACCOUNT_ID` — already set.

If either is missing the cron silently skips and writes a row to
`cron_runs` with `status='skipped'`.

## Verify

After a Sunday run:

```sh
# Most recent row for this cron.
wrangler d1 execute polaris-email --remote \
  --command "SELECT * FROM cron_runs WHERE job_name='d1-backup' ORDER BY last_run_at DESC LIMIT 1"

# Recent backup objects.
wrangler r2 object list polaris-email --prefix backups/d1/
```

You can manually trigger a backup any time via the Workers dashboard
("Trigger cron") or by deploying a one-off PR that adds an extra minute
to the schedule and reverting.

## Restore a backup

The `.sql` file is a plain SQLite dump produced by `wrangler d1 export`'s
sister API. Restore into a fresh D1 instance:

```sh
# 1. Download.
wrangler r2 object get polaris-email/backups/d1/2026-04-12-<filename>.sql \
  --file restore.sql

# 2. Create a target DB (skip if reusing an existing one — be careful).
wrangler d1 create polaris-email-restore

# 3. Apply.
wrangler d1 execute polaris-email-restore --remote --file restore.sql
```

For partial restores (one table, one row), open the .sql in an editor
and extract the relevant `INSERT` statements before applying. Don't
restore directly over the production DB — apply to a separate instance
first and validate.

## R2 lifecycle

A 12-week expiry rule is applied to the `polaris-email-logs` R2 bucket
(under the `backups/d1/` prefix) by `polaris-email setup infra apply` —
see `apps/polaris-cli/internal/setup/plan/desired.go` for the
authoritative retention setting and `cfapi/r2.go:AddLifecycleExpiryRule`
for the API surface. Older backups age out automatically; to change
retention, edit `desired.go` and re-run `apply`.

## Cross-reference

- [D1 recovery](./d1-recovery.md) — point-in-time recovery via D1
  Time-Travel for the live database (different mechanism, different
  use case).
- `services/api/src/scheduled/d1-backup.ts` — handler source.
- `services/api/src/scheduled/index.ts` — dispatcher registration.
