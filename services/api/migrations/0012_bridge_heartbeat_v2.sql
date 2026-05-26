-- 0012_bridge_heartbeat_v2.sql
--
-- Bridge heartbeat v2 — bidirectional control + diagnostics.
--
-- Adds:
--   * `bridge_settings` (one row per bridge, defaulted on register).
--   * `bridge_directives` (queued one-shot commands the bridge applies
--     + acks via the heartbeat channel — roll_hmac, restart).
--   * Three columns on `bridges`:
--       - `last_heartbeat_payload TEXT` — JSON snapshot of the latest
--         heartbeat request (rendered as cards on the Detail page).
--       - `hmac_rotated_at TEXT` — the most recent successful roll.
--         Drives the 30d auto-roll cron selector.
--       - `hmac_pending_rotated_at TEXT` — set when a staged roll is
--         queued but not yet acked. Prevents overlapping rolls.
--   * Four new audit actions:
--       bridge.settings.update, bridge.directive.queue,
--       bridge.directive.ack, bridge.directive.expire.
--
-- Backfill: every existing bridge gets a `bridge_settings` row with the
-- column defaults so the bridge's first heartbeat after upgrade lands a
-- complete settings payload.

PRAGMA foreign_keys = OFF;

-- --- bridge_settings ----------------------------------------------------------
CREATE TABLE bridge_settings (
  bridge_id              TEXT PRIMARY KEY REFERENCES bridges(id) ON DELETE CASCADE,
  version                INTEGER NOT NULL DEFAULT 1,
  smtp_enabled           INTEGER NOT NULL DEFAULT 1,
  imap_enabled           INTEGER NOT NULL DEFAULT 1,
  smtp_port              INTEGER NOT NULL DEFAULT 465,
  imap_port              INTEGER NOT NULL DEFAULT 993,
  smtp_tls_mode          TEXT NOT NULL DEFAULT 'auto'
                           CHECK(smtp_tls_mode IN ('auto','manual','off')),
  imap_tls_mode          TEXT NOT NULL DEFAULT 'auto'
                           CHECK(imap_tls_mode IN ('auto','manual','off')),
  max_message_size_bytes INTEGER NOT NULL DEFAULT 52428800,
  max_imap_sessions      INTEGER NOT NULL DEFAULT 200,
  log_level              TEXT NOT NULL DEFAULT 'info'
                           CHECK(log_level IN ('debug','info','warn','error')),
  updated_at             TEXT NOT NULL,
  updated_by             TEXT NOT NULL
);

-- Backfill defaults for every existing bridge. New registrations insert
-- their own row alongside the bridges row in admin/bridges.ts.
INSERT INTO bridge_settings (bridge_id, updated_at, updated_by)
SELECT id, COALESCE(last_seen_at, created_at), 'system:migration-0012'
FROM bridges;

-- --- bridge_directives --------------------------------------------------------
CREATE TABLE bridge_directives (
  id           TEXT PRIMARY KEY,                  -- ULID
  bridge_id    TEXT NOT NULL REFERENCES bridges(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL
                 CHECK(kind IN ('roll_hmac','restart')),
  payload      TEXT NOT NULL,                     -- JSON; shape depends on kind
  queued_at    TEXT NOT NULL,
  delivered_at TEXT,                              -- first heartbeat that received it
  acked_at     TEXT,                              -- bridge confirmed application
  expires_at   TEXT                               -- staged-roll grace deadline (nullable)
);
CREATE INDEX idx_bridge_directives_pending
  ON bridge_directives(bridge_id, acked_at);
CREATE INDEX idx_bridge_directives_expires
  ON bridge_directives(expires_at)
  WHERE acked_at IS NULL;

-- --- bridges columns ----------------------------------------------------------
-- `last_heartbeat_json` (from 0007) already carries the v2 heartbeat
-- snapshot; we don't add a separate `last_heartbeat_payload` column.
ALTER TABLE bridges ADD COLUMN hmac_rotated_at           TEXT;
ALTER TABLE bridges ADD COLUMN hmac_pending_rotated_at   TEXT;

-- Seed `hmac_rotated_at` for existing bridges using their `created_at`
-- so the 30d auto-roll selector has a definite baseline. Without this
-- the first cron tick would skip every row (`hmac_rotated_at < now-30d`
-- compares against NULL).
UPDATE bridges SET hmac_rotated_at = created_at WHERE hmac_rotated_at IS NULL;

-- --- audit_log CHECK rebuild --------------------------------------------------
-- Add the four new actions. Same copy → drop → rename pattern as
-- 0008 / 0009 / 0010 / 0011.
CREATE TABLE audit_log_new (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL CHECK(action IN (
              'bootstrap.consume',
              'bootstrap.webauthn_enrolled',
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
              'bridge.register','bridge.rotate','bridge.disable','bridge.enable','bridge.delete',
              'bridge.cf_token.mint','bridge.cf_token.revoke',
              'bridge.ts_authkey.mint','bridge.ts_authkey.revoke',
              'bridge.settings.update',
              'bridge.directive.queue','bridge.directive.ack','bridge.directive.expire',
              'domain.create','domain.update','domain.disable',
              'domain.verify','domain.verify_incomplete','domain.dkim_rotate',
              'domain.inbound.enable','domain.inbound.disable',
              'domain.outbound.enable','domain.outbound.disable',
              'dkim_key.create','dkim_key.activate','dkim_key.retire',
              'webhook_sub.create','webhook_sub.update','webhook_sub.delete','webhook_sub.replay',
              'webhook_sub.test','webhook_sub.rotate',
              'message.submitted','message.received','message.marked_read','message.expunged',
              'rate_limit.exceeded',
              'cf_zone.configure',
              'mta_sts.enable','mta_sts.disable','mta_sts.promote',
              'tls_rpt.enable','tls_rpt.disable',
              'suppression.create','suppression.disable','suppression.import',
              'message.suppressed','message.sender_suppressed',
              'abuse_event.record',
              'admin.alert.sent',
              'admin.alert.dismiss',
              'admin.alert.dismiss_bulk',
              'sender_abuse_profile.tier_advance',
              'sender.suppress_auto',
              'tls_rpt_report.ingest',
              'dmarc.promote','dmarc.pause','dmarc.rollback',
              'dmarc.mgmt_enabled',
              'triage.classify',
              'triage.operator_override',
              'policy.decide',
              'policy.override',
              'message.held',
              'message.held_release',
              'message.held_drop',
              'moderation.feedback_recorded',
              'inbound_sender_block.create','inbound_sender_block.delete',
              'tenant.create','tenant.update','tenant.disable','tenant.rotate_pepper',
              'operator.create','operator.update','operator.disable',
              'operator.rotate_key','operator.rotate_pubkey',
              'auth.login','auth.logout'
            )),
  target    TEXT,
  meta      TEXT NOT NULL,
  at        INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash  TEXT NOT NULL
);

INSERT INTO audit_log_new (id, actor, action, target, meta, at, prev_hash, row_hash)
SELECT id, actor, action, target, meta, at, prev_hash, row_hash FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX idx_audit_log_at     ON audit_log(at);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_actor  ON audit_log(actor);

PRAGMA foreign_keys = ON;
