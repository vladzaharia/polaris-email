-- W2b — LLM-assisted complaint triage ledger.
--
-- Records every Workers AI triage classification, including the prompt
-- hash + raw response so an operator can audit + iterate on the prompt
-- without re-running the inference. Used by the panel /reports/triage page.

CREATE TABLE triage_events (
  id                      TEXT PRIMARY KEY,
  message_id              TEXT,
  inbound_alias           TEXT,
  model                   TEXT NOT NULL,
  prompt_hash             TEXT NOT NULL,
  response_json           TEXT NOT NULL,
  category                TEXT NOT NULL,
  severity                TEXT NOT NULL,
  confidence              REAL NOT NULL,
  actionable              INTEGER NOT NULL CHECK (actionable IN (0, 1)),
  target_recipient        TEXT,
  target_sender_principal TEXT,
  target_message_id       TEXT,
  summary                 TEXT,
  applied_suppression_id  TEXT,
  operator_verdict        TEXT,
  created_at              TEXT NOT NULL
);

CREATE INDEX idx_triage_events_category   ON triage_events(category, created_at DESC);
CREATE INDEX idx_triage_events_actionable ON triage_events(actionable, created_at DESC);
CREATE INDEX idx_triage_events_severity   ON triage_events(severity, created_at DESC);
CREATE INDEX idx_triage_events_confidence ON triage_events(confidence ASC, created_at DESC);
CREATE INDEX idx_triage_events_created    ON triage_events(created_at DESC);

-- audit_log extension for triage events.

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
              'dmarc.promote','dmarc.pause','dmarc.rollback','dmarc.claim_management',
              -- W2b / 0018
              'triage.classify',
              'triage.operator_override',
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
VALUES (18, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0018_triage_events');
