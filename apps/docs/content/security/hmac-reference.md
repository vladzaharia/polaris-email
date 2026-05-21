---
title: HMAC reference
description: The formal canonical-string layout, bare-hex header, domain tags, test-vector location, and the security guarantees plus caveats of the polaris-mail HMAC scheme. Audience — security reviewers and integrators implementing a verifier from scratch.
sidebar_label: HMAC reference
sidebar_position: 3
---

# polaris-mail HMAC reference

This is the formal spec. If you want narrative ("why HMAC, why a
nonce") read the [developer concept](/developers/authentication/concept)
first. This page is byte-exact.

polaris-mail HMAC signatures are **un-versioned**. There is one
canonical-string format, two domain-separation tags, and one signature
header. The historical `v1=` / `v2=` envelope tags and `.v1` suffixes
were removed. This page is the source of truth.

The machine-readable source of truth is
[`packages/test-vectors/vectors.json`](https://github.com/vladzaharia/polaris-email/blob/main/packages/test-vectors/vectors.json).
Every first-party verifier MUST pass every vector.

## Canonical signing string

Seven lines joined by single `\n` bytes (`0x0a`). No trailing newline.
No `\r`:

```text
<direction>\n
<METHOD>\n
<path>\n
<canonical-query>\n
<X-Polaris-Ts>\n
<X-Polaris-Nonce>\n
<lowercase-hex(SHA-256(raw-body-bytes))>
```

| Field             | Specification                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direction`       | `polaris-api` (HTTP requests to the REST surface) **or** `polaris-webhook` (outgoing webhook deliveries). Domain separation. No `.v1` suffix.                       |
| `METHOD`          | Uppercased HTTP method: `POST`, `GET`, `PATCH`, `DELETE`, …. Must match `^[A-Z]+$`.                                                                                 |
| `path`            | URL path with leading `/`. No fragment, no scheme, no host.                                                                                                         |
| `canonical-query` | RFC3986 percent-encoded query string, sorted first by lowercased key then by raw value. Empty string when there is no query. No leading `?`.                        |
| `X-Polaris-Ts`    | Millisecond Unix timestamp as a base-10 integer string. No leading zeros.                                                                                           |
| `X-Polaris-Nonce` | 16–128 ASCII chars. No whitespace, CR, LF, tab, NUL, or non-ASCII.                                                                                                  |
| Body hash         | `lowercase-hex(SHA-256(body))` over the **exact raw bytes** sent on the wire. No canonicalisation, no whitespace normalisation. Empty body hashes the empty string. |

### Canonical-query encoding

The canonical query is built as follows:

1. Split the raw query string into `(key, value)` pairs.
2. Sort pairs first by lowercased key, then by raw value.
3. Percent-encode each key (lowercased) and each value per RFC3986,
   then escape `!'()*` as `%21 %27 %28 %29 %2A` (these are reserved
   under RFC3986 but allowed by `encodeURIComponent`).
4. Join as `k=v` pairs with `&`.

An empty query is the empty string. Repeated keys are preserved (after
sort).

## Signature header

```text
X-Polaris-Sig: <lowercase-hex(HMAC-SHA256(secret, canonical))>
```

The hex string is exactly 64 characters (SHA-256 → 32 bytes → 64 hex
chars). The header value matches `^[0-9a-f]{64}$`. Verifiers MUST
reject anything else.

No `v1=` / `v2=` / algorithm prefix. The bare-hex shape is enforced by
the regex `^[0-9a-f]+$` in `packages/hmac/src/index.ts`; any value
containing `=`, `:`, or uppercase hex is refused with
`invalid_signature`.

## Domain tags

| Tag               | Used for                                                    | Signer location                           |
| ----------------- | ----------------------------------------------------------- | ----------------------------------------- |
| `polaris-api`     | HTTP requests from a caller to the polaris-mail REST API    | Caller's SDK or hand-rolled signing code  |
| `polaris-webhook` | Outgoing webhook deliveries from polaris-mail to a consumer | `services/api/src/queue/fanout.ts` (only) |

Domain separation prevents an attacker from re-using an API-direction
signature as a webhook-direction signature. The two tags are the only
allowed values.

## Required request headers

| Header             | Format                                                         | Validation                               |
| ------------------ | -------------------------------------------------------------- | ---------------------------------------- |
| `X-Polaris-Key-Id` | Opaque key identifier (e.g. ULID).                             | Resolves to a secret in the key cache.   |
| `X-Polaris-Ts`     | Milliseconds since Unix epoch, base-10 integer.                | `^[0-9]+$`; clock-skew check below.      |
| `X-Polaris-Nonce`  | 16–128 ASCII chars, unique per request within the skew window. | Length window + ASCII check.             |
| `X-Polaris-Sig`    | 64 lowercase hex chars.                                        | `^[0-9a-f]{64}$`; constant-time compare. |

Reject any of the four if they contain space, tab, CR, LF, NUL, or any
byte above `0x7e` — **before** running HMAC verification. This guards
against header smuggling and downstream parser confusion.

## Clock skew tolerance

Verifiers MUST reject requests where:

```text
abs(now_ms - ts_ms) > 300_000   // ±5 minutes
```

For test fixtures, verifiers accept an injected `now_ms` so a vector's
recorded `ts` can be replayed deterministically.

## Constant-time comparison

Verifiers MUST compare signatures with a constant-time byte comparison:

| Language | Primitive                                           |
| -------- | --------------------------------------------------- |
| Node     | `crypto.timingSafeEqual`                            |
| Go       | `crypto/subtle.ConstantTimeCompare`                 |
| Python   | `hmac.compare_digest`                               |
| Shell    | `polaris-mail auth verify` (wraps the Go primitive) |

A naïve `===` / `==` comparison leaks signature bytes via timing and is
a verification bug.

## Outgoing webhooks

The webhook direction signs the **v2 envelope** (full `Message` inlined;
see the [unified Message model](/developers/messages/unified-model)).
The HMAC scheme is identical to the API direction — only `direction`
and the body shape differ.

Headers on every delivery:

```text
X-Polaris-Event-Id: <ulid>            # dedupe for 24h on the receiver
X-Polaris-Event:    message.received  # convenience
X-Polaris-Ts:       <ms-unix>
X-Polaris-Nonce:    <16-128 chars>
X-Polaris-Sig:      <64 hex chars>
```

Body shape:

```json
{
  "event_id": "01J...",
  "event": "message.received",
  "occurred_at": 1700000000000,
  "message": {
    /* full Message — see the unified model page */
  }
}
```

Receivers MUST verify with `direction = "polaris-webhook"` and SHOULD
dedupe by `X-Polaris-Event-Id`. `X-Polaris-Event-Id` is **not** inside
the signature — it is a convenience header for dedupe — but the
`event_id` field inside the body is, because the body bytes are hashed
into line 7 of the canonical string.

## Worked example

Taken **verbatim** from the first happy-path vector in `packages/test-vectors/vectors.json`:

| Field     | Value                                                                      |
| --------- | -------------------------------------------------------------------------- |
| direction | `polaris-api`                                                              |
| method    | `POST`                                                                     |
| path      | `/v1/messages`                                                             |
| query     | `mode=test`                                                                |
| ts        | `1700000000000`                                                            |
| nonce     | `AAAABBBBCCCCDDDD`                                                         |
| secret    | `XBNRJYZ8WS5KQDVPM7T4F2H6CG3A1E9N`                                         |
| body      | `{"from":"a@b.com","to":["c@d.com"],"subject":"hi","category":"svc.test"}` |

Canonical string (literal bytes, `\n` is `0x0a`):

```text
polaris-api
POST
/v1/messages
mode=test
1700000000000
AAAABBBBCCCCDDDD
4f5be64fbe43e9989dfd64b3a3b91c1f59d2d4d52d676d96fab2cf3d3b8b3a32
```

The last line is `lowercase-hex(SHA-256(body-bytes))`.

Expected signature header:

```text
X-Polaris-Sig: 79f7c3e0d7b2bcc835fc9f6f70116fd7160af3ef2235491da4266776c860d7b1
```

## Test vectors

`packages/test-vectors/vectors.json` ships the canonical fixture set.
Each entry has the shape:

```json
{
  "name": "api/POST/messages/happy",
  "direction": "polaris-api",
  "method": "POST",
  "path": "/v1/messages",
  "query": "mode=test",
  "ts": "1700000000000",
  "nonce": "AAAABBBBCCCCDDDD",
  "secret": "...",
  "body": "...",
  "must_verify": true,
  "expected_sig": "79f7c3e0d7b2bcc835fc9f6f70116fd7160af3ef2235491da4266776c860d7b1",
  "expected_error": null
}
```

Every first-party verifier (`packages/hmac`, `packages/sdk-node`,
`packages/sdk-go`, `polaris-mail auth verify`) MUST pass every vector.
CI's `sdk-test-vectors` job enforces this.

Verifiers are invoked with `now_ms == vector.ts` so the clock-skew gate
is skipped during tests. In production, the gate is always on.

## Verifier error codes

Defined in `packages/hmac/src/index.ts`; SDKs and the API surface this
set verbatim.

| Code                | Cause                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_header`    | One of `X-Polaris-Ts`, `X-Polaris-Nonce`, `X-Polaris-Sig` is absent.                                                                         |
| `header_invalid`    | A header contained whitespace, CR/LF/NUL, or non-ASCII; the timestamp wasn't a base-10 integer; or the nonce length was outside `[16, 128]`. |
| `clock_skew`        | `abs(now_ms - ts_ms) > 300_000`.                                                                                                             |
| `invalid_signature` | Signature didn't match `^[0-9a-f]+$`, didn't hex-decode, or the constant-time comparison failed.                                             |

Note that signatures shaped like `v1=…` / `v2=…` fail the bare-hex
regex and are rejected with `invalid_signature` — not `header_invalid`.
This is intentional: consumers get a single stable error code for
"the signature is bad".

## Security guarantees

What the scheme guarantees, assuming a secret that has not leaked:

- **Authenticity.** Only a holder of the secret can produce a valid
  signature for a `(direction, method, path, query, ts, nonce, body)`
  tuple.
- **Integrity.** Any change to method, path, query, timestamp, nonce, or
  body invalidates the signature.
- **Replay resistance within ±5 min.** The skew window plus nonce
  storage prevents replay of a captured request beyond a 5-minute
  ceiling and within that window prevents replay of an already-seen
  nonce.
- **Direction binding.** A captured API-direction signature cannot be
  replayed as a webhook-direction signature, and vice versa, because
  the domain tag is hashed into the canonical string.
- **Timing-attack resistance.** Constant-time signature comparison
  prevents byte-by-byte extraction of the expected MAC.

## Caveats

What the scheme does **not** do:

- **It does not provide confidentiality.** TLS does. Bodies and headers
  travel in cleartext to the TLS terminator.
- **It does not bind the signature to a TLS session.** A man-in-the-
  middle who can break TLS gets a working request; HMAC doesn't help.
- **It does not protect a leaked secret.** If your secret is exposed,
  the attacker can sign anything until you rotate. Revocation via
  `KV_REVOCATIONS` propagates within ≤60 s — see
  [Threat model](/security/threat-model).
- **It does not prevent replay across the 5-minute boundary if your
  nonce storage is shorter than 5 min.** polaris-mail's KV nonce store
  has a TTL ≥ the skew window; verifiers you implement must do the
  same.
- **It does not authenticate `X-Polaris-Key-Id`.** The key-id is
  outside the signature because the verifier needs it to look up the
  secret. The signature is authenticated by _being computable_ under
  the looked-up secret — but a hostile key-id with a valid signature
  under that key's secret will still authenticate as that key. Don't
  treat the key-id as if it were inside the signature.

## Implementation references

| Component                            | File                                                |
| ------------------------------------ | --------------------------------------------------- |
| Canonical signer + verifier          | `packages/hmac/src/index.ts`                        |
| API direction (inbound auth)         | `services/api/src/auth.ts`                          |
| Webhook direction (outbound signing) | `services/api/src/queue/fanout.ts`                  |
| Node SDK verifier                    | `packages/sdk-node/`                                |
| Go SDK verifier                      | `packages/sdk-go/`                                  |
| Operator-side CLI                    | `polaris-mail auth verify` (in `apps/polaris-cli/`) |
| Test vectors                         | `packages/test-vectors/vectors.json`                |

## See also

- [HMAC concept](/developers/authentication/concept) — narrative
  version of this page.
- [Threat model](/security/threat-model) — where HMAC sits in the
  trust-boundary diagram.
- [Errors](/reference/errors) — wire-level error codes including the
  HMAC failure modes above.

<!-- Verified against: docs/hmac-reference.md, packages/hmac/src/index.ts, packages/test-vectors/vectors.json, services/api/src/auth.ts, services/api/src/queue/fanout.ts @ eeee222cdf8359f8f2bf1013a103abdb3c705f06 -->
