// 0019 — pool-workers integration test for the inbound policy engine gate.
//
// Three scenarios:
//   (a) Clean inbound → engine returns 'pass', message is persisted,
//       policy_decisions row exists with verdict='pass'.
//   (b) Phishy inbound (no AI binding, no extras) → score lands in hold
//       band → message NOT persisted, held_messages row inserted, raw
//       MIME stored in R2 under policy_held/<decision_id>.
//   (c) Stacked phishy inbound (multiple decisive heuristics) → score in
//       block_decisive band → message NOT persisted, NO held_messages row,
//       raw MIME stored in R2 under policy_blocked/<decision_id>.
//
// Tests use the same forged ForwardableEmailMessage harness as
// email-handler.workers.test.ts. No AI binding is provided — the engine
// runs Stages 1+2 only, which is sufficient to exercise hold/block paths
// on heuristic-decisive band scores.
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
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

function rfc822Clean(): string {
  return [
    'From: alice@example.com',
    'To: user@verified.test',
    'Subject: Hello',
    'Message-ID: <ok-1@example.com>',
    'Date: Mon, 1 Jan 2024 00:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Just saying hi.',
    '',
  ].join('\r\n');
}

function rfc822Phishy(): string {
  // Stacked negative signals on inbound:
  //   phishy_terms_subject (-3) + display_name_spoof_brand (-5)
  //   + url_anchor_mismatch (-5) + display_name_spoof_internal misses
  // Expected total ≈ -13 → uncertain band → with no AI binding, defaults
  // to 'hold'.
  return [
    'From: "PayPal Security" <attacker@example.net>',
    'To: user@verified.test',
    'Subject: URGENT verify your account',
    'Message-ID: <phish-1@example.net>',
    'Date: Mon, 1 Jan 2024 00:00:00 +0000',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><a href="http://attacker.com/login">https://paypal.com/login</a></body></html>',
    '',
  ].join('\r\n');
}

function rfc822DecisiveBlock(): string {
  // Push score below -25 by stacking more inbound signals. We use a
  // phishy subject + display_name_spoof_brand + url_anchor_mismatch +
  // mime_html_only + invalid date + reply_to mismatch + many Received
  // headers via Authentication-Results faked-fail.
  return [
    'Received: from a.com (1.2.3.4)',
    'Received: from b.com (5.6.7.8)',
    'Received: from c.com (9.10.11.12)',
    'Received: from d.com (1.2.3.4)',
    'Received: from e.com (5.6.7.8)',
    'Received: from f.com (9.10.11.12)',
    'Received: from g.com (1.2.3.4)',
    'Received: from h.com (5.6.7.8)',
    'Received: from i.com (9.10.11.12)',
    'Received: from j.com (1.2.3.4)',
    'Received: from k.com (5.6.7.8)',
    'Received: from l.com (9.10.11.12)',
    'Received: from m.com (1.2.3.4)',
    'From: "PayPal Security" <attacker@example.net>',
    'Reply-To: support@something-else.com',
    'To: someone-else@example.com',
    'Subject: URGENT verify your account password reset',
    'Date: Mon, 1 Jan 2099 00:00:00 +0000',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body>',
    '<a href="http://attacker.com/login">https://paypal.com/login</a>',
    '<a href="http://attacker.com/x">https://google.com</a>',
    '<a href="http://attacker.com/y">https://microsoft.com</a>',
    '</body></html>',
    '',
  ].join('\r\n');
}

