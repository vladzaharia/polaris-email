# polaris-email D1 migrations

This directory holds the SQL migration files for every D1 database in the
sharded polaris-email architecture, plus the original (pre-redesign) migrations
under `legacy/`.

## Layout

```
migrations/
  legacy/      Pre-redesign migrations 0001..0005. Apply to the existing
               single `polaris-email` D1 (the only DB in production today).
               This is what `wrangler d1 migrations apply polaris-email`
               consumes (see services/api/wrangler.jsonc -> migrations_dir).
               Do not edit historical files; add new ones if a hotfix to the
               legacy DB is required during the cutover window.

  control/     Schema for the new `polaris-control` D1. Holds tenants,
               zones, domains, principals (api keys + smtp creds), routing
               rules, webhook subscriptions, DKIM keys, daemons.

  messages/    TEMPLATE schema for `polaris-messages-YYYY-MM` shards. A new
               D1 is created each month (provisioned at runtime); the runner
               applies every migration in this directory to the fresh shard
               before first use.

  audit/       Schema for `polaris-audit`. Hash-chained audit log + signed
               anchor records.
```

## The three new databases

| Database                     | Purpose                                                |
| ---------------------------- | ------------------------------------------------------ |
| `polaris-control`            | Slow-changing config: tenants, domains, principals.    |
| `polaris-messages-YYYY-MM`   | Per-month message metadata + idempotency keys.         |
| `polaris-audit`              | Append-only audit log with hash-chained tamper detect. |

Sharding messages by month bounds the per-shard row count and keeps backups,
restores, and queries cheap. The control DB stays small and is the join target
for every message lookup.

## Cutover plan (Phase 0d)

Phase 0 is **additive only**. The new `control/`, `messages/`, `audit/`
schemas exist on disk but no test infrastructure or runtime code consumes them
yet. The legacy DB and legacy migrations remain the source of truth.

Cutover sequence (per the redesign plan):
1. Phase 0 (this PR): write new schemas + custom runner. No behavior change.
2. Phase 0d: wire the runner into the API Worker startup path; add bindings
   for the new DBs in wrangler.jsonc; switch tests to apply the new schemas.
3. Backfill: dual-write from the legacy DB into the sharded DBs.
4. Cutover: flip reads to the new DBs.
5. Contract: drop the now-unused legacy tables in a follow-up migration.

## Expand-then-contract migration pattern

Every schema change to a live database must be applied as two separate
migrations:

1. **Expand**: add the new column / table / index without removing or renaming
   anything. Old code keeps working; new code starts dual-writing or reading
   from the new shape.
2. **Contract**: after every Worker version that reads the old shape has been
   drained from the rotation, a follow-up migration drops the old column /
   table / index.

This is why the new SQL files in `control/`, `messages/`, `audit/` add new
tables and columns but never modify legacy tables in this phase. The eventual
removal of legacy tables happens in a contract-phase migration after backfill
completes.

## How to run migrations

### Today (legacy DB only)

`wrangler d1 migrations apply polaris-email --remote` reads from
`migrations/legacy` (configured via `migrations_dir` in
`services/api/wrangler.jsonc`). `bin/bootstrap.sh` runs this during the
initial deploy.

### After Phase 0d (sharded DBs)

The custom runner in `@polaris-email/migrations` (`packages/migrations`)
applies migrations programmatically:

```ts
import { applyMigrations } from '@polaris-email/migrations';
import controlMigrations from './migrations-bundle/control.js';
await applyMigrations(env.CONTROL_DB, controlMigrations);
```

A Phase 2 CLI (`bin/migrate.sh` or similar) will wrap this so an operator can
apply migrations to control / audit / a specific messages shard from the
command line. The per-month messages shards are created and migrated lazily
at runtime by the API Worker when the month's first message arrives.
