// W1 — pool-workers integration test for outbound suppression enforcement.
//
// Exercises both directions:
//   (a) Sender suppression → entire send fails closed with status=failed,
//       last_error=sender_suppressed:*, fanout=message.sender_suppressed,
//       binding.send NEVER invoked.
//   (b) Per-recipient drop → surviving recipients sent; dropped emit
//       message.suppressed fanout event; if ALL dropped, status=bounced.
//
// Both directions reuse the same OUTBOUND queue + FANOUT recorder shape as
// the golden-path test in queue-consumer.workers.test.ts.
import {
  applyD1Migrations,
  createMessageBatch,
  createExecutionContext,
  getQueueResult,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import worker from '../../src/index.js';
import type { FanoutEvent, OutboundQueueMessage, SendEmailBinding } from '../../src/env.js';

interface TestEnv {
  DB: D1Database;
  R2: R2Bucket;
  FANOUT_QUEUE: Queue<FanoutEvent>;
  EMAIL_VERIFIED_TEST?: SendEmailBinding;
}
const testEnv = env as unknown as TestEnv;

interface SendCapture {
  from: string;
  to: string | string[];
}

function stubBinding(): { binding: SendEmailBinding; captured: SendCapture[] } {
  const captured: SendCapture[] = [];
  const binding: SendEmailBinding = {
    async send(msg) {
      captured.push({ from: msg.from, to: msg.to });
      return {
        delivered: Array.isArray(msg.to) ? msg.to : [msg.to],
        permanent_bounces: [],
        queued: [],
      };
    },
  };
  return { binding, captured };
}

function fanoutRecorder(): { sent: FanoutEvent[]; queue: Queue<FanoutEvent> } {
  const sent: FanoutEvent[] = [];
  const queue = {
    async send(ev: FanoutEvent) {
      sent.push(ev);
    },
    async sendBatch(batch: { messages: { body: FanoutEvent }[] }) {
      for (const m of batch.messages) sent.push(m.body);
    },
  } as unknown as Queue<FanoutEvent>;
  return { sent, queue };
}

function rfc822(): Uint8Array {
  const m =
    'From: sender@verified.test\r\nTo: a@example.com, b@example.com\r\n' +
    'Subject: hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n';
  return new TextEncoder().encode(m);
}

async function seedMessageRow(id: string, r2Key: string): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, direction, status, from_addr, r2_key,
       content_sha256, body_bytes, created_at)
     VALUES (?, 'mb1', 'out', 'queued', 'sender@verified.test', ?, 'sha-test', 100, ?)`,
  )
    .bind(id, r2Key, now)
    .run();
}

async function seedDomain(): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO mail_domains (id, zone_id, name, status, wildcard_subdomains,
       dmarc_policy, inbound_enabled, outbound_enabled, provider,
       dkim_selector, created_at, updated_at, verified_at)
     VALUES ('d1', 'z1', 'verified.test', 'verified', 1, 'none',
       1, 1, 'cloudflare', 'cf', ?, ?, ?)`,
  )
    .bind(now, now, now)
    .run();
}

