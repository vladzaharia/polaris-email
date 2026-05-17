---
title: HMAC concept
description: How polaris-email authenticates API requests and outgoing webhooks — what the signature covers, the four request headers, the ±5-minute skew window, and why an idempotency key is a separate thing from the nonce.
sidebar_label: HMAC concept
sidebar_position: 1
---

# HMAC, the developer view

polaris-email signs every authenticated request. The signing scheme is
also what receivers use to verify outgoing webhooks. This page explains
**why** the scheme is shaped the way it is and **what** each header
does. If you are implementing a verifier from scratch, you also want
the [HMAC reference](/security/hmac-reference) for the byte-exact
canonical-string layout.

## Why signatures, not bearer tokens

A bearer token is a static string — present it and you authenticate.
That's fine for short-lived API tokens behind TLS, but it has two
properties polaris-email needs to avoid:

- **Replay**. A captured request can be re-sent indefinitely until the
  bearer is rotated.
- **No request binding**. A bearer authenticates *the caller*, not *this
  particular request*. A leak of the token over a proxy log gives the
  attacker arbitrary requests, not just the one that leaked.

HMAC signatures bind the signature to the exact request: method, path,
query, timestamp, nonce, and the SHA-256 of the body. Change any byte
and the signature is wrong. Wait too long to replay and the timestamp
check refuses you. Re-use the same nonce in the skew window and the
replay defence refuses you.

## What gets signed

Seven things are joined into a canonical string, then HMAC-SHA256'd with
your secret:

| Line | Field            | Why                                                                                                                                     |
| ---- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | direction        | Domain separation — `polaris-api` for requests, `polaris-webhook` for outgoing webhooks. Prevents cross-direction signature reuse.      |
| 2    | METHOD           | Uppercased HTTP method.                                                                                                                 |
| 3    | path             | URL path with leading `/`. No host, no scheme, no fragment.                                                                             |
| 4    | canonical-query  | Sorted, percent-encoded query string. Empty string when there is none.                                                                  |
| 5    | X-Polaris-Ts     | Millisecond Unix timestamp.                                                                                                             |
| 6    | X-Polaris-Nonce  | 16–128 ASCII chars unique within the skew window.                                                                                       |
| 7    | sha256(body)     | Lowercase hex over the **exact raw body bytes** on the wire. No whitespace normalisation. Empty body hashes the empty string.           |

Joined by single `\n` bytes. No trailing newline. No `\r`. The full
byte-exact layout is in the [reference](/security/hmac-reference).

## The four request headers

| Header             | Purpose                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `X-Polaris-Key-Id` | Identifies which key signed this request. Opaque — usually a ULID.                                               |
| `X-Polaris-Ts`     | Milliseconds since the Unix epoch, base-10 integer string.                                                       |
| `X-Polaris-Nonce`  | 16–128 ASCII chars. Must be unique per request within the ±5-minute skew window.                                 |
| `X-Polaris-Sig`    | 64 lowercase hex chars. `HMAC-SHA256(secret, canonical)` encoded as hex.                                         |

The signature header is the **bare** hex tag. No `v1=` prefix, no
algorithm prefix, no `:` separator. Verifiers reject anything matching
`v1=…` / `v2=…` / `sha256=…` outright.

## Clock skew window

Verifiers reject requests where `abs(now_ms - ts_ms) > 300_000` — five
minutes either way. If your client's clock is wrong by more than five
minutes, you will see `clock_skew` errors and need to fix NTP before
debugging signatures.

For tests, verifiers accept an injected `now_ms` so a fixture timestamp
of `1700000000000` can be replayed deterministically.

## Idempotency key — a separate thing

`X-Idempotency-Key` is not part of the signature. It is a separate
header that asks polaris-email to **dedupe** a request if you retry it.
Two different concerns:

- The **nonce** stops an attacker from replaying *your* request. It is
  inside the signature. The server stores it briefly to detect a replay.
