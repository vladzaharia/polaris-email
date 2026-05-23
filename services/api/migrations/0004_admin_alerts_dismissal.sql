-- 0004_admin_alerts_dismissal.sql
--
-- Add soft-dismissal columns to admin_alerts so operators can clear the
-- active view of acknowledged noise without violating the "immutable
-- historical ledger" stance the table was originally designed around.
--
-- We do NOT delete dismissed rows. Operators can re-expose them via the
-- `?include_dismissed=1` query param on the list endpoint, and the audit
-- log records the dismissal event itself (action='admin.alert.dismiss')
-- so we still have a tamper-evident trail of who silenced what.
--
-- The partial index keeps the default "active alerts" list query cheap —
-- the panel sorts by created_at DESC with `dismissed_at IS NULL` in the
-- WHERE clause, which can be served entirely from the index without
-- touching the main table for the common case.

ALTER TABLE admin_alerts ADD COLUMN dismissed_at TEXT;
ALTER TABLE admin_alerts ADD COLUMN dismissed_by TEXT;

CREATE INDEX idx_admin_alerts_active
  ON admin_alerts(created_at DESC)
  WHERE dismissed_at IS NULL;

-- ============================================================================
-- audit_log CHECK widening for the new admin.alert.dismiss[_bulk] actions.
-- SQLite doesn't support ALTER TABLE ... ALTER CONSTRAINT, so the
-- canonical recipe is: copy → drop → rename. The hash chain is preserved
-- intact because we copy every row verbatim (including prev_hash + row_hash).
-- ============================================================================

PRAGMA foreign_keys = OFF;

-- Pre-step: drop the dangling `v_credential_usage` view. Migration 0003
-- dropped `api_key_sender_scopes` but left this view (which references
-- it) intact. SQLite tolerates a broken view at rest, but as soon as we
-- recreate any table, schema re-validation fires and the view's missing-
-- table reference errors with "no such table: main.api_key_sender_scopes".
-- The view is unused (grep across the repo confirms zero references), so
-- we drop it permanently rather than rebuild it with a constant-zero stub.
DROP VIEW IF EXISTS v_credential_usage;

CREATE TABLE audit_log_new (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL CHECK(action IN (
              'bootstrap.consume',
              'bootstrap.webauthn_enrolled',
              'mailbox.create','mailbox.update','mailbox.disable','mailbox.delete',
              'mailbox.expunge',
              'mailbox_sender.create','mailbox_sender.update','mailbox_sender.disable','mailbox_sender.delete',
              'email_sender.create','email_sender.disable',
              'mailbox_receiver.create','mailbox_receiver.update','mailbox_receiver.disable','mailbox_receiver.delete',
              'routing_rule.create','routing_rule.update','routing_rule.delete',
              'api_key.issue','api_key.rotate','api_key.rotate.emergency','api_key.revoke',
              'api_key.revoke.emergency',
              'smtp_credential.issue','smtp_credential.disable','smtp_credential.rotate',
              'mailbox_credential.issue','mailbox_credential.rotate','mailbox_credential.disable',
              'dry_run_rotate',
              'bridge.register','bridge.rotate','bridge.deregister',
              'domain.create','domain.update','domain.disable',
              'domain.verify','domain.verify_incomplete','domain.dkim_rotate',
              'domain.inbound.enable','domain.inbound.disable',
              'domain.outbound.enable','domain.outbound.disable',
              'dkim_key.create','dkim_key.activate','dkim_key.retire',
              'webhook_sub.create','webhook_sub.update','webhook_sub.delete','webhook_sub.replay',
              'webhook_sub.test','webhook_sub.rotate',
              'message.submitted','message.received','message.marked_read','message.expunged',
              'rate_limit.exceeded',
              'cf_zone.configure',
              'mta_sts.enable','mta_sts.disable','mta_sts.promote',
              'tls_rpt.enable','tls_rpt.disable',
              'suppression.create','suppression.disable','suppression.import',
              'message.suppressed','message.sender_suppressed',
              'abuse_event.record',
              'admin.alert.sent',
              'admin.alert.dismiss',
              'admin.alert.dismiss_bulk',
              'sender_abuse_profile.tier_advance',
              'sender.suppress_auto',
              'tls_rpt_report.ingest',
              'dmarc_aggregate_report.ingest',
              'dmarc.promote','dmarc.pause','dmarc.rollback','dmarc.claim_management',
              'triage.classify',
              'triage.operator_override',
              'policy.decide',
              'policy.override',
              'message.held',
              'message.held_release',
              'message.held_drop',
              'moderation.feedback_recorded',
              'inbound_sender_block.create','inbound_sender_block.delete',
              'tenant.create','tenant.update','tenant.disable','tenant.rotate_pepper',
              'operator.create','operator.update','operator.disable',
              'operator.rotate_key','operator.rotate_pubkey',
              'auth.login','auth.logout'
            )),
  target    TEXT,
  meta      TEXT NOT NULL,
  at        INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash  TEXT NOT NULL
);

INSERT INTO audit_log_new (id, actor, action, target, meta, at, prev_hash, row_hash)
SELECT id, actor, action, target, meta, at, prev_hash, row_hash FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX idx_audit_log_at     ON audit_log(at);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_actor  ON audit_log(actor);

PRAGMA foreign_keys = ON;

-- ============================================================================
-- Version stamp
-- ============================================================================
INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0004_admin_alerts_dismissal');
