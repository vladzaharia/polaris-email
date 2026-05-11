import { describe, expect, it } from 'vitest';
import { verify } from '../src/index.js';
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

describe('node verifier against shared vectors', () => {
  for (const v of vectors.vectors as Vector[]) {
    it(v.name, () => {
      const r = verify({
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
        if (!r.ok && v.expected_error) expect(r.code).toBe(v.expected_error);
      }
    });
  }
});
