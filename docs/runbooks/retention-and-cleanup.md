# Retention and cleanup

`polaris-email` retains every message, attachment, audit log entry,
delivery row, and policy decision for the lifetime of the deployment. A
nightly janitor sweeps expired idempotency keys and short-lived caches
but does NOT trim long-lived data. Operators are responsible for
deciding when (and how aggressively) to prune.

This runbook documents what each retention class needs.

## Retention classes

| Class                        | Where                       | Default retention        | Pruning         |
| ---------------------------- | --------------------------- | ------------------------ | --------------- |
| Message bodies + attachments | R2 (`polaris-email` bucket) | indefinite               | manual          |
| Message rows                 | D1 `messages` table         | indefinite               | manual          |
| Delivery rows                | D1 `message_deliveries`     | indefinite               | manual          |
| Audit log                    | D1 `audit_log` + B2 anchors | 7 years (B2 Object Lock) | not allowed     |
| DMARC / TLS-RPT reports      | D1 + R2                     | indefinite               | manual          |
| Policy decisions             | D1 `policy_decisions`       | indefinite               | manual          |
| Held messages (MIME blobs)   | R2                          | until released/dropped   | replay clears   |
| Idempotency keys             | D1                          | per-row `expires_at`     | janitor nightly |
| Nonces                       | KV                          | 10 min                   | KV TTL          |
| API key plaintext            | KV                          | 15 min                   | KV TTL          |

## Janitor

`services/api/src/scheduled/janitor.ts` runs nightly at 03:00 UTC. It
deletes:

- Expired idempotency_keys rows.
- Expired auth artifacts.
- Soft-deleted mailbox/credential rows past their grace window.

It does NOT touch messages, attachments, audit, or deliveries. That work
is operator-driven.

## Manual message pruning

To trim messages older than N days for a specific mailbox:

```sql
-- 1) Pull the R2 keys we're about to orphan
SELECT id, r2_key
  FROM messages
 WHERE mailbox_id = '<id>' AND created_at < datetime('now', '-90 days');

-- 2) Delete the D1 rows (cascades to message_attempts +
--    message_deliveries; webhook_dlq.message_id SET NULL).
DELETE FROM messages
 WHERE mailbox_id = '<id>' AND created_at < datetime('now', '-90 days');
```

Then sweep R2 for the orphaned keys with `wrangler r2 object delete`.
Attachments are content-addressed; if two messages shared a hash, only
delete the R2 object after confirming no remaining row references it.

A future operator-facing CLI (`polaris-email retention prune`) is
tracked in the backlog; until then this is manual.

## Held messages

`held_messages` rows + their R2 `policy_held/<decision_id>.eml` blobs
persist until an operator releases or drops them. The Moderation panel
shows the queue; bulk operations live in
`polaris-email policy held list/release/drop`.

R2 keys for dropped messages remain (the row records `released_at`); a
future janitor cycle could sweep them.

## Audit retention

**Do not delete `audit_log` rows.** The chained-hash table is the
canonical record of every privileged action; entries are anchored hourly
to Backblaze B2 with Object Lock COMPLIANCE (~7-year retain-until).
Pruning rows here breaks the chain and invalidates every subsequent
anchor.

The 7-year B2 retain-until covers GDPR / SOX / HIPAA audit windows.
Operators who need longer should adjust `ANCHOR_RETENTION_DAYS` before
the corresponding anchor lands.

## Planned: Logpush → R2 Parquet pipeline

The long-term plan is a monthly Logpush job that exports
audit/delivery/message rows to R2 Parquet for cold-storage analytics.
That pipeline is not yet wired up. Manual pruning is the only path
today.

## Quota pressure recovery

If R2 usage spikes unexpectedly:

```sh
# Look for fat attachments
wrangler r2 object list polaris-email --prefix att/ --json \
  | jq '. | sort_by(.size) | reverse | .[0:20]'
```

A single sender pushing oversized attachments is the most common cause.
Suppress the sender (`polaris-email suppression add ...`) and then
prune their messages per the SQL above.
