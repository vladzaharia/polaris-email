---
title: On-call runbook
description: First commands and decision trees for common polaris-email incidents — triage, outbound failures, webhook delivery failures, bridge offline, audit-anchor staleness, schema migration rollback, D1 quota, cost alerts, mirror staleness, and DLQ filling.
sidebar_label: On-call runbook
sidebar_position: 1
---

# polaris-email on-call runbook

First commands and decision trees for common incidents. Pairs with the
[Operators](/operators) workflows and the cost model (lands in a later batch).

If you'd rather scan a symptom → cause → fix index than walk the
decision trees below, jump to the
[troubleshooting decision matrix](/operators/troubleshooting/decision-matrix).

## Triage at 3 AM

Whatever the alert, first command is:

```bash
polaris-email status
```

This returns red/yellow/green per domain plus aggregate health:

- **Bridges**: per-bridge `last_seen_at` (alert if > 2 minutes)
- **Outbound**: per-domain send rate, p99 send latency, queue depth, DLQ depth
- **Inbound**: per-domain receive rate, fanout backlog, fanout DLQ depth
- **Recent error class summary**: top 5 error categories in last 1h

If `status` itself fails (no response, auth error), the control plane Worker
or the API token is broken. Check Cloudflare dashboard health for Workers in
the prod account.

## Common incidents

### "Outbound to acme.com is failing"

Drill into the failures with the platform's native log tooling — there is
no `polaris-email logs` subcommand. From a workstation with `wrangler`
configured:

```bash
wrangler tail polaris-email-api --status error --search "acme.com"
wrangler tail polaris-email-out --status error --search "acme.com"
```

Cross-reference the failed messages with `polaris-email status --domain acme.com`
for aggregate rates.

Look at error class:

- **provider_5xx**: Cloudflare Email Service issue. Check
  https://www.cloudflarestatus.com/. There is no built-in provider
  fail-over; if the outage is sustained, soft-disable the domain
  (`polaris-email domain disable acme.com`) so callers stop queueing
  doomed messages, then re-enable once the upstream recovers.
- **dkim_invalid**: receiver bouncing on DKIM. Check current DKIM key state:
  ```bash
  polaris-email domain show acme.com   # look for dkim_keys with state
  ```
  If a retiring key was removed from DNS prematurely, rotate again with
  `polaris-email domain rotate-dkim acme.com` and republish the new
  selector before retiring the old one.
- **rate_limited**: tenant exceeding per-tenant rate limit. Coordinate with
  the tenant; rate-limit adjustments are an operator-side D1 update today
  (no CLI verb).

### "Webhook deliveries are failing for service X"

```bash
wrangler tail polaris-email-api --status error --search webhook
polaris-email webhook dlq list
```

Note: webhook fan-out runs **inside** `services/api` (folded in from the
old `services/fanout` Worker). There is no separate
`polaris-email-fanout` Worker to tail.

Per-subscription circuit breaker marks a sub `paused` after 5
consecutive failures. To bring a paused sub back online, update its row
directly (no dedicated `resume` verb today):

```bash
wrangler d1 execute polaris-email --command \
  "UPDATE webhook_subs SET paused = 0, failure_count = 0 WHERE id = '<sub_id>'"
```

If receiver is permanently broken and DLQ is filling:

```bash
polaris-email webhook dlq inspect <id>             # confirm contents
polaris-email webhook dlq replay <id>              # try once
polaris-email webhook dlq drop <id> --confirm <id> # two-person rule
```

### "Bridge is offline / can't authenticate"

```bash
polaris-email bridge list
# look for last_seen_at gap

# On the bridge host:
docker compose logs polaris-bridge --tail 100
```

Common causes:

- Cert renewal: lego may have failed; check lego logs. Bridge hot-reloads on
  `.renewed` sentinel; stale certs cause TLS handshake failures.
- HMAC key drift: rotation was started but registration.json on the host
  wasn't updated. Re-deploy the bridge registration:
  ```bash
  polaris-email bridge rotate <name>
  # SCP the new registration.json onto the host; restart the bridge.
  ```
- CF Access service token expired (rare; tokens are long-lived but
  revocable). Check the Access app in dashboard.

### "Audit chain anchor is stale"

```bash
polaris-email audit anchors
# Each entry should be ≤ 1 hour apart.
polaris-email audit verify
# Walks the chain end-to-end; any tamper or gap shows up here.
```

If the gap is > 1h: the anchor cron stopped or is hitting an error. The
anchor cron lives inside `services/api` (phase B1 folded the standalone
`services/cron` Worker into `services/api`). Tail it:

```bash
wrangler tail polaris-email-api --status error --search anchor
```

If the B2 writes are failing, the anchor key may have been revoked, the
bucket policy may have changed, or the account may be over its B2 cap.
Verify with `polaris-email audit anchors` and the Backblaze B2 console.

Backblaze B2 is the authoritative external backstop (Object Lock COMPLIANCE
~7-year retention, write-only Application Key). If anchor writes have been
silently dropped, comparing the latest D1 `audit_anchors` row against the
most recent B2 object is the tamper-evidence signal — see
`bin/audit-verify.sh`.

### "Schema migration applied but Worker rolled back"

