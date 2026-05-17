# Webhook DLQ operations

The webhook fan-out queue has a backing dead-letter queue:
`polaris-email-fanout-dlq`. Terminal failures (6 attempts exhausted) land
in the `webhook_dlq` D1 table; operators can list, inspect, replay, or
drop entries. This runbook covers the common scenarios.

## Inspect the queue

```sh
polaris-email webhook dlq list                # pending entries (LIMIT 200)
polaris-email webhook dlq show <dlq_id>       # full row including last_error
```

The panel surfaces the same data at `/admin/dlq`. Rows with `replayed_at`
or `dropped_at` are filtered out by default.

## Replay a single entry

```sh
polaris-email webhook dlq replay <dlq_id>
```

The replay endpoint reconstructs the original `FanoutEvent` and enqueues
it back onto `polaris-email-fanout`. The queue consumer reuses the
existing `message_deliveries` row (INSERT OR IGNORE keyed on
`message_id, webhook_sub_id`) and resets the attempt counter, so a
successful replay flips the row from DLQ back to `succeeded`.

Replays are rate-limited (~10/min per admin key) — bulk replay should
chunk and pause.

## Replay everything for one subscriber

```sh
polaris-email webhook dlq list --webhook-sub <sub_id> -o json \
  | jq -r '.[].id' \
  | xargs -n1 -I{} polaris-email webhook dlq replay {}
```

Rate-limit headroom is preserved by the per-key bucket; if you start
getting `rate_limited` errors, sleep 60s.

## Drop a poisoned entry

If the message will never deliver successfully (e.g. the destination URL
permanently 410s), drop it:

```sh
polaris-email webhook dlq drop <dlq_id> --confirm <dlq_id>
```

`--confirm` must equal the DLQ id; this is the type-the-name confirmation
that prevents accidental drops from a stale shell.

## Subscriber-outage cascade

When a single subscriber is down for an extended period:

1. **Pause the sub** to stop new events from queueing:
   `polaris-email webhook-sub pause <sub_id>`. Existing DLQ rows remain.
2. **Drain the DLQ** when the destination recovers:
   list + replay as above, in batches that respect the rate limit.
3. **Verify recovery** in the panel: `Messages → filter status:delivered`.

## Permanent-failure cleanup

The `webhook_dlq` table has no automatic retention. Periodically (monthly
in production) review and drop entries older than 30 days that have
neither been replayed nor dropped — they're typically tombstones from
long-decommissioned destinations.

## What if the original message was retention-pruned?

The DLQ row stores `message_id` but the D1 `messages` row may be gone if
retention swept it. Replay fails with `not_found: message has been
retention-pruned`. There is no recovery path; drop the entry.

## Observability

Each DLQ entry write logs a structured JSON line. Each successful
re-enqueue logs a `webhook_delivery` event with the per-attempt
`delivery_id`. The panel's `/admin/status` endpoint surfaces total DLQ
depth; `cron_runs` does not track DLQ growth (no cron writes it).
