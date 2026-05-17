---
title: Monitoring and alerting
description: Workers Analytics Engine queries, Logpush destinations, the ALERT_WEBHOOK integration point, and the SLOs polaris-email operators should aim for.
sidebar_label: Monitoring
sidebar_position: 1
---

# Monitoring and alerting

polaris-email ships three observability surfaces out of the box:

1. **Workers Analytics Engine** — Cloudflare's first-party metrics
   store, queryable via SQL. Free tier covers the Small tier in the
   [cost model](/operators/concepts/cost-model).
2. **Logpush** — structured Worker logs streamed to an external
   destination (R2, S3, or a SIEM).
3. **`ALERT_WEBHOOK`** — a single inbound webhook URL the synthetic
   monitor, staleness cron, and admin-alert pipeline POST to on
   failure.

Wire all three before you take consumer traffic. The first one is
free; the second is ~$5/mo subscription floor + volume; the third
costs whatever your Slack / PagerDuty / Opsgenie plan costs.

## Workers Analytics Engine

Every Worker emits two kinds of telemetry to Analytics Engine:

- **Per-request metrics** — count, latency, CPU-ms, status code,
  caller key id (hashed), route. Emitted by the API Worker on every
  authenticated request.
- **Per-domain rollups** — outbound throughput, bounce rate, DKIM
  failure rate, fanout backlog depth. Emitted by the queue consumer
  + cron handlers in `services/api`.

Query via `wrangler` or the dashboard's Analytics → Workers Analytics
Engine view. The dataset names are stable across environments
(`polaris_api_requests`, `polaris_outbound_attempts`, etc.) so a
single query string works against any deployment.

### Outbound throughput

```sql
SELECT
  intDiv(toUInt32(timestamp), 60) * 60 AS minute,
  blob1 AS domain,
  count() AS sends,
  countIf(blob2 = 'sent')     AS delivered,
  countIf(blob2 = 'bounced')  AS bounced,
  countIf(blob2 = 'failed')   AS failed
FROM polaris_outbound_attempts
WHERE timestamp > now() - INTERVAL 1 HOUR
GROUP BY minute, domain
ORDER BY minute DESC
```

### Error rate, last hour

```sql
SELECT
  blob1 AS error_code,
  count() AS hits
FROM polaris_api_requests
WHERE timestamp > now() - INTERVAL 1 HOUR
  AND blob2 != '2'      -- HTTP status class
GROUP BY error_code
ORDER BY hits DESC
LIMIT 20
```

### DLQ depth (current)

The webhook DLQ is a Cloudflare Queue, not Analytics Engine — depth
is a live count, not a time series:

```sh
wrangler queues consumer status polaris-email-fanout-dlq
```

The fanout DLQ is the only one operators routinely watch. The
outbound DLQ collects poison messages too; for both, the
[webhook DLQ runbook](/operators/runbooks/webhook-dlq) covers replay
and drop.

### Anchor cron freshness

```sql
SELECT
  max(timestamp) AS last_anchor,
  now() - max(timestamp) AS lag
FROM polaris_cron_runs
WHERE blob1 = 'anchor' AND blob2 = 'ok'
```

`lag` > 1h is the alert threshold. The
[anchor maintenance runbook](/operators/runbooks/anchor-maintenance)
covers the failure modes.

### Bridge `last_seen` lag

Bridges land their `last_seen_at` in D1, not Analytics Engine —
they're rare and small, so D1 is the right home:

```sh
wrangler d1 execute polaris-email --command "
  SELECT id, name, last_sync_at,
         (strftime('%s', 'now') * 1000 - strftime('%s', last_sync_at) * 1000) / 1000 AS lag_seconds
  FROM mail_bridges
  ORDER BY last_sync_at DESC
"
```

`lag_seconds > 120` is the threshold (the on-call runbook starts
alerting at 2 minutes).

## Logpush destinations

Logpush jobs ship structured Worker logs (one JSON line per console
output) to an external destination. polaris-email recommends one of:

| Destination | When | Notes |
| --- | --- | --- |
| **R2** | Default. Cheapest, same account, no cross-cloud egress. | Pair with a retention rule so logs roll off at your audit window. |
| **S3** | You already have an SIEM that ingests from S3 (Splunk, Sumo, Panther). | Cross-cloud egress applies. |
| **HTTP webhook** | Lightweight forwarding to a logs-as-a-service backend (Datadog, Axiom, Logtail). | Buffered server-side; spiky delivery. |

Create a Logpush job per Worker via `wrangler` or the dashboard:

```sh
wrangler logpush create \
  --dataset workers_trace_events \
  --destination-conf "r2://polaris-logs/api/{DATE}" \
  --filter '{"where":{"key":"ScriptName","operator":"eq","value":"polaris-email-api"}}'
```

Repeat for `polaris-email-in`, `polaris-email-out`, and
`polaris-email-panel`. The
[CF account compromise runbook](/operators/runbooks/cf-account-compromise)
treats this Logpush mirror as **authoritative** in the case of a
fully-compromised CF account — keep the destination outside the
polaris-email CF account when possible (cross-account R2 or a third
party).

### What to grep for in Logpush

The Workers emit structured `console.warn` / `console.error` lines
the operator can pattern-match on:

| `event` | Surface | Meaning |
| --- | --- | --- |
| `hmac_verification_failed` | API | One of `bad_signature`, `clock_skew`, `nonce_replay`. Includes the key id + path. |
| `anchor_b2_write_failed` | API cron | B2 PUT failed; daily backfill cron will retry. |
| `synthetic_check_failed` | API cron | `/healthz` probe failed twice in a row; `ALERT_WEBHOOK` already fired. |
| `revocation_check_failed` | API | `KV_REVOCATIONS` read errored; treated as not-revoked but logged. |
| `webhook_delivery_failed` | API queue | One webhook attempt failed; check `paused` and `failure_count` on the sub. |

