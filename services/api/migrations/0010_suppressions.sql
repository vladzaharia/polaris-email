-- W1 — bi-directional suppression list.
--
-- One table is the source of truth for "do not send" decisions, queried by
-- services/out on every outbound message. Rows distinguished by
-- `entity_type`:
--
--   * 'recipient' — do not send TO this address (hard bounce, spam complaint,
--     one-click unsubscribe, manual op flag, LLM-classified abuse).
--   * 'sender'    — do not allow this principal/mailbox/sender_address to
--     send anything (auto-fired by the W2c sender-threshold cron, manual
--     panel/CLI add for ops, or single-shot critical bypass like
--     phishing/legal).
--
-- Scope columns let writers target the right granularity:
--   scope = 'global'         | scope_target = NULL
--   scope = 'domain'         | scope_target = mail_domains.id  (the *sender's* domain)
--   scope = 'mailbox'        | scope_target = mailboxes.id
--   scope = 'sender_address' | scope_target = mailbox_senders.id  (or the literal address)
--
-- For recipient suppressions, scope/scope_target additionally constrain which
-- SENDER the suppression applies to — e.g. an unsubscribe is per-sender, but
-- a hard bounce is global. The enforcement query in services/out joins both
-- (entity_type, address, scope).
--
-- expires_at semantics:
--   * NULL                = permanent.
--   * future ISO-8601     = active until that timestamp; outbound check ignores
--                            rows where expires_at < now.
--   * past ISO-8601       = expired; row retained for audit but not enforced.
--
-- W2c (sender threshold) writes time-boxed rows with escalating durations,
-- and the sender_abuse_profile table (added in 0012) tracks the lifetime
-- history so escalation persists across expirations.
--
-- Address normalization is the producer's responsibility. The
-- @polaris-email/suppressions package owns the canonical form:
-- NFC, lowercase, IDNA-encode domain, strip Gmail-style +tags only when
-- domain matches the Gmail-equivalent list.
--
-- Reasons mapped to sources (informational):
--   hard_bounce              → cf_email_service (W3) / arf_inbox (W2)
--   spam_complaint           → arf_inbox (W2) / llm_triage (W2b)
--   unsubscribe              → one_click (W4) / cli / panel
--   manual                   → cli / panel
--   arf_complaint            → arf_inbox (W2)
--   phishing_report          → llm_triage (W2b)
--   sender_abuse_threshold   → sender_threshold_cron (W2c)
--   role_account             → import (legacy migrations)
--   invalid                  → cf_email_service (CF reports an undeliverable
--                              address shape)

CREATE TABLE suppressions (
  id                  TEXT PRIMARY KEY,
  entity_type         TEXT NOT NULL
                        CHECK (entity_type IN ('recipient','sender')),
  address_normalized  TEXT NOT NULL,
  address_local       TEXT,
  address_domain      TEXT,
  scope               TEXT NOT NULL DEFAULT 'global'
                        CHECK (scope IN ('global','domain','mailbox','sender_address')),
  scope_target        TEXT,
  reason              TEXT NOT NULL
                        CHECK (reason IN (
                          'hard_bounce',
                          'spam_complaint',
                          'unsubscribe',
                          'manual',
                          'arf_complaint',
                          'phishing_report',
                          'sender_abuse_threshold',
                          'role_account',
                          'invalid'
                        )),
  source              TEXT NOT NULL
                        CHECK (source IN (
                          'cf_email_service',
                          'arf_inbox',
                          'one_click',
                          'cli',
                          'panel',
                          'import',
                          'sender_threshold_cron',
                          'llm_triage'
                        )),
  source_ref          TEXT,                              -- FK-ish to triage_events / abuse_events / messages
  severity            TEXT NOT NULL DEFAULT 'warn'
                        CHECK (severity IN ('info','warn','critical')),
  created_at          TEXT NOT NULL,
  expires_at          TEXT,                              -- NULL = permanent
  disabled_at         TEXT,                              -- operator override (audit-logged)
  disabled_reason     TEXT,
  notes               TEXT
);

-- Per-direction lookup. The enforcement path queries by entity_type + address
-- and (for senders) optionally scope+scope_target, so the leading column is
-- entity_type to keep the b-tree narrow.
CREATE INDEX idx_suppressions_lookup
  ON suppressions(entity_type, address_normalized);

-- Scoped lookup for sender suppressions that target a specific principal.
CREATE INDEX idx_suppressions_scope
  ON suppressions(entity_type, scope, scope_target, address_normalized);

-- Panel filters: list-by-reason and list-by-recent.
CREATE INDEX idx_suppressions_reason ON suppressions(reason, created_at DESC);
CREATE INDEX idx_suppressions_created ON suppressions(created_at DESC);

-- Composite uniqueness: at most one *active* row per (entity_type, address,
-- scope, scope_target) tuple. Active = disabled_at IS NULL.
-- Time-expired rows stay in the table for audit but are filtered out by the
-- expires_at clause in the enforcement query.
CREATE UNIQUE INDEX idx_suppressions_active_unique
  ON suppressions(entity_type, address_normalized, scope, COALESCE(scope_target, ''))
  WHERE disabled_at IS NULL;

-- ---------------------------------------------------------------------------
-- audit_log CHECK rebuild — full additive list following the 0009 pattern.
-- New entries:
--   suppression.create, suppression.disable, suppression.import
--   message.suppressed, message.sender_suppressed
-- ---------------------------------------------------------------------------

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
              -- CF zone discover + configure (0008)
              'cf_zone.configure',
              -- MTA-STS + TLS-RPT (Phase C / 0009)
              'mta_sts.enable','mta_sts.disable','mta_sts.promote',
              'tls_rpt.enable','tls_rpt.disable',
              -- suppressions (W1 / 0010)
              'suppression.create','suppression.disable','suppression.import',
              'message.suppressed','message.sender_suppressed',
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
VALUES (10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0010_suppressions');
