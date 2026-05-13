# polaris-email on-call runbook

First commands and decision trees for common incidents. Pairs with
`docs/OPERATOR.md` (workflows) and `docs/cost-model.md` (billing).

## Triage at 3 AM

Whatever the alert, first command is:

```bash
polaris-email status
```

This returns red/yellow/green per domain plus aggregate health:

- **Daemons**: per-daemon `last_seen_at` (alert if > 2 minutes)
- **Outbound**: per-domain send rate, p99 send latency, queue depth, DLQ depth
- **Inbound**: per-domain receive rate, fanout backlog, fanout DLQ depth
- **Recent error class summary**: top 5 error categories in last 1h

If `status` itself fails (no response, auth error), the control plane Worker
or the API token is broken. Check Cloudflare dashboard health for Workers in
the prod account.

## Common incidents

### "Outbound to acme.com is failing"

```bash
polaris-email logs failures --domain acme.com --since 1h
polaris-email logs send --domain acme.com --status failed --since 1h
```

Look at error class:

- **provider_5xx**: Cloudflare Email Service issue. Check
  https://www.cloudflarestatus.com/. If sustained > 5 min, cut domain over
  to fallback provider:
  ```bash
  polaris-email domain set-provider acme.com --provider ses
  ```
  (SES is not currently implemented as a provider; future work)
- **dkim_invalid**: receiver bouncing on DKIM. Check current DKIM key state:
  ```bash
  polaris-email domain show acme.com   # look for dkim_keys with state
  ```
  If `retiring` was removed from DNS prematurely, restore via `polaris-email
  domain rotate-dkim acme.com --rollback`.
- **rate_limited**: tenant exceeding per-tenant rate limit. Coordinate with
  tenant; if legitimate, raise their `tenants.rate_limit_per_min` via
  `polaris-email tenant update`.

### "Webhook deliveries are failing for service X"

```bash
polaris-email logs webhooks --tenant <name> --since 1h --status failed
polaris-email webhook dlq list --tenant <name>
```

Per-subscription circuit breaker (A8) marks a sub `paused` after 5
consecutive failures. To resume:

```bash
polaris-email webhook resume <sub_id>
```

If receiver is permanently broken and DLQ is filling:

```bash
polaris-email webhook dlq inspect <id>             # confirm contents
polaris-email webhook dlq replay <id>              # try once
polaris-email webhook dlq drop <id> --confirm <id> # two-person rule
```

### "Daemon is offline / can't authenticate"

```bash
polaris-email daemon list
# look for last_seen_at gap

# On the daemon host:
docker compose logs polaris-daemon --tail 100
```

Common causes:

- Cert renewal: lego may have failed; check lego logs. Daemon hot-reloads on
  `.renewed` sentinel; stale certs cause TLS handshake failures.
- HMAC key drift: rotation was started but registration.json on the host
  wasn't updated. Re-deploy the daemon registration:
  ```bash
  polaris-email daemon rotate <name>
  # SCP the new registration.json onto the host; restart the daemon.
  ```
- CF Access service token expired (rare; tokens are long-lived but
  revocable). Check the Access app in dashboard.

### "Audit chain anchor is stale"

```bash
polaris-email audit anchors --since 24h
# Each entry should be ≤ 1 hour apart.
```

If gap > 1h: the anchor cron stopped or is hitting an error. Check
`workers/control-plane` logs for anchor cron failures. Re-trigger manually:

```bash
polaris-email audit force-anchor   # for ops use only; recorded in audit
```

If R2 writes are failing, the anchor key may be revoked or the bucket may
have hit object-lock conflicts. Check the `polaris-anchors` account state.

The external anchor mirror (signed Git or transparency log) is the
authoritative backstop; if R2 anchors are lost, the external mirror is what
prevents history forgery.

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

Single `polaris-email` D1; older message rows archive to R2 Parquet
when storage approaches the 10 GB cap. Run the archival job:

```bash
polaris-email db archive-messages --older-than 90d
# Selects rows from messages older than 90 days, writes them to R2 as
# Parquet (queryable via DuckDB), and DELETEs them from D1.
```

Dump lifecycle:

1. New month's database becomes write target.
2. Prior month read-only for 90 days (replays still possible).
3. Dump to R2 as Parquet via Logpush.
4. D1 dropped.

Manual dump: `polaris-email db dump-month 2026-04 --to-r2`.

### "Cost alert: bill is 2x baseline"

```bash
polaris-email cost --month $(date +%Y-%m) --by-service
```

Cost cliffs to look for (I19):

- **Workers CPU-ms** dominated by Argon2id-on-every-send → confirm Argon2id
  moved out of request path. If still in path, escalate.
- **Queue operations** dominated by webhook retries → check fanout DLQ for
  poison messages.
- **R2 Class A operations** spike → buggy retry loop re-PUTting MIME (I14).
  Check `messages.send_attempt_id` distribution for tight clustering.
- **D1 writes** spike → audit log row storm (rate-limit-storm, deploy
  failure replays).

## Safety rules

- **Never** run `wrangler d1 execute --remote` with destructive SQL without
  a second operator's confirmation.
- **Never** rotate the audit anchor key without first verifying the external
  mirror has the most recent anchor (otherwise the chain becomes
  unverifiable).
- **Never** run `polaris-email domain delete` without checking for live
  webhook subscriptions first; orphan subs lose inbound mail silently.
- **Two-person rule** is enforced by Cloudflare Access for: `tenant
  rotate-pepper`, `domain delete`, `webhook dlq drop`, anchor key rotation.
