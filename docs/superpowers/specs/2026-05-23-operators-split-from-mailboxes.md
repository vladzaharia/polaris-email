# Split operators from mailboxes — design

**Status:** approved 2026-05-23 (operator directive: "do it all, don't wait for my approval")
**Owners:** Vlad
**Replaces:** the `principals` table + the `OPERATOR_SENTINEL_MAILBOX_ID` (`01J0000000000000000000PLRS`) anchor pattern

## 1. Motivation

The `principals` table is the original abstraction layer between mailboxes and credentials, with `mailbox_id NOT NULL REFERENCES mailboxes(id)`. When operators were grafted onto the same machinery (because `api_keys.principal_id REFERENCES principals(id)`), the only way to satisfy the FK without inventing a real mailbox was the `OPERATOR_SENTINEL_MAILBOX_ID` sentinel row. The code comment at `services/api/src/routes/admin/operators.ts:181` admits this directly: _"the sentinel mailbox anchor; no schema-level distinction is needed"_.

Since migration 0003 already moved every mailbox-scope credential into `mailbox_credentials` (deleting `pk_live_` rows from `api_keys` and dropping `submission_credentials`), the only remaining users of `principals` are operators. The table now exists solely to host one row per operator with a fake FK pointing at a sentinel.

There is also no operators surface in the panel. `services/api/src/routes/admin/operators.ts` ships a complete CRUD + key-rotation REST API; nothing in `apps/panel` consumes it. The operator's `pk_op_` key — surfaced as "Principals: 1 attached(api_key)" on the sentinel mailbox detail view — is invisible from the credentials UI.

## 2. Goals and non-goals

**Goals**

- Drop the `principals` table.
- Drop the sentinel mailbox row + every `… WHERE id <> '01J…'` filter that exists only to hide it.
- Rewire `api_keys` to reference `operators` directly. Rewire `messages` likewise.
- Refactor the operator auth path (`services/api/src/auth.ts`) to read `api_keys → operators` without the principals join. Rename `AuthCtx.principal_id` → `AuthCtx.operator_id`.
- Ship a panel `/operators` List + Detail surface so the existing REST API is actually consumable. Operator detail surfaces the operator's `pk_op_` key as a CLI-typed credential row that's undeletable (rotation only).

**Non-goals**

- Backwards compatibility with the sentinel pattern. Pre-production stance: clean cut, one migration, no expand-then-contract dance.
- Changes to mailbox credential auth (`lib/mailbox-cred-auth.ts`). That path doesn't touch principals.
- BIMI, DMARC, or any other unrelated surface. This spec is scoped to operators.
- Migrating operator api_keys onto the bearer auth scheme used by `mailbox_credentials` cli tokens. The HMAC path stays. The CLI already implements it.

## 3. Target schema

**Drop:**

- `principals` table (with all indexes).
- `mailboxes` row `01J0000000000000000000PLRS`.
- `api_keys.principal_id` column.
- `operators.api_key_id` column. The current-key pointer is derived: `api_keys WHERE operator_id = ? AND status = 'primary'`. One less foreign key to keep in sync during rotation.
- `messages.principal_id` column. The audit-log row records who submitted; the column was load-bearing only for the principals join, which is going away.

**Add:**

- `api_keys.operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE`.
- Index `idx_api_keys_operator_id ON api_keys(operator_id)`.

**Backfill (one-shot in migration 0006):**

- `UPDATE api_keys SET operator_id = (SELECT id FROM operators WHERE operators.api_key_id = api_keys.id) WHERE operator_id IS NULL` — every existing pk*op* key resolves to exactly one operator.
- Pre-production sanity: any `api_keys` row without a matching operator (orphan from earlier shape) is deleted before the `NOT NULL` constraint lands.

**Migration shape:**

SQLite has no `ALTER TABLE … DROP COLUMN` for FK-bearing columns when paired with the table-rebuild patterns we use elsewhere. Migration 0006 rebuilds `api_keys` and `messages` to drop the old column, copies rows verbatim, and re-attaches indexes. Same pattern as migration 0005 used for `audit_log`. The `operators` table can use plain `ALTER TABLE DROP COLUMN` since SQLite supports that for non-FK columns since 2021.

## 4. Auth refactor (`services/api/src/auth.ts`)

The operator auth path is the only consumer of `api_keys` (mailbox credentials live in a separate table with separate auth machinery in `lib/mailbox-cred-auth.ts`).

Changes:

