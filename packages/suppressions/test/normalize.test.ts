import { describe, expect, it } from 'vitest';
import { isActive, normalizeAddress, senderScopeCandidates } from '../src/index.js';

describe('normalizeAddress', () => {
  it('lowercases ASCII local + domain', () => {
    expect(normalizeAddress('Foo@Example.COM')).toEqual({
      normalized: 'foo@example.com',
      local: 'Foo',
      domain: 'example.com',
    });
  });

  it('strips surrounding angle brackets', () => {
    expect(normalizeAddress('<bob@example.org>')!.normalized).toBe('bob@example.org');
  });

  it('returns null on malformed addresses', () => {
    expect(normalizeAddress('')).toBeNull();
    expect(normalizeAddress(null)).toBeNull();
    expect(normalizeAddress(undefined)).toBeNull();
    expect(normalizeAddress('no-at-sign')).toBeNull();
    expect(normalizeAddress('@example.com')).toBeNull();
    expect(normalizeAddress('local@')).toBeNull();
  });

  it('strips Gmail +tags and dots and folds googlemail.com', () => {
    expect(normalizeAddress('Foo.Bar+spam@gmail.com')!.normalized).toBe('foobar@gmail.com');
    expect(normalizeAddress('foobar+anything@googlemail.com')!.normalized).toBe('foobar@gmail.com');
  });

  it('preserves +tags on non-Gmail providers', () => {
    expect(normalizeAddress('foo+bar@protonmail.com')!.normalized).toBe('foo+bar@protonmail.com');
  });

  it('IDNA-encodes unicode domains', () => {
    expect(normalizeAddress('test@münchen.de')!.domain).toBe('xn--mnchen-3ya.de');
  });

  it('NFC-normalizes local part', () => {
    // "café" can be two different NFC/NFD encodings; canonicalize.
    const composed = 'café@example.com'; // é precomposed
    const decomposed = 'café@example.com'; // e + combining acute
    expect(normalizeAddress(composed)!.normalized).toBe(normalizeAddress(decomposed)!.normalized);
  });
});

describe('senderScopeCandidates', () => {
  it('always includes global', () => {
    expect(senderScopeCandidates({})).toEqual([{ scope: 'global', scope_target: null }]);
  });

  it('adds domain, mailbox, sender_address when provided', () => {
    expect(
      senderScopeCandidates({
        domainId: 'D',
        mailboxId: 'M',
        senderAddressId: 'S',
      }),
    ).toEqual([
      { scope: 'global', scope_target: null },
      { scope: 'domain', scope_target: 'D' },
      { scope: 'mailbox', scope_target: 'M' },
      { scope: 'sender_address', scope_target: 'S' },
    ]);
  });
});

describe('isActive', () => {
  it('null = permanent = active', () => {
    expect(isActive(null)).toBe(true);
    expect(isActive(undefined)).toBe(true);
  });

  it('future timestamp = active', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isActive(future)).toBe(true);
  });

  it('past timestamp = inactive', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isActive(past)).toBe(false);
  });

  it('unparseable = fails closed (treated as active)', () => {
    expect(isActive('not-a-date')).toBe(true);
  });
});
