---
title: Activity inspection
description: Red/yellow/green snapshots, queue and DLQ depths, Worker log tails, suppression list, and audit-chain verification. The daily-ops surface.
sidebar_label: Activity inspection
sidebar_position: 6
---

# Activity inspection

The daily-ops surface. Nothing in this page mutates state; everything
either reads from the control plane or tails Worker logs.

## `status` — red/yellow/green snapshot

```sh
polaris-email status                       # all rollups
polaris-email status --domain acme.com     # one domain
polaris-email status --queues              # queue + DLQ depths only
```

`--queues` is the recommended fast path for DLQ-depth alerts — it
skips per-domain rollups and returns just the inbound / outbound /
fanout queue and DLQ depths. Pair it with the
[webhook-dlq runbook](/operators/runbooks/webhook-dlq) for on-call.

The full `status` view rolls up:

- Last successful send / receive per domain.
- DKIM key state (`pending` / `active` / `retiring`) per domain.
- Webhook subscription health (last 24-hour success rate, DLQ row
  count) per mailbox.
- Cron-job last-success times (the panel surfaces the `cron_runs`
  table; the CLI reads the same rows).

Red rows are anything stale beyond the configured threshold; yellow is
"degraded, still functional"; green is healthy.

## Worker log tails

```sh
wrangler tail polaris-email-out --status error --search "acme.com"   # outbound errors
wrangler tail polaris-email-in  --status error --search "acme.com"   # inbound errors
wrangler tail polaris-email-api --status error --search "webhook"    # webhook + cron failures
wrangler tail polaris-email-out --status ok                          # full log stream
wrangler tail polaris-email-api --status error --since 1h            # last hour, errors only
```

The previous separate `polaris-email-fanout` and `polaris-email-cron`
Workers were folded into `polaris-email-api`; webhook delivery and
cron failures both surface under that Worker's tail.

## Audit chain

```sh
polaris-email audit verify                     # walk hash chain end-to-end
polaris-email audit anchors                    # list B2 anchors (off-Cloudflare)
```

`audit verify` walks every row in `audit_log`, recomputes each
`row_hash`, and cross-checks `audit_anchors` for matching Backblaze B2
keys. Any divergence is a critical incident — see the
[anchor-maintenance runbook](/operators/runbooks/anchor-maintenance).

`audit anchors` lists every anchor row with its B2 object key and
`external_ref_at` timestamp. Rows where `external_ref_at IS NULL` are
unanchored (the daily backfill cron will retry the B2 PUT).

Audit anchors live **off** Cloudflare — Backblaze B2 with Object Lock
COMPLIANCE mode and ~7-year retention. A fully-compromised CF account
can stop anchors from being written but cannot rewrite existing
anchors. See [the threat model](/security/threat-model#audit-anchors)
for the full property statement.

## Webhook DLQ

```sh
polaris-email webhook dlq list
polaris-email webhook dlq inspect <id>
```

Read-only fast path. Full DLQ operations
(replay / drop) live under
[Routing and webhooks](/operators/day-2/routing-and-webhooks#webhook-dlq).

## Suppression list

The suppression list is **bi-directional**:

- **Outbound** — bounces and complaints from outbound deliveries land
  here, and subsequent sends to suppressed addresses are dropped.
- **Inbound** — mail from suppressed addresses is also dropped.

```sh
polaris-email suppression list
polaris-email suppression check user@example.com
polaris-email suppression show <id>
polaris-email suppression add
polaris-email suppression remove <id>
```

`suppression add` is interactive (it prompts for the address, reason,
and source); pass `--from-file` for non-interactive use. `remove`
requires the row id, not the address — there's no implicit "unblock by
address".

## HMAC signature verify

When a webhook consumer reports a `bad_signature` error, capture the
`X-Polaris-*` headers and raw body and replay them locally:

```sh
polaris-email auth verify \
    --method POST --path /v1/messages --body req.json \
    --ts 1700000000000 --nonce <nonce> --sig <hex> \
    --secret "$(op read op://Vault/Polaris/secret)"
```

Returns `OK` on stdout (exit 0) for a valid signature; on failure
prints `INVALID code=<code> err=<reason>` on stderr (exit 1). Useful
when you need to confirm whether the bug is on the signer or the
verifier.

## Cost monitoring

Monthly bill lives in the Cloudflare dashboard → Billing → Usage page;
there is no CLI command. Alert weekly if Workers CPU-ms exceeds 50% of
the subscription tier. See
[the cost model](/operators/concepts/cost-model) for the line-item
breakdown.

## Daily-ops checklist

- **Watch DLQ depth**: alert if `polaris-email status --queues` shows
  DLQ growth > 0 over a 5-minute window.
- **Watch audit anchor age**: anchors run hourly and land in Backblaze
  B2; anchor age > 90 min is an alert (the anchor cron inside
  `services/api` may be stuck).
- **Watch cost**: review the CF dashboard Billing → Usage page
  weekly; alert if Workers CPU-ms exceeds 50% of the subscription
  tier.

## Related runbooks

- [Anchor maintenance](/operators/runbooks/anchor-maintenance) — when
  `audit verify` flags drift or `audit anchors` shows unanchored rows
  past 25 hours.
- [Webhook DLQ](/operators/runbooks/webhook-dlq) — when DLQ depth
  alerts fire.
- [D1 recovery](/operators/runbooks/d1-recovery) — when `status` rows
  go red because D1 itself is the problem.

<!-- Verified against: docs/operator.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
