-- Hybrid Policy Engine (heuristics + inbound LLM tiebreaker).
--
-- Adds five tables that back the new policy decisions, held-message
-- moderation queue, admin-feedback learning loop, per-mailbox inbound
-- blocklist, and per-scope policy config.
--
-- Also extends the `messages` table: persists `stream_type` (currently
-- only lives on the SendRequest schema and is dropped after fan-out),
-- adds `policy_decision_id` FK, and extends the status CHECK to permit
-- the new 'held' state.
--
-- And rebuilds audit_log's CHECK with the policy/moderation actions.

-- ---------------------------------------------------------------------------
-- policy_decisions — one row per evaluatePolicy() invocation.
-- ---------------------------------------------------------------------------

CREATE TABLE policy_decisions (
  id                       TEXT PRIMARY KEY,
  message_id               TEXT,
  direction                TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  stream_type              TEXT NOT NULL CHECK(stream_type IN ('transactional','marketing','agent','inbound')),
  verdict                  TEXT NOT NULL CHECK(verdict IN ('pass','pass_warn','hold','block')),
  total_score              INTEGER NOT NULL,
  heuristic_reasons_json   TEXT NOT NULL,
  llm_invoked              INTEGER NOT NULL CHECK(llm_invoked IN (0,1)),
  llm_label                TEXT,
  llm_confidence           REAL,
  llm_budget_state         TEXT,
  decided_at               TEXT NOT NULL,
  override_decision_id     TEXT,
  override_admin_id        TEXT,
  override_reason          TEXT
);

CREATE INDEX idx_policy_decisions_message     ON policy_decisions(message_id);
CREATE INDEX idx_policy_decisions_verdict     ON policy_decisions(verdict, decided_at DESC);
CREATE INDEX idx_policy_decisions_dir_stream  ON policy_decisions(direction, stream_type, decided_at DESC);
CREATE INDEX idx_policy_decisions_decided     ON policy_decisions(decided_at DESC);

-- ---------------------------------------------------------------------------
-- held_messages — moderation queue. One row per 'hold' verdict.
-- ---------------------------------------------------------------------------

