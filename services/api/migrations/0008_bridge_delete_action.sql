-- 0008_bridge_delete_action.sql
--
-- Adds `bridge.delete` to the `audit_log.action` CHECK enum so the new
-- hard-delete endpoint (DELETE /v1/admin/bridges/:id?hard=true) can
-- record what it did.
--
-- SQLite has no `ALTER TABLE ... ALTER CONSTRAINT`; this is the
-- copy → drop → rename pattern used by 0004 and 0005. The chained-hash
-- invariant survives because rows are copied verbatim — every row's
-- prev_hash + row_hash carry across to the rebuilt table.
--
-- The CHECK list below is the live production list (verified against
-- D1 sqlite_master) plus the single new entry. Other Zod-vs-CHECK
-- drift (operator.*, dmarc.claim_management, etc.) is intentionally
-- NOT addressed here — keeping this migration scoped to one change so
-- it's trivial to review and revert if needed.

PRAGMA foreign_keys = OFF;

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
              'bridge.register','bridge.rotate','bridge.deregister','bridge.delete',
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
              'dmarc.promote','dmarc.pause','dmarc.rollback',
              'dmarc.mgmt_enabled',
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
