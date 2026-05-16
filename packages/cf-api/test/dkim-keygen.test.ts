// W10 — DKIM keygen tests. Asserts both algorithms produce non-empty
// base64-encoded SPKI public + PKCS#8 private keys, and that the
// derived-selector logic uses the additive polaris{YYYY} namespace
// without ever colliding with CF's `cf*` primary.
import { describe, expect, it } from 'vitest';
import { generateKeyMaterial, planRotation } from '../src/dkim-rotation.js';

describe('W10 — generateKeyMaterial', () => {
  it('ed25519 produces base64 SPKI public + PKCS#8 private', async () => {
    const k = await generateKeyMaterial('ed25519');
    expect(k.publicKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(k.privateKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(k.publicKey.length).toBeGreaterThan(30);
    expect(k.privateKey.length).toBeGreaterThan(30);
  });

  it('rsa2048 produces a longer public key (2048-bit modulus)', async () => {
    const k = await generateKeyMaterial('rsa2048');
    expect(k.publicKey.length).toBeGreaterThan(300);
  });
});

describe('W10 — selector derivation', () => {
  it('fresh rotation starts at polaris<YYYY>-1', async () => {
    const plan = await planRotation({
      current: null,
      algo: 'ed25519',
      domain: 'example.com',
    });
    expect(plan.pendingKey.selector).toMatch(/^polaris\d{4}-1$/);
  });

  it('refuses to inherit a cf* selector — starts new polaris namespace', async () => {
    const plan = await planRotation({
      current: {
        id: 'k',
        domainId: 'd',
        selector: 'cf2024-1',
        publicKey: 'pk',
        algo: 'ed25519',
        state: 'active',
      },
      algo: 'ed25519',
      domain: 'example.com',
    });
    expect(plan.pendingKey.selector).toMatch(/^polaris\d{4}-1$/);
  });

  it('bumps an existing polaris<YYYY>-<seq> selector', async () => {
    const plan = await planRotation({
      current: {
        id: 'k',
        domainId: 'd',
        selector: 'polaris2026-3',
        publicKey: 'pk',
        algo: 'ed25519',
        state: 'active',
      },
      algo: 'ed25519',
      domain: 'example.com',
    });
    expect(plan.pendingKey.selector).toMatch(/^polaris\d{4}-4$/);
  });
});
