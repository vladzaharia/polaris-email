-- polaris-email — canonical end-state schema (version=1)
--
-- Single D1 database (`polaris-email`). Append-only going forward: any change
-- after this file lands as `0002_*.sql`, `0003_*.sql`, etc.
--
-- ============================================================================
-- Naming conventions (deliberate inconsistency)
-- ============================================================================
-- * Better-auth tables are SINGULAR (`user`, `session`, `account`,
--   `verification`) because the Drizzle adapter expects these exact names.
-- * Everything else is PLURAL (`mailboxes`, `mail_domains`, `mailbox_senders`,
--   `messages`, ...). This split is permanent; do not rename.
--
-- ============================================================================
-- Timestamp formats (deliberate split)
-- ============================================================================
-- * Better-auth tables (`user`, `session`, `account`, `verification`) and
--   `step_ups.valid_until` use INTEGER MILLISECONDS since epoch
--   (better-auth's Drizzle adapter requires this).
-- * `audit_log.at` / `audit_anchors.signed_at` use INTEGER (legacy ms epoch).
-- * Every other table uses TEXT ISO-8601 (e.g. `2025-01-02T03:04:05.678Z`)
--   for human/debug readability.
-- This split is permanent.
--
-- ============================================================================
-- CHECK enums (enumerated inline at each column)
-- ============================================================================
-- * mail_domains.status           : pending | verifying | verified | failed | disabled
-- * mail_domains.provider         : cloudflare
-- * dkim_keys.algo                : ed25519 | rsa2048
-- * dkim_keys.state               : pending | active | retiring
-- * principals.kind               : api_key | smtp_cred
-- * api_keys.status               : primary | secondary | revoked
-- * messages.direction            : in | out
-- * messages.status               : received | mime_stored | queued | sending | sent | bounced | delivered | failed
-- * mailbox_receivers.action      : webhook | forward | drop
-- * webhook_subs.kind             : external | tailnet
-- * message_deliveries.status     : pending | succeeded | failed | dlq
-- * approvals.status              : pending | approved | rejected
-- * audit_log.action              : (long list — see CHECK on the column)
--
-- ============================================================================
-- FK ON DELETE policy (per A9)
-- ============================================================================
-- mailbox_senders.mailbox_id           -> CASCADE
-- mailbox_receivers.mailbox_id         -> CASCADE
-- webhook_subs.mailbox_id              -> CASCADE
-- principals.mailbox_id                -> CASCADE
-- api_key_sender_scopes.api_key_id     -> CASCADE
-- api_key_sender_scopes.sender_id      -> CASCADE
-- api_keys.principal_id                -> CASCADE
-- submission_credentials.principal_id  -> CASCADE
-- submission_credentials.sender_id     -> CASCADE
-- message_deliveries.message_id        -> CASCADE
-- message_deliveries.webhook_sub_id    -> CASCADE
-- webhook_dlq.message_id               -> SET NULL  (preserve DLQ for audit)
-- webhook_dlq.webhook_sub_id           -> CASCADE
-- mailbox_receivers.webhook_sub_id     -> SET NULL
-- approvals.requester_user_id          -> CASCADE
-- approvals.approver_user_id           -> SET NULL
-- session.user_id / account.user_id    -> CASCADE (better-auth standard)
-- step_ups.user_id                     -> CASCADE
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ===========================================================================
-- Bookkeeping plane
-- ===========================================================================

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  sha        TEXT NOT NULL
);

-- One-shot bootstrap. id is a sentinel constant so only one row can exist.
-- bin/bootstrap.sh + routes/bootstrap.ts read/write `consumed_at` and
-- `admin_key_id`; `admin_key_secret` and `webauthn_credential_id` are slots
-- for the WebAuthn enrollment flow.
CREATE TABLE bootstrap (
  id                     INTEGER PRIMARY KEY CHECK(id = 1),
  consumed_at            TEXT,
  admin_key_id           TEXT,
  admin_key_secret       TEXT,
  webauthn_credential_id TEXT
);
INSERT INTO bootstrap (id) VALUES (1);

