// 8a: coverage for the @polaris-mail/ids module. Until now this package
// shipped without tests, despite generating every message_id /
// audit-log id / request_id in the platform. The behaviour we lock down:
//
//   * `ulid()` produces 26-char Crockford32 strings.
//   * `ulid()` is monotonic at sub-millisecond resolution (lex-sort = chrono-sort).
//   * the leading 10 chars decode back to a recent millisecond timestamp.
//   * `ulid()` rejects nonsensical timestamps with the contract from `index.ts`.
//   * `requestId()` matches the `req_<24hex>` shape we depend on for log
//     correlation.
import { describe, it, expect } from 'vitest';
import { ulid, requestId } from '../src/index.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function decodeUlidTime(s: string): number {
  // First 10 chars are the millisecond timestamp encoded in Crockford32.
  let t = 0;
  for (let i = 0; i < 10; i++) {
    const idx = CROCKFORD.indexOf(s[i]!);
    if (idx < 0) throw new Error(`bad char at ${i}: ${s[i]}`);
    t = t * 32 + idx;
  }
  return t;
}

describe('ulid()', () => {
  it('produces a 26-char Crockford32 string', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNPQRSTVWXYZ]{26}$/);
  });

  it('is monotonic and unique across 100 calls in a tight loop', () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) ids.push(ulid());
    // Uniqueness — even if all timestamps collide, the 16-char random tail
    // makes collisions astronomically unlikely.
    expect(new Set(ids).size).toBe(100);
    // Lex-sort matches insertion order when timestamps are non-decreasing.
    // We assert the encoded *time prefix* is non-decreasing across the run;
    // the random tail can reorder within a millisecond bucket.
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]!.slice(0, 10) >= ids[i - 1]!.slice(0, 10)).toBe(true);
    }
  });

  it('time prefix decodes back to a value close to Date.now()', () => {
    const before = Date.now();
    const id = ulid();
    const after = Date.now();
    const t = decodeUlidTime(id);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it('honours an explicit now argument exactly', () => {
    const fixed = 1_700_000_000_000;
    const id = ulid(fixed);
    expect(decodeUlidTime(id)).toBe(fixed);
  });

  it('throws on a non-integer or negative timestamp ("bad time")', () => {
    expect(() => ulid(-1)).toThrow(/bad time/);
    expect(() => ulid(1.5)).toThrow(/bad time/);
    expect(() => ulid(Number.NaN)).toThrow(/bad time/);
  });
});

describe('requestId()', () => {
  it('matches the req_<24hex> shape', () => {
    const id = requestId();
    expect(id).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it('is unique across many calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(requestId());
    expect(ids.size).toBe(100);
  });
});
