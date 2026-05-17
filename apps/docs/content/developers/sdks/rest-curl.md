---
title: REST + curl
description: HMAC signing and webhook verification from any language using curl + openssl — the wire-level fallback when no first-party SDK is available.
sidebar_label: REST + curl
sidebar_position: 3
---

# REST + curl

The first-party SDKs cover [Node](/developers/sdks/node) and
[Go](/developers/sdks/go). For any other language, sign requests
yourself against the canonical HMAC scheme. This page collects the
wire-level snippets you need.

The signing scheme is **identical** for outbound API calls and inbound
webhooks. What differs is the domain tag in the canonical string
(`polaris-api` vs `polaris-webhook`). The signature header is the
un-versioned `X-Polaris-Sig: <hex>` — 64 lowercase hex chars, no prefix.

## Canonical string

```
<domain>\n<METHOD>\n<path>\n<canonical-query>\n<ts>\n<nonce>\n<sha256-hex-of-body>
```

| Field                | Notes                                                           |
| -------------------- | --------------------------------------------------------------- |
| `domain`             | `polaris-api` for API requests, `polaris-webhook` for webhooks. |
| `METHOD`             | Uppercase HTTP method.                                          |
| `path`               | Request path, no query string.                                  |
| `canonical-query`    | Empty string if no query; otherwise the verbatim query string.  |
| `ts`                 | Milliseconds since epoch, ASCII decimal.                        |
| `nonce`              | Base64url, at least 96 bits of entropy. One-shot.               |
| `sha256-hex-of-body` | SHA-256 of the exact body bytes on the wire, lowercase hex.     |

HMAC is SHA-256, 256-bit keys, constant-time compare. The full spec is in
[HMAC reference](/security/hmac-reference); the narrative is at
[HMAC concept](/developers/authentication/concept).

## Sign and POST `/v1/messages` (curl)

```sh
TS=$(date +%s)000
NONCE=$(openssl rand -hex 12)
BODY='{"from":"noreply@example.com","to":["user@external.com"],"subject":"Hello","text":"Hi","category":"svc.test"}'
BH=$(printf "%s" "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANON="polaris-api\nPOST\n/v1/messages\n\n$TS\n$NONCE\n$BH"
SIG=$(printf "%b" "$CANON" | openssl dgst -sha256 -hmac "$POLARIS_EMAIL_KEY_SECRET" -hex | awk '{print $2}')
curl -sS -X POST "$POLARIS_EMAIL_URL/v1/messages" \
  -H "content-type: application/json" \
  -H "x-polaris-key-id: $POLARIS_EMAIL_KEY_ID" \
  -H "x-polaris-ts: $TS" \
  -H "x-polaris-nonce: $NONCE" \
  -H "x-polaris-sig: $SIG" \
  -d "$BODY"
```

The endpoint also accepts `Content-Type: message/rfc822` with raw RFC 5322
bytes. The body hash is over the exact wire bytes either way. See
[Quickstart → curl (raw RFC822)](/developers/quickstart).

## Idempotency

Add an `Idempotency-Key` header. Same key + same body returns the original
`messageId` with `X-Polaris-Idempotent: replay`. Same key + different
body → `409 idempotency_conflict`. 24h TTL.

Valid keys match `^[A-Za-z0-9_-]{8,128}$`.

```sh
curl ... -H "idempotency-key: order-12345-confirm" ...
```

## Verify a webhook (curl + openssl)

Webhook deliveries arrive as `POST` requests with `X-Polaris-Sig`,
`X-Polaris-Ts`, and `X-Polaris-Nonce` headers. Reconstruct the canonical
string with the `polaris-webhook` domain tag and constant-time-compare the
HMAC.

```sh
# Inputs you receive
TS="$X_POLARIS_TS"
NONCE="$X_POLARIS_NONCE"
SIG="$X_POLARIS_SIG"
BODY=$(cat raw-body.json)        # exact bytes received
SECRET="$POLARIS_WEBHOOK_SECRET" # per-subscription secret

# Recompute
BH=$(printf "%s" "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANON="polaris-webhook\nPOST\n/your/webhook/path\n\n$TS\n$NONCE\n$BH"
EXPECTED=$(printf "%b" "$CANON" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

# Compare (use a constant-time compare in real code; shell `=` is not)
if [ "$SIG" = "$EXPECTED" ]; then
  echo ok
else
  echo "bad signature" >&2
  exit 1
fi
```

**Production code must use a constant-time compare.** Most languages ship
one (`hmac.compare_digest`, `crypto.timingSafeEqual`, `subtle.ConstantTimeCompare`).
Falling back to `=` leaks the signature one byte at a time via timing.

Reject before comparing if the timestamp is more than 5 minutes off the
current wall clock, or if the nonce has been seen recently (replay
window).

## Webhook envelope

The webhook body is the v2 envelope:

```json
{
  "event_id": "01HXR...",
  "event": "message.sent",
  "occurred_at": 1700000000000,
  "message": {
    "id": "01HXR...",
    "subject": "...",
    "from": "...",
    "to": ["..."]
  }
}
```

The full `Message` is inlined; no follow-up `GET /v1/messages/:id` is
required. See the [unified Message model](/developers/messages/unified-model)
for the full shape.

## Retry semantics

| Status                | Retry?                   |
| --------------------- | ------------------------ |
| `401 bad_signature`   | no — terminal            |
| `401 key_propagating` | yes, after `Retry-After` |
| `429 rate_limited`    | yes, after `Retry-After` |
| `5xx`                 | yes, exponential backoff |
| All other `4xx`       | no — fix the request     |

The retry contract is in the
[consumer contract](/reference/consumer-contract).

<!-- Verified against: docs/quickstart/README.md, docs/sdk.md, docs/hmac-reference.md @ 60cc6d59541b3279a65c755222fd9290ce76fc5e -->
