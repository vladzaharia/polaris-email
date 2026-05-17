# SDKs

polaris-email ships two first-party SDKs (Node and Go). Each one ships a
hand-written webhook verifier alongside the REST client; the verifier is
intentionally hand-written so the security-critical constant-time compare
and header validation stay auditable.

| Language | Package          | HMAC client  | Webhook verifier             |
| -------- | ---------------- | ------------ | ---------------------------- |
| Node/TS  | `@polaris/sdk`   | hand-written | `@polaris/sdk/webhook`       |
| Go       | `polaris-sdk-go` | hand-written | `polarissdkgo.VerifyWebhook` |

## `@polaris/sdk` (Node)

Sub-paths:

- `@polaris/sdk` / `@polaris/sdk/core` — fetch-based REST client (works in
  Node, Workers, browsers).
- `@polaris/sdk/react` — TanStack Query hooks (`useMessages`,
  `useMessage`, `useSendMessage`, …).
- `@polaris/sdk/node` — Node-only helpers (file-stream uploads,
  `node:crypto` HMAC).
- `@polaris/sdk/webhook` — webhook verifier (hand-written).

```ts
import { PolarisClient } from '@polaris/sdk';

const polaris = new PolarisClient({
  baseUrl: process.env.POLARIS_EMAIL_URL!,
  keyId: process.env.POLARIS_EMAIL_KEY_ID!,
  keySecret: process.env.POLARIS_EMAIL_KEY_SECRET!,
});

const res = await polaris.messages.send({
  from: 'noreply@example.com',
  to: ['user@external.com'],
  subject: 'Hi',
  text: 'Hello',
});
```

React hook usage (TanStack Query under the hood):

```tsx
import { PolarisProvider, useMessages } from '@polaris/sdk/react';

function Inbox({ mailboxId }: { mailboxId: string }) {
  const { data, isLoading } = useMessages({ mailbox_id: mailboxId, direction: 'in' });
  if (isLoading) return <p>loading…</p>;
  return (
    <ul>
      {data?.data.map((m) => (
        <li key={m.id}>{m.subject}</li>
      ))}
    </ul>
  );
}
```

Webhook verification:

```ts
import { verifyWebhook } from '@polaris/sdk/webhook';

const result = verifyWebhook({
  secret: process.env.POLARIS_WEBHOOK_SECRET!,
  method: req.method,
  path: req.path,
  query: req.url.split('?')[1] ?? '',
  headers: Object.fromEntries(req.headers),
  rawBody: rawBodyBuffer,
});
if (!result.ok) return new Response('bad sig', { status: 401 });
const envelope = JSON.parse(rawBodyBuffer.toString('utf8'));
// envelope.message is the full Message; no extra GET required.
```

The signature header is the **un-versioned** `X-Polaris-Sig: <hex>` — there
is no `v1=` / `v2=` prefix. The HMAC was un-versioned; both the
API direction (`polaris-api`) and the webhook direction (`polaris-webhook`)
sign with the same un-versioned format. See
[`docs/hmac-reference.md`](hmac-reference.md) for the canonical spec.

### `listAllMessages` AsyncIterable (Phase 7a)

The Node SDK ships an `AsyncIterable` helper that auto-paginates through
the whole result set, hiding the `next_offset` cursor:

```ts
for await (const message of polaris.listAllMessages('mailbox_id=01J...&limit=100')) {
  // Each iteration yields one Message; the SDK fetches the next page
  // transparently when the current one drains.
}
```

Use this when you want every message and don't want to track cursors;
fall back to manual `polaris.listMessages(...)` when you need to checkpoint
the cursor for resumable jobs.

### `assertIdempotencyKey` (Phase 7a)

Both SDKs ship a strict client-side validator for `Idempotency-Key`
values so a malformed key fails before the round-trip. In Node:

