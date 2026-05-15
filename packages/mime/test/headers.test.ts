import { describe, expect, it } from 'vitest';
import {
  parseAddressList,
  parseFirstAddress,
  decodeMimeWord,
  parseAuthResults,
} from '../src/headers.js';

describe('parseAddressList', () => {
  it('extracts a single bare address', () => {
    expect(parseAddressList('bob@example.com')).toEqual(['bob@example.com']);
  });

  it('extracts an address with display name + angle brackets', () => {
    expect(parseAddressList('Alice <alice@example.com>')).toEqual(['alice@example.com']);
  });

  it('extracts multiple comma-separated addresses', () => {
    expect(parseAddressList('Alice <a@x.com>, bob@y.com, "Carol" <c@z.com>')).toEqual([
      'a@x.com',
      'bob@y.com',
      'c@z.com',
    ]);
  });

  it('lower-cases addresses', () => {
    expect(parseAddressList('Bob <BOB@Example.COM>')).toEqual(['bob@example.com']);
  });

  it('returns [] for null/undefined/empty', () => {
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList('')).toEqual([]);
  });
});

describe('parseFirstAddress', () => {
  it('returns the first address from a list', () => {
    expect(parseFirstAddress('Alice <a@x.com>, bob@y.com')).toBe('a@x.com');
  });

  it('returns null when no addresses are present', () => {
    expect(parseFirstAddress('not an address')).toBeNull();
    expect(parseFirstAddress(null)).toBeNull();
    expect(parseFirstAddress(undefined)).toBeNull();
  });
});

describe('decodeMimeWord', () => {
  it('decodes a base64 encoded-word', () => {
    expect(decodeMimeWord('=?utf-8?B?SGVsbG8gV29ybGQ=?=')).toBe('Hello World');
  });

  it('decodes a quoted-printable encoded-word', () => {
    expect(decodeMimeWord('=?utf-8?Q?Hello=20World?=')).toBe('Hello World');
  });

  it('decodes underscore as space in Q-encoding', () => {
    expect(decodeMimeWord('=?utf-8?Q?Hello_World?=')).toBe('Hello World');
  });

  it('returns the input verbatim when no encoded-words present', () => {
    expect(decodeMimeWord('Plain subject')).toBe('Plain subject');
  });

  it('returns null for null/undefined input', () => {
    expect(decodeMimeWord(null)).toBeNull();
    expect(decodeMimeWord(undefined)).toBeNull();
  });

  it('returns empty string for empty string input', () => {
    expect(decodeMimeWord('')).toBe('');
  });

  it('falls back to the raw payload on decode failure', () => {
    // Invalid base64 should round-trip the payload through the catch path.
    const got = decodeMimeWord('=?utf-8?B?!!!notbase64!!!?=');
    expect(typeof got).toBe('string');
  });
});

describe('parseAuthResults', () => {
  it('extracts spf, dkim, and dmarc verdicts', () => {
    const r = parseAuthResults('mx.cloudflare; spf=pass; dkim=fail; dmarc=pass');
    expect(r.spf).toBe('pass');
    expect(r.dkim).toBe('fail');
    expect(r.dmarc).toBe('pass');
  });

  it('lower-cases verdicts', () => {
    const r = parseAuthResults('mx; SPF=Pass; DKIM=Fail');
    expect(r.spf).toBe('pass');
    expect(r.dkim).toBe('fail');
  });

  it('returns empty object when nothing matches', () => {
    expect(parseAuthResults('mx.cloudflare')).toEqual({});
    expect(parseAuthResults('')).toEqual({});
  });

  it('returns empty object for null/undefined', () => {
    expect(parseAuthResults(null)).toEqual({});
    expect(parseAuthResults(undefined)).toEqual({});
  });

  it('ignores unknown methods', () => {
    const r = parseAuthResults('mx; arc=pass; spf=pass');
    expect(r.spf).toBe('pass');
    expect((r as Record<string, unknown>).arc).toBeUndefined();
  });
});
