# Error catalog

Every non-2xx response uses this envelope:

```json
{ "error": { "code": "scope_violation", "message": "...", "retryable": false, "request_id": "req_..." } }
```

`X-Request-Id` is also set as a response header for correlation.

| HTTP | code | retryable | notes |
|------|------|-----------|-------|
| 400 | `bad_request` | no | malformed body, missing required field |
| 401 | `bad_signature` | **no** | HMAC mismatch — do not retry |
| 401 | `key_propagating` | yes (after `Retry-After`) | new key not yet in colo cache; retry once after ~2 s |
| 401 | `clock_skew` | yes (after resync) | `X-Polaris-Ts` outside ±5 min |
| 401 | `unauthorized` | no | missing key id / session |
| 403 | `key_revoked` | no | terminal — call ops |
| 403 | `scope_violation` | no | `from` outside `sender_scopes`, or scope action denied |
| 403 | `forbidden` | no | generic deny |
| 404 | `not_found` | no | |
| 409 | `nonce_replay` | no | duplicate `X-Polaris-Nonce` — generate a fresh one |
| 409 | `idempotency_conflict` | no | same `Idempotency-Key`, different body |
| 409 | `conflict` | no | resource state conflict |
| 422 | `domain_not_verified` | no | sending domain not yet DNS-verified |
| 422 | `recipient_rejected` | no | client-side recipient validation failed |
| 429 | `rate_limited` | yes (after `Retry-After`) | |
| 502 | `cf_upstream` | yes | CF Email Service transient — safe to retry with same `Idempotency-Key` |
| 503 | `degraded` | yes | local circuit-breaker open |

## Retry policy

Retry **only** when `retryable: true`. Honor `Retry-After` if present (seconds). With an `Idempotency-Key` header, 5xx and `cf_upstream` are safe to retry; same key + same body always returns the original `messageId`. Different body + same key → `409 idempotency_conflict`.

## Outbound webhook events

`message.sent` / `message.delivered` / `message.bounced` / `message.failed` / `message.received` / `credential.rotated` / `credential.revoked`. Subscribed events live in `webhook_subs.events`.

`message.failed` distinguishes from `message.bounced`: bounced = remote-side permanent failure (mailbox doesn't exist); failed = our-side permanent failure (binding misconfigured, DKIM missing).
