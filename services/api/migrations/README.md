# polaris-mail D1 migrations

Single D1 database (`polaris-mail`). Earlier
revisions was rolled back: at our expected volume, splitting D1 by purpose
adds operational complexity without commensurate benefit. One DB, expand-
then-contract migrations within it.

## Layout

```
migrations/
  0001_init.sql                  Canonical v1 schema. Nothing was deployed
                                 prior to this; the v1 from-scratch shape
                                 lives entirely here.
  0002_bridge.sql                Phase L mail-bridge tables.
  0003_audit_actions.sql         Widens audit_log.action for Phase L.
  0004_idempotency_composite_pk  A8 fix — (principal_id, key) composite PK.
  0005_read_once_secrets.sql     A11 / B6 — drops plaintext secret columns
                                 and JMAP bearer-token rows. Hard cutover;
                                 every existing secret is regenerated in
                                 the same maintenance window.
```

`wrangler d1 migrations apply polaris-mail --remote` consumes this
directory in lex order; the custom runner in `@polaris-mail/migrations`
exposes a programmatic alternative (used by the polaris-mail CLI's
`polaris-mail bootstrap` flow).

## Tables

Mailbox plane: `mailboxes`, `mailbox_senders`, `mailbox_receivers`,
`principals`, `api_keys`, `submission_credentials`,
`principal_sender_scopes`, `dkim_keys`, `bridges`, `zones`, `mail_domains`.

Routing: `webhook_subs`.

Messages: `messages`, `message_attempts`, `message_deliveries`,
`idempotency_keys`, `r2_refs`.

Audit: `audit_log` (chained-hash; `audit_anchors` was dropped in 0026).

Bookkeeping: `schema_migrations`, `bootstrap`.

## Expand-then-contract pattern

For any future schema change to a live D1, apply the change as two
separate migrations:

1. **Expand**: add the new column / table / index without removing or
   renaming anything. Old code keeps working; new code starts dual-writing
   or reading from the new shape.
2. **Contract**: after every Worker version that reads the old shape has
   been drained from the rotation, a follow-up migration drops the old
   column / table / index.

ALTER TABLE on a multi-million-row table tends to hit D1's per-query
timeout, so prefer additive new tables over column-level changes when
possible.

## How to run migrations

```bash
wrangler d1 migrations apply polaris-mail --remote
# or, programmatically (polaris-mail CLI):
polaris-mail bootstrap     # runs migrations as part of one-time setup
```
