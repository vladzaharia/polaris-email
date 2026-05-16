-- 0008: extend audit_log.action CHECK constraint to include `cf_zone.configure`
-- emitted by the new CF-zone discover/configure flow (services/api/src/routes/admin/cf-zones.ts).
--
-- SQLite can't ALTER a CHECK constraint, so we follow the same rebuild
-- pattern used in 0006_rename_daemon_to_bridge.sql: rename the old table,
-- create a new one with the extended CHECK, copy rows, drop the old.
--
-- Append-only: only adds an enum value; no data is rewritten.

PRAGMA foreign_keys = OFF;

ALTER TABLE audit_log RENAME TO audit_log_old;

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL CHECK(action IN (
              -- bootstrap
              'bootstrap.consume',
              -- mailbox CRUD
              'mailbox.create','mailbox.update','mailbox.disable','mailbox.delete',
              'mailbox.expunge',
              -- sender CRUD
              'mailbox_sender.create','mailbox_sender.update','mailbox_sender.disable','mailbox_sender.delete',
              'email_sender.create','email_sender.disable',
              -- receiver CRUD
              'mailbox_receiver.create','mailbox_receiver.update','mailbox_receiver.disable','mailbox_receiver.delete',
              'routing_rule.create','routing_rule.update','routing_rule.delete',
              -- credential lifecycle
              'api_key.issue','api_key.rotate','api_key.rotate.emergency','api_key.revoke',
              'api_key.revoke.emergency',
              'smtp_credential.issue','smtp_credential.disable','smtp_credential.rotate',
              'mailbox_credential.issue','mailbox_credential.rotate','mailbox_credential.disable',
              'dry_run_rotate',
              -- bridge lifecycle
              'bridge.register','bridge.rotate','bridge.deregister',
              -- domain + DKIM
              'domain.create','domain.update','domain.disable',
              'domain.verify','domain.verify_incomplete','domain.dkim_rotate',
              'domain.inbound.enable','domain.inbound.disable',
              'domain.outbound.enable','domain.outbound.disable',
              -- dkim_key direct events
              'dkim_key.create','dkim_key.activate','dkim_key.retire',
              -- webhook subs + DLQ
              'webhook_sub.create','webhook_sub.update','webhook_sub.delete','webhook_sub.replay',
              'webhook_sub.test',
              -- messages
              'message.submitted','message.received','message.marked_read','message.expunged',
              -- rate limiting
              'rate_limit.exceeded',
              -- CF zone discover + configure (new)
              'cf_zone.configure',
              -- legacy tenant ops
              'tenant.create','tenant.update','tenant.disable','tenant.rotate_pepper'
            )),
  target    TEXT,
  meta      TEXT NOT NULL,
  at        INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash  TEXT NOT NULL
);

INSERT INTO audit_log (id, actor, action, target, meta, at, prev_hash, row_hash)
  SELECT id, actor, action, target, meta, at, prev_hash, row_hash FROM audit_log_old;

DROP TABLE audit_log_old;

PRAGMA foreign_keys = ON;
