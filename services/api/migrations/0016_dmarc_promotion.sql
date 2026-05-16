-- W8 — DMARC policy auto-promotion state machine.
--
-- Reads the W6 dmarc_alignment_rollup data and advances mail_domains
-- through `dmarc_policy ∈ {none, quarantine, reject}` based on alignment
-- rate over a soak period. The cron is GUARDED: it only writes DNS for
-- domains where `dmarc_record_managed_by_polaris=1`. Operators opt in
-- explicitly via a new admin endpoint; for the default state (boolean=0)
-- the cron only updates the promotion-state column so the panel can show
-- "ready to promote" without ever touching DNS.
--
-- This honors the CLAUDE.md rule: never override Cloudflare-managed DNS
-- AND never override operator-authored DMARC records.

ALTER TABLE mail_domains
  ADD COLUMN dmarc_promotion_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (dmarc_promotion_mode IN ('auto', 'manual', 'paused'));

ALTER TABLE mail_domains
  ADD COLUMN dmarc_promotion_state TEXT NOT NULL DEFAULT 'none'
    CHECK (dmarc_promotion_state IN (
      'none',                  -- at p=none, no recommendation yet
      'quarantine_ready',      -- alignment good for soak → recommend promote
      'quarantine',            -- at p=quarantine (panel record)
      'reject_ready',          -- alignment still good → recommend final promote
      'reject',                -- at p=reject (terminal)
      'paused'                 -- alignment dropped → cron paused, operator review
    ));

ALTER TABLE mail_domains
  ADD COLUMN dmarc_promotion_last_at TEXT;

-- Has POLARIS taken management of `_dmarc.{domain}`? Default 0 means the
-- cron is observe-only for this domain. Flipping to 1 requires the operator
-- to call POST /v1/admin/domains/:id/dmarc/claim-management — they're
-- attesting they're OK with the platform writing DMARC TXT records.
ALTER TABLE mail_domains
  ADD COLUMN dmarc_record_managed_by_polaris INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_mail_domains_dmarc_promotion ON mail_domains(dmarc_promotion_state);

-- audit_log extension for the promotion state transitions.

PRAGMA foreign_keys = OFF;

ALTER TABLE audit_log RENAME TO audit_log_old;

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL CHECK(action IN (
              'bootstrap.consume',
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
              'webhook_sub.test',
              'message.submitted','message.received','message.marked_read','message.expunged',
              'rate_limit.exceeded',
              'cf_zone.configure',
              'mta_sts.enable','mta_sts.disable','mta_sts.promote',
              'tls_rpt.enable','tls_rpt.disable',
              'suppression.create','suppression.disable','suppression.import',
              'message.suppressed','message.sender_suppressed',
              'abuse_event.record',
              'admin.alert.sent',
              'sender_abuse_profile.tier_advance',
              'sender.suppress_auto',
              'tls_rpt_report.ingest',
              'dmarc_aggregate_report.ingest',
              -- W8 / 0016
              'dmarc.promote',
              'dmarc.pause',
              'dmarc.rollback',
              'dmarc.claim_management',
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
VALUES (16, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0016_dmarc_promotion');
