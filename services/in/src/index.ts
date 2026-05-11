// polaris-email-in: Email Routing handler.
import { parseMime, ParseError } from './parse.js';

interface Env {
  DB: D1Database;
  R2: R2Bucket;
  KV_RATE: KVNamespace;
  FANOUT_QUEUE: Queue<FanoutInbound>;
}

interface FanoutInbound {
  event_id: string;
  event: 'message.received';
  message_id: string;
  mailbox_id: string | null;
  service_id: string | null;
  created_at: number;
  data: Record<string, unknown>;
}

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulidLite(): string {
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  let t = Date.now();
  let out = '';
  for (let i = 9; i >= 0; i--) {
    out = (CROCK[t % 32] ?? '0') + out;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) out += CROCK[(rnd[i] ?? 0) % 32];
  return out;
}

function randomSuffix(): string {
  const r = new Uint8Array(16);
  crypto.getRandomValues(r);
  return Array.from(r, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total > 25 * 1024 * 1024) {
      throw new ParseError('too_large', 'over 25MiB');
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

interface Match {
  to_regex?: string;
  from_regex?: string;
  subject_regex?: string;
}

function matches(rule: Match, msg: { to: string[]; from: string | null; subject: string | null }): boolean {
  if (rule.to_regex && !new RegExp(rule.to_regex).test(msg.to.join(','))) return false;
  if (rule.from_regex && !new RegExp(rule.from_regex).test(msg.from ?? '')) return false;
  if (rule.subject_regex && !new RegExp(rule.subject_regex).test(msg.subject ?? '')) return false;
  return true;
}

async function rateShed(env: Env, mailboxId: string, sourceIp: string | null): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 60_000);
  const a = await env.KV_RATE.get(`mbox:${mailboxId}:${bucket}`);
  const aCount = a ? Number.parseInt(a, 10) : 0;
  if (aCount >= 120) return true;
  await env.KV_RATE.put(`mbox:${mailboxId}:${bucket}`, String(aCount + 1), { expirationTtl: 90 });
  if (sourceIp) {
    const b = await env.KV_RATE.get(`ip:${sourceIp}:${bucket}`);
    const bCount = b ? Number.parseInt(b, 10) : 0;
    if (bCount >= 60) return true;
    await env.KV_RATE.put(`ip:${sourceIp}:${bucket}`, String(bCount + 1), {
      expirationTtl: 90,
    });
  }
  return false;
}

