---
title: Cost model
description: Forward CF-bill projections at small / medium / large traffic tiers, the cost cliffs that disproportionately blow the bill, and the cadence for re-running these numbers.
sidebar_label: Cost model
sidebar_position: 2
---

# polaris-email cost model

Forward projections at three traffic tiers. Re-run quarterly; every
quarter the operator pulls the previous month's actuals from the
Cloudflare dashboard Billing → Usage page and notes any deltas against
the projection here.

All figures USD, list pricing as of May 2026, Workers Paid plan ($5/mo
subscription floor). Excludes Email Service per-message pricing
(operator TBD).

## Traffic tiers

| Tier       | Msgs/day | Msgs/month | Webhook subs avg | Notes                           |
| ---------- | -------- | ---------- | ---------------- | ------------------------------- |
| **Small**  | 1k       | ~30k       | 1                | Internal tooling, single tenant |
| **Medium** | 100k     | ~3M        | 3                | Multi-tenant SaaS, modest scale |
| **Large**  | 10M      | ~300M      | 5                | Marketing-grade volume          |

## Per-tier projections

### Small (1k msgs/day)

| Service                        | Cost/mo     | Notes                            |
| ------------------------------ | ----------- | -------------------------------- |
| Workers Paid (sub floor)       | $5          | Includes 10M req/mo + 30M CPU-ms |
| D1 storage                     | &lt;$1      | &lt;500 MB across all shards     |
| D1 reads/writes                | &lt;$1      | Well under free tier             |
| R2 storage                     | &lt;$1      | ~1.5 GB MIME @ $0.015/GB-mo      |
| R2 ops                         | &lt;$1      | &lt;100k Class A + Class B       |
| KV                             | &lt;$1      | Cache-only usage                 |
| Queues                         | &lt;$1      | ~120k ops                        |
| Logpush                        | $5          | Subscription floor               |
| Analytics Engine               | $0          | Free tier                        |
| **Subtotal CF**                | **~$15**    | + Email Service per-msg (TBD)    |
| Cloudflare Access (Zero Trust) | $0          | Free tier ≤50 users              |
| **Total**                      | **~$15/mo** | + Email Service                  |

### Medium (100k msgs/day)

| Service           | Cost/mo        | Notes                                                                          |
| ----------------- | -------------- | ------------------------------------------------------------------------------ |
| Workers Paid      | $5–10          | Subscription + modest overage                                                  |
| D1 storage        | $5–10          | Single `polaris-email` DB; old message rows archived to R2 Parquet when needed |
| D1 reads/writes   | $5–10          | ~3M writes × 4 ops/msg avg                                                     |
| R2 storage        | $10            | ~150 GB MIME (2-week retention; older dumped to Parquet)                       |
| R2 ops            | $5             | ~3M PUT + retries                                                              |
| KV                | $1–2           | Hot path cache                                                                 |
| Queues            | $10            | 3M msgs × 4 ops/msg × $0.40/M                                                  |
| Logpush           | $5–15          | Per-batch volume                                                               |
| Analytics Engine  | $5             | Per-domain counters                                                            |
| **Subtotal CF**   | **~$50–75**    | + Email Service per-msg                                                        |
| Cloudflare Access | $0             | Still ≤50 users                                                                |
| **Total**         | **~$50–75/mo** | + Email Service                                                                |

### Large (10M msgs/day)

| Service                     | Cost/mo           | Notes                                                                        |
| --------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| Workers Paid (CPU-ms heavy) | $50–500           | Driven by per-request work; see cliff #1 below                               |
| D1 storage                  | $50               | Single `polaris-email` DB; older message rows archived monthly to R2 Parquet |
| D1 reads/writes             | $100–200          | 300M writes/mo × 4–5 ops avg                                                 |
| R2 storage                  | $200              | ~15 TB rolling MIME                                                          |
| R2 ops                      | $50               | 300M PUT + Class B reads in fanout                                           |
| KV                          | $5                | Cache-only                                                                   |
| Queues                      | **$1500**         | 300M msgs × 4 ops × $0.40/M = the dominant CF line                           |
| Logpush                     | $50               | Volume-driven                                                                |
| Analytics Engine            | $20               | Per-domain rollups                                                           |
| **Subtotal CF**             | **~$2,000–2,500** | + Email Service (almost certainly the line-item dominator at this scale)     |
| Cloudflare Access           | ~$50              | If team grows past 50 users                                                  |
| **Total**                   | **~$2k–10k/mo**   | + Email Service                                                              |

## Cost cliffs

Things that disproportionately blow the bill if not watched:

1. **Workers CPU-ms — Argon2id-on-every-send**: at Large scale, each
   request paying ~50 ms CPU for Argon2id alone = 15M CPU-seconds/month.
   At $0.02 per million CPU-ms past the sub allocation, that's ~$300/mo
   for one hash. **Mitigation**: Argon2id moved to the Out Worker
   (deferred hashing pattern).

2. **Queues operations — 4 ops/msg multiplier**: every send is enqueue
   - dequeue + ack = 3 ops min, plus DLQ for failures. At 300M msgs/mo
     and $0.40/M ops, this is the _single biggest CF line item_ and grows
     linearly. **Mitigation**: confirm the pipeline is not double-enqueuing
     on retry (the `send_attempt_id` CAS guards against it).

3. **R2 Object Lock retention**: not relevant for polaris-email's R2
   bucket (which doesn't use Object Lock), but worth flagging at the
   adjacent **Backblaze B2** anchor bucket — anchors in COMPLIANCE mode
   bill for storage until retention expires. **Mitigation**: lock only
   the small (~200-byte) signed anchor entries, not full audit-log
   copies.

4. **Email Service GA pricing**: unknown until Cloudflare announces.
   Watch closely during the beta-to-GA transition. **Mitigation**: the
   Provider interface ships as v1.x so you can flip per-domain to
   SES / Postmark if pricing changes adversely.

5. **D1 storage cliff at 10 GB/database**: not a billing cost so much
   as a correctness cliff — writes fail when the cap is reached.
   **Mitigation**: monthly archival of older-than-N-day rows from the
   single `polaris-email` D1 to R2 Parquet.

6. **Per-tenant Workers Secrets**: ~64 secret cap per Worker. Adding a
   tenant pepper per tenant blows this at 50+ tenants. **Mitigation**:
   single master pepper + HKDF-derived per-tenant peppers (already
   shipped in `@polaris-email/crypto-utils`).

## How to read actuals

Two sources to cross-check against the projections above:

1. **Cloudflare dashboard → Billing → Usage** — service-level breakdown
   for the current and prior months. Authoritative for line-item amounts.
2. **Workers Analytics Engine** — per-Worker CPU-ms, request counts,
   and subrequest counts joined to message volume from the `messages`
   D1 table. Query directly via `wrangler` or pipe to a spreadsheet.

## Re-evaluation cadence

- **Quarterly**: re-run this projection; update the per-tier rows with
  observed values from the Cloudflare Billing dashboard.
- **On any pricing announcement from Cloudflare**: pause the
  Email-Service-only domains and re-evaluate the Provider interface
  fallback decision.
- **On 2× growth in any one metric** (msgs/day, tenants, webhooks/msg):
  re-run cost cliff #1–6 against the new baseline.

<!-- Verified against: docs/cost-model.md @ 60cc6d59541b3279a65c755222fd9290ce76fc5e -->
