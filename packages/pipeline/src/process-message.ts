// Unified message pipeline.
//
// `processMessage()` is the single entry point for both inbound (CF Email
// Routing -> services/in) and outbound (REST /v1/messages, SMTP /v1/send/raw
// -> services/api) flows. All callers normalize their bytes into canonical
// RFC822 and call this function. It:
//
//   1. SHA-256 the canonical bytes and HEAD-then-PUT to R2 (reference-counted
//      so the janitor can delete unreferenced objects).
//   2. Parse + summarize MIME via `@polaris-email/mime`.
//   3. Outbound only: claim idempotency key in D1.
//   4. INSERT messages row at `status='received'` with thread_id +
//      header_message_id.
//   5. Outbound: enqueue OUTBOUND_QUEUE, transition to `queued`.
//      Inbound: resolve mailbox_receivers and return fanout enqueues; the
//      caller is responsible for dispatching to FANOUT_QUEUE.
//   6. Audit `message.submitted` (outbound) / `message.received` (inbound).

import { ulid } from '@polaris-email/ids';
import { sha256Hex } from '@polaris-email/hmac';
import { extractAttachmentParts, normalizeAddress, summarizeMime } from '@polaris-email/mime';
import { audit } from './audit.js';

export interface OutboundQueueMessage {
  messageId: string;
  source: 'raw';
  r2KeyOrInline: string;
  fromDomain: string;
  fromAddress: string;
  /**
   * Envelope recipients (RCPT TO). The CF `send_email` binding's `to` field
   * is the envelope-to (NOT the From/Sender header), so we must thread the
   * actual recipients through the queue. Populated by the pipeline from
   * `args.envelopeTo`. Older queue messages may omit it; consumers fall
   * back to `[fromAddress]` only as a last-ditch behaviour-preserving path.
   */
  envelopeTo?: string[];
  mailboxId: string;
  domainId: string | null;
  mode: 'live' | 'test';
  // `retries` removed in Phase 2b — services/out reads CF Workers Queues'
  // native `m.attempts` counter instead of trusting the queue body.
}

/**
 * Subset of the Cloudflare Worker environment that `processMessage` needs.
 * Each Worker (api / in) extends its own Env from this. OUTBOUND_QUEUE is
 * optional because services/in never produces to it.
 */
export interface PipelineEnv {
  DB: D1Database;
  R2: R2Bucket;
  OUTBOUND_QUEUE?: Queue<OutboundQueueMessage>;
}

export interface ProcessMessageArgs {
  direction: 'in' | 'out';
  mailboxId: string;
  principalId?: string | null;
  bridgeId?: string | null;
  rawMime: Uint8Array;
  source: 'rest' | 'smtp' | 'cf_email_routing';
  idempotencyKey?: string;
  /** Inbound-only authentication verdicts from CF Email Routing. */
  auth?: {
    spf?: string;
    dkim?: string;
    dmarc?: string;
    remoteIp?: string;
  };
  /** Outbound-only: envelope recipients for audit + queue enqueue. */
  envelopeTo?: string[];
  /** Inbound-only: envelope recipient that triggered the route. */
  recipientAddress?: string;
}

export interface FanoutEnqueue {
  webhookSubId: string;
  event: 'message.received';
}

export interface ProcessMessageResult {
  messageId: string;
  status: 'queued' | 'received';
  fresh: boolean;
  fanoutEnqueues?: FanoutEnqueue[];
}

export class ProcessMessageError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

/**
 * 4a.9: sanitize an attachment filename for inclusion in an R2 key.
 *
 * R2 keys end up in URLs served by the public custom domain
 * `r2.mail.plrs.im`; an unsafe filename can smuggle path traversal
 * (`..`), NUL, control chars, or whitespace. We collapse anything that
 * isn't a conservative ASCII shortlist to `_`, and explicitly reject the
 * dot/double-dot sentinels. SHA-256 in the key prefix already makes the
 * object content-addressed, so the filename component is purely cosmetic
 * (it influences the `Content-Disposition` filename when served).
 */
