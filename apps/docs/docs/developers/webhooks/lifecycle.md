---
title: Subscription lifecycle
description: Create, scope, verify, retry, dedupe, rotate, and disable webhook subscriptions — the full lifecycle of a polaris-email webhook from `POST /v1/admin/webhook-subs` to DLQ.
sidebar_label: Subscription lifecycle
sidebar_position: 2
---

# Webhook subscription lifecycle

A webhook subscription is one row in `webhook_subs` plus the
per-subscription signing secret. This page walks the full lifecycle:
create → scope → verify → retry → dedupe → rotate → disable. If you
need to pick a delivery pattern first, start at the
[decision tree](/developers/webhooks/decision-tree).

## Create

Two ways in:

**REST** — `POST /v1/admin/webhook-subs` (admin HMAC, scope
`admin:rotate`). Body:

```json
{
  "mailbox_id": "01J...",
  "url": "https://hooks.your-service.com/email",
  "kind": "external",
  "events": ["message.received"]
}
```

Response:

```json
{ "id": "01J...", "secret": "<64-hex-char signing key>" }
```

The `secret` is shown **exactly once** — copy it into your consumer's
secret store before dismissing the response. Lose it and you must
rotate (see below) to get a new one.

**Panel** — Settings → Webhooks → Add. The panel surfaces the same
`SecretRevealDialog` you get for mailbox passwords; the secret is read
back from the API response, never re-fetched.

The `kind` field gates the URL allowlist:

- `external` → must be `https://` and reach the public internet.
- `tailnet` → must be a `*.ts.net` MagicDNS hostname.
- `bridge` is **not** a `webhook_subs.kind`; bridge-proxied delivery is
  configured via a separate `local_webhook_targets` row mapped onto an
  `external` URL pointing at the bridge's `:8080/hooks/...` path. See
  the [decision tree](/developers/webhooks/decision-tree).

## Scope

Each row is scoped to one `mailbox_id`. The fanout consumer resolves
matching subscriptions per event:

- **Outbound events** (`message.sent`, `message.delivered`,
  `message.bounced`, `message.failed`) → every active subscription for
  the message's `mailbox_id` whose `events` array includes the event.
- **Inbound events** (`message.received`) → the consumer fires against
  the specific `webhook_sub_id` resolved by the inbound routing rule;
  it does not fan out to every mailbox subscription. This is how
  per-receiver routing (e.g. `support@` → one URL, `billing@` →
  another) stays scoped.

There is no domain-level filter and no event-type wildcard. List every
event you want delivered explicitly in `events`.

## Envelope (v2)

The body is the v2 envelope with the full `Message` inlined — no
follow-up `GET /v1/messages/:id` is required to read content:

```json
{
  "event_id": "01J...",
  "event": "message.received",
  "occurred_at": "2026-05-16T12:00:00.000Z",
  "message": {
    /* full Message — see /developers/messages/unified-model */
  }
}
```

Bodies and attachments include `body_url` + per-attachment `url`
pointing at the public R2 custom domain `r2.mail.plrs.im`. Subscribers
fetch bytes directly — no HMAC header is required for those URLs. The
SHA-256 in the key is the unguessability boundary; see the
[threat model](/security/threat-model) for the privacy implications.

## Verify

The fanout consumer signs every delivery before POST. Headers:

| Header                  | Value                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `X-Polaris-Sig`         | Lowercase hex HMAC-SHA-256. **Un-versioned** — no `v2=` prefix.                                      |
| `X-Polaris-Ts`          | Unix epoch milliseconds (string).                                                                    |
| `X-Polaris-Nonce`       | Per-delivery random nonce.                                                                           |
| `X-Polaris-Event-Id`    | Stable across retries of the same event.                                                             |
| `X-Polaris-Event`       | One of `message.received`, `message.sent`, `message.delivered`, `message.bounced`, `message.failed`. |
| `X-Polaris-Delivery-Id` | Per-attempt ULID. Different on every retry, even for the same `event_id`.                            |

Canonical-string and HMAC domain tag (`polaris-webhook`) are the same
shape the API uses for request signing — see the
[HMAC concept](/developers/authentication/concept) for the narrative and
the [HMAC reference](/security/hmac-reference) for the byte-exact spec.

Use the published SDKs to verify rather than rolling your own:

- Node — `verifyWebhook` from `@polaris/sdk/webhook`.
- Go — `polarissdkgo.VerifyWebhook`
  (`github.com/vladzaharia/polaris-email/packages/sdk-go`).