CREATE TABLE held_messages (
  id                 TEXT PRIMARY KEY,
  message_id         TEXT,
  direction          TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  stream_type        TEXT NOT NULL,
  decision_id        TEXT NOT NULL REFERENCES policy_decisions(id),
  raw_mime_r2_key    TEXT NOT NULL,
  hold_reason        TEXT NOT NULL,
  hold_until         TEXT NOT NULL,
  released_at        TEXT,
  released_by        TEXT,
  released_action    TEXT CHECK(released_action IN (
                       'released','dropped','expired_auto_drop','expired_auto_release'
                     )),
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_held_messages_open        ON held_messages(released_action, created_at DESC);
CREATE INDEX idx_held_messages_hold_until  ON held_messages(hold_until);
CREATE INDEX idx_held_messages_decision    ON held_messages(decision_id);

-- ---------------------------------------------------------------------------
-- moderation_feedback — admin decisions, fed back into the LLM prompt.
-- ---------------------------------------------------------------------------

CREATE TABLE moderation_feedback (
  id                          TEXT PRIMARY KEY,
  decision_id                 TEXT NOT NULL REFERENCES policy_decisions(id),
  message_id                  TEXT,
  admin_id                    TEXT NOT NULL,
  action                      TEXT NOT NULL CHECK(action IN (
                                'released_as_legit',
                                'dropped_as_phishing',
                                'dropped_as_spam',
                                'dropped_as_marketing',
                                'reclassified'
                              )),
  original_verdict            TEXT NOT NULL,
  corrected_verdict           TEXT,
  message_summary             TEXT NOT NULL,
  heuristic_reasons_summary   TEXT NOT NULL,
  llm_label_at_decision       TEXT,
  llm_confidence_at_decision  REAL,
  admin_notes                 TEXT,
  created_at                  TEXT NOT NULL
);

CREATE INDEX idx_moderation_feedback_recent   ON moderation_feedback(created_at DESC);
CREATE INDEX idx_moderation_feedback_admin    ON moderation_feedback(admin_id, created_at DESC);
CREATE INDEX idx_moderation_feedback_action   ON moderation_feedback(action, created_at DESC);

-- ---------------------------------------------------------------------------
-- inbound_sender_blocks — per-mailbox sender blocklist managed by admin.
-- ---------------------------------------------------------------------------

CREATE TABLE inbound_sender_blocks (
  id                           TEXT PRIMARY KEY,
  mailbox_id                   TEXT NOT NULL REFERENCES mailboxes(id),
  sender_address_normalized    TEXT NOT NULL,
  reason                       TEXT,
  created_by                   TEXT NOT NULL,
  created_at                   TEXT NOT NULL,
  UNIQUE(mailbox_id, sender_address_normalized)
);

CREATE INDEX idx_inbound_sender_blocks_mailbox ON inbound_sender_blocks(mailbox_id);

-- ---------------------------------------------------------------------------
-- policy_config — global / per-domain / per-mailbox policy overrides.
-- ---------------------------------------------------------------------------

CREATE TABLE policy_config (
  id            TEXT PRIMARY KEY,
  scope_type    TEXT NOT NULL CHECK(scope_type IN ('global','domain','mailbox')),
  scope_target  TEXT,
  config_json   TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  UNIQUE(scope_type, scope_target)
);

-- ---------------------------------------------------------------------------
-- Rebuild messages: add stream_type + policy_decision_id columns, and
-- extend the status CHECK to permit 'held'.
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys = OFF;

ALTER TABLE messages RENAME TO messages_old_0019;

CREATE TABLE messages (
  id                      TEXT PRIMARY KEY,
  mailbox_id              TEXT NOT NULL REFERENCES mailboxes(id),
  principal_id            TEXT REFERENCES principals(id),
  bridge_id               TEXT REFERENCES bridges(id),
  direction               TEXT NOT NULL CHECK(direction IN ('in','out')),
  status                  TEXT NOT NULL CHECK(status IN (
                            'received','mime_stored','queued','sending',
                            'sent','bounced','delivered','failed','held')),
  from_addr               TEXT NOT NULL,
  from_addr_normalized    TEXT GENERATED ALWAYS AS (LOWER(from_addr)) STORED,
  to_addrs                TEXT,
  subject                 TEXT,
  r2_key                  TEXT NOT NULL,
  content_sha256          TEXT NOT NULL,
  parsed_json             TEXT,
  body_bytes              INTEGER,
  attachments_total_bytes INTEGER,
  idempotency_key         TEXT,
  message_id_header       TEXT,
  header_message_id       TEXT,
  thread_id               TEXT,
  send_attempt_id         TEXT,
  received_at_bridge      TEXT,
  received_at_api         TEXT,
  queued_at               TEXT,
  sending_at              TEXT,
  sent_at                 TEXT,
  delivered_at            TEXT,
  failed_at               TEXT,
  bounce_metadata         TEXT,
  last_error              TEXT,
  auth_spf                TEXT,
  auth_dkim               TEXT,
  auth_dmarc              TEXT,
  auth_remote_ip          TEXT,
  stream_type             TEXT NOT NULL DEFAULT 'transactional'
                          CHECK(stream_type IN ('transactional','marketing','agent','inbound')),
  policy_decision_id      TEXT,
  created_at              TEXT NOT NULL
);

INSERT INTO messages (
  id, mailbox_id, principal_id, bridge_id, direction, status,
  from_addr, to_addrs, subject, r2_key, content_sha256, parsed_json,
  body_bytes, attachments_total_bytes, idempotency_key, message_id_header,
  header_message_id, thread_id, send_attempt_id, received_at_bridge,
  received_at_api, queued_at, sending_at, sent_at, delivered_at, failed_at,
  bounce_metadata, last_error, auth_spf, auth_dkim, auth_dmarc,
  auth_remote_ip, stream_type, policy_decision_id, created_at
)
SELECT
  id, mailbox_id, principal_id, bridge_id, direction, status,
  from_addr, to_addrs, subject, r2_key, content_sha256, parsed_json,
  body_bytes, attachments_total_bytes, idempotency_key, message_id_header,
  header_message_id, thread_id, send_attempt_id, received_at_bridge,
  received_at_api, queued_at, sending_at, sent_at, delivered_at, failed_at,
  bounce_metadata, last_error, auth_spf, auth_dkim, auth_dmarc,
  auth_remote_ip,
  -- Direction='in' on legacy rows gets stream_type='inbound'; everything
  -- else defaults to 'transactional' (which was the implicit pre-engine
  -- behaviour for outbound).
  CASE WHEN direction='in' THEN 'inbound' ELSE 'transactional' END,
  NULL,
  created_at
FROM messages_old_0019;

DROP TABLE messages_old_0019;

CREATE INDEX idx_messages_mailbox_created     ON messages(mailbox_id, created_at DESC);
CREATE INDEX idx_messages_mailbox_dir_status  ON messages(mailbox_id, direction, status);
CREATE INDEX idx_messages_direction_status_at ON messages(direction, status, created_at DESC);
CREATE INDEX idx_messages_from_normalized     ON messages(from_addr_normalized);
CREATE INDEX idx_messages_content_sha256      ON messages(content_sha256);
CREATE INDEX idx_messages_idempotency_key     ON messages(idempotency_key);
CREATE INDEX idx_messages_mailbox_thread      ON messages(mailbox_id, thread_id, created_at DESC);
CREATE INDEX idx_messages_header_message_id   ON messages(header_message_id);
CREATE INDEX idx_messages_policy_decision     ON messages(policy_decision_id);
CREATE INDEX idx_messages_stream_type         ON messages(stream_type, created_at DESC);

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Rebuild audit_log CHECK with the new policy + moderation actions.
-- ---------------------------------------------------------------------------

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
              'triage.classify',
              'triage.operator_override',
              -- Policy engine / 0019.
              'policy.decide',
              'policy.verdict_block',
              'policy.verdict_hold',
              'policy.override',
              'policy.config_update',
              'message.held',
              'message.held_release',
              'message.held_drop',
              'moderation.feedback_recorded',
              'inbound_sender_block.create','inbound_sender_block.delete',
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
VALUES (19, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0019_policy_engine');
