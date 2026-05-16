-- polaris-email — add messages.bounced_at (schema version=7)
--
-- Phase 2b (Production correctness P0): when services/out observes a
-- permanent bounce, it stamps `bounced_at` so that the message's lifecycle
-- timeline is complete (`queued_at` → `sending_at` → `bounced_at`). Until
-- now we wrote `status='bounced'` without a timestamp; the panel + audit
-- replay both need a real epoch to render bounce age.

ALTER TABLE messages ADD COLUMN bounced_at TEXT;

INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0007_add_bounced_at');
