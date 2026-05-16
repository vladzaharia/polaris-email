-- Phase C — MTA-STS (RFC 8461) + TLS-RPT (RFC 8460) columns on mail_domains
-- and five new audit_log actions to track lifecycle.
--
-- Self-hosted MTA-STS architecture (see /Users/vlad/.claude/plans/
-- plan-a-glimmering-harbor.md §C.1): the policy file is served by
-- services/api from a per-tenant Worker custom domain
-- (`mta-sts.{tenant}`), so `mta_sts_mode` actually controls what the
-- world sees, not just bookkeeping. `mta_sts_max_age` lets operators
-- tune the sender-cache TTL per tenant (RFC 8461 allows 0..31557600).
-- `tls_rpt_*` columns drive a single TXT record at `_smtp._tls.{tenant}`.

ALTER TABLE mail_domains ADD COLUMN mta_sts_mode TEXT NOT NULL DEFAULT 'none'
  CHECK (mta_sts_mode IN ('none','testing','enforce'));
ALTER TABLE mail_domains ADD COLUMN mta_sts_policy_id TEXT;
ALTER TABLE mail_domains ADD COLUMN mta_sts_max_age INTEGER NOT NULL DEFAULT 86400;
ALTER TABLE mail_domains ADD COLUMN mta_sts_verified_at TEXT;
ALTER TABLE mail_domains ADD COLUMN tlsrpt_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_domains ADD COLUMN tlsrpt_rua TEXT;
ALTER TABLE mail_domains ADD COLUMN tlsrpt_verified_at TEXT;

CREATE INDEX idx_mail_domains_mta_sts_mode ON mail_domains(mta_sts_mode);

-- audit_log.action CHECK rebuild — SQLite cannot widen CHECK in place. Same
-- pattern as 0003 / 0006: rename old, recreate with widened list, copy, drop.

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
              -- mailbox bridge ops
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
              -- unified mailbox credentials
              'mailbox_credential.issue','mailbox_credential.rotate','mailbox_credential.disable',
              'dry_run_rotate',
              -- bridge lifecycle (renamed from daemon.* in B4)
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
              -- MTA-STS + TLS-RPT (Phase C)
              'mta_sts.enable','mta_sts.disable','mta_sts.promote',
              'tls_rpt.enable','tls_rpt.disable',
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
VALUES (7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0007_mta_sts');
