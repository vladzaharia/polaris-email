# Messages

The unified `Message` model. Inbound mail (from Email Routing or the mail
bridge) and outbound mail (REST submission or bridge submission) live in the
same table, share the same JSON shape, and are retrieved through the same
endpoints. Canonical types live in
[`openapi/polaris-email.yaml`](../openapi/polaris-email.yaml); this guide is
operator-facing prose.

## Shape

```json
{
  "id": "01JG...",
  "mailbox_id": "01JG...",
  "direction": "in" | "out",
  "status": "queued" | "sending" | "sent" | "bounced" | "received" | "failed",
  "from": "alerts@acme.com",
  "to": ["ops@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "...",
  "message_id": "<mid@host>",
  "thread_id": "01JG...",
  "in_reply_to": "<parent-mid@host>",
  "references": ["<...>"],
  "received_at": 1700000000000,
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
  "created_at": 1700000000000,
  "updated_at": 1700000000123
}
```

`direction` is the most important field: `in` rows come from inbound MIME
(Email Routing or IMAP via the mail bridge); `out` rows come from REST
submission (`POST /v1/messages` with `application/json` or `message/rfc822`).
The pipeline is the same for both; only `direction` differs.

## R2 access (B5) — public custom domain, content-addressed keys

The polaris-email R2 bucket is fronted by the public custom domain
`r2.mail.plrs.im`. Object keys are content-addressed:

- **Body** key — `mime/<aa>/<bb>/<sha256>` where `sha256` is the SHA-256 of
  the canonical RFC822 bytes (`<aa>`, `<bb>` are the first two byte-pair
  prefixes for filesystem-friendly bucketing). Body URL:
  `https://r2.mail.plrs.im/mime/<aa>/<bb>/<sha256>`.
- **Attachment** key — `att/<sha256>/<filename>` where `sha256` is the
  SHA-256 of the decoded attachment bytes. Attachment URL:
  `https://r2.mail.plrs.im/att/<sha256>/<filename>`.

Unguessability comes from the SHA-256 in the key — there is no signature,
no expiry, no HMAC header. **Treat the URL itself as a capability token**:
anyone with the URL can fetch the bytes forever. Audit-log readers
implicitly gain content read access; see `SECURITY.md` for the policy.

Identical attachments forwarded to multiple mailboxes share one R2 object.

Bodies and attachments below `INLINE_BODY_BYTES_MAX` / `INLINE_ATTACHMENTS_BYTES_MAX`
(default **64 KiB** and **256 KiB** respectively) are also embedded inline
on the response. Larger bodies / attachments are URL-only — the consumer
follows the `body_url` / `attachment.url` link to fetch the raw bytes from
`r2.mail.plrs.im` directly.

Tune via `wrangler secret`:

| Variable                       | Default           | Effect                                              |
| ------------------------------ | ----------------- | --------------------------------------------------- |
| `INLINE_BODY_BYTES_MAX`        | 65536             | Bodies above this are URL-only (no `text` / `html`) |
| `INLINE_ATTACHMENTS_BYTES_MAX` | 262144            | Attachments above this are URL-only (no inline b64) |
| `R2_PUBLIC_HOST`               | `r2.mail.plrs.im` | The R2 custom domain hostname for URL building      |

The `polaris-anchors` bucket stays **private** — audit anchors are not
served on a public custom domain.

## Retrieval endpoints

All retrieval endpoints require `messages:read` (or `admin:read` for
cross-mailbox queries) and are HMAC-signed as `polaris-api`.

| Endpoint                                         | Purpose                                                         |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `GET /v1/messages`                               | Filtered list (mailbox_id, direction, status, q, since, …).     |
| `GET /v1/messages/:id`                           | Single message with bodies + per-attachment public URLs.        |
| `POST /v1/messages/get`                          | Bulk fetch by id (up to 256 ids per call).                      |
| `GET /v1/mailboxes/:id/changes?since=<state>`    | Delta cursor for sync (returns ids changed since state).        |
| `GET /v1/mailboxes/:id/messages?fields=metadata` | Metadata-only listing — no inline bodies, URLs still populated. |

The previous `GET /v1/messages/:id/attachments/:n` signed-URL endpoint was
**deleted** in B5. Consumers fetch attachments straight from the public R2
custom domain using the `url` returned on each attachment.

## State mutation

State mutations are explicit; they never emit webhooks (the consumer is the
one driving them, so there is no event to fan out).

| Endpoint                         | Effect                                                   |
| -------------------------------- | -------------------------------------------------------- |
| `PATCH /v1/messages/:id`         | Update flags: `seen`, `flagged`, custom keywords.        |
| `DELETE /v1/messages/:id`        | Soft-delete (`expunged_at` set; row retained for audit). |
| `POST /v1/mailboxes/:id/expunge` | Hard-delete all soft-deleted rows for a mailbox.         |

Soft-delete decrements the `r2_refs` count on the message's body/attachment
objects; hard-expunge is what eventually frees R2 storage. The retention
janitor (`services/cron`) tidies up nightly.

## Webhook v2 envelope

Inbound mail and bounce/delivery events are delivered to subscribers as
**signed webhooks**. The v2 envelope (mandatory; no v1 fallback) is:

```json
{
  "event_id": "01JG...",
  "event": "message.received",
  "occurred_at": 1700000000000,
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
X-Polaris-Ts: 1700000000000
X-Polaris-Nonce: ...
X-Polaris-Sig: <lowercase-hex(HMAC-SHA256(secret, canonical))>
```

The signature header carries the raw lowercase-hex MAC — no `v1=` /
`v2=` prefix (HMAC is un-versioned per phase B3). The canonical-string
format and `polaris-webhook` domain tag are the same as for API
requests; only the envelope shape (full `Message` inlined, no follow-up
GET) differs. See [`docs/hmac-reference.md`](hmac-reference.md) for the
signing spec.

Events emitted:

- `message.received` — inbound mail accepted and persisted.
- `message.sent` — outbound message handed off successfully to the
  Cloudflare Email Service binding.
- `message.delivered` — terminal success state, set once the last
  subscribed webhook has confirmed delivery (`services/fanout` is the
  only emitter; `services/out` never sets this directly).
- `message.bounced` — permanent remote-side delivery failure (mailbox
  rejected the message).
- `message.failed` — permanent local-side failure (binding misconfigured,
  R2 body missing, DKIM unavailable, retries exhausted).

State mutations (`PATCH` / `DELETE` / `expunge`) intentionally emit no
webhook.

## Canonical reference

The wire format and validation rules are normative in
[`openapi/polaris-email.yaml`](../openapi/polaris-email.yaml). When this
document and the OpenAPI spec disagree, the spec wins.
