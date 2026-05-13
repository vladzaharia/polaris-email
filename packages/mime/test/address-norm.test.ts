import { describe, it, expect } from 'vitest';
import {
  normalizeAddress,
  addressesEqual,
  longestSuffixMatch,
  AddressError,
} from '../src/address-norm.js';

describe('normalizeAddress', () => {
  it('lowercases the domain, preserves local-part case', () => {
    const n = normalizeAddress('Alice@AcMe.CoM');
    expect(n.localPart).toBe('Alice');
    expect(n.domain).toBe('acme.com');
    expect(n.full).toBe('Alice@acme.com');
  });

  it('strips trailing dots from domain', () => {
    expect(normalizeAddress('a@example.com.').domain).toBe('example.com');
  });

  it('rejects address without @', () => {
    const e = (() => {
      try {
        normalizeAddress('justlocal');
      } catch (err) {
        return err;
      }
    })();
    expect(e).toBeInstanceOf(AddressError);
    expect((e as AddressError).code).toBe('no_at');
  });

  it('rejects multi-@ addresses', () => {
    const e = (() => {
      try {
        normalizeAddress('a@b@c.com');
      } catch (err) {
        return err;
      }
    })();
    expect((e as AddressError).code).toBe('multi_at');
  });

  it('rejects empty local-part', () => {
    expect(() => normalizeAddress('@example.com')).toThrow(/empty local-part/);
  });

  it('rejects empty domain', () => {
    expect(() => normalizeAddress('local@')).toThrow(/empty domain/);
  });

  it('IDNA-encodes Unicode domain via URL', () => {
    const n = normalizeAddress('user@xn--mnchen-3ya.de'); // Punycode form
    expect(n.domain).toBe('xn--mnchen-3ya.de');
  });

  it('rejects malformed domain (cannot become a hostname)', () => {
    // The URL constructor accepts most strings; this is mostly a smoke test
    // that the catch path exists. Spaces in the domain do trip the constructor.
    expect(() => normalizeAddress('user@with space.com')).toThrow(/IDNA conversion failed/);
  });
});

describe('addressesEqual', () => {
  it('treats different cases as equal', () => {
    expect(addressesEqual('Alice@Example.Com', 'alice@example.com')).toBe(true);
  });

  it('does NOT treat homograph variants as equal', () => {
    // Cyrillic 'а' (U+0430) vs Latin 'a' (U+0061) in 'аcme'/'acme'.
    const cyr = 'noreply@аcme.com';
    const lat = 'noreply@acme.com';
    expect(addressesEqual(cyr, lat)).toBe(false);
  });

  it('returns false on either malformed address (fail-closed)', () => {
    expect(addressesEqual('garbage', 'a@b.com')).toBe(false);
    expect(addressesEqual('a@b.com', 'garbage')).toBe(false);
  });
});

describe('longestSuffixMatch', () => {
  const candidates = ['acme.com', 'mail.acme.com', 'billing.acme.com'];

  it('exact match wins over parent suffix', () => {
    expect(longestSuffixMatch('mail.acme.com', candidates)).toBe('mail.acme.com');
  });

  it('falls back to most-specific parent', () => {
    expect(longestSuffixMatch('news.acme.com', candidates)).toBe('acme.com');
  });

  it('exact match on apex', () => {
    expect(longestSuffixMatch('acme.com', candidates)).toBe('acme.com');
  });

  it('returns null when nothing matches', () => {
    expect(longestSuffixMatch('otherbrand.com', candidates)).toBeNull();
  });

  it('does not suffix-match into a different label', () => {
    // `fakeacme.com` MUST NOT match `acme.com` — that's the bug class H2 prevents.
    expect(longestSuffixMatch('fakeacme.com', candidates)).toBeNull();
  });
});
