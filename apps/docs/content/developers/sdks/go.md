---
title: Go SDK
description: The polaris-sdk-go Go SDK — HMAC-signing client, typed APIError, webhook verifier with WebhookEnvelope parse helpers.
sidebar_label: Go (polaris-sdk-go)
sidebar_position: 2
---

# `polaris-sdk-go` (Go)

Hand-written Go SDK for the polaris-mail control plane. Used internally
by the `polaris-mail` CLI and the `mail-bridge` binary. The import path
is `github.com/polaris-mail/polaris-sdk-go`.

This package is **internal-only** within the polaris-\* service family. It
is not published to the Go public proxy.

## Install

The SDK is consumed via Go modules from the polaris-mail monorepo. In the
monorepo, the module is reachable directly:

```go
import polarissdk "github.com/polaris-mail/polaris-sdk-go"
```

Outside the monorepo (e.g. when wiring a private fork), pin the module via
`replace` in your `go.mod`:

```
replace github.com/polaris-mail/polaris-sdk-go => /path/to/packages/sdk-go
```

## Quickstart: signed API request

```go
import (
    "context"

    polarissdk "github.com/polaris-mail/polaris-sdk-go"
)

c := polarissdk.NewClient(os.Getenv("POLARIS_MAIL_URL"))
c.KeyID = os.Getenv("POLARIS_MAIL_KEY_ID")
c.KeySecret = []byte(os.Getenv("POLARIS_MAIL_KEY_SECRET"))

msg, err := c.GetMessage(context.Background(), "01HABCDEFGHJKMNPQRSTVWXYZ0")
if err != nil {
    // see "Typed errors" below
}
_ = msg
```

`Client.Do(...)` is the lower-level entry point if a typed helper has not
been written yet for a route — it computes the canonical signing string,
attaches `X-Polaris-Ts` / `X-Polaris-Nonce` / `X-Polaris-Sig` headers, and
returns the raw response.

## Send a message

```go
res, err := c.Messages.Send(ctx, polarissdk.SendRequest{
    From:    "noreply@example.com",
    To:      []string{"user@external.com"},
    Subject: "Hi",
    Text:    "Hello",
})
```

For the wire shape, see [Quickstart](/developers/quickstart) and the
[REST reference](/reference/api/submit-a-message-json-or-rfc-822).

## Idempotency

Both SDKs ship a strict client-side validator for `Idempotency-Key` values
so a malformed key fails before the round-trip. The pattern matches the
OpenAPI parameter definition exactly: `^[A-Za-z0-9_-]{8,128}$`. Pass via
the per-request option or attach with `Client.Do`.

## Verify a webhook

```go
res := polarissdk.VerifyWebhook(polarissdk.VerifyInput{
    Direction: polarissdk.DirectionWebhook,
    Method:    r.Method,
    Path:      r.URL.Path,
    Query:     r.URL.RawQuery,
    Headers: map[string]string{
        "x-polaris-ts":    r.Header.Get("X-Polaris-Ts"),
        "x-polaris-nonce": r.Header.Get("X-Polaris-Nonce"),
        "x-polaris-sig":   r.Header.Get("X-Polaris-Sig"),
    },
    Body:   bodyBytes,
    Secret: webhookSecret,
})
if !res.OK {
    // res.Code is one of CodeMissingHeader / CodeHeaderInvalid /
    // CodeClockSkew / CodeInvalidSignature; res.Err carries the detail.
    http.Error(w, "bad signature", http.StatusUnauthorized)
    return
}
```

The signature header is the **un-versioned** `X-Polaris-Sig: <hex>` — no
`v1=` / `v2=` prefix.

For the common "verify then parse the JSON envelope" pattern, use
`VerifyAndParseWebhook`:

```go
env, res := polarissdk.VerifyAndParseWebhook(in)
if !res.OK {
    return // res.Code / res.Err describe the failure
}
log.Printf("event %s for message %s", env.Event, env.Message.ID)
```

The two-step dance is also available when you want to inspect the raw body
first:

```go
res := polarissdk.VerifyWebhook(in)
if !res.OK { http.Error(w, "bad sig", 401); return }
env, err := polarissdk.ParseWebhookEnvelope(in.RawBody)
```

The verifier is hand-written so the constant-time compare and header
validation stay auditable. Source: `packages/sdk-go/webhook.go`.

## Iterate all messages

The Go SDK exposes a cursor-aware list helper. Loop until `NextOffset` is
empty:

```go
opts := polarissdk.ListMessagesOptions{Limit: 100}
for {
    page, err := c.ListMessages(ctx, opts)
    if err != nil {
        return err
    }
    for _, m := range page.Data {
        process(m)
    }
    if page.NextOffset == "" {
        break
    }
    opts.Offset = page.NextOffset
}
```

Checkpoint `opts.Offset` to resume a long-running drain.

## Typed errors

Non-2xx API responses surface as `*APIError`, which carries the stable
wire code + retryable hint from the API envelope. Switch on `Code` rather
than parse `Error()` strings.

```go
import "errors"

_, err := c.GetMessage(ctx, "01HABCDEFGHJKMNPQRSTVWXYZ0")
if err != nil {
    var apiErr *polarissdk.APIError
    if errors.As(err, &apiErr) {
        switch apiErr.Code {
        case "not_found":
            // 404; the message id was missing in the bulk response.
        case "rate_limited":
            // honor apiErr.Retryable (true); back off and retry.
        case "scope_violation":
            // 403; the caller's key isn't authorised for this scope.
        }
        return
    }
    // Transport-level errors (timeouts, refused connections) are NOT
    // wrapped as *APIError — use errors.Is for those.
    if errors.Is(err, context.DeadlineExceeded) {
        // ...
    }
}
```

sdk-go exports concrete `*APIError` sub-types per code
(`*BadSignatureError`, `*KeyRevokedError`, `*RateLimitedError`, …). Switch
on the type for finer-grained handling.

`polarissdk.IsRetryable(err)` is a convenience that returns `true` for
retryable `*APIError` values and timeouts on `net.Error`. Use it when you
do not need to inspect the code.

The retry contract is in the
[consumer contract](/reference/consumer-contract).

## Files

- `client.go` — HMAC-signing HTTP transport (`Client.Do`).
- `messages.go` — typed request/response structs and method helpers
  (`PatchMessageFlags`, `GetMessage`, `BulkGetMessages`, …) plus
  `WebhookEnvelope` and `ParseWebhookEnvelope`.
- `webhook.go` — strict canonical-string HMAC signer / verifier
  (`VerifyWebhook`, `VerifyAndParseWebhook`, `Sign`, `BuildCanonical`).
- `errors.go` — `APIError` + `ParseAPIError` + `IsRetryable`.

## How the SDKs are kept in sync

SDKs are **hand-written**, not generated. The contract is
`openapi/polaris-mail.yaml`. The Node and Go SDKs share canonical test
vectors from `packages/test-vectors/vectors.json`; every verifier MUST
pass them in CI.

<!-- Verified against: docs/sdk.md, packages/sdk-go/README.md @ 60cc6d59541b3279a65c755222fd9290ce76fc5e -->
