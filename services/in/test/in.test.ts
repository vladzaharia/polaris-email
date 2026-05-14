import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

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
    if (/FROM mail_domains WHERE name = \?/i.test(s)) {
      const name = this.params[0] as string;
      const r = this.db.domains.find((d) => d['name'] === name);
      return (r ?? null) as T | null;
    }
    if (/FROM messages WHERE mailbox_id = \?1 AND r2_key = \?2/i.test(s)) {
      return null; // never dedup-hit in tests
    }
    if (/FROM messages WHERE mailbox_id = \?1 AND header_message_id/i.test(s)) {
      return null;
    }
    if (/FROM messages\s+WHERE mailbox_id = \?1 AND from_addr_normalized/i.test(s)) {
      return null;
    }
    if (/SELECT row_hash FROM audit_log/i.test(s)) {
      return null;
    }
    if (/INSERT OR IGNORE INTO idempotency_keys/i.test(s)) {
      return { key: this.params[0] } as T;
    }
    return null;
  }
  async all<T = unknown>(): Promise<{ results: T[] }> {
    const s = this.sql;
    if (/FROM mailbox_receivers\s+WHERE domain_id = \?/i.test(s)) {
      const domainId = this.params[0] as string;
      const rows = this.db.receivers.filter((r) => r['domain_id'] === domainId);
      // Some calls bind (domain_id, mailbox_id), filter accordingly.
      if (this.params.length >= 2) {
        const mailboxId = this.params[1] as string;
        return { results: rows.filter((r) => r['mailbox_id'] === mailboxId) as T[] };
      }
      return { results: rows as T[] };
    }
    return { results: [] };
  }
  async run() {
    if (/INSERT INTO messages/i.test(this.sql)) {
      const row: Row = {
        id: this.params[0],
        mailbox_id: this.params[1],
        from_addr: this.params[5],
        r2_key: this.params[8],
        header_message_id: this.params[13],
        thread_id: this.params[14],
      };
      this.db.messages.push(row);
    }
    if (/INSERT INTO audit_log/i.test(this.sql)) {
      this.db.audits.push({ action: this.params[1], target: this.params[2] });
    }
    return { meta: { changes: 1 }, results: [] };
  }
}

class FakeDB {
  domains: Row[] = [];
  receivers: Row[] = [];
  messages: Row[] = [];
  audits: Row[] = [];
  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
}

class FakeR2 {
  putCalls: { key: string; len: number }[] = [];
  store = new Map<string, Uint8Array>();
  async head(key: string) {
    return this.store.has(key) ? {} : null;
  }
  async put(key: string, body: Uint8Array) {
    this.store.set(key, body);
    this.putCalls.push({ key, len: body.byteLength });
  }
  async delete() {}
  async get() {
    return null;
  }
}

class FakeKV {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
}

class FakeQueue<T> {
  sent: T[] = [];
  async send(m: T) {
    this.sent.push(m);
  }
}

function rfc822(to = 'b@example.com'): Uint8Array {
  const lines = [
    'From: alice@sender.com',
    `To: ${to}`,
    'Subject: hi',
    'Message-ID: <abc@sender.com>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'hello world',
    '',
  ];
  return new TextEncoder().encode(lines.join('\r\n'));
}

function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function mkMessage(opts: { to: string; raw: Uint8Array }): ForwardableEmailMessage {
  let rejected: string | undefined;
  return {
    to: opts.to,
    from: 'alice@sender.com',
    raw: streamFrom(opts.raw),
    setReject(reason: string) {
      rejected = reason;
    },
    async forward() {},
    get _rejected() {
      return rejected;
    },
  } as unknown as ForwardableEmailMessage;
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

describe('services/in email handler', () => {
  it('calls processMessage on a routable inbound message and enqueues fanout entries', async () => {
    const db = new FakeDB();
    db.domains.push({ id: 'D1', name: 'example.com' });
    db.receivers.push({
      id: 'R1',
      mailbox_id: 'MB1',
      address_pattern: '*',
      action: 'webhook',
      webhook_sub_id: 'WS1',
      forward_to: null,
      domain_id: 'D1',
    });
    const r2 = new FakeR2();
    const kv = new FakeKV();
    const fanout = new FakeQueue<{ event: string; message_id: string; webhook_sub_id: string }>();
    const env = {
      DB: db as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
      KV_RATE_LIMIT: kv as unknown as KVNamespace,
      FANOUT_QUEUE: fanout as unknown as Queue<unknown>,
    };
    const m = mkMessage({ to: 'b@example.com', raw: rfc822() });
    await worker.email(m, env as never, ctx);
    expect(r2.putCalls.length).toBe(1);
    expect(db.messages.length).toBe(1);
    expect(db.messages[0]!.r2_key).toMatch(/^mime\//);
    expect(db.messages[0]!.thread_id).toBeTruthy();
    expect(db.messages[0]!.header_message_id).toBe('<abc@sender.com>');
    expect(fanout.sent.length).toBe(1);
    expect(fanout.sent[0]!.event).toBe('message.received');
    expect(fanout.sent[0]!.webhook_sub_id).toBe('WS1');
  });

  it('rejects unknown domain with 550', async () => {
    const db = new FakeDB();
    const r2 = new FakeR2();
    const fanout = new FakeQueue();
    const env = {
      DB: db as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
      KV_RATE_LIMIT: new FakeKV() as unknown as KVNamespace,
      FANOUT_QUEUE: fanout as unknown as Queue<unknown>,
    };
    const m = mkMessage({ to: 'someone@unknown.test', raw: rfc822('someone@unknown.test') });
    await worker.email(m, env as never, ctx);
    expect(r2.putCalls.length).toBe(0);
    expect(db.messages.length).toBe(0);
  });

  it('drops when receiver action=drop', async () => {
    const db = new FakeDB();
    db.domains.push({ id: 'D1', name: 'example.com' });
    db.receivers.push({
      id: 'R1',
      mailbox_id: 'MB1',
      address_pattern: '*',
      action: 'drop',
      webhook_sub_id: null,
      forward_to: null,
      domain_id: 'D1',
    });
    const r2 = new FakeR2();
    const fanout = new FakeQueue();
    const env = {
      DB: db as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
      KV_RATE_LIMIT: new FakeKV() as unknown as KVNamespace,
      FANOUT_QUEUE: fanout as unknown as Queue<unknown>,
    };
    const m = mkMessage({ to: 'b@example.com', raw: rfc822() });
    await worker.email(m, env as never, ctx);
    expect(db.messages.length).toBe(0);
    expect((fanout as FakeQueue<unknown>).sent.length).toBe(0);
  });
});
