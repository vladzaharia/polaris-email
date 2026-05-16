// Phase B.5 — pool-workers integration test for the services/in Email Routing
// handler. Imports the worker module directly (which works because
// pool-workers runs tests inside the same isolate as the worker) and invokes
// `worker.email(message, env, ctx)` with a forged ForwardableEmailMessage.
// This is the simplest correct way to exercise an email-only worker — the
// `cdn-cgi/handler/email` route that the real CF runtime intercepts is NOT
// surfaced through `SELF.fetch()` in pool-workers (SELF bypasses the
// cdn-cgi layer and calls `fetch()` directly).
//
// Migrations are loaded in Node (via `global-setup.ts`) and forwarded into
// the worker isolate through vitest's `inject()` channel — importing
// `@cloudflare/vitest-pool-workers` directly from a test file that runs
// inside workerd crashes the runtime.
import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import worker from '../../src/index.js';

interface TestEnv {
  DB: D1Database;
  R2: R2Bucket;
  KV_RATE_LIMIT: KVNamespace;
  FANOUT_QUEUE: Queue<unknown>;
}

const testEnv = env as unknown as TestEnv;

function rfc822(subject: string): string {
  return [
    'From: alice@example.com',
    'To: user@verified.test',
    `Subject: ${subject}`,
    `Message-ID: <${subject}@x>`,
    'Date: Mon, 1 Jan 2024 00:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'hi',
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
  getForwardedTo: () => string | undefined;
} {
  let rejected: string | undefined;
  let forwardedTo: string | undefined;
  const msg = {
    from: args.from,
    to: args.to,
    raw: streamFrom(args.raw),
    rawSize: args.raw.byteLength,
    headers: new Headers(),
    setReject(reason: string) {
      rejected = reason;
    },
    async forward(rcptTo: string) {
      forwardedTo = rcptTo;
    },
    async reply() {
      throw new Error('reply not supported in this test harness');
    },
  } as unknown as ForwardableEmailMessage;
  return {
    msg,
    getReject: () => rejected,
    getForwardedTo: () => forwardedTo,
  };
}

beforeAll(async () => {
  // `inject('migrations')` is populated by `test/integration/global-setup.ts`
  // running in Node before any worker isolate is booted.
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);

  // Seed: one verified domain + one mailbox + a wildcard webhook receiver. We
  // use plain `'*'` for the pattern so any local-part matches.
  const now = new Date().toISOString();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES ('z1', 'cfz1', 'verified.test', ?)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO mail_domains (id, zone_id, name, status, wildcard_subdomains, dmarc_policy, dmarc_rua, inbound_enabled, outbound_enabled, provider, dkim_selector, created_at, updated_at, verified_at)
       VALUES ('d1', 'z1', 'verified.test', 'verified', 1, 'none', 'mailto:postmaster@verified.test', 1, 1, 'cloudflare', 'cf', ?, ?, ?)`,
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

describe('services/in email handler (pool-workers)', () => {
  it('accepts verified-domain mail and writes messages + R2', async () => {
    const ctx = createExecutionContext();
    const raw = new TextEncoder().encode(rfc822('hello'));
    const { msg, getReject } = mkMessage({
      from: 'alice@example.com',
      to: 'user@verified.test',
      raw,
    });
    await worker.email!(msg, testEnv as unknown as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(getReject()).toBeUndefined();

    const row = await testEnv.DB.prepare(
      `SELECT id, r2_key, status FROM messages WHERE mailbox_id = 'mb1'`,
    ).first<{ id: string; r2_key: string; status: string }>();
    expect(row).toBeTruthy();
    expect(row!.r2_key).toMatch(/.+/);

    const obj = await testEnv.R2.get(row!.r2_key);
    expect(obj).not.toBeNull();
  });

  it('rejects unknown domain (no messages row)', async () => {
    const ctx = createExecutionContext();
    const raw = new TextEncoder().encode(rfc822('reject-domain'));
    const { msg, getReject } = mkMessage({
      from: 'alice@example.com',
      to: 'user@nope.invalid',
      raw,
    });
    const before = await testEnv.DB.prepare(`SELECT COUNT(*) as c FROM messages`).first<{
      c: number;
    }>();
    await worker.email!(msg, testEnv as unknown as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(getReject()).toMatch(/550/);
    const after = await testEnv.DB.prepare(`SELECT COUNT(*) as c FROM messages`).first<{
      c: number;
    }>();
    expect(after!.c).toBe(before!.c);
  });

  it('rejects 26 MiB body with size cap', async () => {
    // Build a 26 MiB body — headers + 26 MiB payload. The `readAll()` reader
    // in services/in throws IngestError('too_large') once the running total
    // exceeds MAX_MESSAGE_SIZE_VERIFIED (25 MiB), which translates to
    // `552 5.3.4 too large`.
    const padding = 'a'.repeat(26 * 1024 * 1024);
    const bodyStr = rfc822('huge').replace(/\r\nhi\r\n/, `\r\n${padding}\r\n`);
    const raw = new TextEncoder().encode(bodyStr);
    const ctx = createExecutionContext();
    const { msg, getReject } = mkMessage({
      from: 'alice@example.com',
      to: 'user@verified.test',
      raw,
    });
    const before = await testEnv.DB.prepare(
      `SELECT COUNT(*) as c FROM messages WHERE mailbox_id='mb1'`,
    ).first<{ c: number }>();
    await worker.email!(msg, testEnv as unknown as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(getReject()).toMatch(/552/);
    const after = await testEnv.DB.prepare(
      `SELECT COUNT(*) as c FROM messages WHERE mailbox_id='mb1'`,
    ).first<{ c: number }>();
    expect(after!.c).toBe(before!.c);
  });
});
