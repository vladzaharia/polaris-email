-- polaris-email — Phase L bridge audit actions (schema version=3)
--
-- Widens audit_log.action CHECK to include new actions emitted by the L slice:
--   * mailbox.expunge              -- POST /v1/mailboxes/:id/expunge purge
--   * mailbox_credential.issue     -- POST /v1/admin/mailboxes/:id/credentials
--   * mailbox_credential.rotate    -- POST /v1/admin/mailboxes/:id/credentials/:credId/rotate
--   * mailbox_credential.disable   -- DELETE /v1/admin/mailboxes/:id/credentials/:credId
--
-- SQLite CHECK constraints cannot be widened in place; we rewrite the table.
-- audit_log.id is preserved (AUTOINCREMENT). Order of operations:
--   1. Rename existing audit_log -> audit_log_old.
--   2. Recreate audit_log with the widened CHECK + the same indexes.
--   3. Copy rows over.
--   4. Drop audit_log_old.

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
              -- mailbox bridge ops (L)
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
              -- unified mailbox credentials (L)
              'mailbox_credential.issue','mailbox_credential.rotate','mailbox_credential.disable',
              'dry_run_rotate',
              -- daemon lifecycle
              'daemon.register','daemon.rotate','daemon.deregister',
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

CREATE INDEX idx_audit_log_at     ON audit_log(at);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_actor  ON audit_log(actor);

PRAGMA foreign_keys = ON;

INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0003_audit_actions');
