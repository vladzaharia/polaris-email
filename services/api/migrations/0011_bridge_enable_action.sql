-- 0011_bridge_enable_action.sql
--
-- Rename `bridge.deregister` → `bridge.disable` and add `bridge.enable`
-- to the audit_log CHECK. Bridges go from `disabled_at = <ts>` back to
-- `disabled_at = NULL` via either:
--   (a) the explicit Enable action on the Detail page (emits
--       `bridge.enable`), or
--   (b) Roll HMAC Secret (which mints a fresh pair AND clears
--       `disabled_at` atomically — emits both `bridge.rotate` and
--       `bridge.enable`).
--
-- Pre-production, so we rename existing rows in-place rather than
-- keeping the legacy name around as a synonym. The chained row_hash
-- invariant breaks for any converted rows — acceptable in
-- pre-production. The nightly `audit-verify` cron will surface the
-- break once; manual reseal (or wait for new rows to extend a fresh
-- chain from the next anchor) is the recovery path.
--
-- Ordering: we rebuild the table TWICE inside the migration. The
-- intermediate CHECK lets the rename UPDATE go through (the existing
-- CHECK from 0010 doesn't know `bridge.disable`); the final CHECK
-- drops `bridge.deregister` so no future row can use it. SQLite has
-- no ALTER CHECK, hence the copy → drop → rename, same pattern as
-- 0008 / 0009 / 0010.

PRAGMA foreign_keys = OFF;

-- 1) Intermediate rebuild: CHECK accepts BOTH the old and the new
--    action names so the upcoming UPDATE can execute without
--    tripping the constraint.
CREATE TABLE audit_log_mid (
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
              'bridge.register','bridge.rotate',
              'bridge.deregister','bridge.disable','bridge.enable',
              'bridge.delete',
              'bridge.cf_token.mint','bridge.cf_token.revoke',
              'bridge.ts_authkey.mint','bridge.ts_authkey.revoke',
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

INSERT INTO audit_log_mid (id, actor, action, target, meta, at, prev_hash, row_hash)
SELECT id, actor, action, target, meta, at, prev_hash, row_hash FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_mid RENAME TO audit_log;

-- 2) Rename rows now that the CHECK accepts the new name.
UPDATE audit_log SET action = 'bridge.disable' WHERE action = 'bridge.deregister';

-- 3) Final rebuild: drop `bridge.deregister` from the allowed set so
--    no future row can use it.
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
              'bridge.register','bridge.rotate','bridge.disable','bridge.enable','bridge.delete',
              'bridge.cf_token.mint','bridge.cf_token.revoke',
              'bridge.ts_authkey.mint','bridge.ts_authkey.revoke',
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
