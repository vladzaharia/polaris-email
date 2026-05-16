-- W2c — Sender abuse profile + escalating suppression cron.
--
-- One materialised view per sender principal that the W2c threshold cron
-- rebuilds + advances. Tier columns are MONOTONIC — they never reset, so a
-- sender's history is permanent even after a time-boxed suppression expires
-- and sending resumes. This is the "permanent memory" rule from the plan.
--
-- Triggering threshold logic (per sender_address; mailbox = 3×, domain = 10×):
--   tier 0 (clean) — needs >= 5 weighted events in 24h to fire → 24h supp
--   tier 1         — needs >= 4 weighted events in 24h to fire → 7d  supp
--   tier 2         — needs >= 3 weighted events in 24h to fire → 30d supp
--   tier 3         — needs >= 2 weighted events in 24h to fire → 90d supp
--   tier 4         — needs >= 1 weighted event in 24h  to fire → permanent
--   tier 5         — already permanent; cron is no-op
--
-- Critical bypass: a single `phishing_report` or `legal_takedown` event
-- fires at the next tier regardless of count. This is the only escape from
-- the "no single event suppresses" rule.

CREATE TABLE sender_abuse_profile (
  -- One row per principal. The composite identity is encoded as
  -- (principal_type, principal_id) so the same address living under a
  -- mailbox or domain scope each gets its own profile.
  principal_type           TEXT NOT NULL
                             CHECK (principal_type IN ('sender_address','mailbox','domain')),
  principal_id             TEXT NOT NULL,
  -- Lifetime counters (monotonic).
  lifetime_event_count     INTEGER NOT NULL DEFAULT 0,
  lifetime_weighted_score  INTEGER NOT NULL DEFAULT 0,
  suppression_count        INTEGER NOT NULL DEFAULT 0,
  -- Tier (0–5). Advances on each fired suppression; never resets.
  current_tier             INTEGER NOT NULL DEFAULT 0
                             CHECK (current_tier >= 0 AND current_tier <= 5),
  -- ISO timestamps so the panel can show "in tier N since …".
  current_tier_started_at  TEXT,
  last_suppressed_at       TEXT,
  last_event_at            TEXT,
  -- Free-form notes (operator override reason for any manual unsuppress).
  notes                    TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  PRIMARY KEY (principal_type, principal_id)
);

CREATE INDEX idx_sender_abuse_profile_tier ON sender_abuse_profile(current_tier DESC);
CREATE INDEX idx_sender_abuse_profile_last_event ON sender_abuse_profile(last_event_at DESC);

-- audit_log extension for sender_abuse_profile / sender.suppress_auto.

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
              -- W2c / 0013
              'sender_abuse_profile.tier_advance',
              'sender.suppress_auto',
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
VALUES (13, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0013_sender_abuse_profile');
