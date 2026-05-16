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
    // 4a.3: atomic UID/change_id allocation. Mock the cold path (INSERT OR
    // IGNORE returns the seed row, UPDATE returns null when no row).
    if (/UPDATE mailbox_uid_counter[\s\S]+RETURNING/i.test(s)) {
      const mid = this.params[0] as string;
      const cur = this.db.uidCounters.get(mid);
      if (!cur) return null;
      cur.next_uid += 1;
      return { next_uid: cur.next_uid, uid_validity: cur.uid_validity } as T;
    }
    if (/INSERT OR IGNORE INTO mailbox_uid_counter[\s\S]+RETURNING/i.test(s)) {
      const mid = this.params[0] as string;
      if (this.db.uidCounters.has(mid)) return null;
      const validity = this.params[1] as number;
      this.db.uidCounters.set(mid, { next_uid: 2, uid_validity: validity });
      return { uid_validity: validity } as T;
    }
    if (/UPDATE mailbox_change_counter[\s\S]+RETURNING/i.test(s)) {
      const mid = this.params[0] as string;
      const cur = this.db.changeCounters.get(mid);
      if (!cur) return null;
      cur.next_change_id += 1;
      return { next_change_id: cur.next_change_id } as T;
    }
    if (/INSERT OR IGNORE INTO mailbox_change_counter[\s\S]+RETURNING/i.test(s)) {
      const mid = this.params[0] as string;
      if (this.db.changeCounters.has(mid)) return null;
      this.db.changeCounters.set(mid, { next_change_id: 2 });
      return { next_change_id: 2 } as T;
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
      // Bind position layout (see packages/pipeline/src/process-message.ts):
      //   0 id, 1 mailbox_id, 2 principal_id, 3 bridge_id, 4 direction,
      //   5 from_addr, 6 to_addrs, 7 subject, 8 r2_key, 9 content_sha256,
      //   10 body_bytes, 11 attachments_total_bytes,
      //   12 idempotency_key, 13 header_message_id, 14 thread_id,
      //   15 received_at_bridge, 16 received_at_api,
      //   17 auth_spf, 18 auth_dkim, 19 auth_dmarc, 20 auth_remote_ip,
      //   21 created_at
      const row: Row = {
        id: this.params[0],
        mailbox_id: this.params[1],
        from_addr: this.params[5],
        r2_key: this.params[8],
        header_message_id: this.params[13],
        thread_id: this.params[14],
        auth_spf: this.params[17],
        auth_dkim: this.params[18],
        auth_dmarc: this.params[19],
        auth_remote_ip: this.params[20],
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
  uidCounters = new Map<string, { next_uid: number; uid_validity: number }>();
  changeCounters = new Map<string, { next_change_id: number }>();
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

function mkMessage(opts: {
  to: string;
  raw: Uint8Array;
  headers?: Record<string, string>;
}): ForwardableEmailMessage {
  let rejected: string | undefined;
  const headerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headerMap.set(k.toLowerCase(), v);
  }
  return {
    to: opts.to,
    from: 'alice@sender.com',
    raw: streamFrom(opts.raw),
    headers: {
      get(name: string) {
        return headerMap.get(name.toLowerCase()) ?? null;
      },
    },
    setReject(reason: string) {
      rejected = reason;
    },
    async forward() {},
    get _rejected() {
      return rejected;
    },
  } as unknown as ForwardableEmailMessage;
}

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

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

  it('Phase 3f: extracts dkim/spf/dmarc verdicts from Authentication-Results header', async () => {
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
    const m = mkMessage({
      to: 'b@example.com',
      raw: rfc822(),
      headers: {
        'authentication-results': 'example.com; dkim=pass; spf=pass; dmarc=pass',
      },
    });
    await worker.email(m, env as never, ctx);
    expect(db.messages.length).toBe(1);
    expect(db.messages[0]!.auth_dkim).toBe('pass');
    expect(db.messages[0]!.auth_spf).toBe('pass');
    expect(db.messages[0]!.auth_dmarc).toBe('pass');
  });

  // 8e — non-pass verdicts must round-trip into messages.auth_* unchanged so
  // downstream consumers (and the audit log) see what the upstream MTA
  // actually said. parseAuthResults lowercases the verdict but does not
  // rewrite or filter values.
  it('8e: non-pass dkim/spf/dmarc verdicts persist verbatim (fail/neutral/permerror)', async () => {
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
    const m = mkMessage({
      to: 'b@example.com',
      raw: rfc822(),
      headers: {
        'authentication-results': 'example.com; dkim=fail; spf=neutral; dmarc=permerror',
      },
    });
    await worker.email(m, env as never, ctx);
    expect(db.messages.length).toBe(1);
    expect(db.messages[0]!.auth_dkim).toBe('fail');
    expect(db.messages[0]!.auth_spf).toBe('neutral');
    expect(db.messages[0]!.auth_dmarc).toBe('permerror');
  });

  // 8e — when CF Email Routing didn't prepend an Authentication-Results
  // header (or when the upstream stripped it), all three columns should
  // come out as null/empty. The pipeline binds parseAuthResults({}) → all
  // undefined → null in D1.
  it('8e: missing Authentication-Results header leaves auth columns null', async () => {
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
    // No `authentication-results` header in the headers map.
    const m = mkMessage({ to: 'b@example.com', raw: rfc822() });
    await worker.email(m, env as never, ctx);
    expect(db.messages.length).toBe(1);
    expect(db.messages[0]!.auth_dkim ?? null).toBeNull();
    expect(db.messages[0]!.auth_spf ?? null).toBeNull();
    expect(db.messages[0]!.auth_dmarc ?? null).toBeNull();
  });

  // 8e — a malformed Authentication-Results header (no recognised
  // dkim/spf/dmarc tokens) must not throw out of parseAuthResults; the
  // pipeline persists null and logs nothing fatal. The downstream MTA had
  // a bad day; we simply lose the verdict for this one message.
  it('8e: malformed Authentication-Results header is treated as missing (no throw)', async () => {
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
    const m = mkMessage({
      to: 'b@example.com',
      raw: rfc822(),
      headers: {
        // No `dkim=`/`spf=`/`dmarc=` segments — parseAuthResults yields {}.
        'authentication-results': 'this is not a real auth-results header at all',
      },
    });
    await expect(worker.email(m, env as never, ctx)).resolves.toBeUndefined();
    expect(db.messages.length).toBe(1);
    expect(db.messages[0]!.auth_dkim ?? null).toBeNull();
    expect(db.messages[0]!.auth_spf ?? null).toBeNull();
    expect(db.messages[0]!.auth_dmarc ?? null).toBeNull();
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

  it('P0 #2: forward branch goes through rateShed (was previously bypassed)', async () => {
    // Pre-stuff the per-domain bucket so the next request must shed.
    const db = new FakeDB();
    db.domains.push({ id: 'D1', name: 'example.com' });
    db.receivers.push({
      id: 'R1',
      mailbox_id: 'MB1',
      address_pattern: '*',
      action: 'forward',
      webhook_sub_id: null,
      forward_to: 'someone@elsewhere.test',
      domain_id: 'D1',
    });
    const r2 = new FakeR2();
    const kv = new FakeKV();
    const bucket = Math.floor(Date.now() / 60_000);
    // Cap is 120; seed at 120 so the next get returns >= cap.
    await kv.put(`dom:D1:${bucket}`, '120');
    const fanout = new FakeQueue();
    const env = {
      DB: db as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
      KV_RATE_LIMIT: kv as unknown as KVNamespace,
      FANOUT_QUEUE: fanout as unknown as Queue<unknown>,
    };
    let forwarded = false;
    let rejected: string | undefined;
    const m = {
      to: 'b@example.com',
      from: 'alice@sender.com',
      raw: streamFrom(rfc822()),
      setReject(reason: string) {
        rejected = reason;
      },
      async forward() {
        forwarded = true;
      },
    } as unknown as ForwardableEmailMessage;
    await worker.email(m, env as never, ctx);
    // rateShed must reject; forward must NOT have been invoked.
    expect(forwarded).toBe(false);
    expect(rejected).toMatch(/rate limit/);
  });

  it('P0 #1: fanout enqueue throwing is caught + setReject called (no uncaught exception)', async () => {
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
    // Make FANOUT_QUEUE.send throw on first call.
    const throwingFanout = {
      sent: [] as unknown[],
      async send(_m: unknown) {
        throw new Error('queue saturated');
      },
    };
    const env = {
      DB: db as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
      KV_RATE_LIMIT: kv as unknown as KVNamespace,
      FANOUT_QUEUE: throwingFanout as unknown as Queue<unknown>,
    };
    let rejected: string | undefined;
    const m = {
      to: 'b@example.com',
      from: 'alice@sender.com',
      raw: streamFrom(rfc822()),
      setReject(reason: string) {
        rejected = reason;
      },
      async forward() {},
    } as unknown as ForwardableEmailMessage;
    // Must not throw out of worker.email.
    await expect(worker.email(m, env as never, ctx)).resolves.toBeUndefined();
    expect(rejected).toMatch(/fanout enqueue failed/);
  });
});