- `AuthCtx.principal_id` → `AuthCtx.operator_id`. Every read site updates accordingly.
- The `SELECT … FROM api_keys` queries on lines 105 and 286 drop the `principal_id` column and add `operator_id`. The downstream `principals` join (lines 121–129) is deleted — the mailbox lookup it produced was unused for the operator path (operator keys don't address a mailbox).
- `revocationCheck(env, ...)` keys on `operator_id` instead of `principal_id`. KV revocation entries written by the revoke handler (`routes/admin.ts:362`) also key on `operator_id`. **Operational note:** KV_REVOCATIONS entries written under the old `principal_id` keys are stranded post-migration. Pre-production, this is acceptable — no live revocations to lose.
- `messages.ts`, `messages-state.ts`, `admin.ts`, `scheduled/sender-abuse-threshold.ts`: every `keyRow.principal_id` / `apiKey.principal_id` / `auth.principal_id` reference updates to the new field name.
- The audit `actor` strings remain `operator:<id>` (already the convention via `actorOf(c)` in `services/api/src/audit.ts`).

## 5. Operators panel UI

**Routes:**

- `/operators` — List. Columns: name, email, role, fingerprint (8-char prefix), last seen, status. Filter chips for role and active/disabled. Header action: "Add operator" → dialog form (name, email, role, ssh pubkey, scopes). Wraps `POST /v1/admin/operators`; the response's `login_token` is surfaced in a one-time-display secret card.

- `/operators/$id` — Detail. Sections:
  - **Identity**: name, email, role, SSH pubkey + fingerprint, created/updated, last seen. Edit dialog wraps `PATCH /v1/admin/operators/:id` (name + role only; SSH pubkey rotation is its own action).
  - **Credentials**: a single row in the same `Table` shape used by mailbox credentials, type=`cli`, prefix=`pk_op_`, identity=`pk_op_<api_key_id>`. **No Disable button.** Action column shows "Rotate" → wraps `POST /v1/admin/operators/:id/rotate-key` (returns a fresh `login_token`, displayed once). Rotation copy explains the old key keeps signing in-flight requests during KV cache TTL.
  - **SSH pubkey rotation**: separate card. "Rotate SSH pubkey" → dialog with the new pubkey textarea → wraps `POST /v1/admin/operators/:id/rotate-pubkey`.
  - **Activity**: scoped audit log feed (`actor = 'operator:<id>'`). Same `<AuditRowItem>` component the domain detail page uses.
  - **Danger zone**: Disable operator (soft delete). Re-enable on disabled operators.

- Nav entry: under the existing Admin section (alongside Bridges / Suppressions). Icon: `UserCog` from lucide.

**Sentinel mailbox cleanup:**

- The list filters `WHERE id <> '01J…'` in `routes/admin/mailboxes.ts:43` and `routes/admin/stats.ts:51` go away with the sentinel row. The route handlers stop referencing it.
- `apps/panel/src/client/pages/mailboxes/Detail.tsx`: drop the `principals` field from `MailboxDetailPayload` and the "Principals: N attached(...)" `MetaRow`. After this work, no mailbox carries operator principals.

## 6. Data flow after migration

```
Operator CLI sends X-Polaris-Key-Id + HMAC body
        │
        ▼
auth.ts: SELECT … FROM api_keys WHERE id = ?
        │  one row, includes operator_id (was principal_id)
        ▼
SELECT id, role, disabled_at FROM operators WHERE id = ?
        │  scope/role/disabled check
        ▼
revocationCheck(env, operator_id)
        │
        ▼
AuthCtx { key_id, operator_id, scopes, ... }
        │
        ▼
route handler (e.g. domain.create) — audit logs with actor='operator:<id>'
```

The principals table and the mailbox lookup that joined through it are both deleted. Nothing reads them.

## 7. Migration ordering and rollout

One migration (`0006_operators_split.sql`), one code deploy. Pre-production posture — no users to coordinate with.

Sequence inside the migration:

1. `PRAGMA foreign_keys = OFF;`
2. Delete any orphan `api_keys` rows whose principal lacks a matching operator (defensive; should be zero in practice).
3. Rebuild `api_keys` with the new shape (`operator_id` instead of `principal_id`). Copy rows, joining through `operators.api_key_id` to derive `operator_id`.
4. Rebuild `messages` to drop the `principal_id` column. Indexes recreated. (No FK to operators on messages — the column was an audit hint and `audit_log` records the actor canonically.)
5. `ALTER TABLE operators DROP COLUMN api_key_id;`.
6. `DROP TABLE principals;`.
7. `DELETE FROM mailboxes WHERE id = '01J0000000000000000000PLRS';`.
8. `PRAGMA foreign_keys = ON;`.
9. Insert into `schema_migrations`.

After migration applies, the redeploy of `services/api` uses the new auth path. Brief window between migration apply and deploy: the running worker will fail every operator auth call (no `principal_id` column). This is acceptable pre-production — `polaris-mail setup infra deploy changed` orders migrations before worker deploy via the existing setup CLI flow, and the gap is seconds.

## 8. Testing

- **Migration**: apply 0001 → 0006 to a fresh sqlite DB; assert `principals` is gone, `api_keys.operator_id` is present and populated, `operators.api_key_id` is gone, sentinel mailbox row is gone.
- **Auth integration test** (new): `services/api/test/integration/operator-auth.workers.test.ts` — seed an operator + api_key, sign a request, hit `GET /v1/admin/operators`, expect 200 with the operator listed. Covers the auth path's switch from principals join → operators-direct.
- **Existing tests**: anywhere that seeded `principals` rows now seeds `api_keys` directly with `operator_id`. Files identified during execution.
- **Panel**: typecheck-only. The existing operators API tests in `services/api/test/integration/` already cover the REST surface; the panel changes are pure consumers.

## 9. Open items

None requiring decisions before execution. The `messages.principal_id` removal in §3 was the one place the trade-off mattered — picking deletion over rename because the column carried no information that `audit_log` doesn't already capture, and keeping it would mean either re-pointing the FK to `operators` (extra plumbing for zero benefit) or leaving a dangling reference. Dropped.

## 10. Out of scope

- Bearer-auth migration for operator keys.
- Multi-operator-per-key support.
- An operator-impersonation panel surface (the `X-Polaris-OBO` header used by the Wish SSH server is unchanged).
