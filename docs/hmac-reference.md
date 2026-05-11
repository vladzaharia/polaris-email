# HMAC reference

## Canonical signing string

```
<direction>\n
<METHOD>\n
<path>\n
<canonical-query>\n
<X-Polaris-Ts>\n
<X-Polaris-Nonce>\n
<lowercase-hex(SHA-256(raw-body-bytes))>
```

- `<direction>` is **`polaris-api.v1`** for inbound API requests, **`polaris-webhook.v1`** for outbound webhook deliveries. Domain separation prevents cross-protocol confusion.
- `<METHOD>` is the uppercased HTTP method (`POST`, `GET`, ...).
- `<path>` is the URL path with leading `/`, **no** fragment.
- `<canonical-query>` is RFC3986 percent-encoded, sorted by lowercased key, then value. Empty string when no query.
- `<X-Polaris-Ts>` is the millisecond unix timestamp as a base-10 integer string (no leading zeros).
- `<X-Polaris-Nonce>` is 16–128 ASCII characters (no whitespace, CR, LF, tab, NUL, non-ASCII).
- Body hash is over the **exact raw bytes** sent on the wire (no canonicalization, no whitespace normalisation).

## Signature header

```
X-Polaris-Sig: v1=<lowercase-hex(HMAC-SHA256(secret, canonical))>
```

The `v1=` prefix is mandatory and must match the verifier's `allowed_algorithms` list (default `["v1"]`). Verifiers MUST refuse anything else; downgrade is not silently accepted.

## Constant-time comparison

Verifiers MUST use a constant-time byte comparison (`crypto.timingSafeEqual` Node, `hmac.compare_digest` Python, `subtle.ConstantTimeCompare` Go).

## Header validation

Reject `X-Polaris-Ts`, `X-Polaris-Nonce`, `X-Polaris-Sig`, `X-Polaris-Key-Id` if they contain any of: space, tab, CR, LF, NUL, byte > 0x7e. Reject before HMAC verification.

## Test vectors

`packages/test-vectors/vectors.json` ships canonical fixtures. Every verifier library MUST pass them. Each entry has:

```
{
  "name": "api/POST/messages/happy",
  "direction": "polaris-api.v1" | "polaris-webhook.v1",
  "method": "POST",
  "path": "/v1/messages",
  "query": "mode=test",
  "ts": "1700000000000",
  "nonce": "AAAABBBBCCCCDDDD",
  "secret": "...",
  "body": "...",
  "expected_sig": "v1=...",
  "must_verify": true | false,
  "expected_error": "bad_signature" | "algorithm_rejected" | "header_invalid" | "clock_skew" | "missing_header" | null
}
```

Verifiers are called with `now() => Number(ts)` to skip skew checks in tests.

## Outgoing webhooks

Webhooks use `polaris-webhook.v1`. Same canonical-string structure. Additional headers:

```
X-Polaris-Event-Id: <ulid>       # dedupe for 24h on the receiver
X-Polaris-Event: message.sent     # convenience
```

Receivers MUST verify the signature and SHOULD dedupe by `X-Polaris-Event-Id`.
