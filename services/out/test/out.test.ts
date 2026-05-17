import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { OutboundQueueMessage, SendEmailBinding } from '../src/env.js';

class FakeQueue<T> {
  sent: T[] = [];
  async send(m: T) {
    this.sent.push(m);
  }
}
class FakeStatement {
  private params: unknown[] = [];
  private db: FakeDB;
  private sql: string;
  constructor(db: FakeDB, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...p: unknown[]) {
    this.params = p;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (/SELECT id, name FROM mail_domains WHERE name = \?/.test(this.sql)) {
      const name = this.params[0] as string;
      const row = this.db.domains.get(name);
      return row ? (row as T) : null;
    }
    if (/SELECT status FROM messages WHERE id = \?/.test(this.sql)) {
      const id = this.params[0] as string;
      const cur = this.db.statuses.get(id);
      return (cur ? ({ status: cur.status as string } as T) : null) as T | null;
    }
    return null;
  }
  async run() {
    if (/UPDATE messages SET status = \?, sending_at/.test(this.sql)) {
      const [status, _ts, last_error, bounce_metadata, id] = this.params;
      this.db.statuses.set(id as string, { status, last_error, bounce_metadata });
      return { meta: { changes: 1 }, results: [] };
    }
    if (/UPDATE messages SET status = \?, sent_at/.test(this.sql)) {
      const [status, _ts, last_error, bounce_metadata, id] = this.params;
      this.db.statuses.set(id as string, { status, last_error, bounce_metadata });
      return { meta: { changes: 1 }, results: [] };
    }
    if (/UPDATE messages SET status = \?, bounced_at/.test(this.sql)) {
      const [status, _ts, last_error, bounce_metadata, id] = this.params;
      this.db.statuses.set(id as string, { status, last_error, bounce_metadata });
      return { meta: { changes: 1 }, results: [] };
    }
    if (/UPDATE messages SET status = \?, failed_at/.test(this.sql)) {
      const [status, _ts, last_error, bounce_metadata, id] = this.params;
      this.db.statuses.set(id as string, { status, last_error, bounce_metadata });
      return { meta: { changes: 1 }, results: [] };
    }
    if (/UPDATE messages SET status = \?, last_error/.test(this.sql)) {
      const [status, last_error, bounce_metadata, id] = this.params;
      this.db.statuses.set(id as string, { status, last_error, bounce_metadata });
      return { meta: { changes: 1 }, results: [] };
    }
    return { meta: { changes: 0 }, results: [] };
  }
  async all() {
    return { results: [], meta: { changes: 0 } };
  }
}
class FakeDB {
  domains = new Map<string, { id: string; name: string }>();
  statuses = new Map<string, { status: unknown; last_error: unknown; bounce_metadata: unknown }>();
  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}
