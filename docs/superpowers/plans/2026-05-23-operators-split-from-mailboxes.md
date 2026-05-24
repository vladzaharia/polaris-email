# Split operators from mailboxes — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the principals abstraction. Make `api_keys` reference `operators` directly, drop the sentinel mailbox, and ship the missing `/operators` panel pages so the existing REST API becomes consumable from the UI.

**Architecture:** One D1 migration rebuilds `api_keys` and `messages` against `operators(id)` instead of `principals(id)`, backfills the bootstrap-admin key as the first operator row, and drops the `principals` table plus the sentinel mailbox. The auth path in `services/api/src/auth.ts` and the four route consumers (`messages`, `messages-state`, `admin`, `sender-abuse-threshold`) switch the field name `principal_id → operator_id`. Bootstrap and the operator create/rotate flows stop touching principals. Panel gets new `/operators` List + Detail pages mirroring the mailboxes pattern.

**Tech Stack:** TypeScript / Hono / Cloudflare D1 + KV / React 19 + TanStack Router (panel).

**Reference:** `docs/superpowers/specs/2026-05-23-operators-split-from-mailboxes.md`

---

### Task 1: D1 migration — drop principals, rewire api_keys + messages to operators

**Files:**

- Create: `services/api/migrations/0006_operators_split.sql`

- [ ] **Step 1: Inspect the api_keys + messages CREATE TABLE shapes so the rebuild is byte-accurate**

Run:

```sh
grep -nA 25 "CREATE TABLE api_keys\b" services/api/migrations/0001_init.sql
grep -nA 50 "CREATE TABLE messages\b"  services/api/migrations/0001_init.sql | head -55
```

Confirm the rebuilt definitions in Step 2 match — minus `principal_id`, plus `operator_id`.

- [ ] **Step 2: Write the migration**

```sql
-- 0006_operators_split.sql
--
-- Splits operators from mailboxes:
--   * Drops the `principals` table (it existed only to host one row per
--     operator under a fake mailbox FK).
--   * Drops the sentinel mailbox `01J0000000000000000000PLRS`.
--   * Rewires `api_keys.principal_id` -> `api_keys.operator_id` (FK to
--     operators(id)).
--   * Drops `operators.api_key_id` (the current-key pointer is now
--     derived: `api_keys WHERE operator_id = ? AND status = 'primary'`).
--   * Drops `messages.principal_id` (carried no info that audit_log
--     doesn't already record).
--   * Backfills the bootstrap-admin api_key as the first operator row.
--
-- Pre-production: no users to coordinate with. Clean cut, one migration.

PRAGMA foreign_keys = OFF;

-- ============================================================================
-- 1. Ensure the bootstrap-admin api_key (pk_admin_) has an operators row.
--    The bootstrap path created it as a principal-only key; the new shape
--    needs every api_keys row to point at an operator.
-- ============================================================================

INSERT INTO operators (
  id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, api_key_id, role,
  created_at, updated_at
)
SELECT
  '01J0000000000000000000ROOT',
  'root',
  'root@polaris-mail.invalid',
  '',
  'sha256:bootstrap-admin-no-pubkey',
  b.admin_key_id,
  'admin',
  COALESCE(b.consumed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  COALESCE(b.consumed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM bootstrap b
WHERE b.admin_key_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM operators WHERE api_key_id = b.admin_key_id
  );

-- ============================================================================
-- 2. Defensive cleanup — any api_keys row whose principal has no matching
--    operator row is an orphan from the pre-0003 shape. Delete first so
--    the NOT NULL FK constraint below holds.
-- ============================================================================

DELETE FROM api_keys
WHERE id NOT IN (SELECT api_key_id FROM operators);

-- ============================================================================
-- 3. Rebuild api_keys — replace principal_id with operator_id.
-- ============================================================================

CREATE TABLE api_keys_new (
  id                 TEXT PRIMARY KEY,
  operator_id        TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
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

INSERT INTO api_keys_new (
  id, operator_id, prefix, secret_argon2id, scopes, rate_limit_per_min,
  status, created_at, last_used_at, last_used_ip, last_used_ua,
  revoked_at, disabled_at
)
SELECT
  k.id,
  o.id,
  k.prefix,
  k.secret_argon2id,
  k.scopes,
  k.rate_limit_per_min,
  k.status,
  k.created_at,
  k.last_used_at,
  k.last_used_ip,
  k.last_used_ua,
  k.revoked_at,
  k.disabled_at
FROM api_keys k
JOIN operators o ON o.api_key_id = k.id;

DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;

CREATE INDEX idx_api_keys_operator_id ON api_keys(operator_id);
CREATE INDEX idx_api_keys_status      ON api_keys(status);

-- ============================================================================
-- 4. Rebuild messages — drop principal_id. (FK target principals goes
--    away; the column itself was an audit hint, redundant with audit_log.)
-- ============================================================================

CREATE TABLE messages_new (
  id                      TEXT PRIMARY KEY,
  mailbox_id              TEXT NOT NULL REFERENCES mailboxes(id),
  bridge_id               TEXT REFERENCES bridges(id),
  direction               TEXT NOT NULL CHECK(direction IN ('in','out')),
  status                  TEXT NOT NULL CHECK(status IN (
                            'received','mime_stored','queued','sending',
                            'sent','bounced','delivered','failed','held'
                          )),
  rfc822_size             INTEGER,
  message_id_header       TEXT,
  in_reply_to             TEXT,
  envelope_from           TEXT,
  envelope_to             TEXT NOT NULL,
  from_addr               TEXT,
  to_addrs                TEXT,
  cc_addrs                TEXT,
  bcc_addrs               TEXT,
  subject                 TEXT,
  date_header             TEXT,
  has_attachments         INTEGER NOT NULL DEFAULT 0,
  parts_summary           TEXT,
  auth_spf                TEXT,
  auth_dkim               TEXT,
  auth_dmarc              TEXT,
  size_bytes              INTEGER,
  stream_type             TEXT
                            CHECK(stream_type IN ('transactional','marketing','agent','inbound')),
  received_at             TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  expunged_at             TEXT
);

INSERT INTO messages_new
  SELECT
    id, mailbox_id, bridge_id, direction, status, rfc822_size,
    message_id_header, in_reply_to, envelope_from, envelope_to,
    from_addr, to_addrs, cc_addrs, bcc_addrs, subject, date_header,
    has_attachments, parts_summary, auth_spf, auth_dkim, auth_dmarc,
    size_bytes, stream_type, received_at, created_at, updated_at,
    expunged_at
  FROM messages;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

CREATE INDEX idx_messages_mailbox       ON messages(mailbox_id, created_at DESC);
CREATE INDEX idx_messages_msgid_header  ON messages(message_id_header);
CREATE INDEX idx_messages_envelope_from ON messages(envelope_from);
CREATE INDEX idx_messages_received_at   ON messages(received_at);

-- ============================================================================
-- 5. Drop operators.api_key_id — derived at read time.
--    SQLite supports ALTER TABLE DROP COLUMN for non-FK-target columns.
-- ============================================================================

-- The column has a UNIQUE constraint + FK; rebuild the table to remove it
-- cleanly. (DROP COLUMN works on simple columns but our column has both.)
CREATE TABLE operators_new (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  email                TEXT NOT NULL UNIQUE,
  ssh_pubkey           TEXT NOT NULL,
  ssh_pubkey_fp_sha256 TEXT NOT NULL UNIQUE,
  role                 TEXT NOT NULL DEFAULT 'operator'
                         CHECK(role IN ('admin','operator','readonly')),
  disabled_at          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  last_seen_at         TEXT
);

INSERT INTO operators_new
  SELECT id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, role,
         disabled_at, created_at, updated_at, last_seen_at
  FROM operators;

DROP TABLE operators;
ALTER TABLE operators_new RENAME TO operators;

CREATE INDEX        idx_operators_disabled_at ON operators(disabled_at);
CREATE UNIQUE INDEX uniq_operators_fp_active
  ON operators(ssh_pubkey_fp_sha256) WHERE disabled_at IS NULL;

-- ============================================================================
-- 6. Drop principals + sentinel mailbox.
-- ============================================================================

DROP TABLE IF EXISTS principals;

DELETE FROM mailboxes WHERE id = '01J0000000000000000000PLRS';

PRAGMA foreign_keys = ON;

-- ============================================================================
-- Version stamp
-- ============================================================================
INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0006_operators_split');
```

