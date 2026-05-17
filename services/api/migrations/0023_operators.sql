-- polaris-email — operators table for human-identity SSH + CLI access
-- (schema version=23)
--
-- An `operator` is a named human (or service account) granted access to the
-- control plane. Each operator owns exactly one row in `api_keys` (1:1 via
-- `api_key_id`); the api_key carries the scopes, the operator row carries
-- the identity (name, email, SSH pubkey fingerprint).
--
-- The operator's `api_key_id` is the bearer used by:
--   * `polaris-email login` (stored encrypted in the OS keychain)
--   * the TUI when launched locally
--
-- For Wish/SSH sessions, the Wish server's bootstrap key (with the new
-- `admin:impersonate` scope) signs each request and adds the
-- `X-Polaris-On-Behalf-Of: operator:<id>` header; the audit log records
-- the operator id as actor regardless of which key signed.
--
-- FK reuse of principals/api_keys requires two accommodations:
--   1. principals.kind currently CHECKs 'api_key'|'smtp_cred'; add 'operator'.
--   2. principals.mailbox_id is NOT NULL; operators aren't mail users, so
--      we seed a sentinel `_polaris_operators` mailbox that every operator
--      principal references. The sentinel is filtered server-side by name.

PRAGMA foreign_keys = OFF;

-- (1) Sentinel mailbox for operator principals.
INSERT INTO mailboxes (id, name, description, created_at, updated_at)
SELECT '01J0000000000000000000PLRS', '_polaris_operators',
       'system mailbox: parent for operator principals (not user-visible)',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM mailboxes WHERE id = '01J0000000000000000000PLRS');

-- (2) Rebuild principals to extend the kind CHECK enum with 'operator'.
ALTER TABLE principals RENAME TO principals_old;
CREATE TABLE principals (
  id           TEXT PRIMARY KEY,
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK(kind IN ('api_key','smtp_cred','operator')),
  display_name TEXT,
  created_at   TEXT NOT NULL,
  disabled_at  TEXT
);
INSERT INTO principals SELECT * FROM principals_old;
DROP TABLE principals_old;
CREATE INDEX idx_principals_mailbox_id ON principals(mailbox_id);
CREATE INDEX idx_principals_kind       ON principals(kind);

-- (3) Operators table.
CREATE TABLE operators (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  email                 TEXT NOT NULL UNIQUE,
  ssh_pubkey            TEXT NOT NULL,
  ssh_pubkey_fp_sha256  TEXT NOT NULL UNIQUE,
  api_key_id            TEXT NOT NULL UNIQUE
                          REFERENCES api_keys(id) ON DELETE RESTRICT,
  role                  TEXT NOT NULL DEFAULT 'operator'
                          CHECK(role IN ('admin','operator','readonly')),
  disabled_at           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  last_seen_at          TEXT
);

CREATE INDEX idx_operators_disabled_at ON operators(disabled_at);
CREATE INDEX idx_operators_api_key_id  ON operators(api_key_id);
CREATE UNIQUE INDEX uniq_operators_fp_active
  ON operators(ssh_pubkey_fp_sha256) WHERE disabled_at IS NULL;

CREATE TRIGGER trg_operators_updated_at
AFTER UPDATE ON operators
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE operators
  SET    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE  id = NEW.id;
END;

PRAGMA foreign_keys = ON;

INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (23, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0023_operators');