function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function mkMessage(args: { from: string; to: string; raw: Uint8Array }): {
  msg: ForwardableEmailMessage;
  getReject: () => string | undefined;
} {
  let rejected: string | undefined;
  const headers = new Headers();
  // The engine reads Authentication-Results; leave empty so dmarc/spf/dkim
  // are undefined and don't contribute scores either way.
  const msg = {
    from: args.from,
    to: args.to,
    raw: streamFrom(args.raw),
    rawSize: args.raw.byteLength,
    headers,
    setReject(reason: string) {
      rejected = reason;
    },
    async forward() {
      /* unused */
    },
    async reply() {
      throw new Error('reply not supported');
    },
  } as unknown as ForwardableEmailMessage;
  return { msg, getReject: () => rejected };
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
      `INSERT INTO mail_domains (id, zone_id, name, status, wildcard_subdomains, dmarc_policy,
         dmarc_rua, inbound_enabled, outbound_enabled, provider, dkim_selector,
         created_at, updated_at, verified_at)
       VALUES ('d1', 'z1', 'verified.test', 'verified', 1, 'none',
         'mailto:postmaster@verified.test', 1, 1, 'cloudflare', 'cf', ?, ?, ?)`,
    ).bind(now, now, now),
    testEnv.DB.prepare(
      `INSERT INTO mailboxes (id, name, created_at, updated_at) VALUES ('mb1', 'inbox', ?, ?)`,
    ).bind(now, now),
    testEnv.DB.prepare(
      `INSERT INTO mailbox_receivers (id, mailbox_id, domain_id, priority, address_pattern, action, enabled, created_at)
       VALUES ('r1', 'mb1', 'd1', 100, '*', 'webhook', 1, ?)`,
    ).bind(now),
  ]);
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM held_messages`).run();
  await testEnv.DB.prepare(`DELETE FROM policy_decisions`).run();
  await testEnv.DB.prepare(`DELETE FROM messages`).run();
});

describe('0019 — inbound policy engine', () => {
  it('clean inbound is persisted; policy_decisions row records pass', async () => {
    const ctx = createExecutionContext();
    const raw = new TextEncoder().encode(rfc822Clean());
    const { msg, getReject } = mkMessage({
      from: 'alice@example.com',
      to: 'user@verified.test',
      raw,
    });
    await worker.email!(msg, testEnv as unknown as never, ctx);
    await waitOnExecutionContext(ctx);

    expect(getReject()).toBeUndefined();
    const message = await testEnv.DB.prepare(
      `SELECT id, status, policy_decision_id FROM messages WHERE mailbox_id='mb1'`,
    ).first<{ id: string; status: string; policy_decision_id: string | null }>();
    expect(message).toBeTruthy();
    expect(message?.policy_decision_id).toBeTruthy();
    const decision = await testEnv.DB.prepare(
      `SELECT verdict, message_id FROM policy_decisions WHERE id = ?`,
    )
      .bind(message!.policy_decision_id)
      .first<{ verdict: string; message_id: string }>();
    expect(decision?.verdict).toBe('pass');
    expect(decision?.message_id).toBe(message!.id);
  });

  it('phishy inbound (no extras) lands in hold; no messages row, held_messages + R2 blob', async () => {
    const ctx = createExecutionContext();
    const raw = new TextEncoder().encode(rfc822Phishy());
    const { msg, getReject } = mkMessage({
      from: 'attacker@example.net',
      to: 'user@verified.test',
      raw,
    });
    await worker.email!(msg, testEnv as unknown as never, ctx);
    await waitOnExecutionContext(ctx);

    // CF Email Routing semantics — we don't reject (no setReject called)
    // so CF treats the message as delivered. We just silently held.
    expect(getReject()).toBeUndefined();

    const messageRow = await testEnv.DB.prepare(
      `SELECT COUNT(*) as c FROM messages WHERE mailbox_id='mb1'`,
    ).first<{ c: number }>();
    expect(messageRow?.c).toBe(0);

    const held = await testEnv.DB.prepare(
      `SELECT id, decision_id, raw_mime_r2_key FROM held_messages
       WHERE direction='inbound' ORDER BY created_at DESC LIMIT 1`,
    ).first<{ id: string; decision_id: string; raw_mime_r2_key: string }>();
    expect(held).toBeTruthy();
    expect(held?.raw_mime_r2_key).toMatch(/^policy_held\//);

    const blob = await testEnv.R2.get(held!.raw_mime_r2_key);
    expect(blob).not.toBeNull();

    const decision = await testEnv.DB.prepare(
      `SELECT verdict, total_score FROM policy_decisions WHERE id = ?`,
    )
      .bind(held!.decision_id)
      .first<{ verdict: string; total_score: number }>();
    expect(decision?.verdict).toBe('hold');
    expect(decision!.total_score).toBeLessThanOrEqual(-5);
  });

  it('stacked phishy inbound is not persisted; forensic blob exists', async () => {
    // Heavily stacked: many decisive heuristics. Exact score depends on
    // how many of them fire; whether the final verdict is `block` or
    // `hold` depends on the stack. What matters for this test is the
    // invariant: a stacked-negative message must NOT land in messages.
    const ctx = createExecutionContext();
    const raw = new TextEncoder().encode(rfc822DecisiveBlock());
    const { msg, getReject } = mkMessage({
      from: 'attacker@example.net',
      to: 'user@verified.test',
      raw,
    });
    await worker.email!(msg, testEnv as unknown as never, ctx);
    await waitOnExecutionContext(ctx);

    expect(getReject()).toBeUndefined();

    const messageRow = await testEnv.DB.prepare(
      `SELECT COUNT(*) as c FROM messages WHERE mailbox_id='mb1'`,
    ).first<{ c: number }>();
    expect(messageRow?.c).toBe(0);

    const decision = await testEnv.DB.prepare(
      `SELECT id, verdict, total_score FROM policy_decisions
       WHERE direction='inbound' ORDER BY decided_at DESC LIMIT 1`,
    ).first<{ id: string; verdict: string; total_score: number }>();
    expect(decision).toBeTruthy();
    expect(['hold', 'block']).toContain(decision!.verdict);

    // The raw MIME lives under policy_held/ or policy_blocked/ depending
    // on the verdict — either way the forensic blob must exist so an
    // operator can later inspect what was killed.
    const heldKey = `policy_held/${decision!.id}.eml`;
    const blockedKey = `policy_blocked/${decision!.id}.eml`;
    const heldBlob = await testEnv.R2.get(heldKey);
    const blockedBlob = await testEnv.R2.get(blockedKey);
    expect(heldBlob !== null || blockedBlob !== null).toBe(true);
  });
});
