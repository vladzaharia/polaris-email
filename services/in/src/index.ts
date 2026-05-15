// polaris-email-in: Cloudflare Email Routing handler.
//
// Validates inbound MIME + domain + rate-shedding + receiver mailbox lookup,
// then hands off the entire pipeline (R2 PUT, messages row, audit, fanout
// list) to `processMessage()` in services/api. This worker only owns the
// edge-specific concerns (raw-stream reading, rate shed, recipient -> mailbox
// resolution, forward primitive, fanout queue dispatch).
import { ulid } from '@polaris-email/ids';
import { processMessage, type PipelineEnv } from '@polaris-email/pipeline';

// Inbound-edge sentinel for the 25MiB stream cap. Strict MIME validation
// happens later inside `processMessage` (via `@polaris-email/mime`'s
// `parseStrict`/`summarizeMime`); this class only signals an edge-level
// size rejection that translates to SMTP 552.
class IngestError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Env {
  DB: D1Database;
  R2: R2Bucket;
  KV_RATE_LIMIT: KVNamespace;
  FANOUT_QUEUE: Queue<FanoutInbound>;
  OUTBOUND_QUEUE?: Queue<unknown>;
}

interface FanoutInbound {
  event_id: string;
  event: 'message.received';
  message_id: string;
  mailbox_id: string;
  webhook_sub_id: string;
  created_at: number;
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
      throw new IngestError('too_large', 'over 25MiB');
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
  const a = addr.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === '*') return true;
  if (!p.includes('*')) return p === a;
  const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(a);
}

export default {
  /**
   * Cloudflare Email Worker handler. Resolves recipient -> domain -> highest
   * priority matching receiver mailbox, then delegates to processMessage().
   * processMessage internally re-evaluates receiver matching to build the
   * fanout list (returned via fanoutEnqueues), which this worker dispatches
   * to FANOUT_QUEUE.
   */
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    let raw: Uint8Array;
    try {
      raw = await readAll(message.raw);
    } catch (e) {
      message.setReject(
        e instanceof IngestError && e.code === 'too_large'
          ? '552 5.3.4 too large'
          : '451 4.7.1 ingest error',
      );
      return;
    }

    const envelopeTo = (message.to ?? '').toLowerCase();
    const envelopeFrom = (message.from ?? '').toLowerCase();
    void envelopeFrom;
    const domainPart = envelopeTo.split('@')[1] ?? '';

    const domainRow = await env.DB.prepare(
      `SELECT id FROM mail_domains WHERE name = ? AND disabled_at IS NULL LIMIT 1`,
    )
      .bind(domainPart)
      .first<{ id: string }>();
    if (!domainRow) {
      message.setReject('550 5.1.1 unknown domain');
      return;
    }

    // Resolve mailbox via receivers (highest-priority match wins).
    const receivers = await env.DB.prepare(
      `SELECT id, mailbox_id, address_pattern, action, forward_to
       FROM mailbox_receivers
       WHERE domain_id = ? AND enabled = 1 AND disabled_at IS NULL
       ORDER BY priority ASC LIMIT 100`,
    )
      .bind(domainRow.id)
      .all<{
        id: string;
        mailbox_id: string;
        address_pattern: string;
        action: string;
        forward_to: string | null;
      }>();
    const match = receivers.results.find((r) => addressMatches(r.address_pattern, envelopeTo));
    if (!match || match.action === 'drop') {
      message.setReject('550 5.1.1 unknown user');
      return;
    }
    if (match.action === 'forward' && match.forward_to) {
      // Hand off to CF Email Routing's forward primitive. No D1 / R2 / fanout
      // write — the forward target owns the message lifecycle from here.
      await message.forward(match.forward_to);
      return;
    }

    // Rate-shed by domain + (optional) source IP.
    if (await rateShed(env, domainRow.id, null)) {
      message.setReject('451 4.7.1 rate limit');
      return;
    }

    let result;
    try {
      result = await processMessage(env as unknown as PipelineEnv, {
        direction: 'in',
        mailboxId: match.mailbox_id,
        rawMime: raw,
        source: 'cf_email_routing',
        recipientAddress: envelopeTo,
        auth: {},
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('in: processMessage error', e instanceof Error ? e.message : 'unknown');
      message.setReject('451 4.7.1 ingest error');
      return;
    }

    const occurred_at = Date.now();
    for (const enq of result.fanoutEnqueues ?? []) {
      await env.FANOUT_QUEUE.send({
        event_id: ulid(),
        event: enq.event,
        message_id: result.messageId,
        mailbox_id: match.mailbox_id,
        webhook_sub_id: enq.webhookSubId,
        created_at: occurred_at,
      });
    }
  },
};