class FakeR2 {
  map = new Map<string, Uint8Array>();
  async get(key: string) {
    const t = this.map.get(key);
    if (!t) return null;
    return {
      arrayBuffer: async () =>
        t.buffer.slice(t.byteOffset, t.byteOffset + t.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(t),
    };
  }
}
class FakeBinding implements SendEmailBinding {
  fail?: 'throw' | 'bounce';
  lastTo?: string | string[];
  lastRaw?: ArrayBuffer | Uint8Array | string;
  async send(msg: {
    from: string;
    to: string | string[];
    raw?: ArrayBuffer | Uint8Array | string;
  }): Promise<{ delivered: string[]; permanent_bounces: string[]; queued: string[] }> {
    this.lastRaw = msg.raw;
    this.lastTo = msg.to;
    if (this.fail === 'throw') throw new Error('boom');
    if (this.fail === 'bounce')
      return { delivered: [], permanent_bounces: ['x@y.com'], queued: [] };
    return { delivered: ['b@x.com'], permanent_bounces: [], queued: [] };
  }
}

function rfc822Bytes(): Uint8Array {
  const m =
    'From: a@example.com\r\nTo: b@x.com\r\nSubject: hi\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n';
  return new TextEncoder().encode(m);
}

interface FakeBatchMessage {
  body: OutboundQueueMessage;
  attempts: number;
  acked: boolean;
  retried: boolean;
  ack(): void;
  retry(): void;
}

function mkBatch(body: OutboundQueueMessage, attempts = 1): MessageBatch<OutboundQueueMessage> {
  const m: FakeBatchMessage = {
    body,
    attempts,
    acked: false,
    retried: false,
    ack() {
      this.acked = true;
    },
    retry() {
      this.retried = true;
    },
  };
  return { messages: [m] } as unknown as MessageBatch<OutboundQueueMessage>;
}

function mkEnv(binding?: FakeBinding) {
  const env = {
    DB: new FakeDB() as unknown as D1Database,
    R2: new FakeR2() as unknown as R2Bucket,
    FANOUT_QUEUE: new FakeQueue() as unknown as Queue<unknown>,
  } as Record<string, unknown>;
  if (binding) env.EMAIL_EXAMPLE_COM = binding;
  return env;
}

function seedQueued(env: Record<string, unknown>, id: string) {
  // Seed status='queued' so the idempotency pre-check doesn't short-circuit.
  const db = env.DB as unknown as FakeDB;
  db.statuses.set(id, { status: 'queued', last_error: null, bounce_metadata: null });
}

describe('out worker', () => {
  it('sends a live message and emits message.sent (status=sent, no delivered transition)', async () => {
    const binding = new FakeBinding();
    const env = mkEnv(binding);
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    r2.map.set('mime/aa/bb/cafe', rfc822Bytes());
    seedQueued(env, '01HXR0000000000000000000A8');
    const batch = mkBatch({
      messageId: '01HXR0000000000000000000A8',
      source: 'raw',
      r2KeyOrInline: 'mime/aa/bb/cafe',
      fromDomain: 'example.com',
      fromAddress: 'a@example.com',
      envelopeTo: ['b@x.com'],
      mailboxId: 'svc',
      domainId: 'D1',
      mode: 'live',
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string }>).sent;
    expect(sent.length).toBe(1);
    expect(sent[0]?.event).toBe('message.sent');
    expect(sent.some((s) => s.event === 'message.delivered')).toBe(false);
    expect(db.statuses.get('01HXR0000000000000000000A8')?.status).toBe('sent');
    expect(binding.lastRaw).toBeTruthy();
  });

  it('P0 bug #1: envelope `to` is the recipient, NOT the sender', async () => {
    // Regression: the previous handler shipped `to: msg.fromAddress` so
    // every message bounced back to the sender. Verify explicitly.
    const binding = new FakeBinding();
    const env = mkEnv(binding);
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    r2.map.set('k', rfc822Bytes());
    seedQueued(env, 'M-recip');
    const batch = mkBatch({
      messageId: 'M-recip',
      source: 'raw',
      r2KeyOrInline: 'k',
      fromDomain: 'example.com',
      fromAddress: 'sender@example.com',
      envelopeTo: ['actual-recipient@x.com'],
      mailboxId: 'svc',
      domainId: 'D1',
      mode: 'live',
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    expect(binding.lastTo).toBe('actual-recipient@x.com');
    expect(binding.lastTo).not.toBe('sender@example.com');
  });

  it('passes envelope as array when there are multiple recipients (cc/bcc)', async () => {
    const binding = new FakeBinding();
    const env = mkEnv(binding);
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    r2.map.set('k', rfc822Bytes());
    seedQueued(env, 'M-multi');
    const batch = mkBatch({
      messageId: 'M-multi',
      source: 'raw',
      r2KeyOrInline: 'k',
      fromDomain: 'example.com',
      fromAddress: 'sender@example.com',
      envelopeTo: ['a@x.com', 'b@x.com', 'c@x.com'],
      mailboxId: 'svc',
      domainId: 'D1',
      mode: 'live',
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    expect(Array.isArray(binding.lastTo)).toBe(true);
    expect(binding.lastTo).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('test mode skips binding and emits synthetic sent', async () => {
    const env = mkEnv();
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    r2.map.set('k', rfc822Bytes());
    seedQueued(env, 'M');
    const batch = mkBatch({
      messageId: 'M',
      source: 'raw',
      r2KeyOrInline: 'k',
      fromDomain: 'example.com',
      fromAddress: 'a@example.com',
      envelopeTo: ['b@x.com'],
      mailboxId: 'svc',
      domainId: 'D1',
      mode: 'test',
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (
      env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string; data: { test?: boolean } }>
    ).sent;
    expect(sent[0]?.data.test).toBe(true);
    expect(db.statuses.get('M')?.status).toBe('sent');
  });

  it('handles permanent bounce (and stamps bounced_at via the bounced status)', async () => {
    const binding = new FakeBinding();
    binding.fail = 'bounce';
    const env = mkEnv(binding);
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    r2.map.set('k', rfc822Bytes());
    seedQueued(env, 'B');
    const batch = mkBatch({
      messageId: 'B',
      source: 'raw',
      r2KeyOrInline: 'k',
      fromDomain: 'example.com',
      fromAddress: 'a@example.com',
      envelopeTo: ['b@x.com'],
      mailboxId: 'svc',
      domainId: 'D1',
      mode: 'live',
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string }>).sent;
    expect(sent[0]?.event).toBe('message.bounced');
    expect(db.statuses.get('B')?.status).toBe('bounced');
  });

  it('no domain row → failed (and emits message.failed event)', async () => {
    const env = mkEnv();
    const r2 = env.R2 as unknown as FakeR2;
    r2.map.set('k', rfc822Bytes());
    seedQueued(env, 'X');
    const batch = mkBatch({
      messageId: 'X',
      source: 'raw',
      r2KeyOrInline: 'k',
      fromDomain: 'nodom.com',
      fromAddress: 'a@nodom.com',
      envelopeTo: ['b@x.com'],
      mailboxId: 'svc',
      domainId: null,
      mode: 'live',
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const db = env.DB as unknown as FakeDB;
    const sent = (env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string }>).sent;
    expect(db.statuses.get('X')?.status).toBe('failed');
    expect(sent[0]?.event).toBe('message.failed');
  });

  it('missing send_email binding → failed + message.failed event', async () => {
    // No binding registered for example.com on the env → bindingNameForDomain
    // resolves to EMAIL_EXAMPLE_COM but the env has no such property. The
    // handler should mark failed AND emit a fanout event so downstream
    // consumers (e.g. panel) can render the terminal transition.
    const env = mkEnv(); // no binding
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    r2.map.set('k', rfc822Bytes());
    seedQueued(env, 'NB');
    const batch = mkBatch({
      messageId: 'NB',
      source: 'raw',
      r2KeyOrInline: 'k',
      fromDomain: 'example.com',
      fromAddress: 'a@example.com',
      envelopeTo: ['b@x.com'],
      mailboxId: 'svc',
      domainId: 'D1',
      mode: 'live',
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (
      env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string; data: { reason?: string } }>
    ).sent;
    expect(db.statuses.get('NB')?.status).toBe('failed');
    expect(sent[0]?.event).toBe('message.failed');
    expect(sent[0]?.data?.reason).toBe('no_binding');
  });

  it('missing R2 body → failed + message.failed event with reason r2_body_missing (P3 #5)', async () => {
    const env = mkEnv();
    const db = env.DB as unknown as FakeDB;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    seedQueued(env, 'R2-miss');
    const batch = mkBatch({
      messageId: 'R2-miss',
      source: 'raw',
      r2KeyOrInline: 'missing-key',
      fromDomain: 'example.com',
      fromAddress: 'a@example.com',
      envelopeTo: ['b@x.com'],
      mailboxId: 'svc',
      domainId: 'D1',
      mode: 'live',
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (
      env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string; data: { reason?: string } }>
    ).sent;
    expect(db.statuses.get('R2-miss')?.status).toBe('failed');
    expect(sent[0]?.event).toBe('message.failed');
    expect(sent[0]?.data?.reason).toBe('r2_body_missing');
  });

  it('invalid FQDN (consecutive dots) → failed + message.failed (P3 #7)', async () => {
    // Without FQDN validation, `bindingNameForDomain('sub..domain.com')` would
    // collapse to the same binding name as `sub.domain.com`. We require a
    // strict FQDN; the row is failed and a fanout event is emitted.
    const env = mkEnv();
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    r2.map.set('k', rfc822Bytes());
    db.domains.set('sub..domain.com', { id: 'D1', name: 'sub..domain.com' });
    seedQueued(env, 'FQ');
    const batch = mkBatch({
      messageId: 'FQ',
      source: 'raw',
      r2KeyOrInline: 'k',
      fromDomain: 'sub..domain.com',
      fromAddress: 'a@sub..domain.com',
      envelopeTo: ['b@x.com'],
      mailboxId: 'svc',
      domainId: 'D1',
      mode: 'live',
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (
      env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string; data: { reason?: string } }>
    ).sent;
    expect(db.statuses.get('FQ')?.status).toBe('failed');
    expect(sent[0]?.event).toBe('message.failed');
    expect(sent[0]?.data?.reason).toBe('invalid_from_domain');
  });

  it('idempotency: re-delivery of an already-sent message acks without resending (P0 #4)', async () => {
    // Pre-seed the status as `sent`. The handler must observe that and
    // skip the binding.send call entirely.
    const binding = new FakeBinding();
    const env = mkEnv(binding);
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    r2.map.set('k', rfc822Bytes());
    db.statuses.set('I-sent', { status: 'sent', last_error: null, bounce_metadata: null });
    const batch = mkBatch(
      {
        messageId: 'I-sent',
        source: 'raw',
        r2KeyOrInline: 'k',
        fromDomain: 'example.com',
        fromAddress: 'a@example.com',
        envelopeTo: ['b@x.com'],
        mailboxId: 'svc',
        domainId: 'D1',
        mode: 'live',
      },
      2 /* second attempt */,
    );
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    expect(binding.lastTo).toBeUndefined();
    // Status unchanged.
    expect(db.statuses.get('I-sent')?.status).toBe('sent');
  });

  it('retry exhaustion → failed + message.failed (uses CF native attempts) (P0 #2)', async () => {
    // Worker queue invokes the handler with attempts=MAX. The binding
    // throws; instead of throwing again (which would re-enqueue) we mark
    // the message failed and emit a fanout event.
    const binding = new FakeBinding();
    binding.fail = 'throw';
    const env = mkEnv(binding);
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    r2.map.set('k', rfc822Bytes());
    seedQueued(env, 'EX');
    const batch = mkBatch(
      {
        messageId: 'EX',
        source: 'raw',
        r2KeyOrInline: 'k',
        fromDomain: 'example.com',
        fromAddress: 'a@example.com',
        envelopeTo: ['b@x.com'],
        mailboxId: 'svc',
        domainId: 'D1',
        mode: 'live',
      },
      5 /* attempts === MAX_DELIVERY_ATTEMPTS */,
    );
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (
      env.FANOUT_QUEUE as unknown as FakeQueue<{
        event: string;
        data: { reason?: string; attempts?: number };
      }>
    ).sent;
    expect(db.statuses.get('EX')?.status).toBe('failed');
    expect(sent[0]?.event).toBe('message.failed');
    expect(sent[0]?.data?.attempts).toBe(5);
  });

  it('non-final attempt that throws is rethrown so Workers Queues retries', async () => {
    const binding = new FakeBinding();
    binding.fail = 'throw';
    const env = mkEnv(binding);
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    r2.map.set('k', rfc822Bytes());
    seedQueued(env, 'RT');
    // attempts=1 → should rethrow; outer try/catch in worker.queue logs and
    // calls m.retry(). The status is `sending` mid-throw, then the outer
    // catch flips it back to failed (so the row is reconcilable).
    const batch = mkBatch(
      {
        messageId: 'RT',
        source: 'raw',
        r2KeyOrInline: 'k',
        fromDomain: 'example.com',
        fromAddress: 'a@example.com',
        envelopeTo: ['b@x.com'],
        mailboxId: 'svc',
        domainId: 'D1',
        mode: 'live',
      },
      1,
    );
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    // Outer catch in worker.queue flips sending → failed (P0 #3 recovery).
    expect(db.statuses.get('RT')?.status).toBe('failed');
    const m = (batch as unknown as { messages: FakeBatchMessage[] }).messages[0]!;
    expect(m.retried).toBe(true);
    expect(m.acked).toBe(false);
  });
  it('oversized raw body rejected before binding.send', async () => {
    // Belt-and-suspenders: a 26 MiB R2 object (above the 25 MiB CF cap) must
    // fail with a typed `message_too_large:<bytes>` last_error and never reach
    // binding.send. The API-layer pre-enqueue check is the
    // authoritative gate; this guards against stale enqueues or bugs.
    const binding = new FakeBinding();
    const env = mkEnv(binding);
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    const oversized = new Uint8Array(26 * 1024 * 1024);
    oversized.fill(0x61); // 'a'
    r2.map.set('mime/big', oversized);
    const batch = mkBatch({
      messageId: 'OVERSIZE',
      source: 'raw',
      r2KeyOrInline: 'mime/big',
      fromDomain: 'example.com',
      fromAddress: 'a@example.com',
      mailboxId: 'svc',
      domainId: 'D1',
      mode: 'live',
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    // binding.send must NEVER be called.
    expect(binding.lastRaw).toBeUndefined();
    // Status must be 'failed' with a typed message_too_large:<bytes> error.
    const status = db.statuses.get('OVERSIZE');
    expect(status?.status).toBe('failed');
    expect(status?.last_error).toMatch(/^message_too_large:\d+$/);
    expect(status?.last_error).toBe(`message_too_large:${oversized.byteLength}`);
    // Fanout must include a typed message.failed event with reason=message_too_large.
    const sent = (
      env.FANOUT_QUEUE as unknown as FakeQueue<{
        event: string;
        data?: { reason?: string; bytes?: number; cap?: number };
      }>
    ).sent;
    expect(sent.length).toBe(1);
    expect(sent[0]?.event).toBe('message.failed');
    expect(sent[0]?.data?.reason).toBe('message_too_large');
    expect(sent[0]?.data?.bytes).toBe(oversized.byteLength);
    expect(typeof sent[0]?.data?.cap).toBe('number');
  });
});
