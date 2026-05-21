import { describe, expect, it } from 'vitest';
import { sign } from '@polaris-mail/hmac';
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

// 8g — cross-SDK interop. The same vector is consumed by sdk-go's
// TestCrossSDKInteropPipeQuery (packages/sdk-go/webhook_test.go). Both
// SDKs must produce a byte-identical signature when given a query string
// with percent-encoded `|` characters and a non-empty JSON body — the
// exact divergence-prone shape that has bitten verifiers in other
// projects. Verifying here AND in sdk-go locks the canonical form down
// from both sides.
describe('cross-SDK interop vector', () => {
  it('sdk-node sign() matches the canonical expected_sig', async () => {
    const v = (vectors.vectors as Vector[]).find(
      (x) => x.name === 'interop/POST/query-pipe-encoded-with-body',
    );
    expect(v, 'interop vector missing — regenerate vectors.json').toBeTruthy();
    const got = await sign(
      {
        direction: v!.direction,
        method: v!.method,
        path: v!.path,
        query: v!.query,
        ts: v!.ts,
        nonce: v!.nonce,
        body: v!.body,
      },
      v!.secret,
    );
    expect(got).toBe(v!.expected_sig);
  });
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