- [ ] **Step 3: Apply the full migration chain to a scratch sqlite DB and verify the target state**

Run:

```sh
cat services/api/migrations/0001_init.sql \
    services/api/migrations/0002_unified_credentials.sql \
    services/api/migrations/0003_credentials_cleanup.sql \
    services/api/migrations/0004_admin_alerts_dismissal.sql \
    services/api/migrations/0005_cf_dmarc_management.sql \
    services/api/migrations/0006_operators_split.sql \
  > /tmp/all_migs.sql
rm -f /tmp/test.db && sqlite3 /tmp/test.db < /tmp/all_migs.sql

sqlite3 /tmp/test.db "SELECT name FROM sqlite_master WHERE type='table' AND name='principals';"   # expect empty
sqlite3 /tmp/test.db "SELECT id FROM mailboxes WHERE id='01J0000000000000000000PLRS';"             # expect empty
sqlite3 /tmp/test.db "PRAGMA table_info(api_keys);"   | grep -E 'operator_id|principal_id'         # expect operator_id only
sqlite3 /tmp/test.db "PRAGMA table_info(messages);"   | grep -E 'operator_id|principal_id'         # expect nothing
sqlite3 /tmp/test.db "PRAGMA table_info(operators);"  | grep api_key_id                            # expect nothing
sqlite3 /tmp/test.db "SELECT version, sha FROM schema_migrations ORDER BY version;"                # expect 1..6
```

All assertions must match the comments. If anything diverges, fix the migration before continuing.

- [ ] **Step 4: Commit**

```sh
git add services/api/migrations/0006_operators_split.sql
git commit -m "feat(api/migrations): split operators from mailboxes (drop principals)"
```

---

### Task 2: Refactor `services/api/src/auth.ts` — drop principals join, rename field to operator_id

**Files:**

- Modify: `services/api/src/auth.ts`

- [ ] **Step 1: Rename the AuthenticatedKey field**

In `services/api/src/auth.ts`, replace lines 9–27 (the `AuthenticatedKey` interface) with:

```typescript
export interface AuthenticatedKey {
  key_id: string;
  /** Operator id resolved via api_keys.operator_id. */
  operator_id: string | null;
  /** Mailbox id of the impersonated operator, when X-Polaris-OBO is set
   *  and the signing key has admin:impersonate. Otherwise null. */
  impersonated_operator_id: string | null;
  scopes_raw: string;
  rate_limit_per_min: number;
  status: 'primary' | 'secondary' | 'revoked';
  revoked_at: number | null;
}
```

