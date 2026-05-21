// Tests for the PR 7 bootstrap additions: idempotency-key replay, the
// already_bootstrapped error code, the webauthn poll endpoint, and the
// completion handshake.
//
// The base bootstrap test in api.test.ts already covers the success path
// + 409 replay; this file focuses on the new affordances the Go CLI's
// genesis-seal flow consumes.
import { describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { mkEnv } from './mocks.js';
import { sign, generateNonce } from '@polaris-mail/hmac';

const ctx = {
  passThroughOnException: () => undefined,
  waitUntil: (p: Promise<unknown>) => p,
} as unknown as ExecutionContext;

async function signedBootstrap(
  env: ReturnType<typeof mkEnv>,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const url = 'https://polaris-mail-api.workers.dev/v1/admin/bootstrap';
  const u = new URL(url);
  const ts = String(Date.now());
  const nonce = generateNonce();
  const sig = await sign(
    {
      direction: 'polaris-api',
      method: 'POST',
      path: u.pathname,
      query: u.search,
      ts,
      nonce,
      body,
    },
    env.POLARIS_SECRET_A!,
  );
  return app.fetch(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-polaris-ts': ts,
        'x-polaris-nonce': nonce,
        'x-polaris-sig': sig,
        ...extraHeaders,
      },
      body,
    }),
    env,
    ctx,
  );
}

interface BootstrapResponse {
  admin_key_id: string;
  admin_key_secret: string;
  mailbox_id: string;
  setup_code: string;
  webauthn_enrol_url: string;
}

describe('bootstrap idempotency', () => {
  it('returns setup_code + webauthn_enrol_url on first run', async () => {
    const env = mkEnv();
    const res = await signedBootstrap(env, '{}');
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootstrapResponse;
    expect(body.admin_key_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.setup_code).toMatch(/^[0-9A-Z]+$/);
    expect(body.webauthn_enrol_url).toContain('/setup/webauthn?code=');
    expect(body.webauthn_enrol_url).toContain(body.setup_code);
  });

  it('returns 409 already_bootstrapped on replay without Idempotency-Key', async () => {
    const env = mkEnv();
    const first = await signedBootstrap(env, '{}');
    expect(first.status).toBe(200);
    const replay = await signedBootstrap(env, '{}');
    expect(replay.status).toBe(409);
    const errBody = (await replay.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe('already_bootstrapped');
  });

  it('returns prior response on replay WITH matching Idempotency-Key', async () => {
    // The Idempotency-Key path replays the cached response. To make the
    // "prior" lookup do something the bootstrap-table check wouldn't
    // also satisfy, we test that the second call returns identical JSON
    // (same admin_key_id + secret) under a fresh request.
    const env = mkEnv();
    const idemKey = 'test-idem-key-12345';
    const first = await signedBootstrap(env, '{}', { 'Idempotency-Key': idemKey });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as BootstrapResponse;
    const replay = await signedBootstrap(env, '{}', { 'Idempotency-Key': idemKey });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as BootstrapResponse;
    expect(replayBody.admin_key_id).toBe(firstBody.admin_key_id);
    expect(replayBody.admin_key_secret).toBe(firstBody.admin_key_secret);
    expect(replayBody.setup_code).toBe(firstBody.setup_code);
  });

  it('different Idempotency-Key still trips the already_bootstrapped guard', async () => {
    const env = mkEnv();
    const first = await signedBootstrap(env, '{}', { 'Idempotency-Key': 'first-key' });
    expect(first.status).toBe(200);
    // A second call with a *different* idem key can't have a cached
    // entry, so it falls through to the admin-key-exists check.
    const replay = await signedBootstrap(env, '{}', { 'Idempotency-Key': 'different-key' });
    expect(replay.status).toBe(409);
    const errBody = (await replay.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe('already_bootstrapped');
  });
});

describe('webauthn setup poll', () => {
  it('returns status=pending immediately after bootstrap', async () => {
    const env = mkEnv();
    const res = await signedBootstrap(env, '{}');
    const body = (await res.json()) as BootstrapResponse;
    const pollRes = await app.fetch(
      new Request(
        `https://polaris-mail-api.workers.dev/v1/admin/setup/webauthn/${body.setup_code}`,
      ),
      env,
      ctx,
    );
    expect(pollRes.status).toBe(200);
    const pollBody = (await pollRes.json()) as { status: string };
    expect(pollBody.status).toBe('pending');
  });

  it('returns status=expired for an unknown code', async () => {
    const env = mkEnv();
    const res = await app.fetch(
      new Request('https://polaris-mail-api.workers.dev/v1/admin/setup/webauthn/unknowncode1234'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('expired');
  });

  it('flips to complete after POST .../complete with valid signature', async () => {
    const env = mkEnv();
    const res = await signedBootstrap(env, '{}');
    const body = (await res.json()) as BootstrapResponse;

    // POST /v1/admin/setup/webauthn/<code>/complete, signed with the
    // freshly minted admin key.
    const completePath = `/v1/admin/setup/webauthn/${body.setup_code}/complete`;
    const completeURL = `https://polaris-mail-api.workers.dev${completePath}`;
    const completeBody = JSON.stringify({ credential_id: 'webauthn-cred-1' });
    const ts = String(Date.now());
    const nonce = generateNonce();
    const sig = await sign(
      {
        direction: 'polaris-api',
        method: 'POST',
        path: completePath,
        query: '',
        ts,
        nonce,
        body: completeBody,
      },
      body.admin_key_secret,
    );
    const completeRes = await app.fetch(
      new Request(completeURL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-polaris-ts': ts,
          'x-polaris-nonce': nonce,
          'x-polaris-sig': sig,
        },
        body: completeBody,
      }),
      env,
      ctx,
    );
    expect(completeRes.status).toBe(200);

    // Poll now returns complete.
    const pollRes = await app.fetch(
      new Request(
        `https://polaris-mail-api.workers.dev/v1/admin/setup/webauthn/${body.setup_code}`,
      ),
      env,
      ctx,
    );
    const pollBody = (await pollRes.json()) as { status: string };
    expect(pollBody.status).toBe('complete');
  });

  it('rejects /complete with bad signature', async () => {
    const env = mkEnv();
    const res = await signedBootstrap(env, '{}');
    const body = (await res.json()) as BootstrapResponse;
    const completePath = `/v1/admin/setup/webauthn/${body.setup_code}/complete`;
    const completeURL = `https://polaris-mail-api.workers.dev${completePath}`;
    const completeRes = await app.fetch(
      new Request(completeURL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-polaris-ts': String(Date.now()),
          'x-polaris-nonce': generateNonce(),
          'x-polaris-sig': 'b'.repeat(64),
        },
        body: '{}',
      }),
      env,
      ctx,
    );
    expect(completeRes.status).toBe(401);
  });
});
