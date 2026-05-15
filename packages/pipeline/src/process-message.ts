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
import { extractAttachmentParts, summarizeMime } from '@polaris-email/mime';

export interface OutboundQueueMessage {
  messageId: string;
  source: 'raw';
  r2KeyOrInline: string;
  fromDomain: string;
  fromAddress: string;
  mailboxId: string;
  domainId: string | null;
  mode: 'live' | 'test';
  retries: number;
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

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function audit(
  env: PipelineEnv,
  args: { actor: string; action: string; target?: string | null; meta?: Record<string, unknown> },
): Promise<void> {
  const at = Date.now();
  const meta = JSON.stringify(args.meta ?? {});
  const prev = await env.DB.prepare(`SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`)
    .first<{ row_hash: string }>()
    .catch(() => null);
  const prevHash = prev?.row_hash ?? '0'.repeat(64);
  const canonical = [args.actor, args.action, args.target ?? '', meta, prevHash, String(at)].join(
    '\n',
  );
  const rowHash = await sha256Hex(new TextEncoder().encode(canonical));
  await env.DB.prepare(
    `INSERT INTO audit_log (actor, action, target, meta, prev_hash, row_hash, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(args.actor, args.action, args.target ?? null, meta, prevHash, rowHash, at)
    .run();
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
  // mandatory for the outbound path that calls this helper.
  if (!principalId) {
    throw new Error('principal id required for idempotency claim');
  }
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (key, mailbox_id, principal_id, message_id, created_at)
     VALUES (?1, ?2, ?3, NULL, ?4)
     RETURNING key`,
  )
    .bind(key, mailboxId, principalId, new Date().toISOString())
    .first<{ key: string }>();
  if (insert?.key === key) return { first: true };
  const row = await env.DB.prepare(
    `SELECT message_id FROM idempotency_keys WHERE principal_id = ?1 AND key = ?2`,
  )
    .bind(principalId, key)
    .first<{ message_id: string | null }>();
  return { first: false, messageId: row?.message_id ?? undefined };
}

/**
 * Allocate a `mailbox_messages_state` row for a freshly-arrived inbound
 * message, plus bumping `mailbox_uid_counter` and `mailbox_change_counter`.
 * Mirrors `services/api/src/lib/state.ts#ensureMailboxState`. Inlined here so
 * the pipeline package stays self-contained and the API + Email Routing
 * Workers both pick up state allocation through `processMessage()`.
 */
async function allocateInboundState(
  env: PipelineEnv,
  mailboxId: string,
  messageId: string,
): Promise<void> {
  const uidRow = await env.DB.prepare(
    `SELECT next_uid, uid_validity FROM mailbox_uid_counter WHERE mailbox_id = ?1`,
  )
    .bind(mailboxId)
    .first<{ next_uid: number; uid_validity: number }>();
  let uid: number;
  let uidValidity: number;
  if (!uidRow) {
    uid = 1;
    uidValidity = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO mailbox_uid_counter (mailbox_id, next_uid, uid_validity) VALUES (?1, ?2, ?3)`,
    )
      .bind(mailboxId, uid + 1, uidValidity)
      .run();
  } else {
    uid = uidRow.next_uid;
    uidValidity = uidRow.uid_validity;
    await env.DB.prepare(`UPDATE mailbox_uid_counter SET next_uid = ?1 WHERE mailbox_id = ?2`)
      .bind(uid + 1, mailboxId)
      .run();
  }
  const counter = await env.DB.prepare(
    `SELECT next_change_id FROM mailbox_change_counter WHERE mailbox_id = ?1`,
  )
    .bind(mailboxId)
    .first<{ next_change_id: number }>();
  let changeId: number;
  if (!counter) {
    changeId = 1;
    await env.DB.prepare(
      `INSERT INTO mailbox_change_counter (mailbox_id, next_change_id) VALUES (?1, ?2)`,
    )
      .bind(mailboxId, changeId + 1)
      .run();
  } else {
    changeId = counter.next_change_id;
    await env.DB.prepare(
      `UPDATE mailbox_change_counter SET next_change_id = ?1 WHERE mailbox_id = ?2`,
    )
      .bind(changeId + 1, mailboxId)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO mailbox_messages_state
      (message_id, mailbox_id, read_at, expunged_at, flags_json, uid, uid_validity, change_id)
     VALUES (?1, ?2, NULL, NULL, '[]', ?3, ?4, ?5)`,
  )
    .bind(messageId, mailboxId, uid, uidValidity, changeId)
    .run();
}

async function recordClaim(
  env: PipelineEnv,
  principalId: string,
  key: string,
  messageId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE idempotency_keys SET message_id = ?3
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
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
      const row = await env.DB.prepare(
        `SELECT thread_id FROM messages
         WHERE mailbox_id = ?1 AND from_addr_normalized = ?2 AND created_at > ?3
         ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(mailboxId, fromAddr.toLowerCase(), sevenDaysAgo)
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
      return { messageId: existing.id, status: 'received', fresh: false };
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
  try {
    const attachmentParts = extractAttachmentParts(args.rawMime);
    for (const part of attachmentParts) {
      const attSha = await sha256Hex(part.bytes);
      const safeName = part.filename.replace(/[/\\]/g, '_').slice(0, 255) || 'attachment';
      const attKey = `att/${attSha}/${safeName}`;
      const attHead = await env.R2.head(attKey).catch(() => null);
      if (!attHead) {
        await env.R2.put(attKey, part.bytes, {
          httpMetadata: { contentType: part.content_type || 'application/octet-stream' },
          customMetadata: { sha256: attSha, contentLength: String(part.bytes.length) },
        });
      }
    }
  } catch (e) {
    // Attachment R2 writes are best-effort — the body is the source of
    // truth and read-time URL derivation re-hashes from the body, so a
    // transient failure here just means a 404 on the public URL until the
    // next ingest. Log and proceed.
    // eslint-disable-next-line no-console
    console.warn(
      'pipeline: attachment R2 write failed',
      e instanceof Error ? e.message : 'unknown',
    );
  }

  const messageId = ulid();
  const fromAddr = summary.from || (args.direction === 'in' ? (args.recipientAddress ?? '') : '');
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
      mailboxId: args.mailboxId,
      domainId: domainRow?.id ?? null,
      mode: 'live',
      retries: 0,
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
  const fanoutEnqueues: FanoutEnqueue[] = [];
  if (args.recipientAddress) {
    const domainPart = args.recipientAddress.split('@')[1] ?? '';
    const domain = await env.DB.prepare(`SELECT id FROM mail_domains WHERE name = ?1 LIMIT 1`)
      .bind(domainPart)
      .first<{ id: string }>()
      .catch(() => null);
    if (domain) {
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
      for (const r of receivers.results) {
        if (!addressMatches(r.address_pattern, args.recipientAddress)) continue;
        if (r.action === 'webhook' && r.webhook_sub_id) {
          fanoutEnqueues.push({
            webhookSubId: r.webhook_sub_id,
            event: 'message.received',
          });
        }
        // 'forward' and 'drop' are handled outside processMessage today.
      }
    }
  }

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
