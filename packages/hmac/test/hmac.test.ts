import { describe, expect, it } from 'vitest';
import {
  buildCanonical,
  canonicalQuery,
  constantTimeEqual,
  fromHex,
  generateNonce,
  generateSecret,
  sign,
  toHex,
  verify,
} from '../src/index.js';

function headers(map: Record<string, string>) {
  return {
    get(name: string) {
      return map[name.toLowerCase()] ?? null;
    },
  };
}

const SECRET = 'test-secret-123456789';
const TS = '1700000000000';
const NONCE = 'AAAABBBBCCCCDDDD';

describe('canonicalQuery', () => {
  it('sorts and percent-encodes', () => {
    expect(canonicalQuery('b=2&a=1')).toBe('a=1&b=2');
    expect(canonicalQuery({ B: '1', a: ['2', '3'] })).toBe('a=2&a=3&b=1');
    expect(canonicalQuery('')).toBe('');
    expect(canonicalQuery(undefined)).toBe('');
    expect(canonicalQuery('q=a b')).toBe('q=a%20b');
  });
});

describe('buildCanonical', () => {
  it('produces a stable string', async () => {
    const c = await buildCanonical({
      direction: 'polaris-api.v1',
      method: 'post',
      path: '/v1/send/raw',
      query: 'mode=test',
      ts: TS,
      nonce: NONCE,
      body: '{"hello":"world"}',
    });
    const lines = c.split('\n');
    expect(lines[0]).toBe('polaris-api.v1');
    expect(lines[1]).toBe('POST');
    expect(lines[2]).toBe('/v1/send/raw');
    expect(lines[3]).toBe('mode=test');
    expect(lines[4]).toBe(TS);
    expect(lines[5]).toBe(NONCE);
    expect(lines[6]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects CRLF in ts/nonce', async () => {
    await expect(
      buildCanonical({
        direction: 'polaris-api.v1',
        method: 'POST',
        path: '/x',
        ts: '1700000000\n000',
        nonce: NONCE,
        body: '',
      }),
    ).rejects.toThrow(/whitespace/);
  });

  it('rejects path without leading slash', async () => {
    await expect(
      buildCanonical({
        direction: 'polaris-api.v1',
        method: 'POST',
        path: 'v1/x',
        ts: TS,
        nonce: NONCE,
        body: '',
      }),
    ).rejects.toThrow(/path/);
  });
});

describe('sign + verify', () => {
  const base = {
    direction: 'polaris-api.v1' as const,
    method: 'POST',
    path: '/v1/send/raw',
    query: 'a=1&b=2',
    ts: TS,
    nonce: NONCE,
    body: '{"x":1}',
  };

  it('round-trips', async () => {
    const sig = await sign(base, SECRET);
    const r = await verify({
      ...base,
      headers: headers({ 'x-polaris-ts': TS, 'x-polaris-nonce': NONCE, 'x-polaris-sig': sig }),
      secret: SECRET,
      now: () => Number(TS),
    });
    expect(r.ok).toBe(true);
  });

  it('rejects different method', async () => {
    const sig = await sign(base, SECRET);
    const r = await verify({
      ...base,
      method: 'GET',
      headers: headers({ 'x-polaris-ts': TS, 'x-polaris-nonce': NONCE, 'x-polaris-sig': sig }),
      secret: SECRET,
      now: () => Number(TS),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_signature');
  });

  it('rejects different path', async () => {
    const sig = await sign(base, SECRET);
    const r = await verify({
      ...base,
      path: '/v1/admin/api-keys/foo/rotate',
      headers: headers({ 'x-polaris-ts': TS, 'x-polaris-nonce': NONCE, 'x-polaris-sig': sig }),
      secret: SECRET,
      now: () => Number(TS),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_signature');
  });

  it('rejects different direction', async () => {
    const sig = await sign(base, SECRET);
    const r = await verify({
      ...base,
      direction: 'polaris-webhook.v1',
      headers: headers({ 'x-polaris-ts': TS, 'x-polaris-nonce': NONCE, 'x-polaris-sig': sig }),
      secret: SECRET,
      now: () => Number(TS),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_signature');
  });

  it('rejects tampered body', async () => {
    const sig = await sign(base, SECRET);
    const r = await verify({
      ...base,
      body: '{"x":2}',
      headers: headers({ 'x-polaris-ts': TS, 'x-polaris-nonce': NONCE, 'x-polaris-sig': sig }),
      secret: SECRET,
      now: () => Number(TS),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_signature');
  });

  it('rejects out-of-skew ts', async () => {
    const sig = await sign(base, SECRET);
    const r = await verify({
      ...base,
      headers: headers({ 'x-polaris-ts': TS, 'x-polaris-nonce': NONCE, 'x-polaris-sig': sig }),
      secret: SECRET,
      now: () => Number(TS) + 10 * 60 * 1000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('clock_skew');
  });

  it('rejects algorithm not in allowlist', async () => {
    const sig = (await sign(base, SECRET)).replace(/^v1=/, 'v2=');
    const r = await verify({
      ...base,
      headers: headers({ 'x-polaris-ts': TS, 'x-polaris-nonce': NONCE, 'x-polaris-sig': sig }),
      secret: SECRET,
      now: () => Number(TS),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('algorithm_rejected');
  });

  it('rejects whitespace prefix on algorithm', async () => {
    const sig = (await sign(base, SECRET)).replace(/^v1=/, 'v1\t=');
    const r = await verify({
      ...base,
      headers: headers({ 'x-polaris-ts': TS, 'x-polaris-nonce': NONCE, 'x-polaris-sig': sig }),
      secret: SECRET,
      now: () => Number(TS),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('header_invalid');
  });

  it('rejects CRLF in nonce header', async () => {
    const sig = await sign(base, SECRET);
    const r = await verify({
      ...base,
      headers: headers({
        'x-polaris-ts': TS,
        'x-polaris-nonce': NONCE + '\n',
        'x-polaris-sig': sig,
      }),
      secret: SECRET,
      now: () => Number(TS),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('header_invalid');
  });

  it('rejects truncated hex', async () => {
    const sig = (await sign(base, SECRET)).slice(0, -2);
    const r = await verify({
      ...base,
      headers: headers({ 'x-polaris-ts': TS, 'x-polaris-nonce': NONCE, 'x-polaris-sig': sig }),
      secret: SECRET,
      now: () => Number(TS),
    });
    expect(r.ok).toBe(false);
  });

  it('rejects missing headers', async () => {
    const r = await verify({
      ...base,
      headers: headers({}),
      secret: SECRET,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('missing_header');
  });
});

describe('constantTimeEqual', () => {
  it('compares correctly', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('hex helpers', () => {
  it('round-trips', () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    expect(toHex(bytes)).toBe('0001feff');
    expect([...fromHex('0001feff')]).toEqual([0, 1, 254, 255]);
  });
});

describe('generators', () => {
  it('nonce length and charset', () => {
    const n = generateNonce();
    expect(n.length).toBeGreaterThanOrEqual(16);
    expect(n).toMatch(/^[0-9A-Z]+$/);
  });
  it('secret length and charset', () => {
    const s = generateSecret();
    expect(s.length).toBeGreaterThanOrEqual(40);
    expect(s).toMatch(/^[0-9A-Z]+$/);
  });
});
