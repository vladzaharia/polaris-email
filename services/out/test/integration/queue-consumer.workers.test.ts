// Phase B.7 — pool-workers integration test for the services/out queue
// consumer. We import the worker module directly (the B.5 spike showed that
// `SELF.fetch()` does NOT route the cdn-cgi handlers correctly in
// pool-workers; for queue handlers we similarly invoke `worker.queue` with
// a forged MessageBatch from `createMessageBatch`).
//
// Migrations are loaded in Node (via `global-setup.ts`) and forwarded into
// the worker isolate through vitest's `inject()` channel — importing
// `@cloudflare/vitest-pool-workers` directly from a test file that runs
// inside workerd crashes the runtime.
//
// The `send_email` binding is overridden per-test by reassigning
// `env.EMAIL_VERIFIED_TEST` to an in-process stub recorder. This works
// because services/out derives the binding name from the domain at runtime
// (`EMAIL_` + uppercase + dot-replace). For domain `verified.test`, the
// binding name is `EMAIL_VERIFIED_TEST` — which matches the static binding
// declared in `services/out/wrangler.test.jsonc`.
import {
  applyD1Migrations,
  createMessageBatch,
  createExecutionContext,
  getQueueResult,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import worker from '../../src/index.js';
import type { OutboundQueueMessage, SendEmailBinding } from '../../src/env.js';

interface TestEnv {
  DB: D1Database;
  R2: R2Bucket;
  FANOUT_QUEUE: Queue<unknown>;
  EMAIL_VERIFIED_TEST?: SendEmailBinding;
}

const testEnv = env as unknown as TestEnv;

interface SendEmailCapture {
  from: string;
  to: string | string[];
  raw?: ArrayBuffer | Uint8Array | string;
}

function stubBinding(): {
  binding: SendEmailBinding;
  captured: SendEmailCapture[];
  setMode: (m: 'ok' | 'bounce' | 'throw') => void;
} {
  let mode: 'ok' | 'bounce' | 'throw' = 'ok';
  const captured: SendEmailCapture[] = [];
  const binding: SendEmailBinding = {
    async send(msg) {
      captured.push({ from: msg.from, to: msg.to, raw: msg.raw });
      if (mode === 'throw') throw new Error('boom');
      if (mode === 'bounce') return { delivered: [], permanent_bounces: ['x@y.com'], queued: [] };
      return {
        delivered: Array.isArray(msg.to) ? msg.to : [msg.to],
        permanent_bounces: [],
        queued: [],
      };
    },
  };
  return {
    binding,
    captured,
    setMode: (m) => {
      mode = m;
    },
  };
}

function rfc822Bytes(): Uint8Array {
  const m =
    'From: sender@verified.test\r\nTo: dest@example.com\r\nSubject: hi\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n';
  return new TextEncoder().encode(m);
}

async function seedMessageRow(opts: {
  id: string;
  r2_key: string;
  from_addr: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO messages (
       id, mailbox_id, direction, status, from_addr, r2_key, content_sha256,
       body_bytes, created_at
     ) VALUES (?, 'mb1', 'out', 'queued', ?, ?, 'sha-test', 100, ?)`,
  )
    .bind(opts.id, opts.from_addr, opts.r2_key, now)
    .run();
}

async function seedDomain(): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO mail_domains (
       id, zone_id, name, status, wildcard_subdomains, dmarc_policy, dmarc_rua,
       inbound_enabled, outbound_enabled, provider, dkim_selector,
       created_at, updated_at, verified_at
     ) VALUES ('d1', 'z1', 'verified.test', 'verified', 1, 'none',
       'mailto:postmaster@verified.test', 1, 1, 'cloudflare', 'cf', ?, ?, ?)`,
  )
    .bind(now, now, now)
    .run();
}

beforeAll(async () => {
  // `inject('migrations')` is populated by `test/integration/global-setup.ts`
  // running in Node before any worker isolate is booted.
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);

  const now = new Date().toISOString();
  // The static parents (zone + mailbox) are inserted once; per-test we reset
  // the rows the test cases touch (messages, mail_domains).
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
  // Reset per-test state.
  await testEnv.DB.prepare(`DELETE FROM messages`).run();
  await testEnv.DB.prepare(`DELETE FROM mail_domains WHERE name = 'verified.test'`).run();
  // Drop any leftover binding stub from a prior test.
  delete (testEnv as unknown as Record<string, unknown>).EMAIL_VERIFIED_TEST;
});

