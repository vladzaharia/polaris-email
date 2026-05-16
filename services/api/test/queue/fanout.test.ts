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
    // 4a.2: atomic UPDATE...RETURNING attempts increment.
    if (/UPDATE message_deliveries[\s\S]+SET attempts = attempts \+ 1[\s\S]+RETURNING attempts/i.test(s)) {
      const [_lastErr, _code, mid, wid] = this.params;
      const r = this.db.deliveries.find(
        (d) => d['message_id'] === mid && d['webhook_sub_id'] === wid,
      );
      if (!r) return null;
      r['attempts'] = (Number(r['attempts'] ?? 0) || 0) + 1;
      return { attempts: r['attempts'] } as T;
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
      // Mirror production WHERE clause: paused_at IS NULL AND disabled_at IS NULL.
      return {
        results: this.db.subs.filter(
          (x) =>
            x['id'] === id && x['paused_at'] == null && x['disabled_at'] == null,
        ) as T[],
      };
    }
    if (/FROM webhook_subs[\s\S]+WHERE mailbox_id = \?1/i.test(s)) {
      const mid = this.params[0] as string;
      return {
        results: this.db.subs.filter(
          (x) =>
            x['mailbox_id'] === mid && x['paused_at'] == null && x['disabled_at'] == null,
        ) as T[],
      };
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
      // 4a.2: tightened CAS — only flip when status IN ('sent','sending','received').
      // Mirror that here so two concurrent test calls observe at most one
      // delivered transition.
      const [ts, mid] = this.params;
      const r = this.db.messages.find((m) => m['id'] === mid);
      if (r && (r['status'] === 'sent' || r['status'] === 'sending' || r['status'] === 'received')) {
        r['status'] = 'delivered';
        r['delivered_at'] = ts;
        return { meta: { changes: 1 }, results: [] };
      }
      return { meta: { changes: 0 }, results: [] };
    } else if (/UPDATE message_deliveries\s+SET status = \?, next_attempt_at = \?/i.test(s)) {
      // 4a.2: terminal status update split out from the attempts increment.
      const [status, _next, mid, wid] = this.params;
      const r = this.db.deliveries.find(
        (d) => d['message_id'] === mid && d['webhook_sub_id'] === wid,
      );
      if (r) r['status'] = status;
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
      R2_PUBLIC_HOST: 'r2.mail.plrs.im',
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
      R2_PUBLIC_HOST: 'r2.mail.plrs.im',
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

  it('4a.2: concurrent maybeMarkDelivered calls flip messages.status exactly once', async () => {
    // Two batches, both for the same message + same sub. The first run
    // succeeds and flips status='delivered'; the second run sees the
    // already-delivered row and the CAS update returns changes=0. We
    // assert delivered_at is the *first* timestamp (CAS guarantees the
    // second flip is a no-op).
    const db = new FakeDB();
    db.messages.push({
      id: 'M_RACE',
      mailbox_id: 'MB1',
      direction: 'out',
      status: 'sent',
      r2_key: 'mime/aa/bb/race',
      created_at: '2026-01-01T00:00:00Z',
    });
    db.subs.push({
      id: 'WS_R',
      mailbox_id: 'MB1',
      url: 'https://hook.example/h',
      kind: 'external',
      secret: 's',
      secret_prev: null,
      events: JSON.stringify(['message.sent']),
      paused_at: null,
    });
    const r2 = new FakeR2();
    r2.store.set('mime/aa/bb/race', rfc822());
    const env = {
      DB: db as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
      R2_PUBLIC_HOST: 'r2.mail.plrs.im',
    } as unknown as Env;
    await fanoutQueueConsumer(
      mkBatch({
        event_id: 'EV_R1',
        event: 'message.sent',
        message_id: 'M_RACE',
        mailbox_id: 'MB1',
        created_at: 1_700_000_000_000,
      }),
      env,
    );
    const firstDelivered = db.messages[0]!.delivered_at;
    expect(firstDelivered).toBeTruthy();
    expect(db.messages[0]!.status).toBe('delivered');
    // Second run — same message_id + same sub. The deliveries row is
    // already 'succeeded' so maybeMarkDelivered re-evaluates true, but
    // the CAS WHERE clause now matches no rows (status='delivered').
    await fanoutQueueConsumer(
      mkBatch({
        event_id: 'EV_R2',
        event: 'message.sent',
        message_id: 'M_RACE',
        mailbox_id: 'MB1',
        created_at: 1_700_000_001_000,
      }),
      env,
    );
    expect(db.messages[0]!.status).toBe('delivered');
    expect(db.messages[0]!.delivered_at).toBe(firstDelivered);
  });

  it('8d: paused webhook sub is skipped (no delivery attempt)', async () => {
    // The production SELECT filters `paused_at IS NULL`. We mirror that in
    // the FakeStmt loader so the consumer never sees the paused row.
    const db = new FakeDB();
    db.messages.push({
      id: 'M_PAUSE',
      mailbox_id: 'MB1',
      direction: 'in',
      status: 'received',
      r2_key: 'mime/aa/bb/pause',
      created_at: '2026-01-01T00:00:00Z',
    });
    db.subs.push({
      id: 'WS_P',
      mailbox_id: 'MB1',
      url: 'https://hook.example/h',
      kind: 'external',
      secret: 's',
      secret_prev: null,
      events: JSON.stringify(['message.received']),
      paused_at: '2026-01-01T00:00:00Z',
      disabled_at: null,
    });
    const r2 = new FakeR2();
    r2.store.set('mime/aa/bb/pause', rfc822());
    const env = {
      DB: db as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
      R2_PUBLIC_HOST: 'r2.mail.plrs.im',
    } as unknown as Env;
    await fanoutQueueConsumer(
      mkBatch({
        event_id: 'EV_P',
        event: 'message.received',
        message_id: 'M_PAUSE',
        mailbox_id: 'MB1',
        webhook_sub_id: 'WS_P',
        created_at: 1_700_000_000_000,
      }),
      env,
    );
    expect(captured).toBeUndefined();
    expect(db.deliveries.length).toBe(0);
  });

  it('8d: disabled webhook sub is dropped (no delivery, no row)', async () => {
    // Same shape as paused but disabled_at is set. Both columns are matched
    // by the same WHERE clause so the consumer treats them identically.
    const db = new FakeDB();
    db.messages.push({
      id: 'M_DIS',
      mailbox_id: 'MB1',
      direction: 'in',
      status: 'received',
      r2_key: 'mime/aa/bb/dis',
      created_at: '2026-01-01T00:00:00Z',
    });
    db.subs.push({
      id: 'WS_D',
      mailbox_id: 'MB1',
      url: 'https://hook.example/h',
      kind: 'external',
      secret: 's',
      secret_prev: null,
      events: JSON.stringify(['message.received']),
      paused_at: null,
      disabled_at: '2026-01-01T00:00:00Z',
    });
    const r2 = new FakeR2();
    r2.store.set('mime/aa/bb/dis', rfc822());
    const env = {
      DB: db as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
      R2_PUBLIC_HOST: 'r2.mail.plrs.im',
    } as unknown as Env;
    await fanoutQueueConsumer(
      mkBatch({
        event_id: 'EV_D',
        event: 'message.received',
        message_id: 'M_DIS',
        mailbox_id: 'MB1',
        webhook_sub_id: 'WS_D',
        created_at: 1_700_000_000_000,
      }),
      env,
    );
    expect(captured).toBeUndefined();
    expect(db.deliveries.length).toBe(0);
  });

  it('4a.2: failed delivery attempts are atomically incremented (not racing reads)', async () => {
    const db = new FakeDB();
    db.messages.push({
      id: 'M_FAIL',
      mailbox_id: 'MB1',
      direction: 'out',
      status: 'sent',
      r2_key: 'mime/aa/bb/fail',
      created_at: '2026-01-01T00:00:00Z',
    });
    db.subs.push({
      id: 'WS_F',
      mailbox_id: 'MB1',
      url: 'https://hook.example/h',
      kind: 'external',
      secret: 's',
      secret_prev: null,
      events: JSON.stringify(['message.sent']),
      paused_at: null,
    });
    const r2 = new FakeR2();
    r2.store.set('mime/aa/bb/fail', rfc822());
    mode = 'fail';
    const env = {
      DB: db as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
      R2_PUBLIC_HOST: 'r2.mail.plrs.im',
    } as unknown as Env;
    // Two failures in sequence; attempts must be 1 then 2.
    await expect(
      fanoutQueueConsumer(
        mkBatch({
          event_id: 'EV_F1',
          event: 'message.sent',
          message_id: 'M_FAIL',
          mailbox_id: 'MB1',
          created_at: 1_700_000_000_000,
        }),
        env,
      ),
    ).resolves.toBeUndefined();
    expect(db.deliveries[0]!.attempts).toBe(1);
    await expect(
      fanoutQueueConsumer(
        mkBatch({
          event_id: 'EV_F2',
          event: 'message.sent',
          message_id: 'M_FAIL',
          mailbox_id: 'MB1',
          created_at: 1_700_000_001_000,
        }),
        env,
      ),
    ).resolves.toBeUndefined();
    expect(db.deliveries[0]!.attempts).toBe(2);
  });
});
