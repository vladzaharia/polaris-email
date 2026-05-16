// polaris-email-in: Cloudflare Email Routing handler.
//
// Validates inbound MIME + domain + rate-shedding + receiver mailbox lookup,
// then hands off the entire pipeline (R2 PUT, messages row, audit, fanout
// list) to `processMessage()` in services/api. This worker only owns the
// edge-specific concerns (raw-stream reading, rate shed, recipient -> mailbox
// resolution, forward primitive, fanout queue dispatch).
import { ulid } from '@polaris-email/ids';
import { parseAuthResults } from '@polaris-email/mime';
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

interface Env extends PipelineEnv {
  DB: D1Database;
  R2: R2Bucket;
  KV_RATE_LIMIT: KVNamespace;
  FANOUT_QUEUE: Queue<FanoutInbound>;
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

async function rateShed(env: Env, domainId: string): Promise<boolean> {
  // Per-domain rate shed only. CF Email Routing's `ForwardableEmailMessage`
  // does not currently expose a remote IP / cf-connecting-ip header, so the
  // previous per-IP branch was always fed `null` and never executed. Until
  // the platform exposes a peer IP we keep the surface minimal — a future
  // platform update can re-introduce the per-IP bucket.
  //
  // 4a.7: ordering note. We read, evaluate against the cap, and only
  // increment when the request is admitted. Pre-Phase-2c the counter was
  // bumped before the cap check, so a single noisy domain that already
  // tripped the limit kept inflating the counter (and the KV TTL kept
  // resetting), wedging the bucket for ~90s. The cap-check-before-write
  // shape below releases the bucket as soon as the first admitted request
  // in the next minute lands.
  //
  // KV is eventually consistent, so two concurrent requests at count=N
  // can both read N and both write N+1 (instead of N+2). The undercount
  // is bounded by isolate concurrency for a single domain — under steady
  // load the bucket still trips, just up to ~10 messages later than the
  // strict count would. We accept this; a Durable Object counter is the
  // right next step if precision matters for billing.
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `dom:${domainId}:${bucket}`;
  const cur = await env.KV_RATE_LIMIT.get(key);
  const count = cur ? Number.parseInt(cur, 10) : 0;
  if (Number.isFinite(count) && count >= 120) return true;
  await env.KV_RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 90 });
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

    // P0 (#2): rate-shed BEFORE the action branch so the forward path is
    // also limited. The previous code only rate-shed the webhook/store
    // path; a flood targeted at a forward route bypassed the limit
    // entirely.
    if (await rateShed(env, domainRow.id)) {
      message.setReject('451 4.7.1 rate limit');
      return;
    }

    if (match.action === 'forward' && match.forward_to) {
      // Hand off to CF Email Routing's forward primitive. No D1 / R2 / fanout
      // write — the forward target owns the message lifecycle from here.
      await message.forward(match.forward_to);
      return;
    }

    // Phase 3f — extract DKIM/SPF/DMARC verdicts from the
    // `Authentication-Results:` header that CF Email Routing prepends.
    // The pipeline persists these into messages.auth_dkim / auth_spf /
    // auth_dmarc when populated; previously this struct was always `{}`,
    // which left the columns NULL and stripped a useful trust signal from
    // every inbound row. CF puts the header in `message.headers` (a
    // Headers-shaped object); fall back to the empty struct if absent.
    const authHeader =
      typeof message.headers?.get === 'function'
        ? (message.headers.get('authentication-results') ?? '')
        : '';
    const authResults = parseAuthResults(authHeader);

    let result;
    try {
      result = await processMessage(env, {
        direction: 'in',
        mailboxId: match.mailbox_id,
        rawMime: raw,
        source: 'cf_email_routing',
        recipientAddress: envelopeTo,
        auth: authResults,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('in: processMessage error', e instanceof Error ? e.message : 'unknown');
      message.setReject('451 4.7.1 ingest error');
      return;
    }

    // P0 (#1): wrap the fanout-enqueue loop in try/catch. Without this, an
    // exception from `FANOUT_QUEUE.send()` propagates out of the email
    // handler — CF Email Routing then retries the entire ingest, which
    // re-runs `processMessage` and (because content-addressed dedup short-
    // circuits) re-enqueues only the un-sent fanout messages. That's
    // mostly safe, but it costs a full re-ingest per fanout failure and
    // depends on dedup to keep the message row stable. Failing this path
    // softly via setReject lets CF's own retry policy handle the retry
    // without running the entire pipeline again.
    const occurred_at = Date.now();
    try {
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
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        'in: fanout enqueue error',
        result.messageId,
        e instanceof Error ? e.message : 'unknown',
      );
      message.setReject('451 4.7.1 fanout enqueue failed');
      return;
    }
  },
};