D1 has no transactional DDL (I10). If a deploy fails mid-migration:

```bash
# 1. Check applied migrations (custom schema_migrations table per package).
wrangler d1 execute polaris-email --command \
  "SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 10"

# 2. The expand-then-contract pattern means the previous Worker code should
#    still work against the new schema (additive changes). Roll the Worker
#    forward, not backward.

# 3. If a column was added with NOT NULL and no default, the migration left
#    rows in a bad state. Manually backfill:
wrangler d1 execute polaris-email --command \
  "UPDATE <table> SET <col> = <default> WHERE <col> IS NULL"
```

### "D1 quota approaching"

Single `polaris-email` D1; older message rows are archived to R2 by the
nightly retention janitor cron, which runs **inside `services/api`** (the
standalone `services/cron` Worker was folded into `services/api`). There is no CLI verb for ad-hoc archival yet — drive it from D1
directly. The retention job picks up soft-deleted (`expunged_at IS NOT
NULL`) rows older than the configured window and removes them along with
their R2 references:

```bash
# Inspect current usage:
wrangler d1 info polaris-email
# Watch the cron tick land:
wrangler tail polaris-email-api --status ok --search janitor
```

Long-term, the plan is monthly Logpush dumps to R2 Parquet; that pipeline
is not yet wired up.

### "Cost alert: bill is 2x baseline"

Cloudflare dashboard → Billing → Usage is the authoritative breakdown.
There is no `polaris-email cost` command; we rely on Cloudflare's billing
UI plus Logpush exports for service-level attribution.

Cost cliffs to look for (I19):

- **Workers CPU-ms** dominated by Argon2id-on-every-send → confirm Argon2id
  moved out of request path. If still in path, escalate.
- **Queue operations** dominated by webhook retries → check fanout DLQ for
  poison messages.
- **R2 Class A operations** surge → buggy retry loop re-PUTting MIME (I14).
  Check `messages.send_attempt_id` distribution for tight clustering.
- **D1 writes** surge → audit log row storm (rate-limit-storm, deploy
  failure replays).

### "Mail bridge mirror is stale / clients see old credentials"

The bridge holds a local SQLite mirror of `mailbox_credentials` and
`mailbox_receivers`. The mirror polls the control plane on a 30s baseline;
mutations should also arrive via the bridge's webhook subscription
(`message.received`-style invalidation).

```bash
# Inspect registered bridges + last-sync timestamps directly in D1:
wrangler d1 execute polaris-email --command \
  "SELECT id, name, last_sync_at, status FROM mail_bridges ORDER BY last_sync_at DESC"
# on the host:
docker compose -f docker-compose.tailscale.yml logs polaris-mail-bridge --tail 200
# (or docker-compose.local.yml depending on deployment mode)
```

Forced resync:

```bash
docker compose exec polaris-mail-bridge /usr/local/bin/bridgectl mirror-sync
```

If the mirror is wedged (stale > 5 min and forced sync fails), restart the
bridge container; it re-pulls a fresh snapshot at boot.

### "Webhook DLQ is filling for a bridge subscription"

The bridge auto-registers a webhook subscription to receive push events. If
the bridge is offline (host down, tailnet partition, expired cert), polaris
parks events in the fanout DLQ.

```bash
polaris-email webhook dlq list --sub-id <bridge-sub-id>
polaris-email webhook dlq inspect <id>
# After confirming the bridge is healthy again:
polaris-email webhook dlq replay <id>
# Replay-all for a single sub:
polaris-email webhook dlq replay-all --sub-id <bridge-sub-id>
```

Drops require the two-person rule:

```bash
polaris-email webhook dlq drop <id> --confirm <id>
```

## Safety rules

- **Never** run `wrangler d1 execute --remote` with destructive SQL without
  a second operator's confirmation.
- **Never** rotate the audit anchor key without first verifying the external
  mirror has the most recent anchor (otherwise the chain becomes
  unverifiable).
- **Never** run `polaris-email domain delete` without checking for live
  webhook subscriptions first; orphan subs lose inbound mail silently.
- **Two-person rule** is enforced via the panel's `withApproval(action)`
  middleware (`apps/panel/src/server/auth/approvals.ts`) for: API-key
  rotate / revoke, bridge rotate / deregister, mailbox-credential rotate,
  `domain delete`, `webhook dlq drop`, anchor key rotation. (The earlier
  WebAuthn step-up flow was removed in phase 2f; destructive ops now gate
  on a second admin's approval, not a self-elevating token.)

:::warning Out of date
The "two-person rule" rows above (the DLQ `drop --confirm` flow and the
final "Safety rules" bullet that cites `withApproval(action)` /
`apps/panel/src/server/auth/approvals.ts`) describe the retired
co-sign control. Real deployments are single-operator; destructive
actions are now gated **client-side** in the panel via
`DestructiveActionDialog` (type-the-resource-name confirmation), and
the chained-hash `audit_log` table — anchored hourly to Backblaze B2
with Object Lock COMPLIANCE — is the canonical record of who did what.
The `--confirm <id>` flag on `webhook dlq drop` is a type-the-id
guard (not a second-operator co-sign); the rest of each procedure
still applies as written.
:::

<!-- Verified against: docs/runbook.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