export function sanitizeAttachmentFilename(name: string): string {
  if (!name) return 'attachment';
  // Strip any directory separators / CR / LF / NUL / control bytes by
  // collapsing the entire filename through a conservative whitelist.
  let safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
  // `.` and `..` would resolve relative to the SHA-prefix and let the
  // object key shape be reinterpreted by some HTTP clients. Replace them
  // outright.
  if (safe === '.' || safe === '..' || safe === '') safe = 'attachment';
  return safe;
}

interface IdemClaim {
  first: boolean;
  messageId?: string;
}

async function tryClaim(
  env: PipelineEnv,
  key: string,
  mailboxId: string,
  principalId: string,
): Promise<IdemClaim> {
  // Composite PK (principal_id, key) — see migration 0004. principal_id is
  // mandatory for the outbound path that calls this helper. Insert with
  // claim_locked=1 so a concurrent claimant can distinguish "first writer
  // mid-flight" (spin a few times) from "first writer finished" (use the
  // recorded message_id).
  if (!principalId) {
    throw new Error('principal id required for idempotency claim');
  }
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO idempotency_keys
       (key, mailbox_id, principal_id, message_id, claim_locked, created_at)
     VALUES (?1, ?2, ?3, NULL, 1, ?4)
     RETURNING key`,
  )
    .bind(key, mailboxId, principalId, new Date().toISOString())
    .first<{ key: string }>();
  if (insert?.key === key) return { first: true };

  // Lost the race. Briefly poll for the winner's message_id before giving
  // up — the winner usually finishes within a few hundred milliseconds.
  // Five 200ms attempts ≈ 1s total wall-clock, well under any caller
  // timeout. A genuinely-stuck claim still surfaces as 425.
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await env.DB.prepare(
      `SELECT message_id, claim_locked FROM idempotency_keys
        WHERE principal_id = ?1 AND key = ?2`,
    )
      .bind(principalId, key)
      .first<{ message_id: string | null; claim_locked: number }>();
    if (row?.message_id) {
      return { first: false, messageId: row.message_id };
    }
    if (row && row.claim_locked === 0) {
      // Winner finished without recording a message_id — treat as resolved
      // failure; caller falls through to the in-progress error path.
      return { first: false };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { first: false };
}

/**
 * Allocate a `mailbox_messages_state` row for a freshly-arrived inbound
 * message, plus bumping `mailbox_uid_counter` and `mailbox_change_counter`.
 * Mirrors `services/api/src/lib/state.ts#ensureMailboxState`. Inlined here so
 * the pipeline package stays self-contained and the API + Email Routing
 * Workers both pick up state allocation through `processMessage()`.
 *
 * 4a.3: counter allocation is **atomic per statement**. The previous
 * SELECT-then-UPDATE pair raced under CF re-delivery — two concurrent
 * pipeline invocations could read the same `next_uid` and assign duplicate
 * UIDs, which breaks IMAP UID FETCH. We now use the `RETURNING` clause on
 * a CAS-ish UPDATE to read+increment in one round-trip, and an INSERT OR
 * IGNORE bootstrap path for the cold counter. SQLite serialises writers,
 * so on D1 the UPDATE is the canonical winner.
 */
async function allocateUid(
  env: PipelineEnv,
  mailboxId: string,
): Promise<{ uid: number; uidValidity: number }> {
  // First try the hot path: atomic increment via UPDATE ... RETURNING.
  // Returns the *new* `next_uid`; the allocated UID is the value we just
  // bumped past, so we subtract 1.
  const updated = await env.DB.prepare(
    `UPDATE mailbox_uid_counter
       SET next_uid = next_uid + 1
     WHERE mailbox_id = ?1
     RETURNING next_uid AS next_uid, uid_validity`,
  )
    .bind(mailboxId)
    .first<{ next_uid: number; uid_validity: number }>()
    .catch(() => null);
  if (updated) {
    return { uid: updated.next_uid - 1, uidValidity: updated.uid_validity };
  }
  // Cold path: row doesn't exist yet. INSERT OR IGNORE so concurrent
  // first-touchers don't both insert; the loser falls through to a retry
  // on the UPDATE branch.
  const uidValidity = Math.floor(Date.now() / 1000);
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO mailbox_uid_counter (mailbox_id, next_uid, uid_validity)
     VALUES (?1, 2, ?2)
     RETURNING uid_validity`,
  )
    .bind(mailboxId, uidValidity)
    .first<{ uid_validity: number }>()
    .catch(() => null);
  if (inserted) {
    return { uid: 1, uidValidity: inserted.uid_validity };
  }
  // INSERT lost the race; the row exists now. Retry the UPDATE.
  const retry = await env.DB.prepare(
    `UPDATE mailbox_uid_counter
       SET next_uid = next_uid + 1
     WHERE mailbox_id = ?1
     RETURNING next_uid AS next_uid, uid_validity`,
  )
    .bind(mailboxId)
    .first<{ next_uid: number; uid_validity: number }>();
  if (!retry) {
    // Defensive: should be unreachable. Throw so the caller's outer
    // try/catch logs and short-circuits state allocation.
    throw new Error('uid allocation lost both insert and update races');
  }
  return { uid: retry.next_uid - 1, uidValidity: retry.uid_validity };
}

async function allocateChangeId(env: PipelineEnv, mailboxId: string): Promise<number> {
  const updated = await env.DB.prepare(
    `UPDATE mailbox_change_counter
       SET next_change_id = next_change_id + 1
     WHERE mailbox_id = ?1
     RETURNING next_change_id AS next_change_id`,
  )
    .bind(mailboxId)
    .first<{ next_change_id: number }>()
    .catch(() => null);
  if (updated) return updated.next_change_id - 1;
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO mailbox_change_counter (mailbox_id, next_change_id)
     VALUES (?1, 2)
     RETURNING next_change_id`,
  )
    .bind(mailboxId)
    .first<{ next_change_id: number }>()
    .catch(() => null);
  if (inserted) return 1;
  const retry = await env.DB.prepare(
    `UPDATE mailbox_change_counter
       SET next_change_id = next_change_id + 1
     WHERE mailbox_id = ?1
     RETURNING next_change_id AS next_change_id`,
  )
    .bind(mailboxId)
    .first<{ next_change_id: number }>();
  if (!retry) throw new Error('change_id allocation lost both insert and update races');
  return retry.next_change_id - 1;
}