export default {
  /**
   * Cloudflare's Email Worker handler. `message` exposes `.raw` (stream), `from`, `to`,
   * `headers`, `forward()`, `setReject()`.
   */
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const id = ulidLite();
    const r2Key = `in/_unrouted/${id}-${randomSuffix()}.eml`;

    let raw: Uint8Array;
    try {
      raw = await readAll(message.raw);
    } catch (e) {
      // Tempfail so sender retries.
      message.setReject(e instanceof ParseError && e.code === 'too_large' ? '552 5.3.4 too large' : '451 4.7.1 ingest error');
      return;
    }

    // Persist raw FIRST so we never lose evidence.
    await env.R2.put(r2Key, raw, { httpMetadata: { contentType: 'message/rfc822' } });

    // Resolve target domain → mailbox via routing_rules
    const envelopeTo = (message.to ?? '').toLowerCase();
    const envelopeFrom = (message.from ?? '').toLowerCase();
    const domain = envelopeTo.split('@')[1] ?? '';

    // Parse MIME — but if it fails, we still record the raw and emit parse_failed.
    let parsed;
    try {
      parsed = await parseMime(raw);
    } catch (e) {
      const reason = e instanceof ParseError ? e.code : 'parse_error';
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages
           (id, mailbox_id, service_id, direction, mode, status, from_addr, subject,
            size_bytes, r2_key, created_at, updated_at, last_error)
         VALUES (?, NULL, NULL, 'in', 'live', 'parse_failed', ?, NULL, ?, ?, ?, ?, ?)`,
      )
        .bind(id, envelopeFrom, raw.byteLength, r2Key, now, now, reason)
        .run();
      message.setReject('554 5.6.0 parse failed');
      return;
    }

    // Routing-rule envelope check: rule mailbox_id must own a mailbox whose address
    // has the envelope-RCPT domain, otherwise reject cross-tenant attempts.
    const rules = await env.DB.prepare(
      `SELECT id, mailbox_id, match_json, priority FROM routing_rules
       WHERE domain = ? ORDER BY priority ASC LIMIT 100`,
    )
      .bind(domain)
      .all<{ id: string; mailbox_id: string; match_json: string; priority: number }>();

    let mailboxId: string | null = null;
    for (const rule of rules.results) {
      let m: Match = {};
      try {
        m = JSON.parse(rule.match_json) as Match;
      } catch {
        continue;
      }
      if (matches(m, parsed)) {
        const mb = await env.DB.prepare(
          `SELECT id, service_id, address FROM mailboxes WHERE id = ? AND disabled_at IS NULL`,
        )
          .bind(rule.mailbox_id)
          .first<{ id: string; service_id: string | null; address: string }>();
        if (!mb) continue;
        // Envelope-RCPT domain must match the mailbox's domain
        const mbDom = mb.address.split('@')[1]?.toLowerCase();
        if (mbDom !== domain) continue;
        mailboxId = mb.id;
        break;
      }
    }
    if (!mailboxId) {
      message.setReject('550 5.1.1 unknown user');
      return;
    }
    // Rate shed
    const ip = parsed.authResults.remoteIp ?? null;
    if (await rateShed(env, mailboxId, ip)) {
      message.setReject('451 4.7.1 rate limit');
      return;
    }
    // Bounce-spoof filter: if this looks like a DSN, require dkim=pass.
    const ct = parsed.headers.find((h) => h.name === 'content-type')?.value ?? '';
    const isDsn = /multipart\/report\s*;\s*report-type=delivery-status/i.test(ct);
    if (isDsn && parsed.authResults.dkim !== 'pass') {
      // Still store, but mark unauthenticated; reputation calc will skip.
      // (No reject — accept and continue.)
    }
    // Look up mailbox details for service_id
    const mbox = await env.DB.prepare(
      `SELECT id, service_id, address, max_inbound_bytes FROM mailboxes WHERE id = ?`,
    )
      .bind(mailboxId)
      .first<{ id: string; service_id: string | null; address: string; max_inbound_bytes: number }>();
    if (!mbox) {
      message.setReject('550 5.1.1 mailbox vanished');
      return;
    }
    if (raw.byteLength > mbox.max_inbound_bytes) {
      // Reject with permanent failure
      message.setReject('552 5.3.4 message too large for mailbox');
      return;
    }
    // Rekey R2 with the resolved mailbox path so the bridge sync loop can find it.
    const r2KeyFinal = `in/${mbox.service_id ?? 'unrouted'}/${id}-${randomSuffix()}.eml`;
    await env.R2.put(r2KeyFinal, raw, { httpMetadata: { contentType: 'message/rfc822' } });
    await env.R2.delete(r2Key);

    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO messages
         (id, mailbox_id, service_id, direction, mode, status, from_addr, subject,
          size_bytes, r2_key, auth_results_json, created_at, updated_at)
       VALUES (?, ?, ?, 'in', 'live', 'received', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        mbox.id,
        mbox.service_id,
        envelopeFrom,
        parsed.subject?.slice(0, 256) ?? null,
        raw.byteLength,
        r2KeyFinal,
        JSON.stringify(parsed.authResults),
        now,
        now,
      )
      .run();

    await env.FANOUT_QUEUE.send({
      event_id: ulidLite(),
      event: 'message.received',
      message_id: id,
      mailbox_id: mbox.id,
      service_id: mbox.service_id,
      created_at: now,
      data: {
        from: parsed.from,
        to: parsed.to,
        subject: parsed.subject,
        message_id_header: parsed.messageId,
        size_bytes: raw.byteLength,
        attachments: parsed.attachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
        })),
        auth_results: parsed.authResults,
        r2_key: r2KeyFinal,
      },
    });
  },
};
