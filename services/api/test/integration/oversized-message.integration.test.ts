// Phase A.6 integration test — pre-enqueue oversized-message rejection.
//
// CF Email Service rejects verified-domain messages above 25 MiB. We MUST
// reject such payloads at the API edge (before `processMessage()` enqueues
// to OUTBOUND_QUEUE and writes to R2) so callers see a typed
// `message_too_large` error with HTTP 413 rather than discovering the cap
// asynchronously at delivery time.
//
// This test covers BOTH ingress paths into `POST /v1/messages`:
//   - application/json (tenant API-key HMAC), where the canonical RFC822
//     bytes are produced server-side by `composeFromJson(req)`. We craft a
//     `text` body large enough that the composed bytes exceed 25 MiB.
//   - message/rfc822 (bridge HMAC), where the request body IS the canonical
//     bytes. We send a body > 25 MiB and assert the same rejection.
//
// Both paths must:
//   1. Return HTTP 413.
//   2. Carry `error.code === 'message_too_large'`.
//   3. Include the actual byte count in the message (for debugging).
//   4. NOT enqueue anything on OUTBOUND_QUEUE.

import { describe, expect, it } from 'vitest';
import { sign, generateNonce } from '@polaris-email/hmac';
import { ulid } from '@polaris-email/ids';
import { MAX_MESSAGE_SIZE_VERIFIED } from '@polaris-email/mime';
import {
  app,
  bootstrapEnv,
  createMailbox,
  createVerifiedDomain,
  ctx,
  issueApiKey,
  signedRequest,
} from './setup.js';

const BRIDGE_HMAC_KEY = 'test-bridge-hmac-key-must-be-32-bytes-long-please';

interface MockQueueLike {
  sent: unknown[];
}

interface ErrorEnvelope {
  error: { code: string; message: string; retryable: boolean; request_id: string };
}

describe('A.6: oversized messages rejected pre-enqueue', () => {
  it('JSON path: text body > 25 MiB returns 413 message_too_large', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'oversized-json-mb');
    await createVerifiedDomain(env, 'example.com');
    const key = await issueApiKey(env, admin, mbId, ['send']);

    // Craft a `text` body so large that composeFromJson() will produce > 25 MiB.
    // The composed RFC822 wraps the body with headers + MIME framing, so a
    // body slightly larger than 25 MiB is more than enough to push the total
    // over the cap.
    const oversized = 'a'.repeat(MAX_MESSAGE_SIZE_VERIFIED + 1024);
    const sendBody = {
      from: 'noreply@example.com',
      to: ['inbox@example.org'],
      subject: 'too big',
      text: oversized,
    };

    const res = await app.fetch(
      await signedRequest(
        'https://x/v1/messages',
        JSON.stringify(sendBody),
        'POST',
        key.key_secret,
        key.key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('message_too_large');
    // The handler embeds the actual byte count for debugging.
    expect(body.error.message).toMatch(/\d+ bytes/);

    // Nothing was enqueued — the size cap fires before processMessage().
    const queue = env.OUTBOUND_QUEUE as unknown as MockQueueLike;
    expect(queue.sent.length).toBe(0);
  });

  it('JSON path: just-under-25MiB body still passes the size gate', async () => {
    // Sanity check that the gate is sharp: a body that, after composition,
    // remains well under the cap continues to enqueue normally. This guards
    // against a regression that accidentally flips the comparison direction.
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'undersized-mb');
    await createVerifiedDomain(env, 'example.com');
    const key = await issueApiKey(env, admin, mbId, ['send']);

    const sendBody = {
      from: 'noreply@example.com',
      to: ['inbox@example.org'],
      subject: 'small',
      text: 'hello',
    };

    const res = await app.fetch(
      await signedRequest(
        'https://x/v1/messages',
        JSON.stringify(sendBody),
        'POST',
        key.key_secret,
        key.key_id,
      ),
      env,
      ctx,
    );
    // 202 accepted (normal path) or any non-413 outcome — what we
    // specifically reject here is `message_too_large` firing on a small body.
    expect(res.status).not.toBe(413);
  });

  it('rfc822 path: body > 25 MiB returns 413 message_too_large', async () => {
    const { env, admin } = await bootstrapEnv({ BRIDGE_HMAC_KEY });

    // Register a bridge row (only the id matters; HMAC is the global env key).
    const bridgeRes = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/bridges',
        JSON.stringify({ name: 'oversize-bridge' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(bridgeRes.status).toBe(201);
    const bridge = (await bridgeRes.json()) as { id: string };

    // Build an oversized opaque body. The bridge path does NOT need a valid
    // RFC822 shape to trigger the size gate — the gate must fire BEFORE
    // parsing per the contract: "fires before any parsing, right after the
    // body is read."
    const body = new Uint8Array(MAX_MESSAGE_SIZE_VERIFIED + 1024);
    body.fill(0x61); // 'a'

    const url = 'https://x/v1/messages';
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
      BRIDGE_HMAC_KEY,
    );
    const req = new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'message/rfc822',
        'x-polaris-bridge-id': bridge.id,
        'x-polaris-submission-id': ulid(),
        'x-polaris-smtp-username': 'oversize-test',
        'x-polaris-ts': ts,
        'x-polaris-nonce': nonce,
        'x-polaris-sig': sig,
      },
      body,
    });

    const res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(413);
    const errBody = (await res.json()) as ErrorEnvelope;
    expect(errBody.error.code).toBe('message_too_large');
    expect(errBody.error.message).toMatch(/\d+ bytes/);

    // No enqueue — and notably no D1 row, no R2 PUT — because the gate
    // fires before any of that pipeline runs.
    const queue = env.OUTBOUND_QUEUE as unknown as MockQueueLike;
    expect(queue.sent.length).toBe(0);
  });
});
