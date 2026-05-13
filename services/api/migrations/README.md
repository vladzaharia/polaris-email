# polaris-email D1 migrations

Single D1 database (`polaris-email`). The sharded design described in earlier
versions of the plan has been rolled back: at our expected volume, splitting
D1 by purpose adds operational complexity without commensurate benefit.
Reduce to one DB, expand-then-contract migrations within it.

## Layout

```
migrations/
  0001_init.sql                     Initial schema (services, domains,
                                    mailboxes, api_keys, messages, audit_log,
                                    audit_anchors, bootstrap, ...)
  0002_outbound_domains.sql         Per-domain DKIM/DMARC + SMTP creds
                                    (legacy 'outbound_domains' / 'smtp_credentials').
  0003_smtp_credentials_rename_hash.sql
  0004_sender_scopes_to_manytomany.sql
  0005_mox_pending_ops.sql          (Drop in 0006 — Mox era over.)
  0006_phase0.sql                   v2 design tables + drops Mox-era tables.
                                    Coexists with legacy tables until cutover
                                    in 0007.
```

`wrangler d1 migrations apply polaris-email --remote` consumes this
directory in lex order; the custom runner in `@polaris-email/migrations`
exposes a programmatic alternative (used by the Phase 2 CLI's
`polaris-email bootstrap` flow).

## What 0006 does

- **Drops**: `mailboxes`, `mox_pending_ops`, `local_webhook_targets`,
  `api_key_usage` — no remaining consumers after the cleanup pass.
- **Adds new canonical tables** that don't conflict with legacy:
  `tenants`, `zones`, `mail_domains`, `principals`, `email_senders_v2`,
  `principal_sender_scopes`, `submission_credentials`, `dkim_keys`,
  `daemons`, `messages_v2`, `message_attempts`, `idempotency_keys`.
- **Leaves legacy tables alone** (services, domains, outbound_domains,
  email_senders, api_keys, smtp_credentials, sender_key_scopes,
  webhook_subs, routing_rules, messages, message_deliveries, audit_log,
  audit_anchors, bootstrap). New code paths use the new tables; legacy
  admin routes continue to work against the old tables until cutover.

The `_v2` suffix on `email_senders_v2` and `messages_v2` is temporary —
the cutover migration in 0007 will:
1. Copy data from the legacy `email_senders` → `email_senders_v2` (and
   from `messages` → `messages_v2`).
2. DROP the legacy table.
3. RENAME the v2 table back to the canonical name.

## Expand-then-contract pattern

Every schema change to a live D1 must be applied as two separate
migrations:

1. **Expand**: add the new column / table / index without removing or
   renaming anything. Old code keeps working; new code starts dual-writing
   or reading from the new shape.
2. **Contract**: after every Worker version that reads the old shape has
   been drained from the rotation, a follow-up migration drops the old
   column / table / index.

This is why 0006 *adds* new tables alongside the legacy ones rather than
trying to ALTER the legacy tables in place. ALTER TABLE on a multi-million-
row table also tends to hit D1's per-query timeout (I10).

## How to run migrations

```bash
wrangler d1 migrations apply polaris-email --remote
# or, programmatically (Phase 2 CLI):
polaris-email bootstrap     # runs migrations as part of one-time setup
```

For tests, the existing API test mock seeds the legacy schema directly;
new tables are added on demand by tests that exercise the v2 routes.
