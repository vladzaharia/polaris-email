---
title: Data residency
description: Where every class of polaris-email data lives — D1, R2, Backblaze B2 anchors, Email Routing, Workers, the mail-bridge SQLite mirror, panel sessions — plus verification commands and the right-to-erasure path.
sidebar_label: Data residency
sidebar_position: 7
---

# Runbook: data residency

polaris-email's stored data:

- **D1** — declared in `services/api/wrangler.local.jsonc` as `database_name` + `location: 'weur'` (configurable).
- **R2** (`polaris-email` bucket) — declared in `services/api/wrangler.local.jsonc` as `bucket_name` + `jurisdiction: 'eu'` (configurable). Holds message bodies + attachments, fronted publicly at `r2.mail.plrs.im` via content-addressed keys.
- **Audit anchors (off-Cloudflare)** — Backblaze B2 bucket with Object Lock COMPLIANCE mode + 7-year default retention. Region is operator-chosen (default `us-west-005`); endpoint, bucket, and region are set in `services/api/wrangler.jsonc` `vars` as `ANCHOR_S3_ENDPOINT` / `ANCHOR_S3_BUCKET` / `ANCHOR_S3_REGION`. The B2 Application Key lives in the operator's password vault, not Workers Secrets. See `packages/object-lock` and `infra/terraform/README.md` for setup.
- **Email Routing inbound** — CF's regional routing follows the domain's MX, which lands in CF's nearest colo. Use a regional CF account to constrain.
- **Workers** — `placement: { mode: 'smart' }` keeps execution close to D1/R2.
- **Mail-bridge SQLite mirror** — on each bridge host's local volume (operator-managed). Holds credential bcrypt hashes and the local message-state mirror; never plaintext passwords.
- **Panel sessions** — stored in D1 (better-auth backing tables).

## Verifying

Use the polaris-email CLI to inventory the stack:

```sh
polaris-email domain list            # mail_domains, including jurisdiction hints
polaris-email cred list --mailbox M  # api keys + smtp credentials for mailbox M
polaris-email status                 # high-level counts
```

For deeper jurisdiction inspection, query the bindings directly via `wrangler d1
info` and `wrangler r2 bucket info`.

## Recipients are unrecoverable

By design, polaris-email does **not** retain plaintext recipient addresses
once a message has been submitted and dispatched. The audit chain records
hashes and metadata, not plaintext to/cc/bcc lists. Consumers expecting to
respond to subpoenas or comparable disclosure requests must keep their own
outbound logs on the sending side; the service cannot reconstruct who you
sent to after the fact. See [the consumer contract](/reference/consumer-contract).

## Right-to-erasure

The unified `processMessage` pipeline writes inbound and outbound messages
to the same `messages` table, so erasure is **one DELETE path**, not two.
There is no separate forensic store to scrub.

Current procedure:

1. Identify the affected messages via the audit log + `messages` table
   (`mailbox_id` + sender/recipient hash columns + `created_at`).
2. Issue `DELETE /v1/messages/:id` per affected row, then
   `POST /v1/mailboxes/:id/expunge` to hard-delete (decrements `r2_refs`).
3. R2 Object Lock blocks immediate object deletion; underlying bytes expire
   on the configured retention window once `r2_refs` reaches zero.
4. Audit-log the ticket id manually via `polaris-email audit chain`.

<!-- Verified against: docs/runbooks/data-residency.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