async function insertSuppression(opts: {
  id: string;
  entity_type: 'recipient' | 'sender';
  address: string;
  scope?: 'global' | 'domain' | 'mailbox' | 'sender_address';
  scope_target?: string | null;
  reason?: string;
  severity?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO suppressions (id, entity_type, address_normalized, address_local,
       address_domain, scope, scope_target, reason, source, source_ref, severity,
       created_at, expires_at, disabled_at, disabled_reason, notes)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'panel', NULL, ?, ?, NULL, NULL, NULL, NULL)`,
  )
    .bind(
      opts.id,
      opts.entity_type,
      opts.address,
      opts.scope ?? 'global',
      opts.scope_target ?? null,
      opts.reason ?? 'manual',
      opts.severity ?? 'warn',
      now,
    )
    .run();
}

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  const now = new Date().toISOString();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES ('z1', 'cfz1', 'verified.test', ?)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO mailboxes (id, name, created_at, updated_at) VALUES ('mb1', 'inbox', ?, ?)`,
    ).bind(now, now),
  ]);
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM messages`).run();
  await testEnv.DB.prepare(`DELETE FROM mail_domains WHERE name = 'verified.test'`).run();
  await testEnv.DB.prepare(`DELETE FROM suppressions`).run();
  delete (testEnv as unknown as Record<string, unknown>).EMAIL_VERIFIED_TEST;
});

describe('W1 — outbound suppression enforcement', () => {
  it('sender suppression fails the entire send closed, no binding call', async () => {
    await seedDomain();
    const r2Key = 'mime/sender-supp';
    const msgId = '01HXSUPP0000000000000000W1';
    await testEnv.R2.put(r2Key, rfc822());
    await seedMessageRow(msgId, r2Key);
    await insertSuppression({
      id: '01HXSENDER000000000000000W1',
      entity_type: 'sender',
      address: 'sender@verified.test',
      reason: 'phishing_report',
      severity: 'critical',
    });

    const stub = stubBinding();
    (testEnv as unknown as Record<string, unknown>).EMAIL_VERIFIED_TEST = stub.binding;

    const fan = fanoutRecorder();
    const origQueue = testEnv.FANOUT_QUEUE;
    (testEnv as unknown as Record<string, unknown>).FANOUT_QUEUE = fan.queue;

    const body: OutboundQueueMessage = {
      messageId: msgId,
      source: 'raw',
      r2KeyOrInline: r2Key,
      fromDomain: 'verified.test',
      fromAddress: 'sender@verified.test',
      envelopeTo: ['a@example.com', 'b@example.com'],
      mailboxId: 'mb1',
      domainId: 'd1',
      mode: 'live',
    };
    const batch = createMessageBatch('polaris-mail-outbound', [
      { id: msgId, timestamp: new Date(), attempts: 1, body },
    ]);
    const ctx = createExecutionContext();
    await worker.queue!(
      batch as unknown as MessageBatch<OutboundQueueMessage>,
      testEnv as unknown as never,
    );
    await getQueueResult(batch, ctx);

    expect(stub.captured.length).toBe(0);
    const row = await testEnv.DB.prepare(
      `SELECT status, last_error, bounce_metadata FROM messages WHERE id = ?`,
    )
      .bind(msgId)
      .first<{ status: string; last_error: string; bounce_metadata: string | null }>();
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toMatch(/^sender_suppressed:phishing_report/);
    expect(JSON.parse(row!.bounce_metadata!)).toHaveProperty('suppressed_sender');

    const suppEv = fan.sent.find((e) => e.event === 'message.sender_suppressed');
    expect(suppEv).toBeDefined();

    (testEnv as unknown as Record<string, unknown>).FANOUT_QUEUE = origQueue;
  });

  it('per-recipient drop sends only the survivors', async () => {
    await seedDomain();
    const r2Key = 'mime/per-recip';
    const msgId = '01HXPERRECIP000000000000W1';
    await testEnv.R2.put(r2Key, rfc822());
    await seedMessageRow(msgId, r2Key);
    await insertSuppression({
      id: '01HXBADRECIP00000000000W1',
      entity_type: 'recipient',
      address: 'a@example.com',
      reason: 'hard_bounce',
    });

    const stub = stubBinding();
    (testEnv as unknown as Record<string, unknown>).EMAIL_VERIFIED_TEST = stub.binding;
    const fan = fanoutRecorder();
    (testEnv as unknown as Record<string, unknown>).FANOUT_QUEUE = fan.queue;

    const body: OutboundQueueMessage = {
      messageId: msgId,
      source: 'raw',
      r2KeyOrInline: r2Key,
      fromDomain: 'verified.test',
      fromAddress: 'sender@verified.test',
      envelopeTo: ['a@example.com', 'b@example.com'],
      mailboxId: 'mb1',
      domainId: 'd1',
      mode: 'live',
    };
    const batch = createMessageBatch('polaris-mail-outbound', [
      { id: msgId, timestamp: new Date(), attempts: 1, body },
    ]);
    const ctx = createExecutionContext();
    await worker.queue!(
      batch as unknown as MessageBatch<OutboundQueueMessage>,
      testEnv as unknown as never,
    );
    await getQueueResult(batch, ctx);

    expect(stub.captured.length).toBe(1);
    expect(stub.captured[0]!.to).toBe('b@example.com');
    const droppedEvent = fan.sent.find((e) => e.event === 'message.suppressed');
    expect(droppedEvent).toBeDefined();
    const data = droppedEvent!.data as { dropped: Array<{ address: string }> };
    expect(data.dropped.map((d) => d.address)).toEqual(['a@example.com']);
  });

  it('all recipients suppressed → bounced, no binding call', async () => {
    await seedDomain();
    const r2Key = 'mime/all-supp';
    const msgId = '01HXALLSUPP00000000000000W1';
    await testEnv.R2.put(r2Key, rfc822());
    await seedMessageRow(msgId, r2Key);
    await insertSuppression({
      id: '01HXRC1000000000000000000W',
      entity_type: 'recipient',
      address: 'a@example.com',
      reason: 'hard_bounce',
    });
    await insertSuppression({
      id: '01HXRC2000000000000000000W',
      entity_type: 'recipient',
      address: 'b@example.com',
      reason: 'hard_bounce',
    });

    const stub = stubBinding();
    (testEnv as unknown as Record<string, unknown>).EMAIL_VERIFIED_TEST = stub.binding;
    const fan = fanoutRecorder();
    (testEnv as unknown as Record<string, unknown>).FANOUT_QUEUE = fan.queue;

    const body: OutboundQueueMessage = {
      messageId: msgId,
      source: 'raw',
      r2KeyOrInline: r2Key,
      fromDomain: 'verified.test',
      fromAddress: 'sender@verified.test',
      envelopeTo: ['a@example.com', 'b@example.com'],
      mailboxId: 'mb1',
      domainId: 'd1',
      mode: 'live',
    };
    const batch = createMessageBatch('polaris-mail-outbound', [
      { id: msgId, timestamp: new Date(), attempts: 1, body },
    ]);
    const ctx = createExecutionContext();
    await worker.queue!(
      batch as unknown as MessageBatch<OutboundQueueMessage>,
      testEnv as unknown as never,
    );
    await getQueueResult(batch, ctx);

    expect(stub.captured.length).toBe(0);
    const row = await testEnv.DB.prepare(`SELECT status, last_error FROM messages WHERE id = ?`)
      .bind(msgId)
      .first<{ status: string; last_error: string }>();
    expect(row?.status).toBe('bounced');
    expect(row?.last_error).toBe('all_recipients_suppressed');
    const bounced = fan.sent.find((e) => e.event === 'message.bounced');
    expect(bounced).toBeDefined();
  });
});