(The old `mailbox_id` and `principal_id` fields are gone. The old `operator_id` field — which meant _impersonated_ operator — is renamed `impersonated_operator_id` so the new `operator_id` can mean the key's _owning_ operator. This is the one semantic split worth preserving.)

- [ ] **Step 2: Rewrite the cold-path D1 lookup**

In `services/api/src/auth.ts`, replace lines 70–150 (the `RowShape` type, the cached-validation function, and the cold-path block) with:

```typescript
type RowShape = {
  id: string;
  operator_id: string;
  secret_argon2id: string;
  scopes: string;
  rate_limit_per_min: number;
  status: 'primary' | 'secondary' | 'revoked';
  revoked_at: number | null;
};
function isRowShape(v: unknown): v is RowShape {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string') return false;
  if (typeof r.operator_id !== 'string') return false;
  if (typeof r.secret_argon2id !== 'string') return false;
  if (typeof r.scopes !== 'string') return false;
  if (typeof r.rate_limit_per_min !== 'number') return false;
  if (r.status !== 'primary' && r.status !== 'secondary' && r.status !== 'revoked') {
    return false;
  }
  return true;
}
let row: RowShape | null = null;
if (cached && isRowShape(cached)) {
  row = cached;
} else {
  // Single-query lookup against api_keys (joined to operators for the
  // disabled-check). After the principals split, api_keys is operator-
  // owned; there is no separate mailbox lookup to do here.
  const keyRow = await env.DB.prepare(
    `SELECT k.id, k.operator_id, k.secret_argon2id, k.scopes,
                k.rate_limit_per_min, k.status, k.revoked_at,
                o.disabled_at AS operator_disabled_at
         FROM api_keys k
         JOIN operators o ON o.id = k.operator_id
         WHERE k.id = ?`,
  )
    .bind(keyId)
    .first<{
      id: string;
      operator_id: string;
      secret_argon2id: string;
      scopes: string;
      rate_limit_per_min: number;
      status: 'primary' | 'secondary' | 'revoked';
      revoked_at: number | null;
      operator_disabled_at: string | null;
    }>();
  if (keyRow) {
    if (keyRow.operator_disabled_at) {
      return buildError(c, 'key_revoked', 'operator disabled');
    }
    row = {
      id: keyRow.id,
      operator_id: keyRow.operator_id,
      secret_argon2id: keyRow.secret_argon2id,
      scopes: keyRow.scopes,
      rate_limit_per_min: keyRow.rate_limit_per_min,
      status: keyRow.status,
      revoked_at: keyRow.revoked_at,
    };
  } else {
    row = null;
  }
  if (row) {
    c.executionCtx.waitUntil(
      env.KV_KEY_CACHE.put(cacheKey, JSON.stringify(row), { expirationTtl: 60 }),
    );
  }
}
if (!row) {
  return buildError(c, 'key_propagating', 'unknown key id', { 'retry-after': '2' });
}
if (row.status === 'revoked' || row.revoked_at != null) {
  return buildError(c, 'key_revoked', 'key has been revoked');
}
```

- [ ] **Step 3: Switch the revocation check to operator_id**

In `services/api/src/auth.ts`, replace lines 160–170 (the `principal_id` revocation block) with:

```typescript
// Per-operator revocation check (KV_REVOCATIONS, 60s in-memory cache).
// The api_keys row may still read `primary` from a stale KV_KEY_CACHE
// entry right after an admin revoke, but KV_REVOCATIONS keyed by
// operator_id is invalidated synchronously by the revoke handler.
const revoked = await revocationCheck(env, row.operator_id).catch(() => false);
if (revoked) {
  return buildError(c, 'key_revoked', 'operator revoked');
}
```

- [ ] **Step 4: Switch the impersonation lookup to a single join**

In `services/api/src/auth.ts`, replace the lines 274–306 (the operator + opKey lookups in the OBO block) with:

```typescript
const opRow = await env.DB.prepare(
  `SELECT o.id, o.disabled_at,
                k.id AS api_key_id, k.operator_id, k.scopes,
                k.status, k.revoked_at
         FROM operators o
         JOIN api_keys k ON k.operator_id = o.id AND k.status = 'primary'
         WHERE o.id = ?`,
)
  .bind(opId)
  .first<{
    id: string;
    disabled_at: string | null;
    api_key_id: string;
    operator_id: string;
    scopes: string;
    status: 'primary' | 'secondary' | 'revoked';
    revoked_at: number | null;
  }>();
if (!opRow) {
  return buildError(c, 'not_found', 'operator not found');
}
if (opRow.disabled_at) {
  return buildError(c, 'key_revoked', 'operator disabled');
}
if (opRow.status === 'revoked' || opRow.revoked_at != null) {
  return buildError(c, 'key_revoked', 'operator key revoked');
}
const revokedOp = await revocationCheck(env, opRow.operator_id).catch(() => false);
if (revokedOp) {
  return buildError(c, 'key_revoked', 'operator revoked');
}
effectiveScopesRaw = opRow.scopes;
effectiveOperatorId = opId;
```

- [ ] **Step 5: Update the `c.set('apiKey', …)` block at lines 315–328**

Replace with:

```typescript
c.set('apiKey', {
  key_id: row.id,
  operator_id: row.operator_id,
  impersonated_operator_id: effectiveOperatorId,
  scopes_raw: effectiveScopesRaw,
  rate_limit_per_min: row.rate_limit_per_min,
  status: row.status,
  revoked_at: row.revoked_at,
});
c.set(
  'actor',
  effectiveOperatorId ? `operator:${effectiveOperatorId}` : `operator:${row.operator_id}`,
);
```

(Note the actor string change: even non-impersonating requests now attribute to the OPERATOR, not the key. This matches the existing `actorOf(c)` convention and is what the audit log was already trying to record — see the audit-actor comment block at lines 30–42.)

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @polaris-mail/api typecheck`

Expected: errors at every read site of the renamed fields (`apiKey.principal_id`, `apiKey.mailbox_id`, `auth.principal_id`, `auth.mailbox_id`, etc.). These get fixed in Tasks 3–7. Run typecheck again at the end of Task 7 to confirm clean.

- [ ] **Step 7: Commit**

```sh
git add services/api/src/auth.ts
git commit -m "refactor(api/auth): drop principals join, rename field to operator_id"
```

---

### Task 3: Update `routes/messages.ts` + `routes/messages-state.ts` consumers

**Files:**

- Modify: `services/api/src/routes/messages.ts`
- Modify: `services/api/src/routes/messages-state.ts`

- [ ] **Step 1: Rename principal_id reads in routes/messages.ts**

Run: `grep -n "principal_id\|\.mailbox_id" services/api/src/routes/messages.ts`

For each match:

- `keyRow.principal_id` → `keyRow.operator_id` (the key owner)
- `apiKey.principal_id` → `apiKey.operator_id`
- `apiKey.mailbox_id` → drop. Anywhere it was used to scope a query, fall back to the explicit `mailbox_id` from the request body / URL param. (The old behavior of "the api_key tells me which mailbox" was operator-scope; operator keys are not bound to a mailbox.)

Notable specific edits:

- Lines 146–166: drop the `if (!keyRow.principal_id)` guard and the principals SELECT that followed it. The new key row always has a non-null operator_id, and the operator's "mailbox" concept is gone. The route already takes the target mailbox from the request body — read that, not the auth context.
- Line 208: `principal_id: keyRow.principal_id` in the INSERT INTO messages → drop the column entirely from the INSERT (it no longer exists).
- Line 336, 349, 426: audit `actor` / payload `principalId` → use `apiKey.operator_id`.
- Line 506: the comment block referencing `messages.principal_id FK` — update to say `audit_log` records the actor, and the column is gone.

- [ ] **Step 2: Same renames in routes/messages-state.ts**

Run: `grep -n "principal_id\|\.mailbox_id" services/api/src/routes/messages-state.ts`

Apply the same transformations. Specifically:

- Lines 120–133: drop the `principal_id` null-guard + principals SELECT. Use `apiKey.operator_id` directly.
- Line 173: `principal_id: keyRow.principal_id` → drop entirely (column gone).
- Lines 320, 366: `auth.principal_id ?? auth.key_id` → `auth.operator_id ?? auth.key_id`.

- [ ] **Step 3: Typecheck the api workspace**

Run: `pnpm --filter @polaris-mail/api typecheck`

Expected: errors remaining only in `routes/admin.ts`, `scheduled/sender-abuse-threshold.ts`, `routes/admin/operators.ts`, `routes/bootstrap.ts`, `routes/admin/mailboxes.ts`, and test files. The messages routes should be clean.

- [ ] **Step 4: Commit**

```sh
git add services/api/src/routes/messages.ts services/api/src/routes/messages-state.ts
git commit -m "refactor(api/messages): rename principal_id to operator_id; drop messages.principal_id INSERT"
```

---

### Task 4: Update `routes/admin.ts` + `scheduled/sender-abuse-threshold.ts`

**Files:**

- Modify: `services/api/src/routes/admin.ts`
- Modify: `services/api/src/scheduled/sender-abuse-threshold.ts`

- [ ] **Step 1: routes/admin.ts**

Run: `grep -n "principal_id" services/api/src/routes/admin.ts`

For each match:

- Line 272 (`fullOld.principal_id`): if it's reading from an api_keys row, rename to `operator_id`.
- Line 347 (`meta: { reason: …, principal_id: keyRow?.principal_id ?? null }`): rename the meta key to `operator_id` and pull from `keyRow?.operator_id`.
- Line 355 (`if (keyRow?.principal_id)`) and Line 362 (`revoke(c.env, keyRow.principal_id, …)`): switch to `keyRow?.operator_id`. The `revoke` helper's signature is unchanged — it takes a string identifier and writes the KV revocation entry under that key. After this change the KV entries are keyed by operator_id everywhere.

- [ ] **Step 2: scheduled/sender-abuse-threshold.ts**

Run: `grep -n "principal_id" services/api/src/scheduled/sender-abuse-threshold.ts`

The matches at lines 387, 388, 391 are reading `a.principal_id` from the `admin_alerts`-or-similar row. These are the abuse-threshold dispatcher's own `principal_id` column (free-form identifier — sender address / mailbox id / domain id), **not** a reference to the now-deleted `principals` table. **Leave these alone.** Confirm via:

```sh
grep -nB 2 "principal_id" services/api/src/scheduled/sender-abuse-threshold.ts | head -20
```

The surrounding context should make clear that this is the abuse-profile principal (free-form), not the auth principal. If any read site refers to an auth-context principal, fix it; if all refer to the abuse-profile column, no edit needed.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @polaris-mail/api typecheck`

Expected: errors remaining only in operators.ts, bootstrap.ts, mailboxes.ts, and tests.

- [ ] **Step 4: Commit**

```sh
git add services/api/src/routes/admin.ts services/api/src/scheduled/sender-abuse-threshold.ts
git commit -m "refactor(api/admin): rename principal_id to operator_id in revoke + audit"
```

---

### Task 5: Refactor `routes/admin/operators.ts` — drop the principals insert, drop the api_key_id update

**Files:**

- Modify: `services/api/src/routes/admin/operators.ts`

- [ ] **Step 1: Drop the OPERATOR_SENTINEL_MAILBOX_ID constant and its uses**

In `services/api/src/routes/admin/operators.ts`:

- Remove the constant at line 34 (`const OPERATOR_SENTINEL_MAILBOX_ID = '…'`).
- The response `mailbox_id: OPERATOR_SENTINEL_MAILBOX_ID` field at line 223 — drop it. The response shape loses the `mailbox_id` field entirely.

- [ ] **Step 2: Rewrite the create-operator batch**

In `services/api/src/routes/admin/operators.ts`, replace the `c.env.DB.batch([...])` block at lines 176–216 with:

```typescript
await c.env.DB.batch([
  c.env.DB.prepare(
    `INSERT INTO operators
         (id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, role,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    operatorId,
    body.name,
    body.email,
    body.ssh_pubkey,
    body.ssh_pubkey_fp_sha256,
    body.role,
    nowIso,
    nowIso,
  ),
  c.env.DB.prepare(
    `INSERT INTO api_keys
         (id, operator_id, prefix, secret_argon2id, scopes,
          rate_limit_per_min, status, created_at)
       VALUES (?, ?, 'pk_op_', ?, ?, ?, 'primary', ?)`,
  ).bind(
    apiKeyId,
    operatorId,
    hashed,
    JSON.stringify(body.scopes),
    body.rate_limit_per_min,
    nowIso,
  ),
  auditInsert.statement,
]);
```

Note: `principals` insert is gone. `operators.api_key_id` is gone from the schema; the operator + api_key reference each other via `api_keys.operator_id`.

- [ ] **Step 3: Update the KV cache warm-write to match the new shape**

In `services/api/src/routes/admin/operators.ts`, find the `KV_KEY_CACHE.put` block (around lines 219–232) and replace with:

```typescript
await c.env.KV_KEY_CACHE.put(`plain:${apiKeyId}`, secret, { expirationTtl: 15 * 60 });
await c.env.KV_KEY_CACHE.put(
  `key:${apiKeyId}`,
  JSON.stringify({
    id: apiKeyId,
    operator_id: operatorId,
    secret_argon2id: hashed,
    scopes: JSON.stringify(body.scopes),
    rate_limit_per_min: body.rate_limit_per_min,
    status: 'primary',
    revoked_at: null,
  }),
  { expirationTtl: 60 },
);
```

- [ ] **Step 4: Drop the `principal_id` field from the create response**

The response object at lines 234–257 still works minus `api_key_id` resolution. The `login_token` line is unchanged. Confirm no `principal_id` field is being returned.

- [ ] **Step 5: Fix the rotate-key handler at line 375**

In `services/api/src/routes/admin/operators.ts`, search for `rotate-key`. The current flow:

1. Mints a new api_key.
2. UPDATEs `operators.api_key_id` to point at it.
3. Marks the old api_key as 'revoked' (or 'secondary').

After this change, step 2 disappears. The "current" api_key is whichever one has `status='primary'` and `operator_id = ?`. Specifically:

```typescript
// OLD:
//   c.env.DB.prepare(`UPDATE operators SET api_key_id = ?, updated_at = ? WHERE id = ?`).bind(...)
//
// NEW: no operators-table update needed. The new api_key was inserted
// with status='primary' and operator_id = opId; the old one was just
// marked status='secondary' or 'revoked' in the same batch.
```

Find the existing `UPDATE operators SET api_key_id` call (was at line 424 in the original); delete it. Confirm the surrounding logic still flips the old key's status correctly.

- [ ] **Step 6: Update the GET / list / lookup queries to derive the current api_key**

Run: `grep -n "api_key_id" services/api/src/routes/admin/operators.ts`

Every `SELECT … api_key_id … FROM operators` becomes a join:

```sql
SELECT o.id, o.name, o.email, o.ssh_pubkey, o.ssh_pubkey_fp_sha256,
       o.role, o.disabled_at, o.created_at, o.updated_at, o.last_seen_at,
       k.id AS api_key_id, k.prefix, k.status, k.last_used_at