```ts
import { assertIdempotencyKey } from '@polaris/sdk';

assertIdempotencyKey(key); // throws TypeError if !/^[A-Za-z0-9_-]{8,128}$/
```

The pattern matches the OpenAPI parameter definition exactly.

## `polaris-sdk-go` (Go)

HMAC-signing client with explicit context.

```go
import "github.com/vladzaharia/polaris-email/packages/sdk-go"

c := polarissdkgo.New(polarissdkgo.Config{
    BaseURL:   os.Getenv("POLARIS_EMAIL_URL"),
    KeyID:     os.Getenv("POLARIS_EMAIL_KEY_ID"),
    KeySecret: os.Getenv("POLARIS_EMAIL_KEY_SECRET"),
})
res, err := c.Messages.Send(ctx, polarissdkgo.SendRequest{
    From:    "noreply@example.com",
    To:      []string{"user@external.com"},
    Subject: "Hi",
    Text:    "Hello",
})
```

Webhook verifier:

```go
result := polarissdkgo.VerifyWebhook(polarissdkgo.VerifyInput{
    Secret:  os.Getenv("POLARIS_WEBHOOK_SECRET"),
    Method:  r.Method,
    Path:    r.URL.Path,
    Query:   r.URL.RawQuery,
    Headers: r.Header,
    RawBody: bodyBytes,
})
if !result.OK { http.Error(w, "bad sig", 401); return }
```

### `WebhookEnvelope` + parse helpers (Phase 7a)

The Go SDK ships a typed `WebhookEnvelope` struct and two parse helpers so
consumers don't have to roll their own JSON shape:

```go
// One-step verify + parse in the happy path:
env, res := polarissdkgo.VerifyAndParseWebhook(in)
if !res.OK { http.Error(w, "bad sig", 401); return }
fmt.Println(env.Event, env.Message.Subject)

// Or the two-step dance, if you want to inspect the raw body first:
res := polarissdkgo.VerifyWebhook(in)
if !res.OK { http.Error(w, "bad sig", 401); return }
env, err := polarissdkgo.ParseWebhookEnvelope(in.RawBody)
```

The header tag is the **un-versioned** `X-Polaris-Sig: <hex>`
removed `v1=` / `v2=` prefixes.

### Typed API errors (Phase 7a)

Both SDKs surface the OpenAPI `Error` shape as typed values: `PolarisError`
(TS) is a discriminated union; sdk-go exports concrete `*APIError`
sub-types per error code (`*BadSignatureError`, `*KeyRevokedError`,
`*RateLimitedError`, …). Switch on the type to handle retryability
without parsing the JSON yourself.

## Where the hand-written verifier lives

| SDK              | Verifier source                    |
| ---------------- | ---------------------------------- |
| `@polaris/sdk`   | `packages/sdk-node/src/webhook.ts` |
| `polaris-sdk-go` | `packages/sdk-go/webhook.go`       |

Both verifiers share canonical test vectors from
`packages/test-vectors/vectors.json`; every verifier MUST pass them in CI.

## How the SDKs are kept in sync

SDKs are **hand-written**, not generated. The contract is `openapi/polaris-email.yaml`. When you add or change a REST endpoint:

1. Update `openapi/polaris-email.yaml` first (the contract).
2. Add the method to `packages/sdk-node/src/index.ts` (TypeScript) AND `packages/sdk-go/messages.go` (Go).
3. Add response/request types to `packages/schema/src/index.ts` (TypeScript — sdk-node imports from there). sdk-go has its own struct definitions in `packages/sdk-go/messages.go`.
4. HMAC parity: `packages/test-vectors/vectors.json` is the source of truth. CI runs `sdk-test-vectors` to verify all SDKs agree on canonical-string + signature for the same inputs.

The old `packages/sdk-codegen/` generator was deleted in commit `71f6e41` (Phase M / D1). It never produced anything real — the "generated" outputs in each SDK package were placeholder stubs, never refreshed.
