# Architecture

High-level system view of polaris-email after the final-architecture
cutover. Companion documents:
[`docs/messages.md`](messages.md) (data shape),
[`docs/sdk.md`](sdk.md) (clients),
[`docs/mail-bridge.md`](mail-bridge.md) (on-prem),
[`docs/deploy.md`](deploy.md) (operations).

## Services (Cloudflare Workers)

| Service        | Role                                                                                                                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/api` | REST surface, admin API, audit chain, idempotency, HMAC auth. **Also** hosts the queue consumer that signs and delivers webhooks, and the cron triggers (hourly audit anchor, weekly secret staleness check, per-minute health synthetic, nightly retention janitor). |
| `services/in`  | Email Routing handler. Parses inbound MIME, runs the unified pipeline, persists.                                                                                                                                                                                      |
| `services/out` | Outbound queue consumer. Drives the configured provider (Cloudflare `send_email` binding per domain).                                                                                                                                                                 |

Three Workers total. The previous separate `services/fanout` and
`services/cron` Workers were folded into `services/api` in phase B1 — at
<10k msg/day the operational overhead of independent Workers outweighed
their isolation benefit.

The previously separate `services/forensic` Worker has been removed — its
key-management role was deprecated when the schema dropped plaintext
recipient storage in favor of zero-payload retention by default. See
[`CONSUMER-CONTRACT.md`](../CONSUMER-CONTRACT.md) for the consumer-facing
implication.

## Apps

| App                | Description                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/panel`       | Admin UI. Hono + React on a Cloudflare Worker; better-auth + OIDC; sessions in D1.                                                                                       |
| `apps/polaris-cli` | Go CLI (`polaris-email`, alias `pml`) — operator workflows + bootstrap.                                                                                                  |
| `apps/mail-bridge` | On-prem Go binary: SMTPS (465) + IMAP4rev2 (993) in one process. Renamed from `apps/submission-daemon`; SMTPS path is the old daemon's code joined by the IMAP listener. |

The mail bridge has **two equally-supported deployment modes** (tailnet
sidecar or local host-network); see [`docs/mail-bridge.md`](mail-bridge.md).

## Mailbox-centric data model

The schema is mailbox-centric. The previous tenant-centric layout was
replaced wholesale in `0001_init.sql`.

```
operator
  └── mailboxes (1..N)
        ├── mailbox_senders        (which addresses this mailbox can send as)
        ├── mailbox_receivers      (which addresses this mailbox claims for inbound)
        ├── principals             (api keys / smtp creds bind here)
        │     └── principal_sender_scopes
        ├── webhook_subs           (per-mailbox event subscriptions)
        └── messages               (in + out share this table; `direction` discriminates)
```

A mailbox is the unit of routing, auth scope, retention, and webhook
delivery. Every message has exactly one `mailbox_id`. Inbound mail is
matched to a mailbox by walking `mailbox_receivers` patterns; outbound
mail is matched by the principal's mailbox + the requested `from`
address's presence in `mailbox_senders`.

## Unified pipeline

A single `processMessage()` in `packages/pipeline` is the only path mail
takes through the system. Both `services/in` (inbound from Email Routing)
and `services/api` (REST submission, JSON or RFC822) call it. It:

1. Resolves `mailbox_id` (from recipient match or principal scope).
2. Canonicalises MIME / SendRequest into the `Message` shape.
3. Writes inline-small bodies to D1, large bodies / attachments to R2
   under content-addressed keys.
4. Enqueues the message for fanout (inbound → webhook delivery) or send
   (outbound → provider).
5. Appends an `audit_log` row (hash-chained to the prior row).

This means the same input validation, address normalisation, attachment
limits, and audit semantics apply to both directions; no parallel pipeline
exists to drift.

## Webhook fan-out

The webhook queue consumer inside `services/api` is the only place that
signs outgoing webhooks. The envelope is **v2** (`Message` inlined):