-- ===========================================================================
-- Cloudflare zone plane
-- ===========================================================================

CREATE TABLE zones (
  id          TEXT PRIMARY KEY,
  cf_zone_id  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

-- ===========================================================================
-- Mailbox plane
-- ===========================================================================
-- Note: mailboxes.default_sender_id is a forward reference to mailbox_senders
-- (created next). SQLite allows forward FKs because constraints are checked
-- only at insert/update time.

CREATE TABLE mailboxes (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  description       TEXT,
  default_sender_id TEXT REFERENCES mailbox_senders(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  disabled_at       TEXT
);
CREATE INDEX idx_mailboxes_disabled_at ON mailboxes(disabled_at);

CREATE TABLE mail_domains (
  id                   TEXT PRIMARY KEY,
  zone_id              TEXT NOT NULL REFERENCES zones(id),
  parent_domain_id     TEXT REFERENCES mail_domains(id),
  name                 TEXT NOT NULL UNIQUE,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK(status IN ('pending','verifying','verified','failed','disabled')),
  wildcard_subdomains  INTEGER NOT NULL DEFAULT 1,
  dmarc_policy         TEXT,
  dmarc_rua            TEXT,
  inbound_enabled      INTEGER NOT NULL DEFAULT 0,
  outbound_enabled     INTEGER NOT NULL DEFAULT 0,
  provider             TEXT NOT NULL DEFAULT 'cloudflare'
                         CHECK(provider IN ('cloudflare')),
  cf_zone_id           TEXT,
  dkim_selector        TEXT DEFAULT 'cf',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  verified_at          TEXT,
  last_verify_check_at TEXT,
  disabled_at          TEXT
);
CREATE INDEX idx_mail_domains_zone_id ON mail_domains(zone_id);
CREATE INDEX idx_mail_domains_parent  ON mail_domains(parent_domain_id);
CREATE INDEX idx_mail_domains_status  ON mail_domains(status);

CREATE TABLE mailbox_senders (
  id                  TEXT PRIMARY KEY,
  mailbox_id          TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  domain_id           TEXT NOT NULL REFERENCES mail_domains(id),
  address             TEXT NOT NULL UNIQUE,
  local_part          TEXT,
  display_name        TEXT,
  default_for_mailbox INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  disabled_at         TEXT
);
CREATE INDEX idx_mailbox_senders_mailbox_id ON mailbox_senders(mailbox_id);
CREATE INDEX idx_mailbox_senders_domain_id  ON mailbox_senders(domain_id);
CREATE INDEX idx_mailbox_senders_address_active
  ON mailbox_senders(address) WHERE disabled_at IS NULL;

CREATE TABLE mailbox_receivers (
  id              TEXT PRIMARY KEY,
  mailbox_id      TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  domain_id       TEXT NOT NULL REFERENCES mail_domains(id),
  priority        INTEGER NOT NULL DEFAULT 100,
  address_pattern TEXT NOT NULL,
  action          TEXT NOT NULL CHECK(action IN ('webhook','forward','drop')),
  webhook_sub_id  TEXT REFERENCES webhook_subs(id) ON DELETE SET NULL,
  forward_to      TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  disabled_at     TEXT
);
CREATE INDEX idx_mailbox_receivers_mailbox_id ON mailbox_receivers(mailbox_id);
CREATE INDEX idx_mailbox_receivers_domain_priority
  ON mailbox_receivers(domain_id, priority, address_pattern)
  WHERE enabled = 1 AND disabled_at IS NULL;

CREATE TABLE dkim_keys (
  id           TEXT PRIMARY KEY,
  domain_id    TEXT NOT NULL REFERENCES mail_domains(id),
  selector     TEXT NOT NULL,
  public_key   TEXT NOT NULL,
  algo         TEXT NOT NULL CHECK(algo IN ('ed25519','rsa2048')),
  state        TEXT NOT NULL CHECK(state IN ('pending','active','retiring')),
  activated_at TEXT,
  retired_at   TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(domain_id, selector)
);
CREATE INDEX idx_dkim_keys_domain_id ON dkim_keys(domain_id);
CREATE INDEX idx_dkim_keys_state     ON dkim_keys(state);

-- ===========================================================================
-- Credential plane
-- ===========================================================================

CREATE TABLE principals (
  id           TEXT PRIMARY KEY,
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK(kind IN ('api_key','smtp_cred')),
  display_name TEXT,
  created_at   TEXT NOT NULL,
  disabled_at  TEXT
);
CREATE INDEX idx_principals_mailbox_id ON principals(mailbox_id);
CREATE INDEX idx_principals_kind       ON principals(kind);

CREATE TABLE api_keys (
  id                 TEXT PRIMARY KEY,
  principal_id       TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  prefix             TEXT NOT NULL,
  secret_argon2id    TEXT NOT NULL,
  scopes             TEXT NOT NULL,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  status             TEXT NOT NULL DEFAULT 'primary'
                       CHECK(status IN ('primary','secondary','revoked')),
  created_at         TEXT NOT NULL,
  last_used_at       TEXT,
  last_used_ip       TEXT,
  last_used_ua       TEXT,
  revoked_at         TEXT,
  disabled_at        TEXT
);
CREATE INDEX idx_api_keys_principal_id ON api_keys(principal_id);
CREATE INDEX idx_api_keys_status       ON api_keys(status);

CREATE TABLE api_key_sender_scopes (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  sender_id  TEXT NOT NULL REFERENCES mailbox_senders(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (api_key_id, sender_id)
);
CREATE INDEX idx_api_key_sender_scopes_sender ON api_key_sender_scopes(sender_id);

CREATE TABLE submission_credentials (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  sender_id     TEXT NOT NULL REFERENCES mailbox_senders(id) ON DELETE CASCADE,
  daemon_id     TEXT,
  username      TEXT NOT NULL UNIQUE,
  bcrypt_hash   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  disabled_at   TEXT
);
CREATE INDEX idx_submission_credentials_principal_id ON submission_credentials(principal_id);
CREATE INDEX idx_submission_credentials_sender_id    ON submission_credentials(sender_id);
CREATE INDEX idx_submission_credentials_daemon_id    ON submission_credentials(daemon_id);

-- ===========================================================================
-- Daemon plane
-- ===========================================================================

CREATE TABLE daemons (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL UNIQUE,
  hmac_key_secret_name TEXT,
  access_token_id      TEXT,
  last_seen_at         TEXT,
  created_at           TEXT NOT NULL,
  disabled_at          TEXT
);

-- ===========================================================================
-- Webhook plane (subs come before messages so mailbox_receivers FK resolves)
-- ===========================================================================

CREATE TABLE webhook_subs (
  id          TEXT PRIMARY KEY,
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'external'
                CHECK(kind IN ('external','tailnet')),
  secret      TEXT NOT NULL,
  secret_prev TEXT,
  events      TEXT NOT NULL,
  paused_at   TEXT,
  created_at  TEXT NOT NULL,
  disabled_at TEXT
);
CREATE INDEX idx_webhook_subs_mailbox_id ON webhook_subs(mailbox_id);

-- ===========================================================================
-- Message plane
-- ===========================================================================

CREATE TABLE messages (
  id                      TEXT PRIMARY KEY,
  mailbox_id              TEXT NOT NULL REFERENCES mailboxes(id),
  principal_id            TEXT REFERENCES principals(id),
  daemon_id               TEXT REFERENCES daemons(id),
  direction               TEXT NOT NULL CHECK(direction IN ('in','out')),
  status                  TEXT NOT NULL CHECK(status IN (
                            'received','mime_stored','queued','sending',
                            'sent','bounced','delivered','failed')),
  from_addr               TEXT NOT NULL,
  from_addr_normalized    TEXT GENERATED ALWAYS AS (LOWER(from_addr)) STORED,
  to_addrs                TEXT,                -- JSON array (advisory)
  subject                 TEXT,
  r2_key                  TEXT NOT NULL,       -- ALWAYS mime/XX/YY/SHA256/...
  content_sha256          TEXT NOT NULL,
  parsed_json             TEXT,                -- cached Message JSON minus attachment bodies
  body_bytes              INTEGER,
  attachments_total_bytes INTEGER,
  idempotency_key         TEXT,
  message_id_header       TEXT,                -- legacy synonym for header_message_id
  header_message_id       TEXT,                -- RFC 5322 Message-ID value
  thread_id               TEXT,                -- computed at submit time (A10a)
  send_attempt_id         TEXT,
  received_at_daemon      TEXT,
  received_at_api         TEXT,
  queued_at               TEXT,
  sending_at              TEXT,
  sent_at                 TEXT,
  delivered_at            TEXT,                -- terminal-success timestamp (A10a)
  failed_at               TEXT,
  bounce_metadata         TEXT,                -- JSON
  last_error              TEXT,
  -- Inbound auth verdicts (NULL for outbound)
  auth_spf                TEXT,
  auth_dkim               TEXT,
  auth_dmarc              TEXT,
  auth_remote_ip          TEXT,
  created_at              TEXT NOT NULL
);
CREATE INDEX idx_messages_mailbox_created     ON messages(mailbox_id, created_at DESC);
CREATE INDEX idx_messages_mailbox_dir_status  ON messages(mailbox_id, direction, status);
CREATE INDEX idx_messages_direction_status_at ON messages(direction, status, created_at DESC);
CREATE INDEX idx_messages_from_normalized     ON messages(from_addr_normalized);
CREATE INDEX idx_messages_content_sha256      ON messages(content_sha256);
CREATE INDEX idx_messages_idempotency_key     ON messages(idempotency_key);
CREATE INDEX idx_messages_mailbox_thread      ON messages(mailbox_id, thread_id, created_at DESC);
CREATE INDEX idx_messages_header_message_id   ON messages(header_message_id);

CREATE TABLE message_attempts (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id),
  send_attempt_id TEXT,
  attempted_at    TEXT NOT NULL,
  succeeded       INTEGER NOT NULL,
  error           TEXT
);
CREATE INDEX idx_message_attempts_message_id ON message_attempts(message_id);

CREATE TABLE message_deliveries (
  message_id         TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  webhook_sub_id     TEXT NOT NULL REFERENCES webhook_subs(id) ON DELETE CASCADE,
  status             TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','dlq')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TEXT,
  last_error         TEXT,
  last_response_code INTEGER,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (message_id, webhook_sub_id)
);
CREATE INDEX idx_message_deliveries_status ON message_deliveries(status);

CREATE TABLE idempotency_keys (
  key          TEXT PRIMARY KEY,
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id),
  principal_id TEXT,
  message_id   TEXT REFERENCES messages(id),
  expires_at   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_idempotency_keys_mailbox_id ON idempotency_keys(mailbox_id);
CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);

-- Webhook DLQ: terminal failures from services/fanout. CLI webhook-dlq
-- commands query/replay/drop these rows. message_id is SET NULL on message
-- delete to preserve audit context.
CREATE TABLE webhook_dlq (
  id               TEXT PRIMARY KEY,
  message_id       TEXT REFERENCES messages(id) ON DELETE SET NULL,
  webhook_sub_id   TEXT NOT NULL REFERENCES webhook_subs(id) ON DELETE CASCADE,
  payload_sha256   TEXT NOT NULL,
  last_status_code INTEGER,
  last_error       TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  dlq_at           TEXT NOT NULL,
  replayed_at      TEXT,
  dropped_at       TEXT
);
CREATE INDEX idx_webhook_dlq_sub_id ON webhook_dlq(webhook_sub_id);
CREATE INDEX idx_webhook_dlq_dlq_at ON webhook_dlq(dlq_at);

-- ===========================================================================
-- Audit plane
-- ===========================================================================
-- audit_log.action enum enumerates every action emitted by services today
-- plus the actions implied by Phases C/D/L. Keep in sync with services/api
-- + services/cron audit() call sites.

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL CHECK(action IN (
              -- bootstrap
              'bootstrap.consume',
              -- mailbox CRUD (Phases C/D)
              'mailbox.create','mailbox.update','mailbox.disable','mailbox.delete',
              -- sender CRUD (renamed from email_sender.*)
              'mailbox_sender.create','mailbox_sender.update','mailbox_sender.disable','mailbox_sender.delete',
              'email_sender.create','email_sender.disable',  -- legacy names kept until services migrate
              -- receiver CRUD (renamed from routing_rule.*)
              'mailbox_receiver.create','mailbox_receiver.update','mailbox_receiver.disable','mailbox_receiver.delete',
              'routing_rule.create','routing_rule.update','routing_rule.delete',  -- legacy
              -- credential lifecycle
              'api_key.issue','api_key.rotate','api_key.rotate.emergency','api_key.revoke',
              'smtp_credential.issue','smtp_credential.disable','smtp_credential.rotate',
              'dry_run_rotate',
              -- daemon lifecycle
              'daemon.register','daemon.rotate','daemon.deregister',
              -- domain + DKIM
              'domain.create','domain.update','domain.disable',
              'domain.verify','domain.verify_incomplete','domain.dkim_rotate',
              -- dkim_key direct events (Phase D)
              'dkim_key.create','dkim_key.activate','dkim_key.retire',
              -- webhook subs + DLQ
              'webhook_sub.create','webhook_sub.update','webhook_sub.delete','webhook_sub.replay',
              -- messages (submit/receive/lifecycle)
              'message.submitted','message.received','message.marked_read','message.expunged',
              -- rate limiting
              'rate_limit.exceeded',
              -- legacy tenant ops (kept so audit replay of historic logs validates;
              -- new code paths must NOT emit these)
              'tenant.create','tenant.update','tenant.disable','tenant.rotate_pepper'
            )),
  target    TEXT,
  meta      TEXT NOT NULL,
  at        INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash  TEXT NOT NULL
);
CREATE INDEX idx_audit_log_at     ON audit_log(at);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_actor  ON audit_log(actor);

