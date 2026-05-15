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
  "body": {
    "text": "inline plaintext (only when small)",
    "html": "<p>inline html (only when small)</p>",
    "text_url": "https://.../signed",
    "html_url": "https://.../signed"
  },
  "attachments": [
    {
      "n": 0,
      "filename": "report.pdf",
      "content_type": "application/pdf",
      "size": 184320,
      "url": "https://.../signed"
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

## Inline-small / signed-URL-large bodies

Bodies and attachments below `MESSAGE_BODY_INLINE_MAX` (default **64 KiB**)
are returned inline in `body.text` / `body.html`. Anything above that
threshold is uploaded to R2 under a content-addressed key and surfaced as a
signed URL (`body.text_url`, `body.html_url`, `attachments[].url`). The URLs
are short-lived (default **10 min**, set via `SIGNED_URL_TTL_SECONDS`).

R2 keys are SHA-256 of the bytes, so identical attachments forwarded to
multiple mailboxes share one object. `r2_refs` tracks the reference count;
the retention janitor deletes the underlying object only after the last
referencing message expunges.

Tune via `wrangler secret`:

| Variable                  | Default  | Effect                                    |
| ------------------------- | -------- | ----------------------------------------- |
| `MESSAGE_BODY_INLINE_MAX` | 65536    | Bytes above this go to R2 + signed URL    |
| `SIGNED_URL_TTL_SECONDS`  | 600      | Lifetime of attachment + body signed URLs |
| `MESSAGE_MAX_TOTAL_BYTES` | 26214400 | Hard reject threshold for whole message   |

## Retrieval endpoints

All retrieval endpoints require `messages:read` (or `admin:read` for
cross-mailbox queries) and are HMAC-signed as `polaris-api.v1`.

| Endpoint                                         | Purpose                                                     |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `GET /v1/messages`                               | Filtered list (mailbox_id, direction, status, q, since, …). |
| `GET /v1/messages/:id`                           | Single message with bodies + signed attachment URLs.        |
| `POST /v1/messages/get`                          | Bulk fetch by id (up to 256 ids per call).                  |
| `GET /v1/mailboxes/:id/changes?since=<state>`    | Delta cursor for sync (returns ids changed since state).    |
| `GET /v1/mailboxes/:id/messages?fields=metadata` | Metadata-only listing — no bodies, no signed URLs.          |
| `GET /v1/messages/:id/attachments/:n`            | Direct attachment fetch; the URL is itself signed.          |

The attachment endpoint is the one exception that does **not** require HMAC
headers — the URL embeds its own signature so it can be handed to browsers,
mail clients, or curl directly.

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
X-Polaris-Sig: v2=<lowercase-hex(HMAC-SHA256(secret, canonical))>
```

The signature header tag is `v2=`. The HMAC canonical-string format and
domain tag (`polaris-webhook.v1`) are unchanged from the previous
implementation; the bump to `v2=` signals the envelope shape change (the
full message is inlined; consumers no longer need a follow-up GET). See
[`docs/hmac-reference.md`](hmac-reference.md) for the signing spec.

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
