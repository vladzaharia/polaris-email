---
title: Unified Message model
description: The single Message shape that backs both inbound (Email Routing, mail bridge IMAP) and outbound (REST submission) mail in polaris-mail.
sidebar_label: Unified model
sidebar_position: 1
---

# The unified Message model

Inbound mail (from Email Routing or the mail bridge) and outbound mail
(REST submission) live in the same `messages` table, share the same JSON
shape, and are retrieved through the same endpoints. The normative wire
format is `openapi/polaris-mail.yaml`; the canonical Zod definition is
`packages/schema/src/index.ts` (`Message`). When this page and the
generated [`/reference/api/polaris-mail-api`](/reference/api/polaris-mail-api) disagree, the spec wins.

## Shape

```json
{
  "id": "01JG...",
  "mailbox_id": "01JG...",
  "direction": "in",
  "status": "received",
  "from": "alerts@acme.com",
  "from_addr": "alerts@acme.com",
  "to": ["ops@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "...",
  "header_message_id": "<mid@host>",
  "thread_id": "01JG...",
  "headers": { "X-Foo": "bar" },
  "text": "inline plaintext (only when small)",
  "html": "<p>inline html (only when small)</p>",
  "body_url": "https://r2.mail.plrs.im/mime/aa/bb/<sha256>",
  "attachments": [
    {
      "filename": "report.pdf",
      "content_type": "application/pdf",
      "size_bytes": 184320,
      "url": "https://r2.mail.plrs.im/att/<sha256>/report.pdf"
    }
  ],
  "auth": { "spf": "pass", "dkim": "pass", "dmarc": "pass" },
  "body_bytes": 4096,
  "attachments_total_bytes": 184320,
  "received_at_api": "2026-05-16T00:00:00.000Z",
  "created_at": "2026-05-16T00:00:00.000Z"
}
```

`direction` is `in` (inbound MIME from Email Routing or the bridge IMAP
listener) or `out` (REST submission via `POST /v1/messages`, JSON or
`message/rfc822`). The pipeline is the same for both — see
`packages/pipeline/src/process-message.ts` for the single
`processMessage()` entrypoint.

## Status enum

| Status        | Direction | Meaning                                                                                |
| ------------- | --------- | -------------------------------------------------------------------------------------- |
| `received`    | in        | Inbound mail accepted and persisted.                                                   |
| `mime_stored` | in / out  | Raw RFC822 written to R2; processing in flight.                                        |
| `queued`      | out       | Submission accepted; awaiting handoff to the Email Service binding.                    |
| `sending`     | out       | Handoff to `services/out` in progress.                                                 |
| `sent`        | out       | Email Service binding accepted the message.                                            |
| `delivered`   | out       | Terminal success — every subscribed webhook confirmed delivery.                        |
| `bounced`     | out       | Permanent remote-side failure (recipient mailbox rejected).                            |
| `failed`      | out       | Permanent local-side failure (binding misconfigured, DKIM missing, retries exhausted). |

## R2 access — public custom domain, content-addressed keys

The polaris-mail R2 bucket is fronted by the public custom domain
`r2.mail.plrs.im`. Object keys are content-addressed:

- **Body** — `mime/<aa>/<bb>/<sha256>` where `sha256` is the SHA-256 of
  the canonical RFC822 bytes (`<aa>`, `<bb>` are the first two byte-pair
  prefixes for filesystem-friendly bucketing). URL:
  `https://r2.mail.plrs.im/mime/<aa>/<bb>/<sha256>`.
- **Attachment** — `att/<sha256>/<filename>` where `sha256` is the
  SHA-256 of the decoded attachment bytes. URL:
  `https://r2.mail.plrs.im/att/<sha256>/<filename>`.

Unguessability comes from the SHA-256 in the key — there is no
signature, no expiry, no HMAC header. **Treat the URL itself as a
capability token**: anyone with the URL can fetch the bytes forever.
Audit-log readers implicitly gain content read access; see the
[threat model](/security/threat-model) for the policy.

Identical attachments forwarded to multiple mailboxes share one R2
object via reference counting.

## Inline body and attachment limits

Bodies and attachments below `INLINE_BODY_BYTES_MAX` /
`INLINE_ATTACHMENTS_BYTES_MAX` are also embedded inline on the response.
Larger payloads are URL-only — the consumer follows `body_url` /
`attachment.url` to fetch the raw bytes from `r2.mail.plrs.im` directly.

