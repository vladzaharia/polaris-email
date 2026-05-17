// Phase 3d — secure-headers + DEV_MODE smoke tests for the panel Worker.
//
// secureHeaders() and the DEV_MODE assertion are mounted as the very first
// middlewares in apps/panel/src/server/index.ts. Hitting the public /healthz
// is enough to exercise both: a successful 200 with `nosniff` proves the
// middleware order, and the DEV_MODE refusal is asserted by setting both
// envs to the dangerous combination.
import { describe, expect, it } from 'vitest';
import worker from '../src/server/index.js';
import type { Env } from '../src/server/env.js';

const ctx = {
  passThroughOnException: () => undefined,
  waitUntil: () => undefined,
} as unknown as ExecutionContext;

function mkEnv(overrides: Partial<Env> = {}): Env {
  const stubFetcher = { fetch: async () => new Response('{}') } as unknown as Fetcher;
  return {
    DB: {} as D1Database,
    API: stubFetcher,
    ASSETS: stubFetcher,
    ADMIN_GROUP: 'polaris-admins',
    COOKIE_PATH: '/panel',
    ...overrides,
  };
}

describe('secure headers (panel worker)', () => {
  it('sets X-Content-Type-Options: nosniff and a Content-Security-Policy on /healthz', async () => {
    const res = await worker.fetch(new Request('https://panel.example/healthz'), mkEnv(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    // Spot-check the headline directives so a regression in the CSP map is
    // caught here rather than at runtime.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});

describe('DEV_MODE assertion (panel worker)', () => {
  it('refuses to serve when DEV_MODE=1 and ENVIRONMENT=production', async () => {
    const res = await worker.fetch(
      new Request('https://panel.example/healthz'),
      mkEnv({ DEV_MODE: '1', ENVIRONMENT: 'production' }),
      ctx,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('misconfigured');
  });

  it('serves normally when DEV_MODE=1 but ENVIRONMENT is not production', async () => {
    const res = await worker.fetch(
      new Request('https://panel.example/healthz'),
      mkEnv({ DEV_MODE: '1', ENVIRONMENT: 'dev' }),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it('serves normally with DEV_MODE unset', async () => {
    const res = await worker.fetch(
      new Request('https://panel.example/healthz'),
      mkEnv({ ENVIRONMENT: 'production' }),
      ctx,
    );
    expect(res.status).toBe(200);
  });
});
