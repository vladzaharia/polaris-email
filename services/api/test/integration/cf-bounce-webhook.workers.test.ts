// W3 — pool-workers integration test for the CF Email Service bounce
// webhook listener.
//
// Asserts:
//   * valid HMAC signature → 200, abuse_events row, suppressions row (for
//     hard_bounce / complaint), messages row flipped to 'bounced'.
//   * invalid signature → 401 / bad_signature, no rows written.
//   * clock skew > 10 min → 401 / clock_skew, no rows written.
//   * idempotent replay (same event_id) → 200 with applied=false; no
//     duplicate abuse_events row.
//   * soft_bounce → abuse_events row written but messages.status NOT
//     flipped (CF Queues handles soft retries).
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import worker from '../../src/index.js';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;
const CF_EVENT_HMAC = 'phase-w3-bounce-test-secret';

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(CF_EVENT_HMAC),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const arr = new Uint8Array(sig);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  return hex;
}

async function callBounce(
  body: string,
  opts: { sig?: string; ts?: string; eventId?: string } = {},
): Promise<Response> {
  const sig = opts.sig ?? (await signBody(body));
  const ts = opts.ts ?? String(Date.now());
  const eventId = opts.eventId ?? `cf-evt-${Math.random()}`;
  const req = new Request('https://x/v1/internal/cf-events/bounce', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cf-event-sig': sig,
      'x-cf-event-ts': ts,
      'x-cf-event-id': eventId,
    },
    body,
  });
  const ctx = createExecutionContext();
  return worker.fetch(req, testEnv as unknown as Env, ctx);
}

async function seedMessage(id: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, direction, status, from_addr, r2_key,
       content_sha256, body_bytes, created_at)
     VALUES (?, 'mb1', 'out', 'sent', 'sender@verified.test', 'mime/key', 'sha', 100, ?)`,
  )
    .bind(id, nowIso)
    .run();
}

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  (testEnv as { CF_EVENT_HMAC?: string }).CF_EVENT_HMAC = CF_EVENT_HMAC;
  const nowIso = new Date().toISOString();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES ('z1', 'cfz1', 'verified.test', ?)`,
    ).bind(nowIso),
    testEnv.DB.prepare(
      `INSERT INTO mailboxes (id, name, created_at, updated_at) VALUES ('mb1', 'inbox', ?, ?)`,
    ).bind(nowIso, nowIso),
    testEnv.DB.prepare(
      `INSERT INTO mail_domains (id, zone_id, name, status, created_at, updated_at, verified_at)
       VALUES ('d1', 'z1', 'verified.test', 'verified', ?, ?, ?)`,
    ).bind(nowIso, nowIso, nowIso),
  ]);
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM messages`).run();
  await testEnv.DB.prepare(`DELETE FROM abuse_events`).run();
  await testEnv.DB.prepare(`DELETE FROM suppressions`).run();
});

describe('W3 — CF bounce webhook', () => {
  it('hard_bounce → 200 + abuse_events + recipient suppression + messages.bounced', async () => {
    const msgId = '01HXW3HARD0000000000000000';
    await seedMessage(msgId);
    const body = JSON.stringify({
      type: 'hard_bounce',
      message_id: msgId,
      recipient: 'gone@example.com',
      smtp_code: '550 5.1.1 User unknown',
      reported_at: Date.now(),
    });
    const r = await callBounce(body);
    expect(r.status).toBe(200);
    const out = (await r.json()) as { abuse_event_id: string; suppression_id: string };
    expect(out.abuse_event_id).toBeTruthy();
    expect(out.suppression_id).toBeTruthy();

    const msg = await testEnv.DB.prepare(
      `SELECT status, bounce_metadata FROM messages WHERE id = ?`,
    )
      .bind(msgId)
      .first<{ status: string; bounce_metadata: string }>();
    expect(msg?.status).toBe('bounced');
    expect(JSON.parse(msg!.bounce_metadata)).toMatchObject({ source: 'cf_bounce_webhook' });

    const supp = await testEnv.DB.prepare(`SELECT reason, severity FROM suppressions WHERE id = ?`)
      .bind(out.suppression_id)
      .first<{ reason: string; severity: string }>();
    expect(supp?.reason).toBe('hard_bounce');
    expect(supp?.severity).toBe('warn');
  });

  it('complaint → critical severity suppression', async () => {
    const msgId = '01HXW3COMPLAINT00000000000';
    await seedMessage(msgId);
    const body = JSON.stringify({
      type: 'complaint',
      message_id: msgId,
      recipient: 'complainer@isp.example',
      reported_at: Date.now(),
    });
    const r = await callBounce(body);
    expect(r.status).toBe(200);
    const out = (await r.json()) as { suppression_id: string };
    const supp = await testEnv.DB.prepare(`SELECT reason, severity FROM suppressions WHERE id = ?`)
      .bind(out.suppression_id)
      .first<{ reason: string; severity: string }>();
    expect(supp?.reason).toBe('spam_complaint');
    expect(supp?.severity).toBe('critical');
  });

  it('invalid signature → 401', async () => {
    const body = JSON.stringify({
      type: 'hard_bounce',
      message_id: 'm1',
      recipient: 'x@y.com',
    });
    const r = await callBounce(body, { sig: 'deadbeef' });
    expect(r.status).toBe(401);
    const count = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM abuse_events`).first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it('clock skew → 401', async () => {
    const body = JSON.stringify({
      type: 'hard_bounce',
      message_id: 'm1',
      recipient: 'x@y.com',
    });
    const r = await callBounce(body, { ts: String(Date.now() - 30 * 60_000) });
    expect(r.status).toBe(401);
  });

  it('replay by event_id → 200 with applied=false, no duplicate row', async () => {
    const msgId = '01HXW3REPLAY00000000000000';
    await seedMessage(msgId);
    const body = JSON.stringify({
      type: 'hard_bounce',
      message_id: msgId,
      recipient: 'replay@example.com',
    });
    const evtId = 'cf-evt-replay-1';
    const r1 = await callBounce(body, { eventId: evtId });
    expect(r1.status).toBe(200);
    const r2 = await callBounce(body, { eventId: evtId });
    expect(r2.status).toBe(200);
    const out2 = (await r2.json()) as { status: string; applied: boolean };
    expect(out2.status).toBe('replay');
    expect(out2.applied).toBe(false);
    const count = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM abuse_events`).first<{
      n: number;
    }>();
    expect(count?.n).toBe(1);
  });

  it('soft_bounce → abuse_events written but messages.status not flipped', async () => {
    const msgId = '01HXW3SOFT0000000000000000';
    await seedMessage(msgId);
    const body = JSON.stringify({
      type: 'soft_bounce',
      message_id: msgId,
      recipient: 'soft@example.com',
    });
    const r = await callBounce(body);
    expect(r.status).toBe(200);
    const msg = await testEnv.DB.prepare(`SELECT status FROM messages WHERE id = ?`)
      .bind(msgId)
      .first<{ status: string }>();
    expect(msg?.status).toBe('sent'); // unchanged
    const aeCount = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM abuse_events`).first<{
      n: number;
    }>();
    expect(aeCount?.n).toBe(1);
    // Soft bounce doesn't suppress.
    const suppCount = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM suppressions`).first<{
      n: number;
    }>();
    expect(suppCount?.n).toBe(0);
  });
});