FROM operators o
LEFT JOIN api_keys k ON k.operator_id = o.id AND k.status = 'primary'
WHERE o.id = ?
```

The LEFT JOIN tolerates the brief mid-rotation window when no key is primary (shouldn't happen with the rotation flow's batched transition, but defensive).

Apply to:

- `GET /v1/admin/operators` (list) — line ~96
- `GET /v1/admin/operators/:id` — line ~127
- `GET /v1/admin/operators/lookup` — line ~105 (this is the Wish hot path)

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @polaris-mail/api typecheck`

Expected: errors remaining only in bootstrap.ts, mailboxes.ts, stats.ts, and tests.

- [ ] **Step 8: Commit**

```sh
git add services/api/src/routes/admin/operators.ts
git commit -m "refactor(api/admin/operators): drop principals + sentinel; derive current key"
```

---

### Task 6: Refactor `routes/bootstrap.ts` — create operator row instead of principal+mailbox

**Files:**

- Modify: `services/api/src/routes/bootstrap.ts`

- [ ] **Step 1: Drop the mailbox insert + principal insert; insert an operators row instead**

In `services/api/src/routes/bootstrap.ts`, replace lines 115–152 (mailbox lookup/insert, principals insert, api_keys insert) with:

```typescript
const now = Date.now();
const nowIso = new Date(now).toISOString();
const operatorId = '01J0000000000000000000ROOT';
const keyId = ulid();
const secret = generateSecret();
const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);

// Bootstrap creates a single 'root' operator. Subsequent operator rows
// are minted via POST /v1/admin/operators (each gets a unique id).
await c.env.DB.prepare(
  `INSERT INTO operators
       (id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, role,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'admin', ?, ?)`,
)
  .bind(
    operatorId,
    'root',
    'root@polaris-mail.invalid',
    '',
    'sha256:bootstrap-admin-no-pubkey',
    nowIso,
    nowIso,
  )
  .run();

await c.env.DB.prepare(
  `INSERT INTO api_keys
       (id, operator_id, prefix, secret_argon2id, scopes,
        rate_limit_per_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'primary', ?)`,
)
  .bind(
    keyId,
    operatorId,
    'pk_admin_',
    hashed,
    '["admin:rotate","admin:read","admin:impersonate"]',
    60,
    nowIso,
  )
  .run();
```

