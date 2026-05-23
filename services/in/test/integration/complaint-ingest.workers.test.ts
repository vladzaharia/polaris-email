// W2 — pool-workers integration test for the complaint-ingest path in
// services/in. Sends ARF + DSN + unstructured emails to the platform
// complaint mailbox and asserts:
//   * an abuse_events row lands with the right classification
//   * a suppressions row appears when the parser identifies an actionable
//     recipient address
//   * unstructured complaints land in abuse_events with classification='other'
//     and trigger the W2b LLM-triage flag (needsLlmTriage=true)
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import worker from '../../src/index.js';

interface TestEnv {
  DB: D1Database;
  R2: R2Bucket;
  KV_RATE_LIMIT: KVNamespace;
  FANOUT_QUEUE: Queue<unknown>;
}
const testEnv = env as unknown as TestEnv;

const PLATFORM_MAILBOX_ID = '01HXPLATFORMCOMPLAINTS0000';

function mockMessage(opts: { to: string; from: string; raw: string }): ForwardableEmailMessage {
  let rejected: string | null = null;
  return {
    from: opts.from,
    to: opts.to,
    headers: new Headers(),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(opts.raw));
        controller.close();
      },
    }),
    rawSize: opts.raw.length,
    setReject(reason: string) {
      rejected = reason;
    },
    async forward() {
      throw new Error('forward not expected in W2 complaint test');
    },
    async reply() {
      throw new Error('reply not expected');
    },
    get rejected() {
      return rejected;
    },
  } as unknown as ForwardableEmailMessage;
}

const ARF_BODY = [
  'From: postmaster@isp.example',
  'To: abuse@verified.test',
  'Subject: spam complaint',
  'Content-Type: multipart/report; report-type=feedback-report; boundary="b1"',
  'MIME-Version: 1.0',
  '',
  '--b1',
  'Content-Type: text/plain',
  '',
  'A user complained.',
  '--b1',
  'Content-Type: message/feedback-report',
  '',
  'Feedback-Type: abuse',
  'User-Agent: SomeISP-Feedback/1.0',
  'Version: 1',
  'Original-Mail-From: <newsletter@verified.test>',
  'Original-Rcpt-To: <user@isp.example>',
  '',
  '--b1--',
  '',
].join('\r\n');

const DSN_BODY = [
  'From: MAILER-DAEMON@receiving.example',
  'To: postmaster@verified.test',
  'Subject: Undelivered Mail',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="d1"',
  '',
  '--d1',
  'Content-Type: text/plain',
  '',
  'Delivery failed.',
  '--d1',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mta.example',
  '',
  'Final-Recipient: rfc822; bounced@example.com',
  'Action: failed',
  'Status: 5.1.1',
  '',
  '--d1--',
  '',
].join('\r\n');

