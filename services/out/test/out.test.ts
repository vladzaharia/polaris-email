import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { OutboundQueueMessage, SendEmailBinding } from '../src/env.js';

class FakeKV {}
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
    if (/SELECT binding_name FROM domains WHERE name = \?/.test(this.sql)) {
      const name = this.params[0] as string;
      return (this.db.domains.get(name) as T) ?? null;
    }
    return null;
  }
  async run() {
    if (/UPDATE messages/.test(this.sql)) {
      const [status, last_error, smtp_response, _ts, id] = this.params;
      this.db.statuses.set(id as string, { status, last_error, smtp_response });
      return { meta: { changes: 1 }, results: [] };
    }
    return { meta: { changes: 0 }, results: [] };
  }
  async all() {
    return { results: [], meta: { changes: 0 } };
  }
}
class FakeDB {
  domains = new Map<string, { binding_name: string | null }>();
  statuses = new Map<string, { status: unknown; last_error: unknown; smtp_response: unknown }>();
  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}
class FakeR2 {
  map = new Map<string, string>();
  async get(key: string) {
    const t = this.map.get(key);
    if (!t) return null;
    return { text: async () => t };
  }
}
class FakeBinding implements SendEmailBinding {
  fail?: 'throw' | 'bounce';
  async send(_msg: {
    from: string;
    to: string | string[];
  }): Promise<{ delivered: string[]; permanent_bounces: string[]; queued: string[] }> {
    if (this.fail === 'throw') throw new Error('boom');
    if (this.fail === 'bounce')
      return { delivered: [], permanent_bounces: ['x@y.com'], queued: [] };
    const toArr = Array.isArray(_msg.to) ? _msg.to : [_msg.to];
    return { delivered: toArr, permanent_bounces: [], queued: [] };
  }
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
    KV: new FakeKV(),
  } as Record<string, unknown>;
  if (binding) env.EMAIL_DEFAULT = binding;
  return env;
}

describe('out worker', () => {
  it('sends a live message and emits message.sent', async () => {
    const binding = new FakeBinding();
    const env = mkEnv(binding);
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { binding_name: 'EMAIL_DEFAULT' });
    r2.map.set(
      'out/svc/msg.json',
      JSON.stringify({
        from: 'a@example.com',
        to: ['b@x.com'],
        subject: 'hi',
        text: 'hello',
      }),
    );
    const batch = mkBatch({
      messageId: '01HXR0000000000000000000A8',
      source: 'json',
      r2KeyOrInline: 'out/svc/msg.json',
      fromDomain: 'example.com',
      fromAddress: 'a@example.com',
      mode: 'live',
      retries: 0,
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string }>).sent;
    expect(sent.length).toBe(1);
    expect(sent[0]?.event).toBe('message.sent');
    expect(db.statuses.get('01HXR0000000000000000000A8')?.status).toBe('sent');
  });
  it('test mode skips binding and emits synthetic sent', async () => {
    const env = mkEnv();
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { binding_name: 'EMAIL_DEFAULT' });
    r2.map.set(
      'k',
      JSON.stringify({
        from: 'a@example.com',
        to: ['b@x.com'],
        subject: 's',
        text: 't',
      }),
    );
    const batch = mkBatch({
      messageId: 'M',
      source: 'json',
      r2KeyOrInline: 'k',
      fromDomain: 'example.com',
      fromAddress: 'a@example.com',
      mode: 'test',
      retries: 0,
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string; data: { test?: boolean } }>).sent;
    expect(sent[0]?.data.test).toBe(true);
    expect(db.statuses.get('M')?.status).toBe('sent');
  });
  it('handles permanent bounce', async () => {
    const binding = new FakeBinding();
    binding.fail = 'bounce';
    const env = mkEnv(binding);
    const db = env.DB as unknown as FakeDB;
    const r2 = env.R2 as unknown as FakeR2;
    db.domains.set('example.com', { binding_name: 'EMAIL_DEFAULT' });
    r2.map.set('k', JSON.stringify({ from: 'a@example.com', to: ['x@y.com'], subject: 's' }));
    const batch = mkBatch({
      messageId: 'B',
      source: 'json',
      r2KeyOrInline: 'k',
      fromDomain: 'example.com',
      fromAddress: 'a@example.com',
      mode: 'live',
      retries: 0,
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const sent = (env.FANOUT_QUEUE as unknown as FakeQueue<{ event: string }>).sent;
    expect(sent[0]?.event).toBe('message.bounced');
    expect(db.statuses.get('B')?.status).toBe('bounced');
  });
  it('no binding for domain → failed', async () => {
    const env = mkEnv();
    const r2 = env.R2 as unknown as FakeR2;
    r2.map.set('k', JSON.stringify({ from: 'a@nodom.com', to: ['x@y.com'], subject: 's' }));
    const batch = mkBatch({
      messageId: 'X',
      source: 'json',
      r2KeyOrInline: 'k',
      fromDomain: 'nodom.com',
      fromAddress: 'a@nodom.com',
      mode: 'live',
      retries: 0,
    });
    await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);
    const db = env.DB as unknown as FakeDB;
    expect(db.statuses.get('X')?.status).toBe('failed');
  });
});
