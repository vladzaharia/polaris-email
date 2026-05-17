-- polaris-email — polish-pass schema additions (schema version=20)
--
-- This migration lands schema foundations needed by upcoming code changes:
--
--  1. idx_messages_mailbox_status_created — covers the hot list-messages
--     query (mailbox + status filter + created_at DESC ordering).
--
--  2. idx_idempotency_keys_mailbox_id — recreated; the 0004 DROP+CREATE
--     of idempotency_keys dropped the index from 0001_init.sql:367 along
--     with the table.
--
--  3. idempotency_keys.claim_locked — supports CAS-on-first-INSERT to
--     resolve the concurrent-claim race that returns HTTP 425 indefinitely
--     if the first worker crashes mid-recordClaim.
--
--  4. uniq_dmarc_aggregate_reports_dedup — partial unique index on
--     (domain, report_id) where report_id IS NOT NULL. Lets ingest write
--     INSERT OR IGNORE to absorb replayed reports without inflating the
--     rollup metrics. NULL report_ids are tolerated (not all providers
--     emit a report-id; those are deduplicated by source_message_id).
--
--  5. audit_anchors.external_ref_at — timestamp (TEXT ISO) recording when
--     the B2 PUT for an anchor succeeded. NULL means the row was inserted
--     into D1 but the off-CF mirror write hasn't landed; a daily backfill
--     cron picks these up. The existing external_ref column stays as the
--     B2 object key.
--
--  6. cron_runs — observability table for scheduled handlers. Each cron
--     wrapper upserts (job_name, last_run_at, status, duration_ms, message)
--     so the panel can surface "last successful anchor 3h ago" without
--     scraping Logpush.
--
--  7. DROP TABLE jmap_push_subscriptions — orphaned since the JMAP rows
--     were deleted in 0005. The previous migration deliberately left the
--     table; no consumers remain, safe to drop here.
--
--  8. webhook_subs.secret_rotated_at — timestamp recording the last secret
--     rotation. Subscribers within the grace window after a rotation can
--     verify against either the current `secret` or `secret_prev`; the panel
--     surfaces the rotation time so operators can confirm subscriber update.

-- --------------------------------------------------------------------------
-- 1. Hot messages query coverage
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_status_created
  ON messages(mailbox_id, status, created_at DESC);

-- --------------------------------------------------------------------------
-- 2 + 3. Idempotency keys: restore mailbox index + add claim_locked
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_mailbox_id
  ON idempotency_keys(mailbox_id);

ALTER TABLE idempotency_keys
  ADD COLUMN claim_locked INTEGER NOT NULL DEFAULT 0;

-- --------------------------------------------------------------------------
-- 4. DMARC report dedup
-- --------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dmarc_aggregate_reports_dedup
  ON dmarc_aggregate_reports(domain, report_id)
  WHERE report_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- 5. Audit anchor off-CF mirror tracking
-- --------------------------------------------------------------------------
ALTER TABLE audit_anchors
  ADD COLUMN external_ref_at TEXT;

-- Backfill existing rows: treat already-anchored rows as confirmed at their
-- signed_at time. signed_at is stored in milliseconds (INTEGER); convert to
-- ISO-8601 to match the column convention.
UPDATE audit_anchors
   SET external_ref_at = strftime('%Y-%m-%dT%H:%M:%fZ', signed_at / 1000.0, 'unixepoch')
 WHERE external_ref IS NOT NULL
   AND external_ref_at IS NULL;

-- --------------------------------------------------------------------------
-- 6. Cron observability
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cron_runs (
  job_name     TEXT PRIMARY KEY,
  last_run_at  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  message      TEXT
);

-- --------------------------------------------------------------------------
-- 8. Webhook secret rotation timestamp
-- --------------------------------------------------------------------------
ALTER TABLE webhook_subs
  ADD COLUMN secret_rotated_at TEXT;

-- --------------------------------------------------------------------------
-- 7. Drop orphaned JMAP push subscriptions
-- --------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_jmap_push_subscriptions_mailbox;
DROP INDEX IF EXISTS idx_jmap_push_subscriptions_expires;
DROP TABLE IF EXISTS jmap_push_subscriptions;

-- --------------------------------------------------------------------------
-- Schema version
-- --------------------------------------------------------------------------
INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (20, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0020_polish');
