# polaris-sdk-go

Hand-written Go SDK for the [polaris-email](https://github.com/vladzaharia/polaris-email)
control plane. Used internally by the `polaris-email` CLI, the `mail-bridge`
binary, and the `submission-daemon`. The package import path is
`github.com/polaris-email/polaris-sdk-go`.

This package is **internal-only** within the polaris-* service family
(see `LICENSE`). It is not published to the Go public proxy.

## Install

The SDK is consumed via Go modules from the polaris-email monorepo. In the
monorepo, the module is reachable as:

```go
import polarissdk "github.com/polaris-email/polaris-sdk-go"
```

Outside the monorepo (e.g. when wiring a private fork), pin the module via
`replace` in your `go.mod`:

```
replace github.com/polaris-email/polaris-sdk-go => /path/to/packages/sdk-go
```

## Quickstart: sign an API request

```go
import (
    "context"

    polarissdk "github.com/polaris-email/polaris-sdk-go"
)

c := polarissdk.NewClient("https://api.polaris-email.example.com")
c.KeyID = "01H0000000000000000000000K"
c.KeySecret = []byte("...HMAC secret...")

msg, err := c.GetMessage(context.Background(), "01HABCDEFGHJKMNPQRSTVWXYZ0")
if err != nil {
    // see "Error handling" below
}
_ = msg
```

`Client.Do(...)` is the lower-level entry point if a typed helper hasn't been
written yet for a route — it computes the canonical signing string, attaches
`X-Polaris-Ts`/`Nonce`/`Sig` headers, and returns the raw response.

## Quickstart: verify a webhook

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

For the common case of "verify, then parse the JSON envelope", use
`VerifyAndParseWebhook`:

```go
env, res := polarissdk.VerifyAndParseWebhook(in)
if !res.OK {
    return // res.Code/res.Err describe the failure
}
log.Printf("event %s for message %s", env.Event, env.Message.ID)
```

## Error handling

Non-2xx API responses surface as `*APIError`, which carries the stable wire
code + retryable hint from the API envelope. Callers should switch on the
`Code` field rather than parse `Error()` strings.

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
            // honor apiErr.Retryable (true here); back off and retry.
        case "scope_violation":
            // 403; the caller's key isn't authorised for this scope.
        }
        return
    }
    // Transport-level errors (timeouts, refused connections) are NOT wrapped
    // as *APIError — use errors.Is for those.
    if errors.Is(err, context.DeadlineExceeded) {
        // ...
    }
}
```

`polarissdk.IsRetryable(err)` is a convenience that returns `true` for retryable
`*APIError` values and timeouts on `net.Error`. Use it as a single-call
shortcut when you don't need to inspect the code.

## Files

- `client.go` — HMAC-signing HTTP transport (`Client.Do`).
- `messages.go` — typed request/response structs and method helpers
  (`PatchMessageFlags`, `GetMessage`, `BulkGetMessages`, …) plus
  `WebhookEnvelope` and `ParseWebhookEnvelope`.
- `webhook.go` — strict canonical-string HMAC signer/verifier
  (`VerifyWebhook`, `VerifyAndParseWebhook`, `Sign`, `BuildCanonical`).
- `errors.go` — `APIError` + `ParseAPIError` + `IsRetryable`.

The wire-shape contract is in [`docs/sdk.md`](../../docs/sdk.md); the canonical
HMAC scheme is in [`docs/security.md`](../../docs/security.md).
