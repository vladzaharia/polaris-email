# SDKs

polaris-email ships three first-party SDKs, all generated from
[`openapi/polaris-email.yaml`](../openapi/polaris-email.yaml). Each one
ships a hand-written webhook verifier alongside the generated REST client;
the verifier is intentionally not codegen output so the security-critical
constant-time compare and header validation stay auditable.

| Language | Package          | HMAC client | Webhook verifier             |
| -------- | ---------------- | ----------- | ---------------------------- |
| Node/TS  | `@polaris/sdk`   | generated   | `@polaris/sdk/webhook`       |
| Python   | `polaris-sdk`    | generated   | `polaris_sdk.webhook`        |
| Go       | `polaris-sdk-go` | generated   | `polarissdkgo.VerifyWebhook` |

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

## `polaris-sdk` (Python)

`httpx` + Pydantic v2. Sync and async clients share the same models.

```python
from polaris_sdk import PolarisClient

client = PolarisClient(
    base_url=os.environ["POLARIS_EMAIL_URL"],
    key_id=os.environ["POLARIS_EMAIL_KEY_ID"],
    key_secret=os.environ["POLARIS_EMAIL_KEY_SECRET"],
)
res = client.messages.send(
    from_="noreply@example.com",
    to=["user@external.com"],
    subject="Hi",
    text="Hello",
)
```

Webhook verifier (`polaris_sdk.webhook`):

```python
from polaris_sdk.webhook import verify_webhook

result = verify_webhook(
    secret=os.environ["POLARIS_WEBHOOK_SECRET"],
    method=request.method,
    path=request.path,
    query=request.query_string.decode(),
    headers=dict(request.headers),
    raw_body=await request.body(),
)
if not result.ok:
    return Response(status_code=401)
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

## Codegen workflow

`packages/sdk-codegen/` orchestrates regen across all three languages from
the single OpenAPI spec:

```bash
pnpm --filter @polaris-email/sdk-codegen regen
```

This:

1. Runs `openapi-generator-cli` for Python and Go clients.
2. Runs the in-house TypeScript generator for the Node SDK (custom
   templates so the React/TanStack hooks land in `/react`).
3. Re-renders the hand-written webhook verifiers (untouched if their
   source files match; the generator only validates they still exist and
   compile).
4. Runs `oxfmt` + each language's formatter.

A CI job (`.github/workflows/sdk-regen-check.yml`) runs the same command
and `git diff --exit-code`s; any drift between the spec and the checked-in
SDK source fails CI. To intentionally land an SDK change, update the spec
first, then commit the regenerated SDK output in the same PR.

### Toolchain caveat

Full regen requires:

- **Java 17+** (for `openapi-generator-cli`'s JAR).
- **Go 1.22+** binary on `$PATH` (for the Go client's `go vet` /
  `go build` smoke after generation).

The CI image has both. Local contributors who only touch one language can
run just that subset via `pnpm --filter @polaris-email/sdk-codegen regen:ts`,
`…regen:py`, or `…regen:go`.

## Where the hand-written verifier lives

| SDK              | Verifier source                              |
| ---------------- | -------------------------------------------- |
| `@polaris/sdk`   | `packages/sdk-node/src/webhook.ts`           |
| `polaris-sdk`    | `packages/sdk-python/polaris_sdk/webhook.py` |
| `polaris-sdk-go` | `packages/sdk-go/webhook.go`                 |

These files are listed in `packages/sdk-codegen/preserve.json` and skipped
by the generator's overwrite pass. They share canonical test vectors from
`packages/test-vectors/vectors.json`; every verifier MUST pass them in CI.
