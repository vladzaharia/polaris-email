---
title: Error catalog
description: The polaris-email error envelope, the full code list with HTTP status + retryability, and the rules for retrying with idempotency keys.
sidebar_label: Errors
sidebar_position: 4
---

# Error catalog

Every non-2xx response uses this envelope:

```json
{
  "error": {
    "code": "scope_violation",
    "message": "...",
    "retryable": false,
    "request_id": "req_..."
  }
}
```

`X-Request-Id` is also set as a response header for correlation. The
canonical enum is `ErrorCode` in `packages/schema/src/index.ts`; the
HTTP-status and retryability mappings live in `services/api/src/errors.ts`.

## Code matrix

| HTTP | code                       | retryable                 | notes                                                                   |
| ---- | -------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| 400  | `bad_request`              | no                        | Malformed body, missing required field.                                 |
| 400  | `bad_content_type`         | no                        | Unsupported `Content-Type` (expects JSON or `message/rfc822`).          |
| 400  | `too_many_recipients`      | no                        | Recipient count exceeds CF Email Service limit.                         |
| 400  | `subject_too_long`         | no                        | Subject above CF Email Service cap.                                     |
| 400  | `header_not_allowed`       | no                        | Header in the forbidden list (`Bcc`, `DKIM-Signature`, …).              |
| 400  | `header_too_long`          | no                        | Single header value above CF Email Service cap.                         |
| 400  | `too_many_custom_headers`  | no                        | Custom-header count exceeds CF Email Service cap.                       |
| 400  | `custom_headers_too_large` | no                        | Custom headers combined byte size exceeds CF Email Service cap.         |
| 401  | `bad_signature`            | no                        | HMAC mismatch — do not retry.                                           |
| 401  | `key_propagating`          | yes (after `Retry-After`) | New key not yet in colo cache; retry once after ~2 s.                   |
| 401  | `clock_skew`               | yes (after resync)        | `X-Polaris-Ts` outside ±5 min.                                          |
| 401  | `unauthorized`             | no                        | Missing key id or session.                                              |
| 403  | `key_revoked`              | no                        | Terminal — call ops.                                                    |
| 403  | `scope_violation`          | no                        | `from` outside `sender_scopes`, or scope action denied.                 |
| 403  | `forbidden`                | no                        | Generic deny.                                                           |
| 404  | `not_found`                | no                        |                                                                         |
| 409  | `nonce_replay`             | no                        | Duplicate `X-Polaris-Nonce` — generate a fresh one.                     |
| 409  | `idempotency_conflict`     | no                        | Same `Idempotency-Key`, different body.                                 |
| 409  | `conflict`                 | no                        | Resource state conflict.                                                |
| 413  | `message_too_large`        | no                        | Total message bytes exceed CF Email Service cap.                        |
| 422  | `domain_not_verified`      | no                        | Sending domain not yet DNS-verified.                                    |
| 422  | `recipient_rejected`       | no                        | Client-side recipient validation failed.                                |
| 429  | `rate_limited`             | yes (after `Retry-After`) |                                                                         |
| 429  | `too_many_requests`        | yes (after `Retry-After`) | Per-principal / per-mailbox quota exceeded; honor `Retry-After`.        |
| 502  | `cf_upstream`              | yes                       | CF Email Service transient — safe to retry with same `Idempotency-Key`. |
| 503  | `degraded`                 | yes                       | Local circuit-breaker open.                                             |

## Retry policy

Retry **only** when `retryable: true`. Honor `Retry-After` (seconds) if
present. With an `Idempotency-Key` header, 5xx and `cf_upstream` are
safe to retry; same key + same body always returns the original
`messageId`. Different body + same key → `409 idempotency_conflict`.

Never retry `bad_signature`, `scope_violation`, `key_revoked`,
`nonce_replay`, `idempotency_conflict`, `domain_not_verified`,
`recipient_rejected`, or any of the CF Email Service compliance codes
(`too_many_recipients`, `subject_too_long`, `message_too_large`,
`header_not_allowed`, `header_too_long`, `too_many_custom_headers`,
`custom_headers_too_large`).

## Outbound webhook events

`message.received`, `message.sent`, `message.delivered`,
`message.bounced`, `message.failed`. Subscribed events live in
`webhook_subs.events`. (`credential.rotated` and `credential.revoked`
are audit-log actions, not webhook events.)

`message.failed` distinguishes from `message.bounced`:

- `message.bounced` — remote-side permanent failure (mailbox doesn't exist).
- `message.failed` — our-side permanent failure (binding misconfigured,
  DKIM missing, retries exhausted).

See the [unified Message model](/developers/messages/unified-model) for
the webhook envelope shape and the rest of the status enum.

<!-- Verified against: packages/schema/src/index.ts, services/api/src/errors.ts, docs/errors.md @ 60cc6d59541b3279a65c755222fd9290ce76fc5e -->
