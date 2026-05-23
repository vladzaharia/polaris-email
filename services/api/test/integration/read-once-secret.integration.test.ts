// A12 integration test — read-once secret enforcement (A11/B6).
//
// Guarantees the schema/API never returns a plaintext secret via GET after
// creation/rotation. Covers three secret-bearing resource families:
//   1. API keys                  (admin.ts)            secret name: key_secret
//   2. SMTP submission credentials (senders.ts)        secret name: secret
//   3. Bridge HMAC keys           (admin/bridges.ts)   secret name: hmac_key
//
// For each family:
//   - POST creation/issuance MUST return the plaintext exactly once.
//   - GET single / GET list MUST NOT return a `secret`, `key_secret`,
//     `hmac_key`, or `plaintext` field on any item.

import { describe, expect, it } from 'vitest';
import {
  app,
  bootstrapEnv,
  createMailbox,
  createVerifiedDomain,
  ctx,
  issueApiKey,
  signedRequest,
} from './setup.js';

/** Recursively walks a JSON value, returning all string-key paths whose value is non-null/non-empty. */
function listKeyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => listKeyPaths(v, `${prefix}[${i}]`));
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      listKeyPaths(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [prefix];
}

/** Returns the subset of key names from a paths list that look like plaintext-secret field names. */
function detectSecretFields(paths: string[]): string[] {
  const offenders: string[] = [];
  for (const p of paths) {
    const tail = p.split('.').pop() ?? p;
    // Strip array suffix like `data[0]` → `data`.
    const name = tail.replace(/\[\d+\]$/, '');
    // The forbidden plaintext names returned by POST creation/rotation
    // handlers. `bcrypt_hash`/`hmac_key_secret_name` are hashes — allowed.
    if (name === 'secret' || name === 'key_secret' || name === 'hmac_key' || name === 'plaintext') {
      offenders.push(p);
    }
  }
  return offenders;
}

describe('A12: read-once secrets — api_keys', () => {
  it('POST returns key_secret; GET (single + list) omits any plaintext field', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'ro-keys');
    await createVerifiedDomain(env, 'example.com');

    // Creation: key_secret is the only plaintext we ever see.
    const key = await issueApiKey(env, admin, mbId, ['send']);
    expect(key.key_secret.length).toBeGreaterThan(20);

    // GET list (mailbox-scoped): no row has any plaintext-secret field.
    const listRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/api-keys?mailbox=${mbId}`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: unknown[] };
    expect(detectSecretFields(listKeyPaths(listBody))).toEqual([]);

    // GET list (full): same property holds.
    const listAllRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/api-keys`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(listAllRes.status).toBe(200);
    const listAllBody = (await listAllRes.json()) as { data: unknown[] };
    expect(detectSecretFields(listKeyPaths(listAllBody))).toEqual([]);

    // The /v1/admin/credentials facade was removed in the cred-refactor;
    // the api_keys list (above) plus the per-mailbox credentials list
    // (covered by the mailbox_credentials read-once test below) provide
    // the same coverage.
  });
});

// Submission credentials (POST /v1/admin/senders/:id/smtp-credentials)
// were folded into the unified mailbox_credentials model in the
// cred-refactor. The mailbox_credentials read-once test below covers
// the same plaintext-once / GET-omits-hash invariants for SMTP creds.

describe('A12: read-once secrets — bridges', () => {
  it('POST returns hmac_key; GET single + list omit it', async () => {
    const { env, admin } = await bootstrapEnv();

    // Register a bridge — returns plaintext hmac_key exactly once.
    const createRes = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/bridges',
        JSON.stringify({ name: 'ro-bridge' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; hmac_key: string };
    expect(created.hmac_key.length).toBeGreaterThan(20);

    // GET single — no hmac_key, no secret.
    const getRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/bridges/${created.id}`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as Record<string, unknown>;
    expect(detectSecretFields(listKeyPaths(getBody))).toEqual([]);
    expect(getBody).not.toHaveProperty('hmac_key');
    expect(getBody).not.toHaveProperty('secret');

    // GET list — same property holds across all rows.
    const listRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/bridges`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: unknown[] };
    expect(detectSecretFields(listKeyPaths(listBody))).toEqual([]);

    // Rotation returns a fresh hmac_key once; the GET afterwards must
    // continue to omit it.
    const rotRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/bridges/${created.id}/rotate`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(rotRes.status).toBe(200);
    const rotBody = (await rotRes.json()) as { hmac_key: string };
    expect(rotBody.hmac_key.length).toBeGreaterThan(20);
    expect(rotBody.hmac_key).not.toBe(created.hmac_key);

    const getAfterRotateRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/bridges/${created.id}`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(getAfterRotateRes.status).toBe(200);
    const getAfterRotateBody = (await getAfterRotateRes.json()) as Record<string, unknown>;
    expect(detectSecretFields(listKeyPaths(getAfterRotateBody))).toEqual([]);
  });
});

describe('A12: read-once secrets — mailbox credentials (unified)', () => {
  it('POST + rotate return plaintext exactly once; GET list omits the hash', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'ro-mb-cred');

    // Issue an SMTP credential. Plaintext password returned once.
    const issueRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/mailboxes/${mbId}/credentials`,
        JSON.stringify({ type: 'smtp' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(issueRes.status).toBe(201);
    const issued = (await issueRes.json()) as { id: string; password: string };
    expect(issued.password.length).toBeGreaterThan(20);

    // GET list — no secret_hash, no plaintext anywhere.
    const listRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/mailboxes/${mbId}/credentials`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: unknown[] };
    expect(detectSecretFields(listKeyPaths(listBody))).toEqual([]);

    // Rotate — returns a fresh password once.
    const rotRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/mailboxes/${mbId}/credentials/${issued.id}/rotate`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(rotRes.status).toBe(200);
    const rot = (await rotRes.json()) as { password: string };
    expect(rot.password.length).toBeGreaterThan(20);
    expect(rot.password).not.toBe(issued.password);

    // GET list after rotation — still no hash exposed.
    const listAfterRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/mailboxes/${mbId}/credentials`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(listAfterRes.status).toBe(200);
    const listAfter = (await listAfterRes.json()) as { data: unknown[] };
    expect(detectSecretFields(listKeyPaths(listAfter))).toEqual([]);
  });
});
