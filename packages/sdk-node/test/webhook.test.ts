import { describe, expect, it } from 'vitest';
import { verifyWebhook } from '../src/webhook.js';
import vectors from '../../test-vectors/vectors.json' with { type: 'json' };

interface Vector {
  name: string;
  direction: 'polaris-api' | 'polaris-webhook';
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
    it(v.name, async () => {
      const r = await verifyWebhook({
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

describe('un-versioned signature header', () => {
  it('rejects a `v1=…`-prefixed signature outright', async () => {
    const v = (vectors.vectors as Vector[]).find((x) => x.must_verify)!;
    const prefixed = 'v1=' + v.expected_sig;
    const r = await verifyWebhook({
      direction: v.direction,
      method: v.method,
      path: v.path,
      query: v.query,
      headers: {
        'x-polaris-ts': v.ts,
        'x-polaris-nonce': v.nonce,
        'x-polaris-sig': prefixed,
      },
      body: v.body,
      secret: v.secret,
      now: () => Number(v.ts),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_signature');
  });

  it('rejects a `v2=…`-prefixed signature outright', async () => {
    const v = (vectors.vectors as Vector[]).find((x) => x.must_verify)!;
    const prefixed = 'v2=' + v.expected_sig;
    const r = await verifyWebhook({
      direction: v.direction,
      method: v.method,
      path: v.path,
      query: v.query,
      headers: {
        'x-polaris-ts': v.ts,
        'x-polaris-nonce': v.nonce,
        'x-polaris-sig': prefixed,
      },
      body: v.body,
      secret: v.secret,
      now: () => Number(v.ts),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_signature');
  });
});
