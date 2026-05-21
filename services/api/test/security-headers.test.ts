// Phase 3d — secure-headers smoke test for the api Worker.
//
// Asserts that the secureHeaders() middleware is mounted before any route by
// hitting the always-public /healthz and confirming the canonical
// `X-Content-Type-Options: nosniff` header is present. If the middleware ever
// regresses (re-ordered after routes, removed from index.ts, etc.) this test
// fails fast.
import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import type { Env } from '../src/env.js';

const ctx = {
  passThroughOnException: () => undefined,
  waitUntil: () => undefined,
} as unknown as ExecutionContext;

describe('secure headers (api worker)', () => {
  it('sets X-Content-Type-Options: nosniff on a public response', async () => {
    const env = {} as unknown as Env; // /healthz reads nothing off env
    const res = await app.fetch(
      new Request('https://polaris-mail-api.workers.dev/healthz'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