## `ALERT_WEBHOOK` integration

`ALERT_WEBHOOK` is a single URL the control plane POSTs to on
failure. It's configured via `polaris-email setup infra configure` and
surfaces in three places:

| Caller | When |
| --- | --- |
| `services/api/src/scheduled/synthetic.ts` | After two consecutive `/healthz` failures. Counter persisted in `KV_RATE_LIMIT` so isolate evictions don't reset it. |
| `services/api/src/scheduled/staleness.ts` | Weekly check that the control-plane signing secret has been rotated within 365 days. |
| `services/api/src/lib/admin-alert.ts` | Generic `sendAlert()` writer used by sender abuse threshold, phishing reports, legal takedowns, DMARC alignment drops, etc. Deduped via `KV_ADMIN_ALERTS` (1h bucket) so an alert storm doesn't spam the operator. |

All three call the webhook through `safeFetch` (see
[`services/api/src/queue/ssrf.ts`](https://github.com/vladzaharia/polaris-email/blob/main/services/api/src/queue/ssrf.ts))
to neutralise SSRF — a misconfigured webhook URL can't be turned into
a probe against private network ranges.

### Payload shape

Synthetic and staleness post a minimal JSON body:

```json
{ "service": "polaris-email", "synthetic_failures": 2 }
```

```json
{ "service": "polaris-email", "staleness": ["control_plane_secret_overdue"] }
```

`sendAlert()` posts the richer admin-alert envelope:

```json
{
  "alert_id": "01HXR...",
  "alert_type": "sender_threshold_breached",
  "severity": "warn",
  "target": "noreply@example.com",
  "subject": "...",
  "body": "...",
  "payload": { "...": "..." },
  "recipients": "ops@example.com",
  "created_at": "2026-05-16T15:00:00Z"
}
```

`alert_type` is one of the literal strings in
[`AdminAlertType`](https://github.com/vladzaharia/polaris-email/blob/main/services/api/src/lib/admin-alert.ts) —
your downstream consumer can route on this.

### Hooking up Slack / PagerDuty / Opsgenie

The webhook is plain JSON POST, so most receivers work directly:

- **Slack incoming webhook**: works out of the box, but you'll
  probably want a one-line forwarder Worker to reshape the JSON into
  Slack's `text` field for nicer rendering.
- **PagerDuty Events API v2**: needs a forwarder Worker to translate
  `severity` into PagerDuty's `severity` enum and synthesise a
  `dedup_key` (the `alert_id` is a fine candidate).
- **Opsgenie / Splunk OnCall**: same shape — point at the inbound
  webhook URL.

A "forwarder Worker" is ~20 lines of Hono. We don't ship one because
the shape of the downstream payload depends entirely on which
receiver you picked.

## SLOs

Aim for these. Each is met today on the canonical deployment; falling
below any one of them is the operator's signal that something has
regressed.

| SLO | Threshold | Measured by |
| --- | --- | --- |
| `/v1/messages` publish latency | 99% < 250 ms | `polaris_api_requests` Analytics Engine, p99 by minute. |
| Webhook delivery latency | 99.9% within 30 s of source event | `polaris_webhook_deliveries` Analytics Engine, p99.9 by minute. |
| Anchor cron freshness | Latest anchor < 1 h stale | `polaris_cron_runs` Analytics Engine + the [anchor maintenance runbook](/operators/runbooks/anchor-maintenance). |
| Synthetic outbound | 100% over rolling 1 h window (allow ≤2 transient blips) | `services/api/src/scheduled/synthetic.ts` counter in `KV_RATE_LIMIT`; alert fires on `≥ ALERT_THRESHOLD` (2). |
| Bridge `last_seen` lag | < 2 min for every healthy bridge | D1 `mail_bridges.last_sync_at`. |
| DLQ growth | Bounded at zero outside an incident window | Queues consumer status; the [webhook DLQ runbook](/operators/runbooks/webhook-dlq) is the recovery path. |

The publish-latency SLO bakes in a budget for Argon2id key
verification — that's why Argon2id moved to the Out Worker in the
deferred-hashing pattern. If you see p99 latency above 250 ms on
authenticated requests, the first thing to check is whether Argon2id
slipped back into the request path.

## Third-party APM

We don't prescribe Datadog, Honeycomb, Grafana, or NewRelic. All
four are reachable via Logpush (HTTP webhook destination) or
Analytics Engine (most have a Cloudflare integration), and the
fan-out shape is bespoke per receiver. If you're already on one of
these stacks, point Logpush at it and write the dashboards there;
don't expect polaris-email to ship a turnkey integration.

The
[Cloudflare Analytics Engine integration docs](https://developers.cloudflare.com/analytics/analytics-engine/)
cover the SQL surface; everything in this page works against that
endpoint.

<!-- Verified against: bin/configure.sh, services/api/src/scheduled/index.ts, services/api/src/scheduled/synthetic.ts, services/api/src/scheduled/staleness.ts, services/api/src/scheduled/anchor.ts, services/api/src/lib/admin-alert.ts, services/api/src/env.ts, apps/docs/content/operators/concepts/cost-model.md, apps/docs/content/operators/runbooks/anchor-maintenance.md @ eeee222cdf8359f8f2bf1013a103abdb3c705f06 -->
