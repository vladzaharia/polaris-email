import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

const polarisStub = {
  async request() {
    return { status: 200, body: { ok: true } };
  },
} as unknown as Parameters<typeof createServer>[0]['polaris'];

function newDeps(opts: Partial<Parameters<typeof createServer>[0]> = {}) {
  const seen = new Set<string>();
  return {
    polaris: opts.polaris ?? polarisStub,
    bridgeKeySecret: opts.bridgeKeySecret ?? 'k',
    localTargets:
      opts.localTargets ?? new Map<string, string>([['expresscharge/email-hook', 'http://upstream.invalid/']]),
    nonceSeen: opts.nonceSeen ?? ((n: string) => seen.has(n)),
    rememberNonce: opts.rememberNonce ?? ((n: string) => seen.add(n)),
    isTrustedWorker: opts.isTrustedWorker ?? (() => true),
  };
}

describe('bridge server', () => {
  it('healthz', async () => {
    const app = createServer(newDeps());
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
  it('rejects untrusted caller on /hooks/*', async () => {
    const app = createServer(newDeps({ isTrustedWorker: () => false }));
    const res = await app.inject({ method: 'POST', url: '/hooks/svc/r1', payload: {} });
    expect(res.statusCode).toBe(403);
  });
  it('rejects bad slug', async () => {
    const app = createServer(newDeps());
    const res = await app.inject({ method: 'POST', url: '/hooks/Bad%20Svc/r1', payload: {} });
    expect(res.statusCode).toBe(400);
  });
  it('rejects nonce replay', async () => {
    const seen = new Set<string>();
    const app = createServer(
      newDeps({
        nonceSeen: (n) => seen.has(n),
        rememberNonce: (n) => seen.add(n),
      }),
    );
    const headers = {
      'content-type': 'application/json',
      'x-polaris-nonce': 'NONCEXYZ123456789',
      'x-polaris-ts': String(Date.now()),
      'x-polaris-sig': 'v1=' + 'a'.repeat(64),
    };
    // First call: no upstream → 502 expected, but nonce gets remembered
    const r1 = await app.inject({
      method: 'POST',
      url: '/hooks/expresscharge/email-hook',
      headers,
      payload: '{}',
    });
    expect(r1.statusCode).toBeGreaterThanOrEqual(400);
    const r2 = await app.inject({
      method: 'POST',
      url: '/hooks/expresscharge/email-hook',
      headers,
      payload: '{}',
    });
    expect(r2.statusCode).toBe(409);
  });
});