| Variable                       | Default           | Effect                                              |
| ------------------------------ | ----------------- | --------------------------------------------------- |
| `INLINE_BODY_BYTES_MAX`        | 65536 (64 KiB)    | Bodies above this are URL-only (no `text` / `html`) |
| `INLINE_ATTACHMENTS_BYTES_MAX` | 262144 (256 KiB)  | Attachments above this are URL-only (no inline b64) |
| `R2_PUBLIC_HOST`               | `r2.mail.plrs.im` | The R2 custom domain hostname for URL building      |

Tune via `wrangler secret put` on `services/api`.

## Retrieval endpoints

All retrieval endpoints require `messages:read` (or `admin:read` for
cross-mailbox queries) and are HMAC-signed with the `polaris-api`
domain tag.

| Endpoint                                            | Purpose                                                         |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `GET /v1/messages`                                  | Filtered list (mailbox_id, direction, status, q, since, …).     |
| `GET /v1/messages/:id`                              | Single message with bodies + per-attachment public URLs.        |
| `POST /v1/messages/get`                             | Bulk fetch by id (up to 256 ids per call).                      |
| `GET /v1/mailboxes/:id/changes?since_state=<state>` | Delta cursor for sync (returns ids changed since state).        |
| `GET /v1/mailboxes/:id/messages?fields=metadata`    | Metadata-only listing — no inline bodies, URLs still populated. |
| `GET /v1/messages/:id/thread`                       | All messages with the same `thread_id`, in order.               |

The previous `GET /v1/messages/:id/attachments/:n` signed-URL endpoint
was removed. Consumers fetch attachments straight from the public R2
custom domain using the `url` returned on each attachment.

Full request and response shapes live under [`/reference/api/polaris-mail-api`](/reference/api/polaris-mail-api).

## State mutation

State mutations are explicit; they never emit webhooks (the consumer is
the one driving them, so there is no event to fan out).

| Endpoint                         | Effect                                                   |
| -------------------------------- | -------------------------------------------------------- |
| `PATCH /v1/messages/:id`         | Update flags: `seen`, `flagged`, custom keywords.        |
| `DELETE /v1/messages/:id`        | Soft-delete (`expunged_at` set; row retained for audit). |
| `POST /v1/mailboxes/:id/expunge` | Hard-delete all soft-deleted rows for a mailbox.         |

Soft-delete decrements the `r2_refs` count on the message's body and
attachment objects; hard-expunge eventually frees R2 storage. The
retention janitor cron inside `services/api` tidies up nightly.

## Webhook v2 envelope

Inbound mail and bounce / delivery events are delivered to subscribers
as **signed webhooks**. The v2 envelope (mandatory; no v1 fallback) is:

```json
{
  "event_id": "01JG...",
  "event": "message.received",
  "occurred_at": "2026-05-16T00:00:00.000Z",
  "message": {
    /* full Message shape, same as GET /v1/messages/:id */
  }
}
```

Headers:

```
Content-Type: application/json
X-Polaris-Event-Id: 01JG...
X-Polaris-Event: message.received
X-Polaris-Ts: 2026-05-16T00:00:00.000Z
X-Polaris-Nonce: ...
X-Polaris-Sig: <lowercase-hex(HMAC-SHA256(secret, canonical))>
```

The signature header carries the raw lowercase-hex MAC — no `v1=` or
`v2=` prefix (HMAC is un-versioned). The canonical-string format and
`polaris-webhook` domain tag are the same as for API requests; only the
envelope shape (full `Message` inlined, no follow-up GET) differs. See
the HMAC reference under [Security](/security) for the canonical spec.

Events emitted:

- `message.received` — inbound mail accepted and persisted.
- `message.sent` — outbound message handed off to the Cloudflare Email
  Service binding.
- `message.delivered` — terminal success state, set once the last
  subscribed webhook confirmed delivery. Emitted by the queue consumer
  inside `services/api`; `services/out` never sets this directly.
- `message.bounced` — permanent remote-side failure.
- `message.failed` — permanent local-side failure (binding
  misconfigured, R2 body missing, DKIM unavailable, retries exhausted).

State mutations (`PATCH` / `DELETE` / `expunge`) intentionally emit no
webhook.

Webhook delivery patterns (external / tailnet / bridge-proxied) are
covered in the [webhook decision tree](/developers/webhooks/decision-tree).

<!-- Verified against: packages/schema/src/index.ts, services/api/src/routes/messages.ts, services/api/src/routes/messages-state.ts, services/api/src/env.ts, openapi/polaris-mail.yaml, docs/messages.md @ 60cc6d59541b3279a65c755222fd9290ce76fc5e -->
