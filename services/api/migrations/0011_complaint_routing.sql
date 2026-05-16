-- W2 — Platform complaint routing.
--
-- Three things:
--
--   1. abuse_events table — append-only ledger of "this sender did
--      something bad" events. Populated by W2 (deterministic ARF/DSN
--      parser), W2b (LLM-triaged unstructured complaints), and W3 (CF
--      hard-bounce webhook). Read by the W2c sender_abuse_profile cron to
--      decide whether to fire an automatic sender suppression.
--
--   2. Platform `polaris-platform-complaints` mailbox — one canonical
--      mailbox that every domain's postmaster@/abuse@/webmaster@ receivers
--      route to. Inbound mail to those aliases lands here so the W2
--      ingest handler can parse + dispatch from one place.
--
--   3. Bookkeeping additions to audit_log enum (abuse_event.record).
--
-- domain.create (in services/api/src/routes/admin/domains.ts) is updated
-- in the same commit to auto-insert the three receivers for every newly-
-- onboarded domain pointing at this platform mailbox.
--
-- Existing domains are backfilled by `bin/backfill-postmaster-receivers.sh`.

-- ---------------------------------------------------------------------------
-- abuse_events
--
-- Immutable rows. Each event credits ONE sender principal. `weight` lets the
-- threshold cron (W2c) give more impact to high-severity categories
-- (phishing/legal) than to ordinary complaints.
-- ---------------------------------------------------------------------------
CREATE TABLE abuse_events (
  id                    TEXT PRIMARY KEY,
  -- The address we sent FROM that the complaint targets. Often known.
  sender_address        TEXT,
  -- IDs of the matching sender principal, when resolution succeeded. Two
  -- separate columns rather than a polymorphic (type,id) because joins are
  -- cleaner.
  sender_principal_mailbox_id     TEXT REFERENCES mailboxes(id),
  sender_principal_sender_id      TEXT REFERENCES mailbox_senders(id),
  sender_principal_domain_id      TEXT REFERENCES mail_domains(id),
  -- Classification — controlled vocabulary.
  classification        TEXT NOT NULL
                          CHECK (classification IN (
                            'spam_complaint','phishing_report','virus',
                            'auth_failure','opt_out','hard_bounce',
                            'legal_takedown','mailing_list_admin','other'
                          )),
  -- Where this event came from (mirrors suppressions.source but with the
  -- extra 'cf_bounce_webhook' source W3 will use).
  source                TEXT NOT NULL
                          CHECK (source IN (
                            'arf_inbox','llm_triage','cf_bounce_webhook',
                            'cf_email_service','panel','cli','import'
                          )),
  source_ref            TEXT,
  -- Weight applied to this event by the W2c threshold cron. 1 = ordinary
  -- complaint; 5 = phishing report; 10 = legal takedown. Tunable.
  weight                INTEGER NOT NULL DEFAULT 1,
  -- The complainant / reporter address, when known.
  reporter_address      TEXT,
  -- The reporting org (User-Agent for ARF, message-source for DSN).
  reporter_org          TEXT,
  -- Original message ID being complained about, when extracted.
  original_message_id   TEXT,
  -- Free-form JSON for the raw parsed report. Useful for forensics + future
  -- re-classification.
  raw_meta              TEXT NOT NULL DEFAULT '{}',
  -- The suppression row that this event caused, if any (one of W2/W2b/W2c
  -- might decide not to suppress immediately).
  caused_suppression_id TEXT,
  reported_at           TEXT NOT NULL,
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_abuse_events_sender_address       ON abuse_events(sender_address, reported_at DESC);
CREATE INDEX idx_abuse_events_mailbox              ON abuse_events(sender_principal_mailbox_id, reported_at DESC);
CREATE INDEX idx_abuse_events_sender_id            ON abuse_events(sender_principal_sender_id, reported_at DESC);
CREATE INDEX idx_abuse_events_domain               ON abuse_events(sender_principal_domain_id, reported_at DESC);
CREATE INDEX idx_abuse_events_classification       ON abuse_events(classification, reported_at DESC);
CREATE INDEX idx_abuse_events_reported_at          ON abuse_events(reported_at DESC);

-- ---------------------------------------------------------------------------
-- Platform complaint mailbox.
--
-- ID and name are well-known constants (suppression-list-style) so the
-- inbound handler can resolve without an extra config lookup.
-- ---------------------------------------------------------------------------
INSERT INTO mailboxes (id, name, description, created_at, updated_at)
VALUES (
  '01HXPLATFORMCOMPLAINTS0000',
  'polaris-platform-complaints',
  'Platform-owned mailbox for postmaster@/abuse@/webmaster@ receivers across every onboarded domain. Inbound mail is parsed by W2 (ARF/DSN), W2b (LLM triage), and writes to abuse_events + suppressions.',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- ---------------------------------------------------------------------------
-- audit_log CHECK rebuild — adds abuse_event.record.
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
              -- W2 / 0011
              'abuse_event.record',
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
VALUES (11, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0011_complaint_routing');
