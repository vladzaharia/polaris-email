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

## Where the hand-written verifier lives

| SDK              | Verifier source                    |
| ---------------- | ---------------------------------- |
| `@polaris/sdk`   | `packages/sdk-node/src/webhook.ts` |
| `polaris-sdk-go` | `packages/sdk-go/webhook.go`       |

Both verifiers share canonical test vectors from
`packages/test-vectors/vectors.json`; every verifier MUST pass them in CI.