- The **idempotency key** lets *you* retry a request safely after a
  transient error. It is outside the signature; the server caches the
  response keyed on `(key_id, idempotency_key)` for 24 hours and returns
  the cached response on a retry.

Pick a fresh nonce on every retry; reuse the same idempotency key.
Conflating the two is a common bug — they look similar but solve
opposite problems.

## Worked example

You are signing this request:

```
POST /v1/send/raw?mode=test HTTP/1.1
Host: api.mail.plrs.im
X-Polaris-Key-Id: ULID-OF-YOUR-KEY
X-Polaris-Ts:    1700000000000
X-Polaris-Nonce: AAAABBBBCCCCDDDD
Content-Type:    application/json

{"from":"a@b.com","to":["c@d.com"],"subject":"hi","category":"svc.test"}
```

With secret `XBNRJYZ8WS5KQDVPM7T4F2H6CG3A1E9N`, the canonical string is
(literal bytes; `\n` is a single byte `0x0a`):

```text
polaris-api
POST
/v1/send/raw
mode=test
1700000000000
AAAABBBBCCCCDDDD
4f5be64fbe43e9989dfd64b3a3b91c1f59d2d4d52d676d96fab2cf3d3b8b3a32
```

The last line is the SHA-256 hex of the body bytes. HMAC-SHA256 of that
string under the secret gives:

```text
X-Polaris-Sig: 3dc5920cc9bd7db06e6001fd75bb3225802c01381e3b079fec05a6e70dae0c27
```

Send the four `X-Polaris-*` headers and you authenticate. Change any
byte of the body, the path, or the query and the signature is wrong.

This is vector `api/POST/messages/happy` from the canonical test fixture
set; see [HMAC reference](/security/hmac-reference#test-vectors) for
where to find it.

## Outgoing webhooks reuse the same scheme

The webhook direction uses the same canonical-string shape and the same
header set. The only differences:

- `direction` is `polaris-webhook` instead of `polaris-api`.
- The body is the v2 event envelope (`event_id`, `event`, `occurred_at`,
  inlined `message`).
- An extra `X-Polaris-Event-Id` header is included so receivers can
  dedupe by event ID for 24 hours.

If you implement a webhook receiver, verify with `direction = "polaris-webhook"`
and dedupe by `X-Polaris-Event-Id`. The [unified Message
model](/developers/messages/unified-model) page has the envelope shape;
the [HMAC reference](/security/hmac-reference) has the formal spec.

## What verifiers must do

Any verifier you write (or one polaris-email ships) must:

1. Reject any of the four headers containing whitespace, CR, LF, NUL, or
   any byte above `0x7e` — **before** running HMAC.
2. Reject any signature header that doesn't match `^[0-9a-f]+$`.
3. Reject `abs(now_ms - ts_ms) > 300_000`.
4. Reject nonces outside the 16–128 length window.
5. Compare signatures with a **constant-time** byte comparison
   (`crypto.timingSafeEqual`, `hmac.compare_digest`, `subtle.ConstantTimeCompare`).
6. Pass every entry in `packages/test-vectors/vectors.json`.

The first-party verifiers — `packages/hmac`, `packages/sdk-node`,
`packages/sdk-go`, `polaris-email auth verify` — all do this. If you
are writing a verifier in another language, the test-vector file is
the source of truth.

## See also

- [HMAC reference](/security/hmac-reference) — the formal canonical-string
  spec, byte-by-byte.
- [Unified Message model](/developers/messages/unified-model) — what
  the body shape of an outgoing webhook looks like.
- [Errors](/reference/errors) — what each HMAC failure code means on the
  wire.

<!-- Verified against: docs/hmac-reference.md, packages/hmac/src/index.ts, packages/test-vectors/vectors.json, services/api/src/auth.ts, services/api/src/queue/fanout.ts @ eeee222cdf8359f8f2bf1013a103abdb3c705f06 -->
