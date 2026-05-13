# polaris-email cost model

Forward projections at three traffic tiers. Re-run quarterly; every quarter the
operator updates `polaris-email cost --month YYYY-MM` against the projection
and notes any deltas in this doc.

All figures USD, list pricing as of May 2026, Workers Paid plan ($5/mo
subscription floor). Excludes Email Service per-message pricing (operator
must confirm during Phase −1 spike).

## Traffic tiers

| Tier | Msgs/day | Msgs/month | Webhook subs avg | Notes |
|---|---|---|---|---|
| **Small** | 1k | ~30k | 1 | Internal tooling, single tenant |
| **Medium** | 100k | ~3M | 3 | Multi-tenant SaaS, modest scale |
| **Large** | 10M | ~300M | 5 | Marketing-grade volume |

## Per-tier projections

### Small (1k msgs/day)

| Service | Cost/mo | Notes |
|---|---|---|
| Workers Paid (sub floor) | $5 | Includes 10M req/mo + 30M CPU-ms |
| D1 storage | <$1 | <500 MB across all shards |
| D1 reads/writes | <$1 | Well under free tier |
| R2 storage | <$1 | ~1.5 GB MIME @ $0.015/GB-mo |
| R2 ops | <$1 | <100k Class A + Class B |
| KV | <$1 | Cache-only usage |
| Queues | <$1 | ~120k ops |
| Logpush | $5 | Subscription floor |
| Analytics Engine | $0 | Free tier |
| **Subtotal CF** | **~$15** | + Email Service per-msg (TBD) |
| Cloudflare Access (Zero Trust) | $0 | Free tier ≤50 users |
| **Total** | **~$15/mo** | + Email Service |

### Medium (100k msgs/day)

| Service | Cost/mo | Notes |
|---|---|---|
| Workers Paid | $5–10 | Subscription + modest overage |
| D1 storage (sharded) | $5–10 | Time-partitioned messages-YYYY-MM rotates monthly |
| D1 reads/writes | $5–10 | ~3M writes × 4 ops/msg avg |
| R2 storage | $10 | ~150 GB MIME (2-week retention; older dumped to Parquet) |
| R2 ops | $5 | ~3M PUT + retries |
| KV | $1–2 | Hot path cache |
| Queues | $10 | 3M msgs × 4 ops/msg × $0.40/M |
| Logpush | $5–15 | Per-batch volume |
| Analytics Engine | $5 | Per-domain counters |
| **Subtotal CF** | **~$50–75** | + Email Service per-msg |
| Cloudflare Access | $0 | Still ≤50 users |
| **Total** | **~$50–75/mo** | + Email Service |

### Large (10M msgs/day)

| Service | Cost/mo | Notes |
|---|---|---|
| Workers Paid (CPU-ms heavy) | $50–500 | Driven by per-request work; see I5 below |
| D1 storage (sharded) | $50 | Multiple time-partitioned message databases live simultaneously |
| D1 reads/writes | $100–200 | 300M writes/mo × 4–5 ops avg |
| R2 storage | $200 | ~15 TB rolling MIME |
| R2 ops | $50 | 300M PUT + Class B reads in fanout |
| KV | $5 | Cache-only |
| Queues | **$1500** | 300M msgs × 4 ops × $0.40/M = the dominant CF line |
| Logpush | $50 | Volume-driven |
| Analytics Engine | $20 | Per-domain rollups |
| **Subtotal CF** | **~$2,000–2,500** | + Email Service (almost certainly the line item dominator at this scale) |
| Cloudflare Access | ~$50 | If team grows past 50 users |
| **Total** | **~$2k–10k/mo** | + Email Service |

## Cost cliffs

Things that disproportionately blow the bill if not watched:

1. **Workers CPU-ms — Argon2id-on-every-send (I5)**: at Large scale, each
   request paying ~50 ms CPU for Argon2id alone = 15M CPU-seconds/month.
   At $0.02 per million CPU-ms past the sub allocation, that's ~$300/mo
   just for one hash. **Mitigation**: Phase 5/I5 — Argon2id moved to the
   Out Worker (deferred hashing pattern).

2. **Queues operations — 4 ops/msg multiplier**: every send is enqueue +
   dequeue + ack = 3 ops min, plus DLQ for failures. At 300M msgs/mo and
   $0.40/M ops, this is the *single biggest CF line item* and grows
   linearly. **Mitigation**: confirm we're not double-enqueuing on retry
   (A7 state machine guards against it via `send_attempt_id` CAS).

3. **R2 Object Lock retention**: anchors in compliance mode bill for
   storage until the retention period expires. Locking 7 years of audit
   shadow copies is expensive. **Mitigation**: lock only the small
   (~200-byte) anchor entries, NOT full audit-log copies (I4).

4. **Email Service GA pricing**: unknown until CF announces. Watch closely
   during the beta-to-GA transition. **Mitigation**: SES/Postmark provider
   shipped as v1.x means we can flip per-domain to a different provider if
   pricing changes adversely (A15 + Resolved Q1).

5. **D1 storage cliff at 10 GB/database**: not a billing cost so much as a
   correctness cliff — writes fail when the cap is reached. **Mitigation**:
   monthly rotation of `polaris-messages-YYYY-MM` with R2 Parquet dump
   (I3).

6. **Per-tenant Workers Secrets**: ~64 secret cap per Worker. Adding a
   tenant pepper per tenant blows this at 50+ tenants. **Mitigation**:
   single master pepper + HKDF-derived per-tenant peppers (H5/I13 — already
   shipped in `@polaris-email/crypto-utils`).

## How `polaris-email cost` is computed

The CLI command pulls from two sources:

1. **Cloudflare Billing API** (`/accounts/{id}/billing/profile`) — service-
   level breakdown for the current month. Requires a scoped API token with
   `Account › Billing: Read`.
2. **Workers Analytics Engine** — per-Worker CPU-ms, request counts, and
   subrequest counts joined to message volume from `messages` D1 table.

Output formats:
- `--output table` (default): summary by service with comparison to last month
- `--output json`: full breakdown for piping to spreadsheets/Datadog
- `--by-service`: each CF service line item separately
- `--by-domain`: attempts to attribute cost to onboarded domains via
  per-domain Analytics Engine counters

## Re-evaluation cadence

- **Quarterly**: re-run this projection; update the per-tier rows with
  observed values from `polaris-email cost`.
- **On any pricing announcement from Cloudflare**: pause the
  Email-Service-only domains and re-evaluate the Provider interface
  fallback decision (A15 / Resolved Q1).
- **On 2x growth in any one metric** (msgs/day, tenants, webhooks/msg):
  re-run cost cliff #1–6 against the new baseline.