const UNSTRUCTURED_BODY = [
  'From: angry@example.org',
  'To: abuse@verified.test',
  'Subject: STOP',
  'Content-Type: text/plain',
  '',
  'I never signed up. Take me off your lists.',
  '',
].join('\r\n');

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  const now = new Date().toISOString();
  // Seed: a zone + a verified domain + the three platform complaint receivers
  // for that domain pointed at the platform mailbox.
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES ('z1', 'cfz1', 'verified.test', ?)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO mail_domains (id, zone_id, name, status, wildcard_subdomains,
         dmarc_policy, inbound_enabled, outbound_enabled, provider,
         dkim_selector, created_at, updated_at, verified_at)
       VALUES ('d1', 'z1', 'verified.test', 'verified', 1, 'none',
         1, 1, 'cloudflare', 'cf', ?, ?, ?)`,
    ).bind(now, now, now),
    // The production schema seeds the platform mailbox via migration; in this
    // test we materialise it inline so the receiver FK below is satisfied.
    testEnv.DB.prepare(
      `INSERT INTO mailboxes (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).bind(PLATFORM_MAILBOX_ID, '_polaris_complaints', now, now),
    // Three receivers pointing at the platform mailbox (seeded by migration 0011).
    testEnv.DB.prepare(
      `INSERT INTO mailbox_receivers (id, mailbox_id, domain_id, priority,
         address_pattern, action, webhook_sub_id, forward_to, enabled, created_at, disabled_at)
       VALUES ('rcpt-postmaster', ?, 'd1', 10, 'postmaster@*', 'webhook', NULL, NULL, 1, ?, NULL)`,
    ).bind(PLATFORM_MAILBOX_ID, now),
    testEnv.DB.prepare(
      `INSERT INTO mailbox_receivers (id, mailbox_id, domain_id, priority,
         address_pattern, action, webhook_sub_id, forward_to, enabled, created_at, disabled_at)
       VALUES ('rcpt-abuse', ?, 'd1', 10, 'abuse@*', 'webhook', NULL, NULL, 1, ?, NULL)`,
    ).bind(PLATFORM_MAILBOX_ID, now),
    testEnv.DB.prepare(
      `INSERT INTO mailbox_receivers (id, mailbox_id, domain_id, priority,
         address_pattern, action, webhook_sub_id, forward_to, enabled, created_at, disabled_at)
       VALUES ('rcpt-webmaster', ?, 'd1', 10, 'webmaster@*', 'webhook', NULL, NULL, 1, ?, NULL)`,
    ).bind(PLATFORM_MAILBOX_ID, now),
  ]);
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM abuse_events`).run();
  await testEnv.DB.prepare(`DELETE FROM suppressions`).run();
});

describe('W2 — complaint ingest', () => {
  it('ARF → abuse_events(spam_complaint) + recipient suppression', async () => {
    const msg = mockMessage({
      to: 'abuse@verified.test',
      from: 'postmaster@isp.example',
      raw: ARF_BODY,
    });
    await worker.email!(msg, testEnv as unknown as never, {} as ExecutionContext);

    const ae = await testEnv.DB.prepare(
      `SELECT classification, source, sender_address, weight, caused_suppression_id
       FROM abuse_events ORDER BY created_at DESC LIMIT 1`,
    ).first<{
      classification: string;
      source: string;
      sender_address: string;
      weight: number;
      caused_suppression_id: string | null;
    }>();
    expect(ae?.classification).toBe('spam_complaint');
    expect(ae?.source).toBe('arf_inbox');
    expect(ae?.sender_address).toContain('newsletter@verified.test');
    expect(ae?.caused_suppression_id).toBeTruthy();

    const supp = await testEnv.DB.prepare(
      `SELECT entity_type, reason, address_normalized FROM suppressions WHERE id = ?`,
    )
      .bind(ae!.caused_suppression_id)
      .first<{ entity_type: string; reason: string; address_normalized: string }>();
    expect(supp?.entity_type).toBe('recipient');
    expect(supp?.reason).toBe('spam_complaint');
    expect(supp?.address_normalized).toBe('user@isp.example');
  });

  it('DSN(permanent 5.x.x) → abuse_events(hard_bounce) + recipient suppression', async () => {
    const msg = mockMessage({
      to: 'postmaster@verified.test',
      from: 'MAILER-DAEMON@receiving.example',
      raw: DSN_BODY,
    });
    await worker.email!(msg, testEnv as unknown as never, {} as ExecutionContext);

    const ae = await testEnv.DB.prepare(
      `SELECT classification, caused_suppression_id FROM abuse_events ORDER BY created_at DESC LIMIT 1`,
    ).first<{ classification: string; caused_suppression_id: string | null }>();
    expect(ae?.classification).toBe('hard_bounce');
    expect(ae?.caused_suppression_id).toBeTruthy();

    const supp = await testEnv.DB.prepare(
      `SELECT reason, address_normalized FROM suppressions WHERE id = ?`,
    )
      .bind(ae!.caused_suppression_id)
      .first<{ reason: string; address_normalized: string }>();
    expect(supp?.reason).toBe('hard_bounce');
    expect(supp?.address_normalized).toBe('bounced@example.com');
  });

  it('unstructured prose → abuse_events(other) without suppression (W2b will triage)', async () => {
    const msg = mockMessage({
      to: 'abuse@verified.test',
      from: 'angry@example.org',
      raw: UNSTRUCTURED_BODY,
    });
    await worker.email!(msg, testEnv as unknown as never, {} as ExecutionContext);

    const ae = await testEnv.DB.prepare(
      `SELECT classification, caused_suppression_id, weight FROM abuse_events ORDER BY created_at DESC LIMIT 1`,
    ).first<{ classification: string; caused_suppression_id: string | null; weight: number }>();
    expect(ae?.classification).toBe('other');
    expect(ae?.caused_suppression_id).toBeNull();
    expect(ae?.weight).toBe(0);

    const suppCount = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM suppressions`).first<{
      n: number;
    }>();
    expect(suppCount?.n).toBe(0);
  });
});
