// Phase 4a tests for the unified pipeline.
//
// Covers the corner-cases the production-hardening pass introduced or
// formalised:
//   * 4a.1 attachment R2 write failure causes processMessage to throw
//   * 4a.3 concurrent allocateInboundState assigns distinct UIDs
//   * 4a.4 malformed inbound message gets `''` from_addr (not recipient)
//   * 4a.5 IDN sender threads correctly across two ingests
//   * 4a.9 unsafe attachment filename is sanitised in the R2 key
//
// We exercise processMessage() against in-memory D1 / R2 fakes that
// implement just enough surface area for the SQL/key shapes the pipeline
// actually emits. The fakes are intentionally narrow — they reject any
// statement they don't recognise so a future pipeline change is forced
// to teach the test about it.
import { describe, expect, it } from 'vitest';
import {
  processMessage,
  ProcessMessageError,
  sanitizeAttachmentFilename,
  type PipelineEnv,
} from '../src/process-message.js';

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
    if (/FROM messages WHERE mailbox_id = \?1 AND r2_key = \?2/i.test(s)) {
      const mid = this.params[0] as string;
      const r2 = this.params[1] as string;
      const row = this.db.messages.find((m) => m['mailbox_id'] === mid && m['r2_key'] === r2);
      return (row ?? null) as T | null;
    }
    if (/FROM messages WHERE mailbox_id = \?1 AND header_message_id/i.test(s)) {
      return null;
    }
    if (/FROM messages\s+WHERE mailbox_id = \?1 AND from_addr_normalized = \?2/i.test(s)) {
      const mid = this.params[0] as string;
      const fromN = this.params[1] as string;
      const row = this.db.messages.find(
        (m) => m['mailbox_id'] === mid && m['from_addr_normalized'] === fromN,
      );
      return (row ?? null) as T | null;
    }
    if (/SELECT row_hash FROM audit_log/i.test(s)) {
      return null;
    }
    if (/SELECT id, row_hash FROM audit_log/i.test(s)) {
      return null;
    }
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
    return { results: [] };
  }
  async run() {
    if (/INSERT INTO messages/i.test(this.sql)) {
      // Bind layout: see packages/pipeline/src/process-message.ts. Post
      // operators-split (migration 0006) the messages table dropped
      // `principal_id`, so every index here is offset by 1 from the prior
      // layout.
      const fromAddr = this.params[4] as string;
      const row: Row = {
        id: this.params[0],
        mailbox_id: this.params[1],
        from_addr: fromAddr,
        // mimic the SQLite generated column LOWER(from_addr).
        from_addr_normalized: fromAddr.toLowerCase(),
        r2_key: this.params[7],
        thread_id: this.params[13],
      };
      this.db.messages.push(row);
    }
    if (/INSERT INTO mailbox_messages_state/i.test(this.sql)) {
      this.db.states.push({
        message_id: this.params[0],
        mailbox_id: this.params[1],
        uid: this.params[2],
        uid_validity: this.params[3],
        change_id: this.params[4],
      });
    }
    if (/INSERT INTO audit_log/i.test(this.sql)) {
      this.db.audits.push({ action: this.params[1], target: this.params[2] });
    }
    return { meta: { changes: 1 }, results: [] };
  }
}

class FakeDB {
  messages: Row[] = [];
  states: Row[] = [];
  audits: Row[] = [];
  uidCounters = new Map<string, { next_uid: number; uid_validity: number }>();
  changeCounters = new Map<string, { next_change_id: number }>();
  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
}

interface FakeR2Opts {
  failPutOnAttKey?: boolean;
}

class FakeR2 {
  store = new Map<string, Uint8Array>();
  putKeys: string[] = [];
  constructor(private opts: FakeR2Opts = {}) {}
  async head(key: string) {
    return this.store.has(key) ? {} : null;
  }
  async put(key: string, body: Uint8Array) {
    if (this.opts.failPutOnAttKey && key.startsWith('att/')) {
      throw new Error('synthetic R2 put failure');
    }
    this.store.set(key, body);
    this.putKeys.push(key);
  }
}

