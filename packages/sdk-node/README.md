# @polaris/sdk

TypeScript SDK for the [polaris-email](https://github.com/vladzaharia/polaris-email)
control plane. Used internally by `apps/panel`, the Workers in `services/*`,
and the test suites for HMAC-signed API calls + webhook verification.

This package is **internal-only** within the polaris-* service family
(see `LICENSE`). It is not published to npm; consumers depend on it via
the pnpm workspace (`workspace:*`).

## Sub-paths

| Import                    | Purpose                                                  |
| ------------------------- | -------------------------------------------------------- |
| `@polaris/sdk`            | `Polaris` HTTP client + typed wrappers + `PolarisError`. |
| `@polaris/sdk/webhook`    | `verifyWebhook` (strict canonical-string HMAC).          |
| `@polaris/sdk/node`       | Node-only helpers (file uploads, stream wrappers).       |
| `@polaris/sdk/react`      | TanStack Query hooks (generated for the panel).          |

## Quickstart: signed API request

```ts
import { Polaris } from '@polaris/sdk';

const client = new Polaris({
  baseUrl: 'https://api.polaris-email.example.com',
  authBuilder: async (req) => buildHmacHeaders(req, secret), // see services/api/test/utils
});

const { body } = await client.listMessages('limit=20');
console.log(body.data);
```

## Quickstart: send a message with idempotency

```ts
await client.sendMessage(
  { from: 'noreply@acme.com', to: ['alice@example.com'], subject: 'hi', text: 'hi' },
  { idempotencyKey: 'order-12345-confirm' },
);
```

`idempotencyKey` is validated client-side against `^[A-Za-z0-9_-]{8,128}$`
before the request leaves the process; this catches misconfigured callers
without a network round-trip. Server-side validation still applies.

## Quickstart: paginate all messages

`listMessages` returns one page (`{ data, next_offset }`). For lazy
auto-pagination across all pages, use the AsyncIterable helper:

```ts
for await (const message of client.listAllMessages('limit=100')) {
  process(message);
}
```

It chains `next_offset` automatically and yields one `Message` at a time
until the API reports `next_offset === null`.

## Quickstart: verify a webhook

```ts
import { verifyWebhook } from '@polaris/sdk/webhook';

const r = await verifyWebhook({
  direction: 'polaris-webhook',
  method: req.method,
  path: new URL(req.url).pathname,
  query: new URL(req.url).search.slice(1),
  headers: Object.fromEntries(req.headers.entries()),
  body: rawBodyBytes,
  secret: subscriptionSecret,
});
if (!r.ok) {
  return new Response('bad signature', { status: 401 });
}
```

## Error handling

Non-2xx responses throw `PolarisError`, which carries the wire `code` +
`retryable` flag from the API envelope.

```ts
import { isPolarisError, isRetryable } from '@polaris/sdk';

try {
  await client.sendMessage(req);
} catch (e) {
  if (isPolarisError(e)) {
    if (e.code === 'rate_limited' && isRetryable(e)) {
      // back off and retry
    } else if (e.code === 'scope_violation') {
      // 403; key not authorised for this from-address
    }
  }
}
```

The contract for retry semantics is in
[`CONSUMER-CONTRACT.md`](../../CONSUMER-CONTRACT.md).

## Files

- `src/index.ts` — `Polaris` client + typed helpers + re-exports.
- `src/webhook.ts` — strict HMAC webhook verifier.
- `src/errors.ts` — `PolarisError`, `parsePolarisError`, `isRetryable`.
- `src/generated/` — generated types from `openapi/polaris-email.yaml`.
- `src/node.ts` — Node-only helpers.
- `src/react.ts` — TanStack Query hooks for the panel.
