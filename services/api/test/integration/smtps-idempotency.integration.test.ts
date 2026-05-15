// A12 integration test — SMTPS idempotency dedup.
//
// Catches the F1-class bug (A2) where the SMTPS forwarder did not pass
// Idempotency-Key from the inbound Message-ID, causing client-retried
// SMTPS submissions to duplicate-enqueue downstream.
//
// Flow:
//   1. Bootstrap; create mailbox, verified domain, sender, smtp-credential
//      (so the `submission_credentials` row exists for the daemon path).
//   2. POST /v1/messages twice with:
//        Content-Type: message/rfc822
//        Idempotency-Key: <same value>
//        Daemon HMAC signed with env.DAEMON_HMAC_KEY
//   3. Both responses MUST return the same message_id.
//   4. OUTBOUND_QUEUE must have exactly ONE enqueue (the second call is a
//      pure idempotency replay; no fresh send).

import { describe, expect, it } from 'vitest';
import { sign, generateNonce } from '@polaris-email/hmac';
import { ulid } from '@polaris-email/ids';
import {
  app,
  bootstrapEnv,
  createMailbox,
  createVerifiedDomain,
  ctx,
  signedRequest,
  tinyRfc822,
} from './setup.js';

const DAEMON_HMAC_KEY = 'test-daemon-hmac-key-must-be-32-bytes-long-please';

async function postRfc822(
  env: Parameters<typeof app.fetch>[1],
  args: {
    daemonId: string;
    submissionId: string;
    smtpUsername: string;
    body: Uint8Array;
    idempotencyKey: string;
  },
): Promise<Response> {
  const url = 'https://x/v1/messages';
  const u = new URL(url);
  const ts = String(Date.now());
  const nonce = generateNonce();
  // Daemon HMAC is computed over the canonical request shape.
  const sig = await sign(
    {
      direction: 'polaris-api',
      method: 'POST',
      path: u.pathname,
      query: u.search,
      ts,
      nonce,
      body: args.body,
    },
    DAEMON_HMAC_KEY,
  );
  const req = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'message/rfc822',
      'x-polaris-daemon-id': args.daemonId,
      'x-polaris-submission-id': args.submissionId,
      'x-polaris-smtp-username': args.smtpUsername,
      'x-polaris-ts': ts,
      'x-polaris-nonce': nonce,
      'x-polaris-sig': sig,
      'idempotency-key': args.idempotencyKey,
    },
    body: args.body,
  });
  return app.fetch(req, env, ctx);
}

interface MockQueueLike {
  sent: unknown[];
}

describe('A12: SMTPS idempotency dedup', () => {
  it('two POSTs with identical Idempotency-Key → same message_id, single enqueue', async () => {
    const { env, admin } = await bootstrapEnv({ DAEMON_HMAC_KEY });

    // 1) Mailbox + verified domain + sender + smtp-credential.
    const mbId = await createMailbox(env, admin, 'smtps-mb');
    const domainId = await createVerifiedDomain(env, 'example.com');
    void domainId;
    const senderRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/domains/${
          (
            await (
              await app.fetch(
                await signedRequest(
                  'https://x/v1/admin/domains/lookup?name=example.com',
                  '',
                  'GET',
                  admin.admin_key_secret,
                  admin.admin_key_id,
                ),
                env,
                ctx,
              )
            ).json()
          ).id as string
        }/senders`,
        JSON.stringify({
          mailbox_id: mbId,
          local_part: 'noreply',
          default_for_mailbox: true,
        }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(senderRes.status).toBe(201);
    const sender = (await senderRes.json()) as { id: string; address: string };

    const credRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/senders/${sender.id}/smtp-credentials`,
        JSON.stringify({ label: 'smtps-idem-test' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(credRes.status).toBe(201);
    const cred = (await credRes.json()) as { username: string };

    // 2) Register a daemon (only the row needs to exist; HMAC is global).
    const daemonRes = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/daemons',
        JSON.stringify({ name: 'integration-daemon' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(daemonRes.status).toBe(201);
    const daemon = (await daemonRes.json()) as { id: string };

    // 3) Identical Idempotency-Key, two POSTs, same RFC822.
    const idempotencyKey = '<msg-' + ulid() + '@example.com>';
    const body = tinyRfc822({
      subject: 'idem-test',
      from: 'noreply@example.com',
      to: 'inbox@example.org',
      body: 'hello world',
      messageId: 'idem-' + ulid(),
    });

    const sub1 = ulid();
    const sub2 = ulid();
    const r1 = await postRfc822(env, {
      daemonId: daemon.id,
      submissionId: sub1,
      smtpUsername: cred.username,
      body,
      idempotencyKey,
    });
    expect(r1.status).toBe(202);
    const j1 = (await r1.json()) as { message_id: string; status: string; fresh: boolean };
    expect(j1.fresh).toBe(true);

    const r2 = await postRfc822(env, {
      daemonId: daemon.id,
      submissionId: sub2,
      smtpUsername: cred.username,
      body,
      idempotencyKey,
    });
    expect(r2.status).toBe(202);
    const j2 = (await r2.json()) as { message_id: string; status: string; fresh: boolean };

    // Same message_id.
    expect(j2.message_id).toBe(j1.message_id);
    // Second call is a replay, not fresh.
    expect(j2.fresh).toBe(false);

    // Exactly one enqueue on OUTBOUND_QUEUE — the replay must NOT re-publish.
    const queue = env.OUTBOUND_QUEUE as unknown as MockQueueLike;
    expect(queue.sent.length).toBe(1);
  });
});