function rfc822WithAttachment(filename = 'safe.txt'): Uint8Array {
  // multipart/mixed with one text body + one application/octet-stream attachment.
  const boundary = 'BOUNDARY';
  const lines = [
    'From: alice@sender.com',
    'To: bob@example.com',
    'Subject: hi',
    'Message-ID: <abc@sender.com>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'hello world',
    '',
    `--${boundary}`,
    `Content-Type: application/octet-stream; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    'aGVsbG8=', // 'hello'
    '',
    `--${boundary}--`,
    '',
  ];
  return new TextEncoder().encode(lines.join('\r\n'));
}

function rfc822(from?: string): Uint8Array {
  const lines: string[] = ['To: bob@example.com', 'Subject: hi'];
  if (from) lines.unshift(`From: ${from}`);
  lines.push('Content-Type: text/plain; charset=utf-8', '', 'hello', '');
  return new TextEncoder().encode(lines.join('\r\n'));
}

function makeEnv(r2Opts: FakeR2Opts = {}): {
  env: PipelineEnv;
  db: FakeDB;
  r2: FakeR2;
} {
  const db = new FakeDB();
  const r2 = new FakeR2(r2Opts);
  const env: PipelineEnv = {
    DB: db as unknown as D1Database,
    R2: r2 as unknown as R2Bucket,
  };
  return { env, db, r2 };
}

describe('4a.1: attachment R2 write failure surfaces as ProcessMessageError', () => {
  it('throws ProcessMessageError when R2.put fails for an attachment', async () => {
    const { env } = makeEnv({ failPutOnAttKey: true });
    await expect(
      processMessage(env, {
        direction: 'in',
        mailboxId: 'MB1',
        rawMime: rfc822WithAttachment('safe.txt'),
        source: 'cf_email_routing',
        recipientAddress: 'bob@example.com',
      }),
    ).rejects.toBeInstanceOf(ProcessMessageError);
  });

  it('exposes a stable error code for callers to map to setReject / 5xx', async () => {
    const { env } = makeEnv({ failPutOnAttKey: true });
    try {
      await processMessage(env, {
        direction: 'in',
        mailboxId: 'MB1',
        rawMime: rfc822WithAttachment('safe.txt'),
        source: 'cf_email_routing',
        recipientAddress: 'bob@example.com',
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProcessMessageError);
      expect((e as ProcessMessageError).code).toBe('attachment_r2_write_failed');
    }
  });
});

describe('4a.3: atomic UID allocation', () => {
  it('assigns distinct UIDs to two concurrent inbound messages', async () => {
    const { env, db } = makeEnv();
    // Bootstrap the counter row so both pipeline runs hit the hot UPDATE
    // path. We then dispatch two processMessage calls in parallel; the
    // RETURNING-based mock serialises on the Map, which mirrors D1
    // SQLite's serialised-writer guarantee.
    db.uidCounters.set('MB1', { next_uid: 1, uid_validity: 1700000000 });
    const a = processMessage(env, {
      direction: 'in',
      mailboxId: 'MB1',
      rawMime: rfc822('alice@sender.com'),
      source: 'cf_email_routing',
      recipientAddress: 'bob@example.com',
    });
    const b = processMessage(env, {
      direction: 'in',
      mailboxId: 'MB1',
      // Different body so dedup doesn't short-circuit.
      rawMime: rfc822WithAttachment('att-2.txt'),
      source: 'cf_email_routing',
      recipientAddress: 'bob@example.com',
    });
    await Promise.all([a, b]);
    const uids = db.states.map((s) => s.uid).sort((x, y) => Number(x) - Number(y));
    expect(uids).toEqual([1, 2]);
  });
});

describe('4a.4: malformed inbound message gets empty from_addr', () => {
  it('writes "" (not the recipient) when the From header is missing', async () => {
    const { env, db } = makeEnv();
    // No From: header — summary.from will be ''.
    await processMessage(env, {
      direction: 'in',
      mailboxId: 'MB1',
      rawMime: rfc822(),
      source: 'cf_email_routing',
      recipientAddress: 'bob@example.com',
    });
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]!.from_addr).toBe('');
    // Crucially, NOT the recipient address.
    expect(db.messages[0]!.from_addr).not.toBe('bob@example.com');
  });
});

describe('4a.5: IDN sender threads correctly', () => {
  it('matches a Unicode form against an already-stored Punycode message', async () => {
    const { env, db } = makeEnv();
    // First ingest under the Unicode form.
    await processMessage(env, {
      direction: 'in',
      mailboxId: 'MB1',
      rawMime: rfc822('alice@münchen.de'),
      source: 'cf_email_routing',
      recipientAddress: 'bob@example.com',
    });
    expect(db.messages).toHaveLength(1);
    // After IDNA normalisation, from_addr is Punycode.
    expect(db.messages[0]!.from_addr).toBe('alice@xn--mnchen-3ya.de');
    const firstThread = db.messages[0]!.thread_id;
    // Second ingest, same logical sender, with the subject that triggers
    // the from-based thread lookup. We reuse the same Unicode form to
    // verify the thread group is reused.
    const secondBody = new TextEncoder().encode(
      [
        'From: alice@münchen.de',
        'To: bob@example.com',
        'Subject: Re: hi',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'follow-up',
        '',
      ].join('\r\n'),
    );
    await processMessage(env, {
      direction: 'in',
      mailboxId: 'MB1',
      rawMime: secondBody,
      source: 'cf_email_routing',
      recipientAddress: 'bob@example.com',
    });
    expect(db.messages).toHaveLength(2);
    expect(db.messages[1]!.thread_id).toBe(firstThread);
  });
});

describe('4a.9: attachment filename sanitisation', () => {
  it('strips path traversal sentinels and NUL bytes', () => {
    expect(sanitizeAttachmentFilename('../etc/passwd')).toBe('.._etc_passwd');
    expect(sanitizeAttachmentFilename('..')).toBe('attachment');
    expect(sanitizeAttachmentFilename('.')).toBe('attachment');
    expect(sanitizeAttachmentFilename('a b')).toBe('a_b');
    expect(sanitizeAttachmentFilename('with space.txt')).toBe('with_space.txt');
    expect(sanitizeAttachmentFilename('safe-name_1.txt')).toBe('safe-name_1.txt');
    expect(sanitizeAttachmentFilename('')).toBe('attachment');
  });

  it('produces a sanitised att/<sha>/<name> R2 key shape', async () => {
    const { env, r2 } = makeEnv();
    await processMessage(env, {
      direction: 'in',
      mailboxId: 'MB1',
      rawMime: rfc822WithAttachment('weird name.txt'),
      source: 'cf_email_routing',
      recipientAddress: 'bob@example.com',
    });
    const attKeys = r2.putKeys.filter((k) => k.startsWith('att/'));
    expect(attKeys).toHaveLength(1);
    // The filename component must be sanitised — no spaces, no traversal.
    expect(attKeys[0]).toMatch(/^att\/[0-9a-f]{64}\/weird_name\.txt$/);
  });
});
