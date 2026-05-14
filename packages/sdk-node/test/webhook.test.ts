import { describe, expect, it } from 'vitest';
import { verifyWebhook } from '../src/webhook.js';
import vectors from '../../test-vectors/vectors.json' with { type: 'json' };

interface Vector {
  name: string;
  direction: 'polaris-api.v1' | 'polaris-webhook.v1';
  method: string;
  path: string;
  query: string;
  ts: string;
  nonce: string;
  secret: string;
  body: string;
  expected_sig: string;
  must_verify: boolean;
  expected_error?: string;
}

describe('@polaris/sdk/webhook verifier against shared vectors', () => {
  for (const v of vectors.vectors as Vector[]) {
    it(v.name, () => {
      const r = verifyWebhook({
        direction: v.direction,
        method: v.method,
        path: v.path,
        query: v.query,
        headers: {
          'x-polaris-ts': v.ts,
          'x-polaris-nonce': v.nonce,
          'x-polaris-sig': v.expected_sig,
        },
        body: v.body,
        secret: v.secret,
        now: () => Number(v.ts),
      });
      if (v.must_verify) {
        expect(r.ok).toBe(true);
      } else {
        expect(r.ok).toBe(false);
      }
    });
  }
});

describe('v2 signature tag', () => {
  it('accepts a v2-prefixed signature when in the allowlist (default)', () => {
    const v = (vectors.vectors as Vector[]).find((x) => x.must_verify)!;
    const v2sig = 'v2=' + v.expected_sig.slice(3);
    const r = verifyWebhook({
      direction: v.direction,
      method: v.method,
      path: v.path,
      query: v.query,
      headers: {
        'x-polaris-ts': v.ts,
        'x-polaris-nonce': v.nonce,
        'x-polaris-sig': v2sig,
      },
      body: v.body,
      secret: v.secret,
      now: () => Number(v.ts),
    });
    expect(r.ok).toBe(true);
  });

  it('rejects v1 when only v2 is allowed', () => {
    const v = (vectors.vectors as Vector[]).find((x) => x.must_verify)!;
    const r = verifyWebhook({
      direction: v.direction,
      method: v.method,
      path: v.path,
      query: v.query,
      headers: {
        'x-polaris-ts': v.ts,
        'x-polaris-nonce': v.nonce,
        'x-polaris-sig': v.expected_sig,
      },
      body: v.body,
      secret: v.secret,
      now: () => Number(v.ts),
      allowedAlgorithms: ['v2'],
    });
    expect(r.ok).toBe(false);
  });
});
