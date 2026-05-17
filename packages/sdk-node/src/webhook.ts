/// <reference types="node" />
// `@polaris/sdk/webhook` — Verify polaris-email webhook deliveries.
//
// The triple-slash above ensures consumers that resolve this TS source
// directly (Phase B.1b switched package main to `src/index.ts` for vitest
// 4.x compat) pull in Node's `Buffer` global type. Without it, apps that
// don't explicitly include `@types/node` in their tsconfig fail typecheck.
//
// Thin wrapper around `@polaris-email/hmac`'s strict canonical-string verifier.
// Historical context: this file once carried its own hand-written HMAC
// implementation alongside the canonical TS package; the duplication was
// collapsed in cleanup. The HMAC scheme itself was un-versioned in
// — direction tags are `polaris-api` / `polaris-webhook` (no `.v1`),
// and the `X-Polaris-Sig` header is bare lowercase hex (no `v1=`/`v2=` prefix).

import { verify, type Direction, type VerifyResult } from '@polaris-email/hmac';

export type { Direction, VerifyResult };

export interface VerifyWebhookInput {
  direction?: Direction;
  method?: string;
  path: string;
  query?: string | URLSearchParams | Record<string, string | string[]>;
  headers: Headers | Record<string, string | string[] | undefined>;
  body: Buffer | Uint8Array | string;
  secret: string | Buffer;
  /** Default 300 seconds. */
  skewSeconds?: number;
  now?: () => number;
}

function pickHeader(h: VerifyWebhookInput['headers'], name: string): string | null {
  if (h instanceof Headers) return h.get(name);
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return null;
  const v = (h as Record<string, string | string[] | undefined>)[key];
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function asUint8(body: VerifyWebhookInput['body']): Uint8Array {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body as ArrayBufferLike);
}

function asSecretString(secret: VerifyWebhookInput['secret']): string {
  if (typeof secret === 'string') return secret;
  return Buffer.from(secret).toString('utf8');
}

export function verifyWebhook(input: VerifyWebhookInput): Promise<VerifyResult> {
  const direction: Direction = input.direction ?? 'polaris-webhook';
  const method = input.method ?? 'POST';
  return verify({
    direction,
    method,
    path: input.path,
    query: input.query,
    headers: {
      get: (name: string) => pickHeader(input.headers, name),
    },
    body: asUint8(input.body),
    secret: asSecretString(input.secret),
    skewSeconds: input.skewSeconds,
    now: input.now,
  });
}
