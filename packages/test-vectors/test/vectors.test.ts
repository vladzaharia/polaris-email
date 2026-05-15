import { describe, expect, it } from 'vitest';
import { verify } from '@polaris-email/hmac';
import vectors from '../vectors.json' with { type: 'json' };

function headers(map: Record<string, string>) {
  return {
    get(name: string) {
      return map[name.toLowerCase()] ?? null;
    },
  };
}

describe('vectors round-trip against hmac package', () => {
  for (const v of vectors.vectors as Array<{
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
  }>) {
    it(v.name, async () => {
      const r = await verify({
        direction: v.direction,
        method: v.method,
        path: v.path,
        query: v.query,
        headers: headers({
          'x-polaris-ts': v.ts,
          'x-polaris-nonce': v.nonce,
          'x-polaris-sig': v.expected_sig,
        }),
        body: v.body,
        secret: v.secret,
        now: () => Number(v.ts),
      });
      if (v.must_verify) {
        expect(r.ok, JSON.stringify(r)).toBe(true);
      } else {
        expect(r.ok).toBe(false);
        if (!r.ok && v.expected_error) {
          expect(r.code).toBe(v.expected_error);
        }
      }
    });
  }
});
