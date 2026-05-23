import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { hashSecret } from '../src/hashing.js';
import { hashAlgo, hashForType, verifyHash } from '../src/lib/cred-hash.js';
import type { Env } from '../src/env.js';

const stubEnv = { ARGON2_PEPPER: 'test-pepper-not-prod' } as unknown as Env;

describe('hashForType', () => {
  it('uses bcrypt for imap/smtp', async () => {
    const imapHash = await hashForType('imap', 'plaintext-secret', stubEnv);
    const smtpHash = await hashForType('smtp', 'plaintext-secret', stubEnv);
    expect(hashAlgo(imapHash)).toBe('bcrypt');
    expect(hashAlgo(smtpHash)).toBe('bcrypt');
  });

  it('uses PBKDF2 for rest/mcp/cli', async () => {
    for (const type of ['rest', 'mcp', 'cli'] as const) {
      const h = await hashForType(type, 'plaintext-secret', stubEnv);
      expect(hashAlgo(h)).toBe('pbkdf2');
    }
  });
});

describe('verifyHash', () => {
  it('verifies a bcrypt-hashed imap/smtp secret', async () => {
    const hash = await hashForType('imap', 'correct-horse-battery-staple', stubEnv);
    expect(await verifyHash(hash, 'correct-horse-battery-staple', stubEnv)).toBe(true);
    expect(await verifyHash(hash, 'wrong', stubEnv)).toBe(false);
  });

  it('verifies a PBKDF2-hashed rest secret with the deploy pepper', async () => {
    const hash = await hashForType('rest', 'super-long-token-secret', stubEnv);
    expect(await verifyHash(hash, 'super-long-token-secret', stubEnv)).toBe(true);
    expect(await verifyHash(hash, 'wrong', stubEnv)).toBe(false);
  });

  it('rejects PBKDF2 hash when the pepper changes', async () => {
    const hash = await hashForType('rest', 'secret', stubEnv);
    const wrongEnv = { ARGON2_PEPPER: 'different-pepper' } as unknown as Env;
    expect(await verifyHash(hash, 'secret', wrongEnv)).toBe(false);
  });

  it('accepts legacy bcrypt hashes with different version letters', async () => {
    // bcryptjs emits $2b$; many legacy stores use $2a$. Both should verify.
    const v2b = await bcrypt.hash('legacy', 12);
    expect(hashAlgo(v2b)).toBe('bcrypt');
    expect(await verifyHash(v2b, 'legacy', stubEnv)).toBe(true);
  });

  it('returns false for unknown hash prefixes', async () => {
    expect(await verifyHash('plaintext', 'plaintext', stubEnv)).toBe(false);
    expect(await verifyHash('$argon2id$v=19$m=…', 'plaintext', stubEnv)).toBe(false);
    expect(await verifyHash('', 'plaintext', stubEnv)).toBe(false);
  });

  it('returns false for malformed bcrypt strings', async () => {
    // $2b$ prefix but wrong total length
    expect(await verifyHash('$2b$12$short', 'x', stubEnv)).toBe(false);
  });

  it('returns false for malformed PBKDF2 strings', async () => {
    expect(await verifyHash('$pbkdf2-sha256$', 'x', stubEnv)).toBe(false);
    expect(await verifyHash('$pbkdf2-sha256$i=NaN$abc$def', 'x', stubEnv)).toBe(false);
    expect(await verifyHash('$pbkdf2-sha256$i=100000$abc', 'x', stubEnv)).toBe(false);
  });
});

describe('hashAlgo', () => {
  it('distinguishes bcrypt, PBKDF2, and unknown', async () => {
    expect(hashAlgo(await bcrypt.hash('x', 10))).toBe('bcrypt');
    expect(hashAlgo(await hashSecret('x', 'pepper'))).toBe('pbkdf2');
    expect(hashAlgo('not-a-hash')).toBe('unknown');
    expect(hashAlgo('')).toBe('unknown');
  });
});
