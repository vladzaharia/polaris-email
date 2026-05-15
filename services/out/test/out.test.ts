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
  lastRaw?: ArrayBuffer | Uint8Array | string;
  async send(msg: {
    from: string;
    to: string | string[];
    raw?: ArrayBuffer | Uint8Array | string;
  }): Promise<{ delivered: string[]; permanent_bounces: string[]; queued: string[] }> {
    this.lastRaw = msg.raw;
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

function mkBatch(body: OutboundQueueMessage) {
  return {
    messages: [
      {
        body,
        ack() {},
        retry() {},
      },
    ],
  } as unknown as MessageBatch<OutboundQueueMessage>;
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

describe('out worker', () => {
  it('sends a live message and emits message.sent (status=sent, no delivered transition)', async () => {
    const binding = new FakeBinding();
    const env = mkEnv(binding);
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    r2.map.set('mime/aa/bb/cafe', rfc822Bytes());
    const batch = mkBatch({
      messageId: '01HXR0000000000000000000A8',
      source: 'raw',
      r2KeyOrInline: 'mime/aa/bb/cafe',
      fromDomain: 'example.com',
      fromAddress: 'a@example.com',
      mailboxId: 'svc',
      domainId: 'D1',
      mode: 'live',
      retries: 0,
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string }>).sent;
    expect(sent.length).toBe(1);
    expect(sent[0]?.event).toBe('message.sent');
    // services/out NEVER emits 'message.delivered' — that's fanout's job.
    expect(sent.some((s) => s.event === 'message.delivered')).toBe(false);
    expect(db.statuses.get('01HXR0000000000000000000A8')?.status).toBe('sent');
    expect(binding.lastRaw).toBeTruthy();
  });
  it('test mode skips binding and emits synthetic sent', async () => {
    const env = mkEnv();
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    r2.map.set('k', rfc822Bytes());
    const batch = mkBatch({
      messageId: 'M',
      source: 'raw',
      r2KeyOrInline: 'k',
      fromDomain: 'example.com',
      fromAddress: 'a@example.com',
      mailboxId: 'svc',
      domainId: 'D1',
      mode: 'test',
      retries: 0,
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (
      env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string; data: { test?: boolean } }>
    ).sent;
    expect(sent[0]?.data.test).toBe(true);
    expect(db.statuses.get('M')?.status).toBe('sent');
  });
  it('handles permanent bounce', async () => {
    const binding = new FakeBinding();
    binding.fail = 'bounce';
    const env = mkEnv(binding);
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { id: 'D1', name: 'example.com' });
    r2.map.set('k', rfc822Bytes());
    const batch = mkBatch({
      messageId: 'B',
      source: 'raw',
      r2KeyOrInline: 'k',
      fromDomain: 'example.com',
      fromAddress: 'a@example.com',
      mailboxId: 'svc',
      domainId: 'D1',
      mode: 'live',
      retries: 0,
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string }>).sent;
    expect(sent[0]?.event).toBe('message.bounced');
    expect(db.statuses.get('B')?.status).toBe('bounced');
  });
  it('no domain row → failed', async () => {
    const env = mkEnv();
    const r2 = env.R2 as unknown as FakeR2;
    r2.map.set('k', rfc822Bytes());
    const batch = mkBatch({
      messageId: 'X',
      source: 'raw',
      r2KeyOrInline: 'k',
      fromDomain: 'nodom.com',
      fromAddress: 'a@nodom.com',
      mailboxId: 'svc',
      domainId: null,
      mode: 'live',
      retries: 0,
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const db = env.DB as unknown as FakeDB;
    expect(db.statuses.get('X')?.status).toBe('failed');
  });
});