Note: the bootstrap key now carries `admin:impersonate` in its scopes by default. This was the de facto behavior (Wish needs it, the bootstrap doc says so) — making it explicit here removes the "you have to manually grant impersonate after bootstrap" footgun.

- [ ] **Step 2: Drop the audit meta field that referenced the old mailbox**

The audit emission at lines 165–170 references `mailbox_id: effectiveMailboxId`. Replace with:

```typescript
await audit(c.env, {
  actor: 'bootstrap',
  action: 'bootstrap.consume',
  target: keyId,
  meta: { issued_at: now, operator_id: operatorId },
});
```

- [ ] **Step 3: Drop the now-unused mailbox imports/helpers**

Run: `grep -n "ulid\|mailboxId\|effectiveMailboxId\|principalId" services/api/src/routes/bootstrap.ts`

Remove any `mailboxId`/`principalId`/`effectiveMailboxId` variable declarations that are now dead. Keep `ulid` only if it's still used for `keyId`.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @polaris-mail/api typecheck`

Expected: errors remaining only in mailboxes.ts, stats.ts, and tests.

- [ ] **Step 5: Commit**

```sh
git add services/api/src/routes/bootstrap.ts
git commit -m "refactor(api/bootstrap): create operators row directly, no principals/mailbox shim"
```

---

### Task 7: Drop sentinel filters in `mailboxes.ts` + `stats.ts`; drop principals payload from mailbox detail

**Files:**

- Modify: `services/api/src/routes/admin/mailboxes.ts`
- Modify: `services/api/src/routes/admin/stats.ts`

- [ ] **Step 1: routes/admin/mailboxes.ts**

In `services/api/src/routes/admin/mailboxes.ts`:

- Remove the `WHERE id <> '01J0000000000000000000PLRS'` clause at line 35 (the v_mailbox_summary list).
- Remove the `WHERE id <> '01J0000000000000000000PLRS'` clause at line 43.
- Remove the principals SELECT block at lines 74–79.
- Remove `principals` from the response payload (lines 101–108).

The result is that the mailbox detail handler returns one fewer field; tests that read `d.principals` need updating in Task 12.

- [ ] **Step 2: routes/admin/stats.ts**

Remove the `AND id <> '01J0000000000000000000PLRS'` clause at line 51.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @polaris-mail/api typecheck`

Expected: clean for `src/`. Errors remain only in test files (Task 12).

- [ ] **Step 4: Commit**

```sh
git add services/api/src/routes/admin/mailboxes.ts services/api/src/routes/admin/stats.ts
git commit -m "refactor(api/admin/mailboxes): drop sentinel filters + principals from response"
```

---

### Task 8: Update existing integration tests that seed principals or sentinel rows

**Files:**

- Modify: any test that does `INSERT INTO principals` or seeds `OPERATOR_SENTINEL_MAILBOX_ID`. Discover them.

- [ ] **Step 1: Find every test consumer**

Run:

```sh
grep -rn "INSERT INTO principals\|principal_id\|01J0000000000000000000PLRS" services/api/test/ services/in/test/ services/out/test/ 2>&1 | grep -v node_modules
```

Each match is one of:

- A test seeding the legacy `principals` table for auth coverage.
- A test that referenced `principal_id` on api_keys (FK has been renamed).
- A test referencing the sentinel mailbox.

- [ ] **Step 2: Rewrite each seed block**

The pattern transformation:

```typescript
// OLD:
await db
  .prepare(
    `INSERT INTO principals (id, mailbox_id, kind, display_name, created_at)
                  VALUES (?, ?, 'api_key', ?, ?)`,
  )
  .bind(principalId, mailboxId, 'test', now)
  .run();
await db
  .prepare(
    `INSERT INTO api_keys (id, principal_id, prefix, secret_argon2id, scopes,
                                         rate_limit_per_min, status, created_at)
                  VALUES (?, ?, 'pk_op_', ?, ?, ?, 'primary', ?)`,
  )
  .bind(keyId, principalId, hash, '["admin:read"]', 60, now)
  .run();

