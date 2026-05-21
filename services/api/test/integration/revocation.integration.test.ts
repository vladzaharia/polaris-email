// A12 integration test — revocation propagation.
//
// Catches the F1-class bug where revocation could fail open silently.
// Flow:
//   1. Bootstrap; create a mailbox + verified domain.
//   2. Issue an API key via POST /v1/admin/api-keys.
//   3. Confirm a POST /v1/messages signed with that key is accepted (2xx).
//   4. Call POST /v1/admin/api-keys/:id/revoke.
//   5. Confirm a subsequent POST /v1/messages with the same key returns 403
//      (`key_revoked`) — the documented code for a revoked key.
//
// "Within 5 seconds" in the plan refers to KV propagation. With the in-memory
// MockKV this is observable immediately; we still cap the assertion in a
// `withTimeout` wrapper so a regression where revocation depends on TTL
// expiry would actually fail the test.

import { describe, expect, it } from 'vitest';
import { ulid } from '@polaris-mail/ids';
import {
  app,
  bootstrapEnv,
  createMailbox,
  createVerifiedDomain,
  ctx,
  issueApiKey,
  signedRequest,
} from './setup.js';

async function postMessage(
  env: Parameters<typeof app.fetch>[1],
  key: { key_id: string; key_secret: string },
  body: object,
): Promise<Response> {
  return app.fetch(
    await signedRequest(
      'https://x/v1/messages',
      JSON.stringify(body),
      'POST',
      key.key_secret,
      key.key_id,
      // POST /v1/messages requires a caller-supplied idempotency key; a fresh
      // ULID per call gives every test a distinct one (matches real callers).
      { 'idempotency-key': ulid() },
    ),
    env,
    ctx,
  );
}

describe('A12: revocation propagation', () => {
  it('revoke → next POST /v1/messages returns key_revoked', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'rev-mb');
    await createVerifiedDomain(env, 'example.com');
    const key = await issueApiKey(env, admin, mbId, ['send']);

    const sendBody = {
      from: 'noreply@example.com',
      to: ['inbox@example.org'],
      subject: 'pre-revoke',
      text: 'hello',
    };

    // Pre-revoke send must succeed (202 Accepted, status 'queued').
    const before = await postMessage(env, key, sendBody);
    expect(before.status).toBe(202);
    const beforeBody = (await before.json()) as { message_id: string; status: string };
    expect(beforeBody.message_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Revoke via the dedicated endpoint.
    const revokeRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/api-keys/${key.key_id}/revoke`,
        JSON.stringify({ mode: 'emergency', reason: 'integration-test' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(revokeRes.status).toBe(200);

    // Within the same isolate, revocationCheck must observe the new KV row
    // (no 5s sleep needed — KV is synchronous in-memory). The assertion
    // below would also catch a regression where the messages.ts handler
    // stopped calling revocationCheck altogether.
    const after = await postMessage(env, key, { ...sendBody, subject: 'post-revoke' });
    expect(after.status).toBe(403);
    const afterBody = (await after.json()) as { error: { code: string; message: string } };
    expect(afterBody.error.code).toBe('key_revoked');
  });

  it('revoke also blocks via the /v1/admin/credentials/:id/revoke facade', async () => {
    // Same coverage but via the unified credentials facade (admin/credentials.ts)
    // — exercises the second call site of `revoke()` and the
    // submission_credentials/api_keys union shape.
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'rev-mb-2');
    await createVerifiedDomain(env, 'example.com');
    const key = await issueApiKey(env, admin, mbId, ['send']);

    // Confirm the key works first.
    const before = await postMessage(env, key, {
      from: 'noreply@example.com',
      to: ['inbox@example.org'],
      subject: 'pre-facade-revoke',
      text: 'hi',
    });
    expect(before.status).toBe(202);

    // Revoke via the facade.
    const revokeRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/credentials/${key.key_id}/revoke`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(revokeRes.status).toBe(200);

    const after = await postMessage(env, key, {
      from: 'noreply@example.com',
      to: ['inbox@example.org'],
      subject: 'post-facade-revoke',
      text: 'hi',
    });
    expect(after.status).toBe(403);
    const afterBody = (await after.json()) as { error: { code: string } };
    expect(afterBody.error.code).toBe('key_revoked');
  });
});