CREATE TABLE audit_anchors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  last_audit_id INTEGER NOT NULL,
  last_row_hash TEXT NOT NULL,
  signature     TEXT NOT NULL,
  signed_at     INTEGER NOT NULL,
  external_ref  TEXT
);

-- ===========================================================================
-- Auth plane (better-auth + custom)
-- ===========================================================================
-- Singular table names + INTEGER millisecond timestamps are mandated by the
-- better-auth Drizzle adapter. Do not rename / do not convert to TEXT.

CREATE TABLE "user" (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  email          TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE "session" (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_session_user_id ON "session"(user_id);

CREATE TABLE "account" (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  account_id                TEXT NOT NULL,
  provider_id               TEXT NOT NULL,
  access_token              TEXT,
  refresh_token             TEXT,
  id_token                  TEXT,
  access_token_expires_at   INTEGER,
  refresh_token_expires_at  INTEGER,
  scope                     TEXT,
  password                  TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  UNIQUE(provider_id, account_id, user_id)
);
CREATE INDEX idx_account_user_id ON "account"(user_id);

CREATE TABLE "verification" (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_verification_identifier ON "verification"(identifier);

-- step_ups: short-lived elevation gate. valid_until is INTEGER ms (aligns
-- with better-auth's "user".id PK).
CREATE TABLE step_ups (
  user_id     TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  valid_until INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

-- approvals: 2-person rule for sensitive actions.
CREATE TABLE approvals (
  id                TEXT PRIMARY KEY,
  requester_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  approver_user_id  TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  action            TEXT NOT NULL,
  resource_id       TEXT,
  data_json         TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','approved','rejected')),
  created_at        TEXT NOT NULL,
  expires_at        TEXT,
  resolved_at       TEXT
);
CREATE INDEX idx_approvals_requester ON approvals(requester_user_id);
CREATE INDEX idx_approvals_approver  ON approvals(approver_user_id);
CREATE INDEX idx_approvals_status    ON approvals(status);

-- ===========================================================================
-- Views
-- ===========================================================================

-- Mailbox summary: counts of active senders + active receivers per mailbox.
CREATE VIEW v_mailbox_summary AS
SELECT
  m.id,
  m.name,
  m.description,
  m.default_sender_id,
  m.created_at,
  m.updated_at,
  m.disabled_at,
  (SELECT COUNT(*) FROM mailbox_senders s
     WHERE s.mailbox_id = m.id AND s.disabled_at IS NULL) AS active_sender_count,
  (SELECT COUNT(*) FROM mailbox_receivers r
     WHERE r.mailbox_id = m.id AND r.enabled = 1 AND r.disabled_at IS NULL) AS active_receiver_count
FROM mailboxes m;

-- Message ⋈ latest message_attempts row (by attempted_at DESC).
CREATE VIEW v_message_with_latest_attempt AS
SELECT
  msg.*,
  a.id              AS latest_attempt_id,
  a.send_attempt_id AS latest_send_attempt_id,
  a.attempted_at    AS latest_attempt_at,
  a.succeeded       AS latest_attempt_succeeded,
  a.error           AS latest_attempt_error
FROM messages msg
LEFT JOIN (
  SELECT *,
         ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY attempted_at DESC) AS rn
  FROM message_attempts
) a ON a.message_id = msg.id AND a.rn = 1;

-- Per-message aggregate delivery state across all webhook subs.
CREATE VIEW v_message_delivery_state AS
SELECT
  m.id                                                                            AS message_id,
  m.mailbox_id,
  m.direction,
  m.status                                                                        AS message_status,
  COALESCE(SUM(CASE WHEN d.status = 'pending'   THEN 1 ELSE 0 END), 0)             AS pending_count,
  COALESCE(SUM(CASE WHEN d.status = 'failed'    THEN 1 ELSE 0 END), 0)             AS failed_count,
  COALESCE(SUM(CASE WHEN d.status = 'dlq'       THEN 1 ELSE 0 END), 0)             AS dlq_count,
  COALESCE(SUM(CASE WHEN d.status = 'succeeded' THEN 1 ELSE 0 END), 0)             AS succeeded_count,
  MAX(d.last_error)                                                                 AS worst_error
FROM messages m
LEFT JOIN message_deliveries d ON d.message_id = m.id
GROUP BY m.id;

-- Credential usage: api_key + owning principal + mailbox + sender-scope count.
CREATE VIEW v_credential_usage AS
SELECT
  k.id                  AS api_key_id,
  k.prefix,
  k.status,
  k.rate_limit_per_min,
  k.last_used_at,
  p.id                  AS principal_id,
  p.display_name        AS principal_display_name,
  p.kind                AS principal_kind,
  mb.id                 AS mailbox_id,
  mb.name               AS mailbox_name,
  (SELECT COUNT(*) FROM api_key_sender_scopes s WHERE s.api_key_id = k.id) AS sender_scope_count
FROM api_keys k
JOIN principals p ON p.id = k.principal_id
JOIN mailboxes  mb ON mb.id = p.mailbox_id;

-- DLQ age view: hours-in-DLQ for active (un-replayed, un-dropped) rows.
CREATE VIEW v_dlq_age AS
SELECT
  dlq.id,
  dlq.message_id,
  dlq.webhook_sub_id,
  dlq.attempts,
  dlq.last_status_code,
  dlq.last_error,
  dlq.dlq_at,
  dlq.replayed_at,
  dlq.dropped_at,
  CAST((julianday('now') - julianday(dlq.dlq_at)) * 24 AS REAL) AS hours_in_dlq
FROM webhook_dlq dlq
WHERE dlq.replayed_at IS NULL AND dlq.dropped_at IS NULL;

-- ===========================================================================
-- Triggers (AFTER UPDATE bump updated_at)
-- ===========================================================================

CREATE TRIGGER trg_mailboxes_updated_at
AFTER UPDATE ON mailboxes
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE mailboxes
  SET    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE  id = NEW.id;
END;

CREATE TRIGGER trg_mail_domains_updated_at
AFTER UPDATE ON mail_domains
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE mail_domains
  SET    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE  id = NEW.id;
END;

-- ===========================================================================
-- Version stamp
-- ===========================================================================

INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0001_init');
