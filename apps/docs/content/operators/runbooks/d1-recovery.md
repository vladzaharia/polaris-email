---
title: D1 recovery
description: PITR drill for the polaris-email D1 — list bookmarks, restore to a fresh DB, cut over via wrangler binding flip, verify the audit chain, and reconcile R2 + KV orphans. Run the drill quarterly.
sidebar_label: D1 recovery
sidebar_position: 6
---

# D1 recovery

The `polaris-email` D1 database holds everything except message bytes:
mailboxes, principals, credentials, messages metadata, audit log,
policy decisions. D1 supports point-in-time-recovery (PITR) with a
30-day window — this runbook covers the restore drill and post-recovery
verification.

Run this drill quarterly so the recovery path is muscle memory by the
time it matters.

## PITR window

Cloudflare D1 retains PITR snapshots for 30 days. Times are
millisecond-precise. Restores create a _new_ database; you don't
overwrite the live one until you flip the wrangler binding.

## Drill: restore to a fresh database

```sh
# 1. List recovery timestamps
wrangler d1 time-travel info polaris-email

# 2. Restore to T-1 hour into a new database
wrangler d1 time-travel restore polaris-email \
  --bookmark <bookmark-from-step-1> \
  --target-name polaris-email-restore-$(date +%Y%m%d-%H%M)

# 3. Inspect the restored DB
wrangler d1 execute polaris-email-restore-$(date +%Y%m%d-%H%M) --command "
  SELECT COUNT(*) FROM messages;
  SELECT MAX(id) FROM audit_log;
"
```

For a drill, stop here. Verify the row counts match expectations and
delete the restore.

## Real incident: cut over

```sh
# 1. Restore (as above) — restore-name should reflect the incident.

# 2. Stop writes by flipping the API into maintenance mode.
bin/killswitch-freeze.sh

# 3. Update services/api/wrangler.local.jsonc to bind the DB
#    name to the restore. Don't rename the database — change the
#    binding's `database_name` to the new id.

# 4. Deploy:
polaris-email setup infra deploy service api

# 5. Verify with the smoke test:
polaris-email setup infra smoke

# 6. Lift maintenance:
bin/killswitch-freeze.sh --restore
```

## Audit chain verification after restore

A PITR restore re-creates rows by id, so the chained-hash invariant
should hold IF the bookmark predates any tampering. Verify before
trusting the restored DB:

```sh
bin/audit-verify.sh --from-id 0 --signing-key-file /path/to/key
```

Cross-check the latest D1 anchor against the matching B2 anchor — if
they agree, the chain is intact. If they diverge, the bookmark you
chose is too recent (it captured tampered rows). Pick an earlier
bookmark and retry.

## R2 + KV are not in scope

D1 PITR does NOT touch R2 (message bodies) or KV (nonce + plaintext
caches). After a restore, R2 may have orphan objects (referenced by
rows that no longer exist) and KV may have entries pointing at rows
that no longer exist.

- KV entries TTL out within minutes.
- R2 orphans require a manual sweep — diff `messages.r2_key` against
  the bucket listing and delete the difference.

## Re-issuing credentials

Credentials are stored hashed in D1. The plaintext is in KV with a
15-minute TTL — gone by the time most restores happen. Customers MUST
rotate after a restore that predates their last credential issuance.
Communicate the bookmark timestamp; anything issued after the bookmark
is functionally revoked.

## Frequency

- Quarterly drill (no cutover) — verifies the path stays working.
- Annual full-drill (restore + smoke + cutover-then-rollback) — exercises
  the wrangler binding flip on staging.

<!-- Verified against: docs/runbooks/d1-recovery.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
