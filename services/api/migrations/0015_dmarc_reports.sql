-- W6 — DMARC aggregate report (RUA) ingestion + rollup.
--
-- Three things:
--   * dmarc_aggregate_reports — one row per inbound report (RFC 7489 §7).
--   * dmarc_alignment_rollup  — daily per-domain pass/fail snapshot. The
--     W8 promotion cron will read this to decide whether a domain is ready
--     to advance from p=none → p=quarantine → p=reject.
--   * Platform `polaris-dmarc-reports` mailbox + audit action.
--
-- The C.11 dmarc_rua default routes reports to `mailto:postmaster@{domain}`.
-- W6 ALSO accepts reports at the platform alias `dmarc-rua@plrs.im` so
-- operators that don't want to wire their own postmaster mailbox get
-- platform-managed aggregation for free. To pick this up, customers should
-- include `mailto:dmarc-rua@plrs.im` in their `_dmarc` RUA list — DMARC
-- supports multiple URIs comma-separated.

CREATE TABLE dmarc_aggregate_reports (
  id                    TEXT PRIMARY KEY,
  domain                TEXT,             -- reported-against domain
  org_name              TEXT,
  org_email             TEXT,
  report_id             TEXT,
  date_range_begin      TEXT,
  date_range_end        TEXT,
  policy_p              TEXT,
  policy_sp             TEXT,
  policy_pct            INTEGER,
  policy_adkim          TEXT,
  policy_aspf           TEXT,
  total_count           INTEGER NOT NULL DEFAULT 0,
  total_dmarc_pass      INTEGER NOT NULL DEFAULT 0,
  total_dkim_pass       INTEGER NOT NULL DEFAULT 0,
  total_spf_pass        INTEGER NOT NULL DEFAULT 0,
  records_json          TEXT NOT NULL DEFAULT '[]',
  source                TEXT NOT NULL DEFAULT 'arf_inbox'
                          CHECK (source IN ('arf_inbox','admin_import')),
  source_message_id     TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_dmarc_reports_domain    ON dmarc_aggregate_reports(domain, created_at DESC);
CREATE INDEX idx_dmarc_reports_created   ON dmarc_aggregate_reports(created_at DESC);

-- Daily alignment rollup. Keyed on (domain, day) so the W8 promotion cron
-- can scan a 14- or 30-day window with one PK seek per day.
CREATE TABLE dmarc_alignment_rollup (
  domain                TEXT NOT NULL,
  day                   TEXT NOT NULL,  -- ISO YYYY-MM-DD (UTC)
  reports               INTEGER NOT NULL DEFAULT 0,
  total_count           INTEGER NOT NULL DEFAULT 0,
  dmarc_pass            INTEGER NOT NULL DEFAULT 0,
  dkim_pass             INTEGER NOT NULL DEFAULT 0,
  spf_pass              INTEGER NOT NULL DEFAULT 0,
  last_seen_at          TEXT NOT NULL,
  PRIMARY KEY (domain, day)
);
CREATE INDEX idx_dmarc_rollup_day ON dmarc_alignment_rollup(day DESC);

-- Platform mailbox for DMARC RUA receiver.
INSERT INTO mailboxes (id, name, description, created_at, updated_at)
VALUES (
  '01HXPLATFORMDMARCREPORTS00',
  'polaris-dmarc-reports',
  'Platform-owned mailbox for inbound DMARC aggregate (RUA) reports. services/in dispatches mail here into the W6 ingest handler.',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- audit_log extension for dmarc_aggregate_report.ingest.

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
              -- W6 / 0015
              'dmarc_aggregate_report.ingest',
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
VALUES (15, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0015_dmarc_reports');