```json
{
  "event_id": "01J...",
  "event": "message.received",
  "occurred_at": 1700000000000,
  "message": {
    /* full Message */
  }
}
```

Signed with `X-Polaris-Sig: <hex>` (no `v2=` prefix; HMAC is un-versioned
post-B3), canonical-string uses the `polaris-webhook` HMAC domain tag.
See [`docs/hmac-reference.md`](hmac-reference.md).

## Storage

- **D1 (`polaris-email`)** — single source of truth: mailboxes, senders,
  receivers, principals, messages, webhook subs, audit log, anchors,
  bookkeeping.
- **R2 (`polaris-email`, jurisdiction `eu` by default)** —
  content-addressed bodies and attachments (`r2_refs` reference count).
  Served over the public custom domain `r2.mail.plrs.im`; SHA-256 keys are
  the unguessability boundary (per B5; see [`SECURITY.md`](../SECURITY.md)).
- **Audit anchors → Backblaze B2** — hourly signed anchors are written to a
  Backblaze B2 bucket with **Object Lock in COMPLIANCE mode** (~7-year
  retention). The B2 application key is **scoped write-only** and lives in
  the operator's password vault — not in the Cloudflare account — so even
  a fully-compromised CF account cannot rewrite history. See
  [`SECURITY.md`](../SECURITY.md) for the threat model.
- **KV** — nonces (HMAC replay), idempotency keys (24h), rate limits,
  key-cache for `key_id → secret` resolution.
- **Queues** — outbound, inbound, fanout + DLQs for each.
- **KV (`KV_REVOCATIONS`)** — credential revocation; queried on every authenticated
  request via `@polaris-email/revocation`. ≤60s propagation (KV write + 60s per-Worker cache).

## Audit chain

Every state mutation appends a row to `audit_log` with `prev_hash` linking
to the previous row's `row_hash`. The hourly cron trigger inside
`services/api` signs the latest `row_hash` + count, writes a record to
`audit_anchors` in D1, and **pushes a signed anchor to Backblaze B2**
under Object Lock COMPLIANCE mode (per O1). Anchor signing key lives
separately from `POLARIS_SECRET_A`; rotation procedure is in
[`docs/runbooks/control-plane-rotation.md`](runbooks/control-plane-rotation.md).

## Authentication

- **API consumers**: HMAC-signed requests (`polaris-api` domain tag,
  un-versioned per B3), key_id + secret per principal. Revocation via
  `KV_REVOCATIONS` (≤60s propagation).
- **Panel**: better-auth with OIDC (default IdP is Cloudflare Access).
  Sessions stored in D1. Step-up auth for destructive ops.
- **Mail bridge**: per-bridge HMAC key seeded at registration, mailbox
  credentials (bcrypt hashes) mirrored locally for SMTPS / IMAP auth.

## Cloudflare account topology

**One** Cloudflare account hosts the entire control plane: Workers, D1,
KV, Queues, R2 (`polaris-email` bucket for message bodies / attachments).
The previous separate `polaris-anchors` and `polaris-staging` accounts
were collapsed in phase O1 — at internal-deployment scale the
operational overhead of three accounts wasn't justified.

Tamper-evidence is preserved by writing audit anchors to **Backblaze B2**
(external to Cloudflare, Object Lock COMPLIANCE mode, ~7-year retention,
operator-vault credentials). See the Storage and Audit chain sections
above, and `SECURITY.md` for the threat model.

Email Service `send_email` bindings are account-scoped; `services/out`
is invoked from `services/api` over a Service Binding, not a public fetch.

## What is intentionally not here

- Multi-folder IMAP (INBOX only on the bridge).
- Full-text search of message bodies (FTS5 deliberately excluded).
- A separate forensic key escrow Worker. The architecture choice is
  zero-payload-by-default, with consumer-side outbound logging as the
  expected pattern for subpoena response.
