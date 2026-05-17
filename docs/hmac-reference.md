# HMAC reference

polaris-email HMAC signatures are **un-versioned**. There is one canonical
string format, two domain-separation tags, and one signature header. The
historical `v1=` / `v2=` envelope tags and `.v1` suffixes were removed — this document is the source of truth for the current shape.

The machine-readable source of truth is
[`packages/test-vectors/vectors.json`](../packages/test-vectors/vectors.json);
every SDK and verifier MUST pass it.

## Canonical signing string

Seven lines joined by a single `\n` (no trailing newline, no `\r`):

```
<direction>\n
<METHOD>\n
<path>\n
<canonical-query>\n
<X-Polaris-Ts>\n
<X-Polaris-Nonce>\n
<lowercase-hex(SHA-256(raw-body-bytes))>
```

| Field             | Value                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direction`       | `polaris-api` (HTTP requests to the REST surface) **or** `polaris-webhook` (outgoing webhook deliveries). Domain separation, no `.v1` suffix.                       |
| `METHOD`          | Uppercased HTTP method: `POST`, `GET`, `PATCH`, `DELETE`, …                                                                                                         |
| `path`            | URL path with leading `/`. No fragment, no scheme, no host.                                                                                                         |
| `canonical-query` | RFC3986 percent-encoded query string, sorted first by lowercased key then by raw value. Empty string when there is no query. No leading `?`.                        |
| `X-Polaris-Ts`    | Millisecond Unix timestamp as a base-10 integer string. No leading zeros.                                                                                           |
| `X-Polaris-Nonce` | 16–128 ASCII chars. No whitespace, CR, LF, tab, NUL, or non-ASCII.                                                                                                  |
| Body hash         | `lowercase-hex(SHA-256(body))` over the **exact raw bytes** sent on the wire. No canonicalisation, no whitespace normalisation. Empty body hashes the empty string. |

## Signature header

```
X-Polaris-Sig: <lowercase-hex(HMAC-SHA256(secret, canonical))>
```

No `v1=` / `v2=` / algorithm prefix. The hex string is exactly 64 characters
(SHA-256 → 32 bytes → 64 hex chars). Verifiers MUST refuse anything else.

## Required request headers

| Header             | Format                                                         |
| ------------------ | -------------------------------------------------------------- |
| `X-Polaris-Key-Id` | Opaque key identifier (e.g. ULID).                             |
| `X-Polaris-Ts`     | Milliseconds since Unix epoch.                                 |
| `X-Polaris-Nonce`  | 16–128 ASCII chars, unique per request within the skew window. |
| `X-Polaris-Sig`    | 64 lowercase hex chars.                                        |

Reject any of the four if they contain space, tab, CR, LF, NUL, or any byte
above `0x7e` — **before** running HMAC verification.

## Clock skew tolerance

Verifiers reject requests where `abs(now_ms - ts_ms) > 300_000` (±5 minutes).
Tests pin `now_ms` to the vector's `ts` to skip the skew check.

## Constant-time comparison

Verifiers MUST compare signatures with a constant-time byte comparison:

- Node: `crypto.timingSafeEqual`
- Python: `hmac.compare_digest`
- Go: `subtle.ConstantTimeCompare`
- Shell: `polaris-email auth verify` (which wraps the Go primitive)

## Worked example

Taken **verbatim** from the first happy-path vector in
[`packages/test-vectors/vectors.json`](../packages/test-vectors/vectors.json):

| Field     | Value                                                                      |
| --------- | -------------------------------------------------------------------------- |
| direction | `polaris-api`                                                              |
| method    | `POST`                                                                     |
| path      | `/v1/send/raw`                                                             |
| query     | `mode=test`                                                                |
| ts        | `1700000000000`                                                            |
| nonce     | `AAAABBBBCCCCDDDD`                                                         |
| secret    | `XBNRJYZ8WS5KQDVPM7T4F2H6CG3A1E9N`                                         |
| body      | `{"from":"a@b.com","to":["c@d.com"],"subject":"hi","category":"svc.test"}` |

Canonical string (literal bytes, `\n` is a single byte `0x0a`):

```
polaris-api
POST
/v1/send/raw
mode=test
1700000000000
AAAABBBBCCCCDDDD
4f5be64fbe43e9989dfd64b3a3b91c1f59d2d4d52d676d96fab2cf3d3b8b3a32
```

(The last line is the SHA-256 hex of the body bytes.)

Expected signature header:

```
X-Polaris-Sig: 3dc5920cc9bd7db06e6001fd75bb3225802c01381e3b079fec05a6e70dae0c27
```

## Outgoing webhooks

The webhook direction signs the **v2 envelope** (full `Message` inlined; see
[`messages.md`](messages.md)). The HMAC scheme is identical to the API
direction — only the `direction` value and the body shape differ. Required
headers on every delivery:

```
X-Polaris-Event-Id: <ulid>            # dedupe for 24h on the receiver
X-Polaris-Event: message.received     # convenience
X-Polaris-Ts:    <ms-unix>
X-Polaris-Nonce: <16-128 chars>
X-Polaris-Sig:   <64 hex chars>
```

Body:

```json
{
  "event_id": "01J...",
  "event": "message.received",
  "occurred_at": 1700000000000,
  "message": {
    /* full Message — see docs/messages.md */
  }
}
```

Receivers MUST verify the signature with `direction = "polaris-webhook"`
and SHOULD dedupe by `X-Polaris-Event-Id`.

## Test vectors

[`packages/test-vectors/vectors.json`](../packages/test-vectors/vectors.json)
ships canonical fixtures. Each entry has:

```json
{
  "name": "api/POST/messages/happy",
  "direction": "polaris-api",
  "method": "POST",
  "path": "/v1/send/raw",
  "query": "mode=test",
  "ts": "1700000000000",
  "nonce": "AAAABBBBCCCCDDDD",
  "secret": "...",
  "body": "...",
  "must_verify": true,
  "expected_sig": "3dc5920cc9bd7db06e6001fd75bb3225802c01381e3b079fec05a6e70dae0c27",
  "expected_error": null
}
```

Every first-party verifier (`packages/hmac`, `packages/sdk-node`,
`packages/sdk-go`, `polaris-email auth verify`) MUST pass every vector;
CI's `sdk-test-vectors` job enforces this. Verifiers are invoked with
`now_ms == vector.ts` so the clock-skew gate is skipped during tests.
