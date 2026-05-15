// Queue-consumer tests for the fanout pipeline embedded in services/api.
// Originally lived at services/fanout/test/fanout.test.ts; folded in during
// the B1 worker consolidation. Drives `fanoutQueueConsumer(batch, env)`
// directly — the equivalent of the queue export from the legacy fanout
// Worker, but with the api-shaped `Env`.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fanoutQueueConsumer, type FanoutEvent } from '../../src/queue/fanout.js';
import type { Env } from '../../src/env.js';

interface Row {
  [k: string]: unknown;
}

class FakeStmt {
  params: unknown[] = [];
  constructor(
    private db: FakeDB,
    private sql: string,
  ) {}
  bind(...p: unknown[]) {
    this.params = p;
    return this;
  }
  async first<T = unknown>(): Promise<T | null> {
    const s = this.sql;
    if (/SELECT id, mailbox_id, direction, status, r2_key/i.test(s)) {
      const id = this.params[0] as string;
      const row = this.db.messages.find((m) => m['id'] === id);
      return (row ?? null) as T | null;
    }
    if (/FROM message_deliveries WHERE message_id = \? AND webhook_sub_id = \?/i.test(s)) {
      const mid = this.params[0] as string;
      const wid = this.params[1] as string;
      const r = this.db.deliveries.find(
        (d) => d['message_id'] === mid && d['webhook_sub_id'] === wid,
      );
      return (r ? { attempts: r['attempts'] } : null) as T | null;
    }
    if (/SELECT[\s\S]+FROM message_deliveries[\s\S]+WHERE message_id = \?/i.test(s)) {
      const mid = this.params[0] as string;
      const rows = this.db.deliveries.filter((d) => d['message_id'] === mid);
      const unfinished = rows.filter((d) => d['status'] !== 'succeeded').length;
      return { unfinished, total: rows.length } as T;
    }
    return null;
  }
  async all<T = unknown>(): Promise<{ results: T[] }> {
    const s = this.sql;
    if (/FROM webhook_subs[\s\S]+WHERE id = \?1/i.test(s)) {
      const id = this.params[0] as string;
      return { results: this.db.subs.filter((x) => x['id'] === id) as T[] };
    }
    if (/FROM webhook_subs[\s\S]+WHERE mailbox_id = \?1/i.test(s)) {
      const mid = this.params[0] as string;
      return { results: this.db.subs.filter((x) => x['mailbox_id'] === mid) as T[] };
    }
    return { results: [] };
  }
  async run() {
    const s = this.sql;
    if (/INSERT OR IGNORE INTO message_deliveries/i.test(s)) {
      const [mid, wid] = this.params;
      if (!this.db.deliveries.find((d) => d['message_id'] === mid && d['webhook_sub_id'] === wid)) {
        this.db.deliveries.push({
          message_id: mid,
          webhook_sub_id: wid,
          status: 'pending',
          attempts: 0,
        });
      }
    } else if (/UPDATE message_deliveries[\s\S]+SET status = 'succeeded'/i.test(s)) {
      const [_code, mid, wid] = this.params;
      const r = this.db.deliveries.find(
        (d) => d['message_id'] === mid && d['webhook_sub_id'] === wid,
      );
      if (r) r['status'] = 'succeeded';
    } else if (/UPDATE messages\s+SET status = 'delivered'/i.test(s)) {
      const [ts, mid] = this.params;
      const r = this.db.messages.find((m) => m['id'] === mid);
      if (r) {
        r['status'] = 'delivered';
        r['delivered_at'] = ts;
      }
    }
    return { meta: { changes: 1 }, results: [] };
  }
}

class FakeDB {
  messages: Row[] = [];
  subs: Row[] = [];
  deliveries: Row[] = [];
  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
}

class FakeR2 {
  store = new Map<string, Uint8Array>();
  async get(key: string) {
    const t = this.store.get(key);
    if (!t) return null;
    return {
      arrayBuffer: async () =>
        t.buffer.slice(t.byteOffset, t.byteOffset + t.byteLength) as ArrayBuffer,
    };
  }
}

function rfc822(): Uint8Array {
  const lines = [
    'From: a@example.com',
    'To: b@x.com',
    'Subject: hi',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'hello',
    '',
  ];
  return new TextEncoder().encode(lines.join('\r\n'));
}