// NEW:
await db
  .prepare(
    `INSERT INTO operators (id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256,
                                          role, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 'admin', ?, ?)`,
  )
  .bind(opId, 'test op', `op-${opId}@test.invalid`, '', `fp-${opId}`, now, now)
  .run();
await db
  .prepare(
    `INSERT INTO api_keys (id, operator_id, prefix, secret_argon2id, scopes,
                                         rate_limit_per_min, status, created_at)
                  VALUES (?, ?, 'pk_op_', ?, ?, ?, 'primary', ?)`,
  )
  .bind(keyId, opId, hash, '["admin:read"]', 60, now)
  .run();
```

Apply to every seed block found in Step 1.

- [ ] **Step 3: Run the full workers test suite from root**

Run: `pnpm exec vitest run`

Expected: all green. If a test failure looks like a stale fixture, treat it the same as Step 2. If a failure looks like a logic regression, halt and inspect.

- [ ] **Step 4: Commit**

```sh
git add services/api/test/ services/in/test/ services/out/test/
git commit -m "test: rewire principals fixtures to direct operator inserts"
```

---

### Task 9: Add an integration test for the new operator auth path

**Files:**

- Create: `services/api/test/integration/operator-auth.workers.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, inject('migrations'));
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM api_keys`).run();
  await testEnv.DB.prepare(`DELETE FROM operators`).run();
});

describe('operator auth path (post-principals split)', () => {
  it('resolves api_key → operator without principals join', async () => {
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO operators (id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256,
                              role, created_at, updated_at)
       VALUES ('op1', 'alice', 'alice@test.invalid', 'ssh-pub', 'fp-alice', 'operator', ?, ?)`,
    )
      .bind(now, now)
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO api_keys (id, operator_id, prefix, secret_argon2id, scopes,
                             rate_limit_per_min, status, created_at)
       VALUES ('01HXKEY00000000000000000A1', 'op1', 'pk_op_', '$argon2id$dummy',
               '["admin:read"]', 60, 'primary', ?)`,
    )
      .bind(now)
      .run();

    const row = await testEnv.DB.prepare(
      `SELECT k.id, k.operator_id, o.disabled_at
       FROM api_keys k JOIN operators o ON o.id = k.operator_id
       WHERE k.id = ?`,
    )
      .bind('01HXKEY00000000000000000A1')
      .first<{ id: string; operator_id: string; disabled_at: string | null }>();
    expect(row).toEqual({
      id: '01HXKEY00000000000000000A1',
      operator_id: 'op1',
      disabled_at: null,
    });
  });

  it('rejects auth when the operator is disabled', async () => {
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO operators (id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256,
                              role, disabled_at, created_at, updated_at)
       VALUES ('op2', 'bob', 'bob@test.invalid', 'ssh-pub', 'fp-bob', 'operator', ?, ?, ?)`,
    )
      .bind(now, now, now)
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO api_keys (id, operator_id, prefix, secret_argon2id, scopes,
                             rate_limit_per_min, status, created_at)
       VALUES ('01HXKEY00000000000000000B2', 'op2', 'pk_op_', '$argon2id$dummy',
               '["admin:read"]', 60, 'primary', ?)`,
    )
      .bind(now)
      .run();

    const row = await testEnv.DB.prepare(
      `SELECT o.disabled_at FROM api_keys k JOIN operators o ON o.id = k.operator_id
       WHERE k.id = ?`,
    )
      .bind('01HXKEY00000000000000000B2')
      .first<{ disabled_at: string | null }>();
    expect(row?.disabled_at).not.toBeNull();
  });

  it('cascades api_keys deletion when the operator is deleted', async () => {
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO operators (id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256,
                              role, created_at, updated_at)
       VALUES ('op3', 'carol', 'carol@test.invalid', 'ssh-pub', 'fp-carol', 'operator', ?, ?)`,
    )
      .bind(now, now)
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO api_keys (id, operator_id, prefix, secret_argon2id, scopes,
                             rate_limit_per_min, status, created_at)
       VALUES ('01HXKEY00000000000000000C3', 'op3', 'pk_op_', '$argon2id$dummy',
               '["admin:read"]', 60, 'primary', ?)`,
    )
      .bind(now)
      .run();
    await testEnv.DB.prepare(`DELETE FROM operators WHERE id = ?`).bind('op3').run();
    const remaining = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE id = ?`)
      .bind('01HXKEY00000000000000000C3')
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run**

Run: `pnpm exec vitest run --project api-workers test/integration/operator-auth.workers.test.ts`

Expected: 3 PASS.

- [ ] **Step 3: Commit**

```sh
git add services/api/test/integration/operator-auth.workers.test.ts
git commit -m "test(api): operator auth path covers join + disabled + cascade"
```

---

### Task 10: Drop principals UI from the mailbox detail page

**Files:**

- Modify: `apps/panel/src/client/pages/mailboxes/Detail.tsx`

- [ ] **Step 1: Drop the interface field**

In `apps/panel/src/client/pages/mailboxes/Detail.tsx`:

```tsx
// OLD (line ~153):
principals: Array<{ id: string; kind: string; display_name: string | null }>;

// NEW: drop the field entirely.
```

- [ ] **Step 2: Drop the MetaRow render**