async function allocateInboundState(
  env: PipelineEnv,
  mailboxId: string,
  messageId: string,
): Promise<void> {
  const { uid, uidValidity } = await allocateUid(env, mailboxId);
  const changeId = await allocateChangeId(env, mailboxId);
  await env.DB.prepare(
    `INSERT INTO mailbox_messages_state
      (message_id, mailbox_id, read_at, expunged_at, flags_json, uid, uid_validity, change_id)
     VALUES (?1, ?2, NULL, NULL, '[]', ?3, ?4, ?5)`,
  )
    .bind(messageId, mailboxId, uid, uidValidity, changeId)
    .run();
}

// Resolve receivers for an inbound message and return the fanout-enqueue
// list. Called both on first delivery and on dedup hits — the queue
// consumer's INSERT OR IGNORE on (message_id, webhook_sub_id) absorbs
// duplicate enqueues from a true replay.
async function resolveInboundFanout(
  env: PipelineEnv,
  args: ProcessMessageArgs,
): Promise<FanoutEnqueue[]> {
  if (!args.recipientAddress) return [];
  const domainPart = args.recipientAddress.split('@')[1] ?? '';
  const domain = await env.DB.prepare(`SELECT id FROM mail_domains WHERE name = ?1 LIMIT 1`)
    .bind(domainPart)
    .first<{ id: string }>()
    .catch(() => null);
  if (!domain) return [];
  const receivers = await env.DB.prepare(
    `SELECT id, action, webhook_sub_id, forward_to, address_pattern
       FROM mailbox_receivers
      WHERE domain_id = ? AND mailbox_id = ? AND enabled = 1
      ORDER BY priority ASC LIMIT 100`,
  )
    .bind(domain.id, args.mailboxId)
    .all<{
      id: string;
      action: string;
      webhook_sub_id: string | null;
      forward_to: string | null;
      address_pattern: string;
    }>()
    .catch(() => ({ results: [] as never[] }));
  const out: FanoutEnqueue[] = [];
  for (const r of receivers.results) {
    if (!addressMatches(r.address_pattern, args.recipientAddress)) continue;
    if (r.action === 'webhook' && r.webhook_sub_id) {
      out.push({ webhookSubId: r.webhook_sub_id, event: 'message.received' });
    }
  }
  return out;
}