Both verifiers do constant-time compare and accept either `secret` or
`secret_prev` so deliveries continue working during a rotation.

## Retry

Return `2xx` within 10 s. Anything else — including `3xx`, network
error, body over 1 MiB, or timeout — counts as a delivery failure.

Retry policy (per-subscription, per-event):

- Up to **6 attempts** total (initial + 5 retries).
- Exponential backoff: `60 s × 2^attempts`, capped at **60 min**.
- On attempt 7, the delivery is moved to `webhook_dlq` and the row is
  marked `status='dlq'`. Operator workflow for replay lives under the
  [webhook DLQ runbook](/operators/runbooks/webhook-dlq).

A failing delivery does **not** affect other subscriptions for the
same message. Each `(message_id, webhook_sub_id)` pair has its own
`message_deliveries` row with its own attempt counter.

## Dedupe

You must dedupe by `X-Polaris-Event-Id` for **24 h**.

`event_id` is stable across retries. `delivery_id` is per-attempt — do
not key your dedupe table on `delivery_id` or you will process the
same event multiple times.

A sample dedupe table (one row per event, 24 h TTL) keyed on
`X-Polaris-Event-Id` is sufficient. Without it, a slow consumer that
returns `2xx` after the 10 s ack window will receive the same payload
again on the next retry — and your consumer must be idempotent or
discard the duplicate.

## Rotate the secret

`POST /v1/admin/webhook-subs/:id/rotate-secret` mints a new 64-hex
secret. The previous secret moves to `secret_prev` and verifiers
continue to accept it during the grace window. A subsequent rotation
overwrites `secret_prev`, so the grace window is exactly one rotation
cycle — there is no permanent multi-secret state.

Rotation propagation is bounded by the worker's KV cache for the
revocation check (≤60 s end to end) plus however long your consumer
takes to load the new secret. A typical safe rotation:

1. Call rotate. Note both the new `secret` and the timestamp.
2. Deploy the new secret to your consumer alongside the old one.
3. Once you have seen at least one successful delivery on the new
   secret, drop the old secret from your verifier.
4. Subsequent rotations overwrite `secret_prev`; do not skip step 2.

The rotation is audited with `action=webhook_sub.rotate`.

## List, inspect, disable

| Operation | Endpoint                                  | Scope          |
| --------- | ----------------------------------------- | -------------- |
| List      | `GET /v1/admin/webhook-subs?mailbox_id=…` | `admin:read`   |
| Detail    | `GET /v1/admin/webhook-subs/:id`          | `admin:read`   |
| Patch     | `PATCH /v1/admin/webhook-subs/:id`        | `admin:rotate` |
| Pause     | `PATCH … { "paused": true }`              | `admin:rotate` |
| Disable   | `DELETE /v1/admin/webhook-subs/:id`       | `admin:rotate` |
| Test      | `POST /v1/admin/webhook-subs/:id/test`    | `admin:rotate` |

`PATCH` re-runs the same SSRF allowlist that `POST` applied at create
time — a row created with a benign URL cannot be flipped to a non-`.ts.net`
target via `PATCH` to bypass the create-time gate. `PATCH` accepts
`url`, `events`, and `paused`.

`DELETE` is soft-delete: it stamps `disabled_at` and the fanout
consumer immediately stops resolving the row. Existing rows in
`message_deliveries` for the subscription keep their terminal state; no
re-delivery is attempted.

Pause is the reversible variant — set `paused_at`, the consumer
short-circuits, but rows remain visible in the list and you can
un-pause with `{ "paused": false }`. Use pause when you are doing a
consumer-side migration; use disable when you are decommissioning the
URL.

## What this page deliberately does not cover

- **Replay strategies** (e.g. driving the DLQ back through a different
  URL after a consumer outage). Replay is the operator side of this
  contract and lives in the [webhook DLQ runbook](/operators/runbooks/webhook-dlq).
- **HMAC canonical-string spec.** The byte-exact canonical-string +
  domain-tag rules live in the [HMAC reference](/security/hmac-reference).
  The webhooks endpoint reuses that spec verbatim with
  `direction = polaris-webhook`.

<!-- Verified against: services/api/src/routes/admin/webhook-subs.ts, services/api/src/queue/fanout.ts, services/api/src/routes/admin.ts (POST /v1/admin/webhook-subs), packages/schema/src/index.ts (CreateWebhookSubRequest, WebhookEventType), docs/architecture.md (v2 envelope) @ eeee222cdf8359f8f2bf1013a103abdb3c705f06 -->