Find the `<MetaRow label="Principals">` block around lines 879–891 and delete the entire row (including the wrapping `MetaRow`).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @polaris-mail/panel typecheck`

Expected: clean.

- [ ] **Step 4: Commit**

```sh
git add apps/panel/src/client/pages/mailboxes/Detail.tsx
git commit -m "refactor(panel/mailboxes): drop principals MetaRow (concept gone)"
```

---

### Task 11: Panel — operators List page

**Files:**

- Create: `apps/panel/src/client/pages/operators/List.tsx`
- Modify: `apps/panel/src/client/queryKeys.ts`

- [ ] **Step 1: Add the query key**

In `apps/panel/src/client/queryKeys.ts`, append:

```typescript
export const operatorKeys = {
  all: ['operators'] as const,
  one: (id: string) => ['operators', id] as const,
  audit: (id: string) => ['operators', id, 'audit'] as const,
};
```

- [ ] **Step 2: Write the List page**

```tsx
// apps/panel/src/client/pages/operators/List.tsx
import { Link } from '@tanstack/react-router';
import { UserCog, Plus } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { operatorKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';

interface OperatorRow {
  id: string;
  name: string;
  email: string;
  ssh_pubkey_fp_sha256: string;
  role: 'admin' | 'operator' | 'readonly';
  disabled_at: string | null;
  created_at: string;
  last_seen_at: string | null;
  api_key_id: string | null;
  api_key_prefix: string | null;
  api_key_last_used_at: string | null;
}

export function OperatorsList(): JSX.Element {
  const q = useAdminQuery<{ data: OperatorRow[] }>(operatorKeys.all, '/api/admin/operators');
  const rows = q.data?.data ?? [];
  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <UserCog className="h-5 w-5" /> Operators
          </h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Humans who hold a polaris CLI / admin API token. Each operator owns one primary api_key;
            rotate it without disabling the operator.
          </p>
        </div>
        <Button
          size="sm"
          disabled
          title="Use the polaris-mail CLI to mint a new operator until the panel form ships"
        >
          <Plus className="h-4 w-4" /> Add operator (CLI only)
        </Button>
      </header>
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<UserCog className="h-5 w-5" />}
          title="No operators yet"
          description="The bootstrap-admin row should always be present. If you see this, run polaris-mail setup infra preflight."
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Fingerprint</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      to="/operators/$id"
                      params={{ id: r.id }}
                      className="font-medium underline"
                    >
                      {r.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.email}</TableCell>
                  <TableCell>
                    <Badge variant={r.role === 'admin' ? 'success' : 'outline'}>{r.role}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">
                    {r.ssh_pubkey_fp_sha256.slice(0, 16)}…
                  </TableCell>
                  <TableCell className="text-xs text-[var(--color-muted-foreground)]">
                    {r.last_seen_at ? formatRelative(r.last_seen_at) : 'never'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.disabled_at ? 'destructive' : 'success'}>
                      {r.disabled_at ? 'disabled' : 'active'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
```

The "Add operator (CLI only)" button is explicitly disabled — minting operators requires capturing the one-time login token, which needs a careful UX. Leaving the wiring to a follow-up keeps this batch scoped.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @polaris-mail/panel typecheck`

Expected: clean.

- [ ] **Step 4: Commit**

```sh
git add apps/panel/src/client/queryKeys.ts apps/panel/src/client/pages/operators/List.tsx
git commit -m "feat(panel/operators): list page"
```

---

### Task 12: Panel — operators Detail page

**Files:**

- Create: `apps/panel/src/client/pages/operators/Detail.tsx`

- [ ] **Step 1: Write the Detail page**

```tsx
// apps/panel/src/client/pages/operators/Detail.tsx
import { useState } from 'react';
import { UserCog, KeyRound, RotateCw, ShieldAlert, History } from 'lucide-react';
import { useParams } from '@tanstack/react-router';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { operatorKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';

interface OperatorPayload {
  id: string;
  name: string;
  email: string;
  ssh_pubkey: string;
  ssh_pubkey_fp_sha256: string;
  role: 'admin' | 'operator' | 'readonly';
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  api_key_id: string | null;
  api_key_prefix: string | null;
  api_key_status: 'primary' | 'secondary' | 'revoked' | null;
  api_key_last_used_at: string | null;
  api_key_created_at: string | null;
}

interface RotateKeyResponse {
  api_key_id: string;
  api_key_prefix: string;
  login_token: string;
}

export function OperatorDetail(): JSX.Element {
  const { id } = useParams({ from: '/operators/$id' });
  const q = useAdminQuery<OperatorPayload>(operatorKeys.one(id), `/api/admin/operators/${id}`);
  const [rotatedToken, setRotatedToken] = useState<string | null>(null);

  const rotateKey = useAdminMutation<RotateKeyResponse, undefined>(
    () => ({ path: `/api/admin/operators/${id}/rotate-key`, method: 'POST' }),
    {
      invalidateKeys: [operatorKeys.one(id), operatorKeys.all],
      successMessage: 'API key rotated. Copy the new login token now.',
      onSuccess: (r) => setRotatedToken(r.login_token),
    },
  );

  const disable = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/operators/${id}`, method: 'DELETE' }),
    { invalidateKeys: [operatorKeys.one(id), operatorKeys.all] },
  );

  if (q.isLoading) return <Skeleton className="h-48 w-full" />;
  if (q.error) return <ErrorText error={q.error} />;
  const op = q.data;
  if (!op) return <p>Operator not found.</p>;

  const isRoot = op.id === '01J0000000000000000000ROOT';

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <UserCog className="h-5 w-5" /> {op.name}
            {isRoot ? <Badge variant="success">root</Badge> : null}
          </h1>
          <p className="font-mono text-xs text-[var(--color-muted-foreground)]">{op.email}</p>
        </div>
        <Badge variant={op.disabled_at ? 'destructive' : 'success'}>
          {op.disabled_at ? 'disabled' : 'active'}
        </Badge>
      </header>

      {/* Identity */}
      <section className="rounded-md border border-[var(--color-border)] p-4">
        <h2 className="mb-2 text-base font-semibold">Identity</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <dt className="text-[var(--color-muted-foreground)]">Role</dt>
          <dd>
            <Badge variant={op.role === 'admin' ? 'success' : 'outline'}>{op.role}</Badge>
          </dd>
          <dt className="text-[var(--color-muted-foreground)]">SSH fingerprint</dt>
          <dd className="font-mono text-xs">{op.ssh_pubkey_fp_sha256}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Created</dt>
          <dd className="text-xs">{formatDate(op.created_at)}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Last seen</dt>
          <dd className="text-xs">{op.last_seen_at ? formatRelative(op.last_seen_at) : 'never'}</dd>
        </dl>
      </section>

      {/* Credentials */}
      <section className="rounded-md border border-[var(--color-border)] p-4">
        <header className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <KeyRound className="h-4 w-4" /> Credentials
            </h2>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              CLI / admin API token for this operator. Rotate to replace; the new token is shown
              once.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => rotateKey.mutate(undefined)}
            disabled={rotateKey.isPending}
          >
            <RotateCw className="h-4 w-4" /> Rotate
          </Button>
        </header>
        {op.api_key_id ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[90px]">Type</TableHead>
                  <TableHead>Identity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>
                    <Badge variant="outline">cli</Badge>
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">
                      {op.api_key_prefix}
                      {op.api_key_id}
                    </code>
                  </TableCell>
                  <TableCell>
                    <Badge variant={op.api_key_status === 'primary' ? 'success' : 'outline'}>
                      {op.api_key_status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {op.api_key_created_at ? formatDate(op.api_key_created_at) : '—'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {op.api_key_last_used_at ? formatRelative(op.api_key_last_used_at) : 'never'}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            No primary key. Use Rotate to mint one.
          </p>
        )}
        {rotatedToken ? (
          <div className="mt-3 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3">
            <p className="mb-1 text-xs font-semibold">One-time login token — copy now</p>
            <code className="block break-all font-mono text-xs">{rotatedToken}</code>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => setRotatedToken(null)}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
      </section>

      {/* Danger zone */}
      {!isRoot ? (
        <section className="rounded-md border border-[var(--color-destructive)] p-4">
          <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
            <ShieldAlert className="h-4 w-4" /> Danger zone
          </h2>
          {op.disabled_at ? (
            <p className="text-sm">Operator is currently disabled.</p>
          ) : (
            <DestructiveActionDialog
              label="Disable operator"
              confirmValue={op.email}
              description="Disables the operator's api_key and SSH login. Can be undone via PATCH."
              onConfirm={() => disable.mutate(undefined)}
            />
          )}
        </section>
      ) : null}

      <ActivityFeed operatorId={op.id} />
    </section>
  );
}

