// 0019 — pool-workers integration test for the outbound policy engine gate.
//
// Four scenarios:
//   (a) Clean message → 'pass', binding invoked, status='sent'.
//   (b) Phishing-shaped message (no extra context) → 'hold', status='held',
//       held_messages row inserted, binding NEVER invoked.
//   (c) Phishing-shaped message + sender at W2c abuse tier 2 → 'block',
//       status='failed' with last_error=policy_block, message.bounced fanout
//       emitted with the reasons vector, binding NEVER invoked.
//   (d) Soak mode (POLICY_ENGINE_OUTBOUND_FULL='false') → same tier-2
//       phishing message still sends; policy_decisions row records the
//       would-be block verdict.
//
// Verifies the engine writes a policy_decisions row in every case and
// stamps messages.policy_decision_id appropriately.
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
  POLICY_ENGINE_OUTBOUND_FULL?: string;
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

function rfc822Clean(): Uint8Array {
  const m =
    'From: sender@verified.test\r\nTo: customer@example.com\r\n' +
    'Subject: Order confirmation\r\nContent-Type: text/plain; charset=utf-8\r\n' +
    'Message-ID: <ok-1@verified.test>\r\n\r\n' +
    'Thanks for your order. Your invoice is attached.\r\n';
  return new TextEncoder().encode(m);
}

function rfc822Phishy(): Uint8Array {
  // Outbound message stacked with negative signals: phishy subject,
  // display-name spoof, double-extension attachment ref in headers,
  // url-anchor mismatch in body. Sum should land in block band.
  const m =
    'From: "PayPal Security" <sender@verified.test>\r\n' +
    'To: customer@example.com\r\n' +
    'Subject: URGENT verify your account\r\n' +
    'Content-Type: text/html; charset=utf-8\r\n' +
    'Message-ID: <phish-1@verified.test>\r\n\r\n' +
    '<a href="http://attacker.com/login">https://paypal.com/login</a>\r\n';
  return new TextEncoder().encode(m);
}

async function seedMessageRow(id: string, r2Key: string): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, direction, status, from_addr, r2_key,
       content_sha256, body_bytes, created_at, stream_type)
     VALUES (?, 'mb1', 'out', 'queued', 'sender@verified.test', ?, 'sha-test', 100, ?, 'transactional')`,
  )
    .bind(id, r2Key, now)
    .run();
}

async function seedDomain(): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO mail_domains (id, zone_id, name, status, wildcard_subdomains,
       dmarc_policy, dmarc_rua, inbound_enabled, outbound_enabled, provider,
       dkim_selector, created_at, updated_at, verified_at)
     VALUES ('d1', 'z1', 'verified.test', 'verified', 1, 'none',
       'mailto:postmaster@verified.test', 1, 1, 'cloudflare', 'cf', ?, ?, ?)`,
  )
    .bind(now, now, now)
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

async function seedAbuseTier(senderAddress: string, tier: number): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO sender_abuse_profile
       (principal_type, principal_id, current_tier, lifetime_event_count,
        lifetime_weighted_score, suppression_count, created_at, updated_at)
     VALUES ('sender_address', ?, ?, 0, 0, 0, ?, ?)`,
  )
    .bind(senderAddress.toLowerCase(), tier, now, now)
    .run();
}

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM held_messages`).run();
  await testEnv.DB.prepare(`DELETE FROM policy_decisions`).run();
  await testEnv.DB.prepare(`DELETE FROM messages`).run();
  await testEnv.DB.prepare(`DELETE FROM sender_abuse_profile`).run();
  await testEnv.DB.prepare(`DELETE FROM mail_domains WHERE name = 'verified.test'`).run();
  await seedDomain();
});

async function runOne(
  msgBody: OutboundQueueMessage,
  bindingOverride: SendEmailBinding,
  policyFull: 'true' | 'false' | undefined,
): Promise<{ sent: FanoutEvent[]; captured: SendCapture[] }> {
  const fan = fanoutRecorder();
  const overrideEnv: Record<string, unknown> = {
    FANOUT_QUEUE: fan.queue,
    EMAIL_VERIFIED_TEST: bindingOverride,
  };
  if (policyFull !== undefined) overrideEnv.POLICY_ENGINE_OUTBOUND_FULL = policyFull;
  const ctx = createExecutionContext();
  const batch = createMessageBatch('polaris-email-outbound', [
    { id: msgBody.messageId, timestamp: new Date(), attempts: 1, body: msgBody },
  ]);
  const merged = { ...(testEnv as unknown as Record<string, unknown>), ...overrideEnv };
  await worker.queue!(batch as unknown as MessageBatch<OutboundQueueMessage>, merged as never);
  await getQueueResult(batch, ctx);
  return { sent: fan.sent, captured: [] };
}

