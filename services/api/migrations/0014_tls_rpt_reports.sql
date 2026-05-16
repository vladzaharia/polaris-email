-- W5 — TLS-RPT report ingestion.
--
-- Two new tables + a platform mailbox:
--
--   * tls_rpt_reports — one row per inbound TLS-RPT report (RFC 8460).
--     Stores the report-level fields (org, date range, totals) AND a JSON
--     blob of the per-policy + per-failure breakdown for forensics.
--   * tls_rpt_failure_summary — denormalised rollup keyed by
--     (domain, result_type, day) so the panel can render a 7/30 day trend
--     chart without re-parsing every report on each page load.
--
-- The platform-owned `polaris-tls-reports` mailbox is the routing
-- destination for `tlsrpt@plrs.im` (and any future per-tenant
-- `tlsrpt@<domain>` aliases that customers want managed by the platform).
-- services/in detects mail to this mailbox and dispatches into the
-- tlsrpt-ingest handler.

CREATE TABLE tls_rpt_reports (
  id                     TEXT PRIMARY KEY,
  -- The domain the report is ABOUT (extracted from the first policy block;
  -- nullable for reports CF Email Routing forwards without policy-domain
  -- context).
  domain                 TEXT,
  -- Report metadata.
  organization_name      TEXT,
  contact_info           TEXT,
  report_id              TEXT,
  date_range_start       TEXT,
  date_range_end         TEXT,
  total_success_count    INTEGER NOT NULL DEFAULT 0,
  total_failure_count    INTEGER NOT NULL DEFAULT 0,
  -- Full parsed payload (policies + failures), JSON.
  policies_json          TEXT NOT NULL DEFAULT '[]',
  -- Inbound message metadata for traceability.
  source                 TEXT NOT NULL DEFAULT 'arf_inbox'
                           CHECK (source IN ('arf_inbox','admin_import')),
  source_message_id      TEXT,
  -- ISO created timestamp.
  created_at             TEXT NOT NULL
);

CREATE INDEX idx_tls_rpt_reports_domain    ON tls_rpt_reports(domain, created_at DESC);
CREATE INDEX idx_tls_rpt_reports_created   ON tls_rpt_reports(created_at DESC);
CREATE INDEX idx_tls_rpt_reports_failures  ON tls_rpt_reports(total_failure_count DESC, created_at DESC);

CREATE TABLE tls_rpt_failure_summary (
  domain            TEXT NOT NULL,
  -- ISO YYYY-MM-DD (UTC) — daily rollup key.
  day               TEXT NOT NULL,
  result_type       TEXT NOT NULL,
  failed_sessions   INTEGER NOT NULL DEFAULT 0,
  reports           INTEGER NOT NULL DEFAULT 0,
  last_seen_at      TEXT NOT NULL,
  PRIMARY KEY (domain, day, result_type)
);
CREATE INDEX idx_tls_rpt_failure_summary_day ON tls_rpt_failure_summary(day DESC);

-- Platform mailbox for TLS-RPT receiver.
INSERT INTO mailboxes (id, name, description, created_at, updated_at)
VALUES (
  '01HXPLATFORMTLSREPORTS0000',
  'polaris-tls-reports',
  'Platform-owned mailbox for inbound TLS-RPT reports (RFC 8460). services/in dispatches mail here into the W5 ingest handler.',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- audit_log extension for tls_rpt_report.ingest.

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
              -- W5 / 0014
              'tls_rpt_report.ingest',
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
VALUES (14, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0014_tls_rpt_reports');