async function recordClaim(
  env: PipelineEnv,
  principalId: string,
  key: string,
  messageId: string,
): Promise<void> {
  // Clear claim_locked alongside writing message_id so spin-waiting peers
  // can detect "winner is done" in one read.
  await env.DB.prepare(
    `UPDATE idempotency_keys
        SET message_id = ?3, claim_locked = 0
      WHERE principal_id = ?1 AND key = ?2 AND message_id IS NULL`,
  )
    .bind(principalId, key, messageId)
    .run();
}

async function computeThreadId(
  env: PipelineEnv,
  ownId: string,
  mailboxId: string,
  references: string | undefined,
  inReplyTo: string | undefined,
  subject: string | undefined,
  fromAddr: string,
): Promise<string> {
  const refIds: string[] = [];
  if (references) {
    const matches = references.match(/<[^>]+>/g);
    if (matches) refIds.push(...matches);
  }
  if (inReplyTo) {
    const m = inReplyTo.match(/<[^>]+>/);
    if (m) refIds.push(m[0]);
  }
  for (const ref of refIds) {
    const row = await env.DB.prepare(
      `SELECT thread_id FROM messages WHERE mailbox_id = ?1 AND header_message_id = ?2 LIMIT 1`,
    )
      .bind(mailboxId, ref)
      .first<{ thread_id: string | null }>()
      .catch(() => null);
    if (row?.thread_id) return row.thread_id;
  }
  if (subject) {
    const normalized = subject
      .replace(/^(re:|fwd?:)\s*/i, '')
      .trim()
      .toLowerCase();
    if (normalized) {
      // 4a.5: the from_addr_normalized generated column is `LOWER(from_addr)`.
      // Callers now pass an IDNA-normalized fromAddr (see processMessage), so
      // the .toLowerCase() here is the right comparison shape; we
      // belt-and-braces re-normalize so a non-canonical caller still hits
      // the index.
      let lookup: string;
      try {
        lookup = fromAddr ? normalizeAddress(fromAddr).full : '';
      } catch {
        lookup = fromAddr.toLowerCase();
      }
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
      const row = await env.DB.prepare(
        `SELECT thread_id FROM messages
         WHERE mailbox_id = ?1 AND from_addr_normalized = ?2 AND created_at > ?3
         ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(mailboxId, lookup, sevenDaysAgo)
        .first<{ thread_id: string | null }>()
        .catch(() => null);
      if (row?.thread_id) return row.thread_id;
    }
  }
  return ownId;
}

function globToRegex(p: string): RegExp {
  return new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

function addressMatches(pattern: string, addr: string): boolean {
  const a = addr.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === '*') return true;
  if (!p.includes('*')) return p === a;
  return globToRegex(p).test(a);
}

/**
 * Unified ingestion pipeline. Idempotent w.r.t. (mailboxId, idempotencyKey)
 * for outbound; content-addressed dedup for inbound (same r2_key + mailbox).
 */
export async function processMessage(
  env: PipelineEnv,
  args: ProcessMessageArgs,
): Promise<ProcessMessageResult> {
  const now = new Date().toISOString();

  const contentSha = await sha256Hex(args.rawMime);
  const r2Key = `mime/${contentSha.slice(0, 2)}/${contentSha.slice(2, 4)}/${contentSha}`;

  if (args.direction === 'in') {
    const existing = await env.DB.prepare(
      `SELECT id, status FROM messages WHERE mailbox_id = ?1 AND r2_key = ?2 LIMIT 1`,
    )
      .bind(args.mailboxId, r2Key)
      .first<{ id: string; status: string }>()
      .catch(() => null);
    if (existing) {
      // Re-resolve fanout targets on dedup hits so a retried inbound
      // delivery still enqueues webhooks. The queue consumer uses
      // INSERT OR IGNORE on `message_deliveries` keyed by
      // (message_id, webhook_sub_id), so a true duplicate delivery from
      // a subscriber's perspective is absorbed without double-delivery.
      const fanoutEnqueues = await resolveInboundFanout(env, args);
      return {
        messageId: existing.id,
        status: 'received',
        fresh: false,
        fanoutEnqueues,
      };
    }
  }

  if (args.direction === 'out' && args.idempotencyKey) {
    if (!args.principalId) {
      // Composite (principal_id, key) PK requires a non-null principal.
      throw new ProcessMessageError(
        'principal id required for outbound idempotency claim',
        400,
        'bad_request',
      );
    }
    const claim = await tryClaim(env, args.idempotencyKey, args.mailboxId, args.principalId);
    if (!claim.first) {
      if (claim.messageId) {
        return { messageId: claim.messageId, status: 'queued', fresh: false };
      }
      throw new ProcessMessageError(
        'idempotency claim in progress; retry after 1s',
        425,
        'idempotency_in_progress',
      );
    }
  }

  const summary = summarizeMime(args.rawMime);

  const head = await env.R2.head(r2Key).catch(() => null);
  if (!head) {
    await env.R2.put(r2Key, args.rawMime, {
      httpMetadata: { contentType: 'message/rfc822' },
      customMetadata: { sha256: contentSha, contentLength: String(args.rawMime.length) },
    });
  }

  // B5: write each attachment as a discrete R2 object keyed by SHA-256 of
  // the decoded bytes. The public R2 custom domain `r2.mail.plrs.im` serves
  // these directly so that the `url` on each attachment in API/webhook
  // responses is fetchable without HMAC or signed URLs. SHA-256 in the key
  // is the unguessability anchor.
  //
  // 4a.1: attachment R2 writes are REQUIRED, not best-effort. The pipeline
  // is content-addressed for dedup: identical attachments will not be
  // re-ingested on retry, so a swallowed failure here would result in a
  // permanent 404 on the public URL embedded in webhooks/API responses.
  // We throw so services/in returns setReject (CF retries the whole
  // delivery) and services/api returns 5xx (caller retries).
  const attachmentParts = extractAttachmentParts(args.rawMime);
  for (const part of attachmentParts) {
    const attSha = await sha256Hex(part.bytes);
    const safeName = sanitizeAttachmentFilename(part.filename);
    const attKey = `att/${attSha}/${safeName}`;
    const attHead = await env.R2.head(attKey).catch(() => null);
    if (!attHead) {
      try {
        await env.R2.put(attKey, part.bytes, {
          httpMetadata: { contentType: part.content_type || 'application/octet-stream' },
          customMetadata: { sha256: attSha, contentLength: String(part.bytes.length) },
        });
      } catch (e) {
        throw new ProcessMessageError(
          `attachment R2 write failed: ${e instanceof Error ? e.message : 'unknown'}`,
          502,
          'attachment_r2_write_failed',
        );
      }
    }
  }

  const messageId = ulid();
  // 4a.4: when summary.from is empty (malformed inbound, no From header),
  // fall back to the RFC 5321 null-sender form (`''`) rather than writing
  // the recipient address into `from_addr`. Outbound rows with an empty
  // From should never occur in practice (sender-policy enforcement happens
  // before the pipeline), but the fallback is symmetric.
  const rawFromAddr = summary.from || '';
  // 4a.5: normalize via IDNA before storing or thread-grouping. The
  // `from_addr_normalized` generated column is `LOWER(from_addr)`, so
  // storing the canonical (Punycode) form means both reads and the index
  // see the same shape — IDN senders no longer miss the thread lookup.
  // Fall back to the raw lowercased value when normalization fails (e.g.
  // empty/malformed senders, where AddressError is expected).
  let fromAddr: string;
  try {
    fromAddr = rawFromAddr ? normalizeAddress(rawFromAddr).full : '';
  } catch {
    fromAddr = rawFromAddr.toLowerCase();
  }
  const subject = summary.subject ?? '';
  const headerMessageId = summary.headerMessageId ?? null;
  const threadId = await computeThreadId(
    env,
    messageId,
    args.mailboxId,
    summary.references,
    summary.inReplyTo,
    summary.subject,
    fromAddr,
  );

  await env.DB.prepare(
    `INSERT INTO messages
       (id, mailbox_id, principal_id, bridge_id, direction, status,
        from_addr, to_addrs, subject, r2_key, content_sha256,
        body_bytes, attachments_total_bytes,
        idempotency_key, header_message_id, message_id_header, thread_id,
        received_at_bridge, received_at_api,
        auth_spf, auth_dkim, auth_dmarc, auth_remote_ip,
        created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'received',
             ?6, ?7, ?8, ?9, ?10,
             ?11, ?12,
             ?13, ?14, ?14, ?15,
             ?16, ?17,
             ?18, ?19, ?20, ?21,
             ?22)`,
  )
    .bind(
      messageId,
      args.mailboxId,
      args.principalId ?? null,
      args.bridgeId ?? null,
      args.direction,
      fromAddr,
      args.envelopeTo ? JSON.stringify(args.envelopeTo) : JSON.stringify(summary.to),
      subject,
      r2Key,
      contentSha,
      summary.body_bytes,
      summary.attachments_total_bytes,
      args.idempotencyKey ?? null,
      headerMessageId,
      threadId,
      null,
      now,
      args.auth?.spf ?? null,
      args.auth?.dkim ?? null,
      args.auth?.dmarc ?? null,
      args.auth?.remoteIp ?? null,
      now,
    )
    .run();

  if (args.direction === 'out' && args.idempotencyKey && args.principalId) {
    await recordClaim(env, args.principalId, args.idempotencyKey, messageId);
  }

  // Inbound: allocate a mailbox_messages_state row so the message is visible
  // on the IMAP wire the moment it lands. Outbound stays invisible per
  // Phase L scope (sent-folder semantics are deferred). Failures are logged
  // but don't fail the ingest — state allocation is recoverable from the
  // janitor + bridge backfill paths.
  if (args.direction === 'in') {
    try {
      await allocateInboundState(env, args.mailboxId, messageId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        'pipeline: state allocation failed (will be repaired on next read)',
        e instanceof Error ? e.message : 'unknown',
      );
    }
  }

  if (args.direction === 'out') {
    if (!env.OUTBOUND_QUEUE) {
      throw new ProcessMessageError(
        'OUTBOUND_QUEUE binding missing for outbound submission',
        500,
        'no_outbound_queue',
      );
    }
    const fromDomain = fromAddr.split('@')[1] ?? '';
    const domainRow = fromDomain
      ? await env.DB.prepare(`SELECT id FROM mail_domains WHERE name = ?`)
          .bind(fromDomain)
          .first<{ id: string }>()
          .catch(() => null)
      : null;
    const sendAttemptId = ulid();
    await env.OUTBOUND_QUEUE.send({
      messageId,
      source: 'raw',
      r2KeyOrInline: r2Key,
      fromDomain,
      fromAddress: fromAddr,
      // Forward envelope recipients verbatim. summary.to is the parsed
      // To header (advisory); the JSON SendRequest path supplies the true
      // RCPT TO list via args.envelopeTo. Fall back to summary.to so the
      // RFC822 / bridge path keeps a sensible default until each header
      // gets parsed.
      envelopeTo: args.envelopeTo ?? summary.to,
      mailboxId: args.mailboxId,
      domainId: domainRow?.id ?? null,
      mode: 'live',
    });
    await env.DB.prepare(
      `UPDATE messages SET status = 'queued', send_attempt_id = ?, queued_at = ? WHERE id = ?`,
    )
      .bind(sendAttemptId, now, messageId)
      .run();

    await audit(env, {
      actor: args.principalId ?? args.bridgeId ?? 'system',
      action: 'message.submitted',
      target: messageId,
      meta: {
        source: args.source,
        bridge_id: args.bridgeId,
        content_sha256: contentSha,
        from: fromAddr,
        to_count: args.envelopeTo?.length ?? summary.to.length,
      },
    });

    return { messageId, status: 'queued', fresh: true };
  }

  // Inbound: resolve receivers + collect fanout list.
  const fanoutEnqueues = await resolveInboundFanout(env, args);

  await audit(env, {
    actor: args.principalId ?? args.bridgeId ?? 'system',
    action: 'message.received',
    target: messageId,
    meta: {
      source: args.source,
      content_sha256: contentSha,
      from: fromAddr,
      to: args.recipientAddress,
      auth: args.auth,
      fanout_count: fanoutEnqueues.length,
    },
  });

  return { messageId, status: 'received', fresh: true, fanoutEnqueues };
}