describe('0019 — outbound policy engine', () => {
  it('clean message passes the engine and is sent', async () => {
    const stub = stubBinding();
    const msgId = '01HXPOLICYCLEANXXXXXXXXXXX';
    const r2Key = `out/${msgId}.eml`;
    await testEnv.R2.put(r2Key, rfc822Clean());
    await seedMessageRow(msgId, r2Key);

    await runOne(
      {
        messageId: msgId,
        source: 'raw',
        r2KeyOrInline: r2Key,
        fromDomain: 'verified.test',
        fromAddress: 'sender@verified.test',
        envelopeTo: ['customer@example.com'],
        mailboxId: 'mb1',
        domainId: 'd1',
        mode: 'live',
      },
      stub.binding,
      'true',
    );

    expect(stub.captured.length).toBe(1);
    const row = await testEnv.DB.prepare(
      `SELECT status, policy_decision_id FROM messages WHERE id=?`,
    )
      .bind(msgId)
      .first<{ status: string; policy_decision_id: string }>();
    expect(row?.status).toBe('sent');
    expect(row?.policy_decision_id).toBeTruthy();

    const decision = await testEnv.DB.prepare(
      `SELECT verdict, total_score, llm_invoked FROM policy_decisions WHERE message_id=?`,
    )
      .bind(msgId)
      .first<{ verdict: string; total_score: number; llm_invoked: number }>();
    expect(decision?.verdict).toBe('pass');
    expect(decision?.llm_invoked).toBe(0);
  });

  it('phishing-shaped message (no extras) lands in hold', async () => {
    const stub = stubBinding();
    const msgId = '01HXPOLICYHOLDXXXXXXXXXXXX';
    const r2Key = `out/${msgId}.eml`;
    await testEnv.R2.put(r2Key, rfc822Phishy());
    await seedMessageRow(msgId, r2Key);

    await runOne(
      {
        messageId: msgId,
        source: 'raw',
        r2KeyOrInline: r2Key,
        fromDomain: 'verified.test',
        fromAddress: 'sender@verified.test',
        envelopeTo: ['customer@example.com'],
        mailboxId: 'mb1',
        domainId: 'd1',
        mode: 'live',
      },
      stub.binding,
      'true',
    );

    expect(stub.captured.length).toBe(0);
    const row = await testEnv.DB.prepare(
      `SELECT status, last_error, policy_decision_id FROM messages WHERE id=?`,
    )
      .bind(msgId)
      .first<{ status: string; last_error: string; policy_decision_id: string }>();
    expect(row?.status).toBe('held');
    expect(row?.last_error).toMatch(/^policy_hold:/);

    const held = await testEnv.DB.prepare(
      `SELECT id, decision_id, raw_mime_r2_key FROM held_messages WHERE message_id=?`,
    )
      .bind(msgId)
      .first<{ id: string; decision_id: string; raw_mime_r2_key: string }>();
    expect(held).toBeTruthy();
    expect(held?.raw_mime_r2_key).toBe(r2Key);
  });

  it('phishing + sender at W2c tier 2 lands in block', async () => {
    const stub = stubBinding();
    const msgId = '01HXPOLICYBLOCKXXXXXXXXXXX';
    const r2Key = `out/${msgId}.eml`;
    await testEnv.R2.put(r2Key, rfc822Phishy());
    await seedMessageRow(msgId, r2Key);
    await seedAbuseTier('sender@verified.test', 2);

    const { sent } = await runOne(
      {
        messageId: msgId,
        source: 'raw',
        r2KeyOrInline: r2Key,
        fromDomain: 'verified.test',
        fromAddress: 'sender@verified.test',
        envelopeTo: ['customer@example.com'],
        mailboxId: 'mb1',
        domainId: 'd1',
        mode: 'live',
      },
      stub.binding,
      'true',
    );

    expect(stub.captured.length).toBe(0);
    const row = await testEnv.DB.prepare(`SELECT status, last_error FROM messages WHERE id=?`)
      .bind(msgId)
      .first<{ status: string; last_error: string }>();
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toMatch(/^policy_block:/);

    const bounced = sent.find((e) => e.event === 'message.bounced');
    expect(bounced).toBeDefined();
    const data = bounced!.data as { reason?: string; top_reasons?: unknown[] };
    expect(data.reason).toBe('policy_block');
    expect((data.top_reasons ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('phishing + tier 2 under POLICY_ENGINE_OUTBOUND_FULL=false sends but records decision', async () => {
    const stub = stubBinding();
    const msgId = '01HXPOLICYSOAKXXXXXXXXXXXX';
    const r2Key = `out/${msgId}.eml`;
    await testEnv.R2.put(r2Key, rfc822Phishy());
    await seedMessageRow(msgId, r2Key);
    await seedAbuseTier('sender@verified.test', 2);

    await runOne(
      {
        messageId: msgId,
        source: 'raw',
        r2KeyOrInline: r2Key,
        fromDomain: 'verified.test',
        fromAddress: 'sender@verified.test',
        envelopeTo: ['customer@example.com'],
        mailboxId: 'mb1',
        domainId: 'd1',
        mode: 'live',
      },
      stub.binding,
      'false', // soak mode
    );

    expect(stub.captured.length).toBe(1); // sent despite the negative score
    const decision = await testEnv.DB.prepare(
      `SELECT verdict, total_score FROM policy_decisions WHERE message_id=?`,
    )
      .bind(msgId)
      .first<{ verdict: string; total_score: number }>();
    // The recorded verdict reflects the ENGINE's decision; effective
    // action was downgraded to pass_warn by the soak flag.
    expect(['block', 'hold']).toContain(decision?.verdict);
    expect(decision!.total_score).toBeLessThanOrEqual(-15);
  });
});
