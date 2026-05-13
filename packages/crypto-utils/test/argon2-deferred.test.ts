import { describe, expect, it } from 'vitest';
import { decryptRecipients, recipientHashCiphertext } from '../src/argon2-deferred.js';

const KEK = Buffer.from(new Uint8Array(32).fill(0x42)).toString('base64');

describe('argon2-deferred envelope', () => {
  it('round-trips a recipient list', async () => {
    const recipients = ['a@example.com', 'b@example.com', 'c+tag@example.org'];
    const env = await recipientHashCiphertext(recipients, KEK);
    const back = await decryptRecipients(env, KEK);
    expect(back).toEqual(recipients);
  });

  it('produces a different ciphertext each call (random IV)', async () => {
    const recipients = ['x@example.com'];
    const a = await recipientHashCiphertext(recipients, KEK);
    const b = await recipientHashCiphertext(recipients, KEK);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('starts with 12-byte IV + 16-byte tag header', async () => {
    const env = await recipientHashCiphertext(['x@example.com'], KEK);
    expect(env.byteLength).toBeGreaterThanOrEqual(12 + 16 + 1);
  });

  it('rejects wrong KEK', async () => {
    const env = await recipientHashCiphertext(['x@example.com'], KEK);
    const otherKek = Buffer.from(new Uint8Array(32).fill(0x55)).toString('base64');
    await expect(decryptRecipients(env, otherKek)).rejects.toThrow();
  });

  it('rejects bad envelope length', async () => {
    await expect(decryptRecipients(new Uint8Array(5), KEK)).rejects.toThrow();
  });

  it('rejects non-32-byte KEK', async () => {
    const tooShort = Buffer.from(new Uint8Array(16).fill(1)).toString('base64');
    await expect(recipientHashCiphertext(['x@e'], tooShort)).rejects.toThrow();
  });
});
