import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

function mkMasterB64() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

describe('forensic worker', () => {
  it('round-trip encrypt/decrypt', async () => {
    const env = { KEY_VERSION: '1', FORENSIC_MASTER_KEY: mkMasterB64() };
    const enc = await worker.fetch(
      new Request('https://x/encrypt', {
        method: 'POST',
        body: JSON.stringify({
          message_id: 'M1',
          tenant_id: 'svc',
          plaintext: JSON.stringify(['a@b.com', 'c@d.com']),
        }),
      }),
      env,
    );
    expect(enc.status).toBe(200);
    const { ciphertext } = (await enc.json()) as { ciphertext: string };
    const dec = await worker.fetch(
      new Request('https://x/decrypt', {
        method: 'POST',
        body: JSON.stringify({
          message_id: 'M1',
          tenant_id: 'svc',
          ciphertext,
          incident_ticket_id: 'INC-1',
          primary_subject: 'a@team.com',
          approver_subject: 'b@team.com',
        }),
      }),
      env,
    );
    expect(dec.status).toBe(200);
    const { plaintext } = (await dec.json()) as { plaintext: string };
    expect(plaintext).toBe(JSON.stringify(['a@b.com', 'c@d.com']));
  });
  it('requires two distinct subjects', async () => {
    const env = { KEY_VERSION: '1', FORENSIC_MASTER_KEY: mkMasterB64() };
    const enc = await worker.fetch(
      new Request('https://x/encrypt', {
        method: 'POST',
        body: JSON.stringify({ message_id: 'M1', tenant_id: null, plaintext: 'x' }),
      }),
      env,
    );
    const { ciphertext } = (await enc.json()) as { ciphertext: string };
    const dec = await worker.fetch(
      new Request('https://x/decrypt', {
        method: 'POST',
        body: JSON.stringify({
          message_id: 'M1',
          tenant_id: null,
          ciphertext,
          incident_ticket_id: 'I',
          primary_subject: 'a@team.com',
          approver_subject: 'a@team.com',
        }),
      }),
      env,
    );
    expect(dec.status).toBe(403);
  });
  it('different message_id rejects ciphertext', async () => {
    const env = { KEY_VERSION: '1', FORENSIC_MASTER_KEY: mkMasterB64() };
    const enc = await worker.fetch(
      new Request('https://x/encrypt', {
        method: 'POST',
        body: JSON.stringify({ message_id: 'M1', tenant_id: null, plaintext: 'x' }),
      }),
      env,
    );
    const { ciphertext } = (await enc.json()) as { ciphertext: string };
    const dec = await worker.fetch(
      new Request('https://x/decrypt', {
        method: 'POST',
        body: JSON.stringify({
          message_id: 'M2',
          tenant_id: null,
          ciphertext,
          incident_ticket_id: 'I',
          primary_subject: 'a@team.com',
          approver_subject: 'b@team.com',
        }),
      }),
      env,
    );
    expect(dec.status).toBe(400);
  });
  it('refuses when master key missing', async () => {
    const env = { KEY_VERSION: '1' };
    const res = await worker.fetch(
      new Request('https://x/encrypt', { method: 'POST', body: '{}' }),
      env,
    );
    expect(res.status).toBe(500);
  });
});
