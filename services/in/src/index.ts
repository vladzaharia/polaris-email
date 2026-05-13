// polaris-email-in: Cloudflare Email Routing handler. Parses inbound MIME,
// stores raw in R2, inserts a canonical messages row, and emits a
// `message.received` fanout event for matching webhook subs.
import { ulid } from '@polaris-email/ids';
import { parseMime, ParseError } from './parse.js';

interface Env {
  DB: D1Database;
  R2: R2Bucket;
  KV_RATE_LIMIT: KVNamespace;
  FANOUT_QUEUE: Queue<FanoutInbound>;
}

interface FanoutInbound {
  event_id: string;
  event: 'message.received';
  message_id: string;
  tenant_id: string | null;
  domain_id: string | null;
  created_at: number;
  data: Record<string, unknown>;
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

async function rateShed(env: Env, domainId: string, sourceIp: string | null): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 60_000);
  const a = await env.KV_RATE_LIMIT.get(`dom:${domainId}:${bucket}`);
  const aCount = a ? Number.parseInt(a, 10) : 0;
  if (aCount >= 120) return true;
  await env.KV_RATE_LIMIT.put(`dom:${domainId}:${bucket}`, String(aCount + 1), {
    expirationTtl: 90,
  });
  if (sourceIp) {
    const b = await env.KV_RATE_LIMIT.get(`ip:${sourceIp}:${bucket}`);
    const bCount = b ? Number.parseInt(b, 10) : 0;
    if (bCount >= 60) return true;
    await env.KV_RATE_LIMIT.put(`ip:${sourceIp}:${bucket}`, String(bCount + 1), {
      expirationTtl: 90,
    });
  }
  return false;
}

function addressMatches(pattern: string, addr: string): boolean {
  // Patterns: exact `local@domain`, prefix `local@*`, suffix `*@domain`,
  // or full-glob `*` (catch-all). Lower-cased.
  const a = addr.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === '*') return true;
  if (!p.includes('*')) return p === a;
  // Convert simple glob to regex (escape, replace \* with .*).
  const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(a);
}

export default {
  /**
   * Cloudflare's Email Worker handler. `message` exposes `.raw` (stream),
   * `from`, `to`, `headers`, `forward()`, `setReject()`.
   */
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const id = ulid();
    const r2KeyTmp = `in/_unrouted/${id}-${randomSuffix()}.eml`;

    let raw: Uint8Array;
    try {
      raw = await readAll(message.raw);
    } catch (e) {
      message.setReject(
        e instanceof ParseError && e.code === 'too_large'
          ? '552 5.3.4 too large'
          : '451 4.7.1 ingest error',
      );
      return;
    }

    // Persist raw FIRST so we never lose evidence.
    await env.R2.put(r2KeyTmp, raw, { httpMetadata: { contentType: 'message/rfc822' } });

    const envelopeTo = (message.to ?? '').toLowerCase();
    const envelopeFrom = (message.from ?? '').toLowerCase();
    const domainPart = envelopeTo.split('@')[1] ?? '';

    // Resolve the recipient domain. If we don't host this domain at all,
    // reject with permanent failure.
    const domainRow = await env.DB.prepare(
      `SELECT md.id, t.id AS tenant_id
       FROM mail_domains md
       LEFT JOIN webhook_subs ws ON ws.domain_id = md.id
       LEFT JOIN tenants t ON ws.tenant_id = t.id
       WHERE md.name = ? AND md.disabled_at IS NULL
       LIMIT 1`,
    )
      .bind(domainPart)
      .first<{ id: string; tenant_id: string | null }>();
    if (!domainRow) {
      message.setReject('550 5.1.1 unknown domain');
      await env.R2.delete(r2KeyTmp).catch(() => undefined);
      return;
    }

    // Parse MIME — if it fails, still record the raw and emit parse_failed.
    let parsed;
    try {
      parsed = await parseMime(raw);
    } catch (e) {
      const reason = e instanceof ParseError ? e.code : 'parse_error';
      const now = Date.now();
      const r2KeyParseFail = `in/${domainRow.id}/${id}-${randomSuffix()}.eml`;
      await env.R2.put(r2KeyParseFail, raw, {
        httpMetadata: { contentType: 'message/rfc822' },
      });
      await env.R2.delete(r2KeyTmp).catch(() => undefined);
      await env.DB.prepare(
        `INSERT INTO messages
           (id, tenant_id, direction, status, from_addr, subject, r2_key,
            received_at_api, created_at, last_error)
         VALUES (?, ?, 'in', 'failed', ?, NULL, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          domainRow.tenant_id ?? '',
          envelopeFrom,
          r2KeyParseFail,
          new Date(now).toISOString(),
          new Date(now).toISOString(),
          reason,
        )
        .run();
      message.setReject('554 5.6.0 parse failed');
      return;
    }

    // Find a matching routing rule. Highest-priority (lowest number) wins.
    const rules = await env.DB.prepare(
      `SELECT id, priority, address_pattern, action, webhook_sub_id, forward_to
       FROM routing_rules
       WHERE domain_id = ? AND enabled = 1 AND disabled_at IS NULL
       ORDER BY priority ASC LIMIT 100`,
    )
      .bind(domainRow.id)
      .all<{
        id: string;
        priority: number;
        address_pattern: string;
        action: string;
        webhook_sub_id: string | null;
        forward_to: string | null;
      }>();

    const match = rules.results.find((r) => addressMatches(r.address_pattern, envelopeTo));
    if (!match || match.action === 'drop') {
      message.setReject('550 5.1.1 unknown user');
      await env.R2.delete(r2KeyTmp).catch(() => undefined);
      return;
    }
    if (match.action === 'forward' && match.forward_to) {
      // Hand off to CF Email Routing's forward primitive. R2 evidence is kept.
      await message.forward(match.forward_to);
      return;
    }

    // Rate-shed by domain + IP to absorb bursts.
    const ip = parsed.authResults.remoteIp ?? null;
    if (await rateShed(env, domainRow.id, ip)) {
      message.setReject('451 4.7.1 rate limit');
      await env.R2.delete(r2KeyTmp).catch(() => undefined);
      return;
    }

    // Rekey R2 to the canonical per-domain path.
    const r2KeyFinal = `in/${domainRow.id}/${id}.eml`;
    await env.R2.put(r2KeyFinal, raw, {
      httpMetadata: { contentType: 'message/rfc822' },
    });
    await env.R2.delete(r2KeyTmp).catch(() => undefined);

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    await env.DB.prepare(
      `INSERT INTO messages
         (id, tenant_id, direction, status, from_addr, subject, r2_key,
          received_at_api, created_at)
       VALUES (?, ?, 'in', 'received', ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        domainRow.tenant_id ?? '',
        envelopeFrom,
        parsed.subject?.slice(0, 256) ?? null,
        r2KeyFinal,
        nowIso,
        nowIso,
      )
      .run();

    await env.FANOUT_QUEUE.send({
      event_id: ulid(),
      event: 'message.received',
      message_id: id,
      tenant_id: domainRow.tenant_id,
      domain_id: domainRow.id,
      created_at: now,
      data: {
        from: envelopeFrom,
        to: envelopeTo,
        subject: parsed.subject ?? null,
        size_bytes: raw.byteLength,
        auth: parsed.authResults,
        matched_rule: match.id,
        matched_webhook_sub: match.webhook_sub_id,
      },
    });
  },
};
