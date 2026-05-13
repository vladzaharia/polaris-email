-- polaris-email D1 schema v4: data-migrate api_keys.sender_scopes (legacy CSV/JSON)
-- into the many-to-many sender_key_scopes table.
--
-- Today, api_keys.sender_scopes is a string column holding a JSON array of
-- SenderScope objects ({kind:'exact',pattern:'noreply@plrs.im'} | {kind:'regex',...}).
-- The new model uses sender_key_scopes (key_id, sender_id) joined to email_senders.
--
-- Staging note: this migration ONLY populates the join table. It does NOT drop
-- api_keys.sender_scopes. The application code (services/api/src/auth.ts,
-- services/api/src/routes/messages.ts) is being switched to a dual-read pattern
-- (sender_key_scopes first, fall back to the legacy column). A future migration
-- will drop the column once readers have been fully cut over.
--
-- Idempotency: keyed on the (key_id, sender_id) PRIMARY KEY of sender_key_scopes
-- via INSERT OR IGNORE. Re-running this migration on a populated database will
-- not duplicate rows.
--
-- Append-only migration. Never edit; add 0005_*.sql for further changes.

PRAGMA foreign_keys = ON;

-- For each api_keys row whose sender_scopes JSON contains an exact-match
-- pattern of the form "local@domain", join through email_senders ↔ outbound_domains
-- to find the corresponding sender_id and insert into sender_key_scopes.
--
-- SQLite's json_each() iterates over the JSON array. We extract `kind` and
-- `pattern` from each element, parse "local@domain" from `pattern`, and join.
-- Regex-kind scopes cannot be mapped to a single sender row; those are left as
-- legacy and will continue to be served via the dual-read fallback until they
-- are re-issued explicitly.
INSERT OR IGNORE INTO sender_key_scopes (key_id, sender_id, created_at)
SELECT
  ak.id          AS key_id,
  es.id          AS sender_id,
  COALESCE(strftime('%s','now') * 1000, 0) AS created_at
FROM api_keys ak,
     json_each(ak.sender_scopes) je
JOIN outbound_domains od
  ON od.domain = substr(json_extract(je.value, '$.pattern'),
                        instr(json_extract(je.value, '$.pattern'), '@') + 1)
JOIN email_senders es
  ON es.domain_id = od.id
 AND es.local_part = substr(json_extract(je.value, '$.pattern'),
                            1,
                            instr(json_extract(je.value, '$.pattern'), '@') - 1)
WHERE json_extract(je.value, '$.kind') = 'exact'
  AND instr(json_extract(je.value, '$.pattern'), '@') > 0;
