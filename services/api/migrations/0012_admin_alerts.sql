-- W2d — Admin alert pipeline.
--
-- One table records every alert the platform emits (sender suppression
-- fires, phishing/legal classification, threshold breaches, etc.) so the
-- panel /admin/alerts page can render the history and the dedupe cron can
-- decide whether a near-duplicate alert is suppressible.
--
-- Delivery channels (V1):
--   * audit_log (always)
--   * ALERT_WEBHOOK env var (POST JSON if set)
--   * admin_alerts table (always; panel reads this)
--
-- Future channels (email, Slack, PagerDuty) plug into the same writer in
-- services/api/src/lib/admin-alert.ts without schema changes — `delivery`
-- column is a free-form JSON array of per-channel attempts.

CREATE TABLE admin_alerts (
  id              TEXT PRIMARY KEY,
  -- Alert taxonomy. Pluggable but conservative; extend as new sources
  -- (e.g. cf_zone.takeover_detected) land.
  alert_type      TEXT NOT NULL
                    CHECK (alert_type IN (
                      'sender_suppressed',
                      'phishing_report_received',
                      'legal_takedown_received',
                      'sender_threshold_breached',
                      'tls_rpt_failure_burst',
                      'dmarc_alignment_drop',
                      'synthetic_check_failed',
                      'manual'
                    )),
  severity        TEXT NOT NULL DEFAULT 'warn'
                    CHECK (severity IN ('info','warn','critical')),
  -- A stable target identifier (sender_address, mailbox_id, domain_id,
  -- suppression_id, etc.) that the dedupe key is computed from.
  target          TEXT NOT NULL,
  -- Operator-facing subject + body. Plain text; the email channel may wrap
  -- in HTML later.
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  -- JSON: per-channel delivery attempts. e.g. [{"channel":"audit_log","ok":true},
  -- {"channel":"webhook","ok":false,"status":502,"error":"..."}].
  delivery        TEXT NOT NULL DEFAULT '[]',
  -- Free-form JSON payload that triggered the alert (suppression id,
  -- event ids, classification, etc).
  payload         TEXT NOT NULL DEFAULT '{}',
  -- The dedupe key used (sha256 hash trimmed to 32 chars). Lookup via
  -- KV_ADMIN_ALERTS keeps the cron-friendly behaviour intact even after the
  -- KV TTL expires; we just consult the row instead.
  dedupe_key      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_admin_alerts_type     ON admin_alerts(alert_type, created_at DESC);
CREATE INDEX idx_admin_alerts_severity ON admin_alerts(severity, created_at DESC);
CREATE INDEX idx_admin_alerts_target   ON admin_alerts(target, created_at DESC);
CREATE INDEX idx_admin_alerts_dedupe   ON admin_alerts(dedupe_key, created_at DESC);
CREATE INDEX idx_admin_alerts_created  ON admin_alerts(created_at DESC);

-- audit_log CHECK rebuild — adds admin.alert.sent.

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
              -- W2d / 0012
              'admin.alert.sent',
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
VALUES (12, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0012_admin_alerts');
