---
title: Node SDK
description: The @polaris/sdk TypeScript SDK — HMAC-signed client, AsyncIterable pagination, idempotency, webhook verifier, and typed errors.
sidebar_label: Node (@polaris/sdk)
sidebar_position: 1
---

# `@polaris/sdk` (Node)

The TypeScript SDK for the polaris-email control plane. Hand-written, not
generated. Works in Node, Cloudflare Workers, and browsers (the core HTTP
client uses `fetch`).

This package is **internal-only** within the polaris-\* service family. It
is not published to npm; consumers depend on it via the pnpm workspace
(`workspace:*`).

## Install

```sh
pnpm add @polaris/sdk@workspace:*
```

## Sub-paths

| Import                 | Purpose                                                  |
| ---------------------- | -------------------------------------------------------- |
| `@polaris/sdk`         | `Polaris` HTTP client + typed wrappers + `PolarisError`. |
| `@polaris/sdk/webhook` | `verifyWebhook` (strict canonical-string HMAC).          |
| `@polaris/sdk/node`    | Node-only helpers (file uploads, stream wrappers).       |
| `@polaris/sdk/react`   | TanStack Query hooks (used by the panel).                |

## Quickstart: signed API request

```ts
import { Polaris } from '@polaris/sdk';

const client = new Polaris({
  baseUrl: process.env.POLARIS_EMAIL_URL!,
  keyId: process.env.POLARIS_EMAIL_KEY_ID!,
  keySecret: process.env.POLARIS_EMAIL_KEY_SECRET!,
});

const { body } = await client.listMessages('limit=20');
console.log(body.data);
```

The client computes the canonical signing string, attaches
`x-polaris-key-id` / `x-polaris-ts` / `x-polaris-nonce` / `x-polaris-sig`
headers, and parses errors into `PolarisError`.

## Send a message

```ts
await client.sendMessage({
  from: 'noreply@example.com',
  to: ['user@external.com'],
  subject: 'Hi',
  text: 'Hello',
});
```

For the wire shape and the JSON / RFC822 split, see
[Quickstart](/developers/quickstart) and the
[REST reference](/reference/api/submit-a-message-json-or-rfc-822).

## Idempotency

```ts
await client.sendMessage(
  { from: 'noreply@acme.com', to: ['alice@example.com'], subject: 'hi', text: 'hi' },
  { idempotencyKey: 'order-12345-confirm' },
);
```

`idempotencyKey` is validated client-side against `^[A-Za-z0-9_-]{8,128}$`
before the request leaves the process. Server-side validation still
applies; this catches misconfigured callers without a round-trip.

The standalone validator is also exported:

```ts
import { assertIdempotencyKey } from '@polaris/sdk';

assertIdempotencyKey(key); // throws TypeError if malformed
```

## Paginate all messages

`listMessages` returns one page (`{ data, next_offset }`). For lazy
auto-pagination, use the `AsyncIterable` helper:

```ts
for await (const message of client.listAllMessages('limit=100')) {
  process(message);
}
```

It chains `next_offset` automatically and yields one `Message` at a time
until the API reports `next_offset === null`. Use the manual
`listMessages` when you need to checkpoint the cursor for resumable jobs.

## Verify a webhook

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
const envelope = JSON.parse(rawBodyBytes.toString('utf8'));
// envelope.message is the full Message; no extra GET required.
```

The signature header is the **un-versioned** `X-Polaris-Sig: <hex>` — no
`v1=` / `v2=` prefix. Both API (`polaris-api`) and webhook
(`polaris-webhook`) directions sign with the same un-versioned format.

The verifier is hand-written so the security-critical constant-time
compare and header validation stay auditable. Source:
`packages/sdk-node/src/webhook.ts`.

## Typed errors

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

`PolarisError` is a discriminated union over the wire `code`. Switch on
the type to handle retryability without parsing JSON yourself. The retry
contract is in the [consumer contract](/reference/consumer-contract).

## React hooks

The panel uses the `/react` sub-path; the same hooks are available to any
downstream React consumer.

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

## Files

- `src/index.ts` — `Polaris` client + typed helpers + re-exports.
- `src/webhook.ts` — strict HMAC webhook verifier.
- `src/errors.ts` — `PolarisError`, `parsePolarisError`, `isRetryable`.
- `src/generated/` — generated types from `openapi/polaris-email.yaml`.
- `src/node.ts` — Node-only helpers.
- `src/react.ts` — TanStack Query hooks for the panel.

<!-- Verified against: docs/sdk.md, packages/sdk-node/README.md @ 60cc6d59541b3279a65c755222fd9290ce76fc5e -->