describe('services/out queue consumer (pool-workers)', () => {
  it('golden path: sends a queued message, transitions to sent, emits message.sent', async () => {
    await seedDomain();
    const r2Key = 'mime/aa/bb/golden';
    const msgId = '01HXR0000000000000000000A8';
    await testEnv.R2.put(r2Key, rfc822Bytes());
    await seedMessageRow({ id: msgId, r2_key: r2Key, from_addr: 'sender@verified.test' });

    const stub = stubBinding();
    (testEnv as unknown as Record<string, unknown>).EMAIL_VERIFIED_TEST = stub.binding;

    const body: OutboundQueueMessage = {
      messageId: msgId,
      source: 'raw',
      r2KeyOrInline: r2Key,
      fromDomain: 'verified.test',
      fromAddress: 'sender@verified.test',
      mailboxId: 'mb1',
      domainId: 'd1',
      mode: 'live',
    };
    const batch = createMessageBatch('polaris-email-outbound', [
      { id: body.messageId, timestamp: new Date(), attempts: 1, body },
    ]);
    const ctx = createExecutionContext();
    await worker.queue!(
      batch as unknown as MessageBatch<OutboundQueueMessage>,
      testEnv as unknown as never,
    );
    await getQueueResult(batch, ctx);

    expect(stub.captured.length).toBe(1);
    const cap = stub.captured[0]!;
    expect(cap.from).toBe('sender@verified.test');
    // The worker uses `to: msg.fromAddress` because the real recipients are
    // encoded inside the RFC822 envelope (see services/out/src/index.ts).
    expect(cap.to).toBe('sender@verified.test');
    expect(cap.raw).toBeTruthy();

    const row = await testEnv.DB.prepare(
      `SELECT status, last_error, sent_at FROM messages WHERE id = ?`,
    )
      .bind(msgId)
      .first<{ status: string; last_error: string | null; sent_at: string | null }>();
    expect(row?.status).toBe('sent');
    expect(row?.sent_at).toBeTruthy();
    expect(row?.last_error).toBeNull();
  });

  it('r2 body missing: status flips to failed with last_error=r2_body_missing, no send', async () => {
    await seedDomain();
    const msgId = '01HXR0000000000000000000B0';
    // Intentionally do NOT put any R2 object for this key.
    await seedMessageRow({
      id: msgId,
      r2_key: 'mime/missing/no-such-object',
      from_addr: 'sender@verified.test',
    });

    const stub = stubBinding();
    (testEnv as unknown as Record<string, unknown>).EMAIL_VERIFIED_TEST = stub.binding;

    const body: OutboundQueueMessage = {
      messageId: msgId,
      source: 'raw',
      r2KeyOrInline: 'mime/missing/no-such-object',
      fromDomain: 'verified.test',
      fromAddress: 'sender@verified.test',
      mailboxId: 'mb1',
      domainId: 'd1',
      mode: 'live',
    };
    const batch = createMessageBatch('polaris-email-outbound', [
      { id: body.messageId, timestamp: new Date(), attempts: 1, body },
    ]);
    const ctx = createExecutionContext();
    await worker.queue!(
      batch as unknown as MessageBatch<OutboundQueueMessage>,
      testEnv as unknown as never,
    );
    await getQueueResult(batch, ctx);

    expect(stub.captured.length).toBe(0);
    const row = await testEnv.DB.prepare(
      `SELECT status, last_error, failed_at FROM messages WHERE id = ?`,
    )
      .bind(msgId)
      .first<{ status: string; last_error: string | null; failed_at: string | null }>();
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('r2_body_missing');
    expect(row?.failed_at).toBeTruthy();
  });

  it('domain row missing: status flips to failed with last_error=no_domain_row, no send', async () => {
    // Note: NO seedDomain() — mail_domains will not have 'verified.test'.
    const r2Key = 'mime/aa/bb/nodom';
    const msgId = '01HXR0000000000000000000C0';
    await testEnv.R2.put(r2Key, rfc822Bytes());
    await seedMessageRow({ id: msgId, r2_key: r2Key, from_addr: 'sender@verified.test' });

    const stub = stubBinding();
    (testEnv as unknown as Record<string, unknown>).EMAIL_VERIFIED_TEST = stub.binding;

    const body: OutboundQueueMessage = {
      messageId: msgId,
      source: 'raw',
      r2KeyOrInline: r2Key,
      fromDomain: 'verified.test',
      fromAddress: 'sender@verified.test',
      mailboxId: 'mb1',
      domainId: 'd1',
      mode: 'live',
    };
    const batch = createMessageBatch('polaris-email-outbound', [
      { id: body.messageId, timestamp: new Date(), attempts: 1, body },
    ]);
    const ctx = createExecutionContext();
    await worker.queue!(
      batch as unknown as MessageBatch<OutboundQueueMessage>,
      testEnv as unknown as never,
    );
    await getQueueResult(batch, ctx);

    expect(stub.captured.length).toBe(0);
    const row = await testEnv.DB.prepare(
      `SELECT status, last_error, failed_at FROM messages WHERE id = ?`,
    )
      .bind(msgId)
      .first<{ status: string; last_error: string | null; failed_at: string | null }>();
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('no_domain_row');
    expect(row?.failed_at).toBeTruthy();
  });
});
