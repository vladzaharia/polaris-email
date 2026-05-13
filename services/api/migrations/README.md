# polaris-email D1 migrations

Single D1 database (`polaris-email`). The sharded design described in earlier
revisions was rolled back: at our expected volume, splitting D1 by purpose
adds operational complexity without commensurate benefit. One DB, expand-
then-contract migrations within it.

## Layout

```
migrations/
  0001_init.sql       Canonical v1 schema. Nothing was deployed prior to
                      this; the v1 from-scratch shape lives entirely here.
```

`wrangler d1 migrations apply polaris-email --remote` consumes this
directory in lex order; the custom runner in `@polaris-email/migrations`
exposes a programmatic alternative (used by the Phase 2 CLI's
`polaris-email bootstrap` flow).

## Tables

Control plane: `tenants`, `zones`, `mail_domains`, `email_senders`,
`principals`, `api_keys`, `submission_credentials`, `principal_sender_scopes`,
`dkim_keys`, `daemons`.

Routing: `webhook_subs`, `routing_rules`.

Messages: `messages`, `message_attempts`, `message_deliveries`,
`idempotency_keys`.

Audit: `audit_log`, `audit_anchors`.

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
wrangler d1 migrations apply polaris-email --remote
# or, programmatically (Phase 2 CLI):
polaris-email bootstrap     # runs migrations as part of one-time setup
```
