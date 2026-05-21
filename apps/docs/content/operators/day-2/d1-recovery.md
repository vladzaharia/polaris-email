---
title: D1 point-in-time recovery
sidebar_position: 12
---

# D1 point-in-time recovery

D1 Time-Travel gives you ~30 days of point-in-time recovery for the live
`polaris-mail` database. Use it when:

- An operator accidentally truncated a table or ran a wrong UPDATE.
- A migration applied incorrectly and you want to roll back the data
  changes (the schema itself rolls back with `wrangler d1 migrations`).
- You need to inspect "what did the DB look like 3 hours ago" without
  affecting current traffic.

For protection beyond 30 days, or against database deletion, see
[D1 backup hygiene](./d1-backup.md) — that's the weekly R2 export.

## Inspect available bookmarks

```sh
# Shows the bookmark for "1 hour ago", "1 day ago", etc.
wrangler d1 time-travel info polaris-mail --timestamp 2026-04-12T15:00:00Z
```

The output includes a bookmark string (e.g.
`0000000123-00000123-00007fff-...`). Bookmarks are stable identifiers
for a specific moment in the WAL.

## Restore to a point in time

Two flavours:

### Restore into a copy (recommended)

Use when you want to inspect the old state without disturbing
production. Create a new D1 database, restore the bookmark into it,
then query it with `wrangler d1 execute`:

```sh
wrangler d1 create polaris-mail-pitr

# This restores polaris-mail's state at <timestamp> into the new DB.
wrangler d1 time-travel restore polaris-mail-pitr \
  --bookmark <bookmark-from-info>
```

### Restore the live database (destructive)

Use only after exhausting the copy approach. **This overwrites the
production database** — any writes since the bookmark are lost.

```sh
# Take a manual backup first.
wrangler d1 execute polaris-mail --remote \
  --command "SELECT COUNT(*) FROM messages"   # Note the count
# (Trigger the d1-backup cron manually via the dashboard, or wait for
# the next Sunday run — see d1-backup.md.)

wrangler d1 time-travel restore polaris-mail \
  --bookmark <bookmark>
```

The Worker fleet will pick up the restored state on the next D1 query;
in-flight writes during the restore window may fail and need to be
retried (idempotency keys protect against double-sends).

## Common scenarios

### "I accidentally revoked all API keys"

1. `wrangler d1 time-travel info polaris-mail --timestamp <when-was-it-fine>`
2. Restore into `polaris-mail-pitr` (see above).
3. `wrangler d1 execute polaris-mail-pitr --remote --command "SELECT * FROM api_keys WHERE revoked_at IS NULL"`
4. Build INSERT / UPDATE statements to apply the missing rows back into
   production (do not restore the whole DB — you'd lose other recent
   activity).
5. Apply the targeted statements with `wrangler d1 execute polaris-mail --remote --command "..."`.

### "A migration dropped data I needed to keep"

If the rollback path through `wrangler d1 migrations rollback` doesn't
restore the data (it rolls schema, not contents), use Time-Travel to
extract the data:

1. Restore the pre-migration timestamp into a copy.
2. Export the affected table(s) from the copy.
3. Apply the rows back into production after the migration's schema
   stabilises.

## Limits

- ~30 day retention. Older history is not recoverable via Time-Travel
  alone — use the weekly R2 export (see d1-backup.md).
- The destroyed-DB case is **not** covered. Time-Travel can only
  resurrect data; it cannot resurrect a deleted database. For that,
  restore from R2 backups into a new D1 instance and update the
  binding in wrangler.jsonc.
- The live restore is destructive. Always restore into a copy first.

## Cross-reference

- [D1 backup hygiene](./d1-backup.md) — weekly R2 export, complementary.
- `services/api/migrations/` — migration source; rollback via
  `wrangler d1 migrations rollback polaris-mail --remote`.