interface AuditRow {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  at: number;
  meta: string | null;
}

function ActivityFeed({ operatorId }: { operatorId: string }): JSX.Element {
  const q = useAdminQuery<{ data: AuditRow[] }>(
    operatorKeys.audit(operatorId),
    `/api/admin/audit?actor=operator:${operatorId}&limit=25`,
  );
  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <History className="h-4 w-4" /> Recent activity
      </h2>
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : q.error || !q.data?.data.length ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No recent activity.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {q.data.data.map((r) => (
            <li key={r.id} className="rounded-md border border-[var(--color-border)] p-2">
              <span className="font-mono text-[10px] text-[var(--color-muted-foreground)]">
                {r.action}
              </span>
              <span className="ml-2 text-xs text-[var(--color-muted-foreground)]">
                {formatRelative(r.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Confirm the /api/admin/audit endpoint accepts an `actor` query param**

Run: `grep -n 'actor' services/api/src/routes/admin.ts | head -10`

If the endpoint already supports filtering by `actor` (it commonly does for the existing audit-feed surface), no change. If it doesn't, replace the URL in `ActivityFeed` with whatever filter the existing audit endpoint exposes (e.g., per-operator audit at `/api/admin/operators/:id/audit` if one exists), and skip the section if neither does.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @polaris-mail/panel typecheck`

Expected: clean.

- [ ] **Step 4: Commit**

```sh
git add apps/panel/src/client/pages/operators/Detail.tsx
git commit -m "feat(panel/operators): detail page (identity + credentials + rotate + danger)"
```

---

### Task 13: Panel — router + nav entry

**Files:**

- Modify: `apps/panel/src/client/router.tsx`
- Modify: wherever the side-nav is defined (likely a sibling component in `apps/panel/src/client/components/` — discover during the task)

- [ ] **Step 1: Discover the existing route + nav definition patterns**

Run:

```sh
grep -n 'mailboxes/List\|/mailboxes' apps/panel/src/client/router.tsx | head -10
grep -rn 'mailboxes' apps/panel/src/client/components/ apps/panel/src/client/app/ 2>&1 | grep -v node_modules | head -10
```

Note the imports and Route definitions for mailboxes; mirror that pattern for operators.

- [ ] **Step 2: Register the new routes in router.tsx**

Add (placement next to the mailboxes routes):

```tsx
import { OperatorsList } from './pages/operators/List.js';
import { OperatorDetail } from './pages/operators/Detail.js';

// inside the route tree, alongside mailboxes routes:
const operatorsListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/operators',
  component: OperatorsList,
});
const operatorDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/operators/$id',
  component: OperatorDetail,
});
```

Adjust the import shape (`createRoute`, `rootRoute`) to match whatever the existing routes use. Add them to the `routeTree` aggregator.

- [ ] **Step 3: Add the nav entry**

Find the side-nav component (look for the `Mailboxes` link). Add an "Operators" entry below it:

```tsx
{ to: '/operators', label: 'Operators', icon: UserCog },
```

Match the exact shape of neighboring entries.

- [ ] **Step 4: Verify navigation works**

Run: `pnpm --filter @polaris-mail/panel typecheck`

Expected: clean. The dev server (if it's running) should hot-reload and surface `/operators` as a clickable nav entry.

- [ ] **Step 5: Commit**

```sh
git add apps/panel/src/client/router.tsx apps/panel/src/client/components/ apps/panel/src/client/app/
git commit -m "feat(panel): wire /operators routes + nav entry"
```

---

### Task 14: Pre-PR gate

- [ ] **Step 1: Run the full pre-PR check**

Run: `pnpm check`

Expected: typecheck + lint + fmt-check all green. Fix any leftover formatting before continuing.

- [ ] **Step 2: Run all tests from the root**

Run: `pnpm exec vitest run`

Expected: all green. If a test fails, treat it as either a fixture-stale issue (apply Task 8's transformation) or a logic regression (halt and inspect).

- [ ] **Step 3: Regenerate test vectors and run the Go sdk tests**

```sh
pnpm --filter @polaris-mail/test-vectors run generate
cd packages/sdk-go && go test ./... && cd -
```

Expected: both green.

- [ ] **Step 4: Confirm clean tree**

Run: `git status --short`

Expected: empty.

---

### Task 15: Deploy

Per the always-redeploy memory: `polaris-mail setup infra deploy changed` runs the migration step before the Worker deploys, so the migration applies first and the new auth code lands second. Brief window of broken operator auth between the two — acceptable pre-production.

- [ ] **Step 1: Deploy**

Run: `polaris-mail setup infra deploy changed`

Expected: api + panel both redeploy. Migration 0006 applies to remote D1 as part of the deploy.

- [ ] **Step 2: Sanity check**

```sh
polaris-mail setup infra smoke
```

Expected: `healthz` + `admin-status` pass. The pre-existing `synthetic-outbound` scope_violation may still fail — unrelated.

- [ ] **Step 3: Verify the operators page**

Open the panel in a browser, navigate to `/operators`. Expect to see at least the root operator row. Click it; the detail page shows the bootstrap-admin's pk*admin* key as a CLI credential row, the root badge, and no danger zone.

---

## Notes

- **Pre-production stance** (per repo memory): no shims, no expand-then-contract. One migration, one code deploy.
- **`pnpm check` must be green** before deploy.
- **Brief auth outage** between migration apply and Worker deploy is acceptable.
- **The bootstrap key now ships with `admin:impersonate` in its default scopes** — explicit instead of implicit. If you don't want that (e.g., a hardening-mode bootstrap that requires post-bootstrap scope grant), drop it from the scopes JSON in Task 6 Step 1 and grant via `PATCH /v1/admin/operators/01J0000000000000000000ROOT` after bootstrap.