let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
let mode: 'ok' | 'fail' = 'ok';

beforeEach(() => {
  captured = undefined;
  mode = 'ok';
  vi.stubGlobal('fetch', async (input: RequestInfo, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : (input as Request).url;
    // safeFetch performs DNS pinning via DoH against 1.1.1.1/dns-query before
    // the webhook POST. Return a synthetic A record pointing at a public IP so
    // the SSRF deny-list check passes and the actual webhook fetch proceeds.
    if (u.startsWith('https://1.1.1.1/dns-query')) {
      return new Response(JSON.stringify({ Answer: [{ data: '203.0.113.5', type: 1 }] }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    }
    const headersIn = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersIn)) headers[k.toLowerCase()] = String(v);
    const bodyStr = init?.body ? String(init.body) : '';
    captured = { url: u, headers, body: bodyStr };
    if (mode === 'ok') return new Response('', { status: 200 });
    return new Response('boom', { status: 500 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mkBatch(body: FanoutEvent): MessageBatch<FanoutEvent> {
  return {
    queue: 'polaris-email-fanout',
    messages: [
      {
        body,
        ack() {},
        retry() {},
      },
    ],
  } as unknown as MessageBatch<FanoutEvent>;
}

describe('fanout envelope + delivered transition', () => {
  it('emits envelope with bare-hex X-Polaris-Sig and message JSON', async () => {
    const db = new FakeDB();
    db.messages.push({
      id: 'M1',
      mailbox_id: 'MB1',
      direction: 'in',
      status: 'received',
      r2_key: 'mime/aa/bb/key',
      thread_id: 'T1',
      header_message_id: '<abc@x>',
      created_at: '2026-01-01T00:00:00Z',
    });
    db.subs.push({
      id: 'WS1',
      mailbox_id: 'MB1',
      url: 'https://hook.example/h',
      kind: 'external',
      secret: 's3cret',
      secret_prev: null,
      events: JSON.stringify(['message.received']),
      paused_at: null,
    });
    const r2 = new FakeR2();
    r2.store.set('mime/aa/bb/key', rfc822());
    const env = {
      DB: db as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
    } as unknown as Env;
    await fanoutQueueConsumer(
      mkBatch({
        event_id: 'EV1',
        event: 'message.received',
        message_id: 'M1',
        mailbox_id: 'MB1',
        webhook_sub_id: 'WS1',
        created_at: 1_700_000_000_000,
      }),
      env,
    );
    expect(captured).toBeTruthy();
    expect(captured!.headers['x-polaris-sig']).toMatch(/^[0-9a-f]{64}$/);
    const envelope = JSON.parse(captured!.body) as Record<string, unknown>;
    expect(envelope.event).toBe('message.received');
    expect(envelope.event_id).toBe('EV1');
    expect(typeof envelope.occurred_at).toBe('string');
    expect((envelope.message as Record<string, unknown>).id).toBe('M1');
    expect((envelope.message as Record<string, unknown>).thread_id).toBe('T1');
  });

  it('flips messages.status to delivered after the last successful sub delivery', async () => {
    const db = new FakeDB();
    db.messages.push({
      id: 'M2',
      mailbox_id: 'MB1',
      direction: 'out',
      status: 'sent',
      r2_key: 'mime/aa/bb/key2',
      created_at: '2026-01-01T00:00:00Z',
    });
    db.subs.push({
      id: 'WSx',
      mailbox_id: 'MB1',
      url: 'https://hook.example/h',
      kind: 'external',
      secret: 's',
      secret_prev: null,
      events: JSON.stringify(['message.sent']),
      paused_at: null,
    });
    const r2 = new FakeR2();
    r2.store.set('mime/aa/bb/key2', rfc822());
    const env = {
      DB: db as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
    } as unknown as Env;
    await fanoutQueueConsumer(
      mkBatch({
        event_id: 'EV2',
        event: 'message.sent',
        message_id: 'M2',
        mailbox_id: 'MB1',
        created_at: 1_700_000_000_000,
      }),
      env,
    );
    const msg = db.messages.find((m) => m['id'] === 'M2')!;
    expect(msg.status).toBe('delivered');
    expect(msg.delivered_at).toBeTruthy();
  });
});
