-- 0013_bridge_settings_dual_listeners.sql
--
-- Heartbeat v2.1 — split SMTP + IMAP into encrypted (SMTPS / IMAPS)
-- and unencrypted (SMTP / IMAP) variants. The bridge can run all four
-- listeners simultaneously; operators toggle each independently and
-- pick a separate port for each.
--
-- The TLS source (auto = embedded ACME, manual = operator PEMs)
-- collapses from two per-protocol columns into one shared
-- `tls_source` — both SMTPS and IMAPS use the same cert material so
-- there's no reason to configure separately. The legacy `off` value
-- moves out of TLS-mode entirely: operators who want plaintext just
-- enable the unencrypted variant.
--
-- Migration: rebuild bridge_settings with the new shape, copy values
-- across (smtp_enabled → smtps_enabled, smtp_port → smtps_port,
-- imap_enabled → imaps_enabled, imap_port → imaps_port). If the
-- legacy tls_mode was 'off' on either protocol, infer plain enablement
-- by promoting the corresponding plain-port column to enabled=1.

PRAGMA foreign_keys = OFF;

CREATE TABLE bridge_settings_new (
  bridge_id              TEXT PRIMARY KEY REFERENCES bridges(id) ON DELETE CASCADE,
  version                INTEGER NOT NULL DEFAULT 1,
  -- SMTPS (encrypted submission) + SMTP (plain).
  smtps_enabled          INTEGER NOT NULL DEFAULT 1,
  smtps_port             INTEGER NOT NULL DEFAULT 465,
  smtp_enabled           INTEGER NOT NULL DEFAULT 0,
  smtp_port              INTEGER NOT NULL DEFAULT 25,
  -- IMAPS (encrypted read) + IMAP (plain).
  imaps_enabled          INTEGER NOT NULL DEFAULT 1,
  imaps_port             INTEGER NOT NULL DEFAULT 993,
  imap_enabled           INTEGER NOT NULL DEFAULT 0,
  imap_port              INTEGER NOT NULL DEFAULT 143,
  -- Shared TLS source for SMTPS + IMAPS.
  tls_source             TEXT NOT NULL DEFAULT 'auto'
                           CHECK(tls_source IN ('auto', 'manual')),
  max_message_size_bytes INTEGER NOT NULL DEFAULT 52428800,
  max_imap_sessions      INTEGER NOT NULL DEFAULT 200,
  log_level              TEXT NOT NULL DEFAULT 'info'
                           CHECK(log_level IN ('debug', 'info', 'warn', 'error')),
  updated_at             TEXT NOT NULL,
  updated_by             TEXT NOT NULL
);

INSERT INTO bridge_settings_new (
  bridge_id, version,
  smtps_enabled, smtps_port,
  smtp_enabled,  smtp_port,
  imaps_enabled, imaps_port,
  imap_enabled,  imap_port,
  tls_source,
  max_message_size_bytes, max_imap_sessions, log_level,
  updated_at, updated_by
)
SELECT
  bridge_id,
  -- Version bump so bridges fetch fresh settings on next heartbeat.
  version + 1,
  -- SMTPS retains the old smtp_enabled state UNLESS smtp_tls_mode was
  -- 'off'; in that case the operator was running plaintext on the old
  -- "SMTP" listener, so we move that intent onto the new smtp_enabled
  -- and disable SMTPS.
  CASE WHEN smtp_tls_mode = 'off' THEN 0 ELSE smtp_enabled END,
  smtp_port,
  CASE WHEN smtp_tls_mode = 'off' THEN smtp_enabled ELSE 0 END,
  25,
  -- Same shape for IMAP.
  CASE WHEN imap_tls_mode = 'off' THEN 0 ELSE imap_enabled END,
  imap_port,
  CASE WHEN imap_tls_mode = 'off' THEN imap_enabled ELSE 0 END,
  143,
  -- Collapse to one tls_source. Pick smtp's mode if it's 'auto' or
  -- 'manual'; otherwise fall through to imap's; default to 'auto'.
  CASE
    WHEN smtp_tls_mode = 'manual' OR imap_tls_mode = 'manual' THEN 'manual'
    ELSE 'auto'
  END,
  max_message_size_bytes, max_imap_sessions, log_level,
  updated_at, updated_by
FROM bridge_settings;

DROP TABLE bridge_settings;
ALTER TABLE bridge_settings_new RENAME TO bridge_settings;

PRAGMA foreign_keys = ON;
