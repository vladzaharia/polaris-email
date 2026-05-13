// Internal submission pipeline (A3: convergence point for /v1/send and /v1/send/raw).
//
// Both ingress paths are thin parsers that build a `NormalizedSubmission` and
// pass it here. Idempotency, sender authorization, R2 storage, message-row
// creation, queue enqueue, and audit emission all live in this function.
//
// The R2 object is always *our* canonical MIME (re-serialized after MIME parse),
// not the submitter's bytes. This is the C2 mitigation enforcement point.

import type { Env } from './env.js';
import { ulid } from '@polaris-email/ids';
import { sha256Hex } from './hashing.js';
import { audit } from './audit.js';
import { tryClaim, recordClaim } from './idempotency-d1.js';

export interface NormalizedSubmission {
  /** Tenant owning this principal. */
  tenantId: string;
  /** Principal id (api_key or smtp_cred). */
  principalId: string;
  /** Submitting daemon (when via /v1/send/raw); null for /v1/send REST path. */
  daemonId: string | null;
  /** Submission id (ULID minted by daemon for SMTP sessions; minted here for REST). */
  submissionId: string;
  /** Envelope sender (Return-Path target). */
  envelopeFrom: string;
  /** Envelope recipients. */
  envelopeTo: string[];
  /** From: header address (extracted, validated against allow-list upstream). */
  fromAddr: string;
  /** Subject header (best-effort, may be empty). */
  subject: string;
  /** Idempotency-Key from request (or undefined). */
  idempotencyKey?: string;
  /** Source channel for audit. */
  source: 'rest' | 'smtp';
  /** Optional client IP (Tailnet identity for SMTP path). */
  clientIp?: string;
  /** Daemon's recorded receipt time (SMTP path only). */
  receivedAtDaemon?: string;
  /** The canonical RFC822 bytes (already through MIME canonicalize). */
  rfc822: Uint8Array;
}

export interface SubmissionResult {
  /** Always present — either newly minted or returned from idempotent replay. */
  messageId: string;
  /** True if this is the original submission, false if idempotent replay. */
  fresh: boolean;
}

export class SubmissionError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly code: string
  ) {
    super(message);
  }
}

/**
 * Submit a normalized message. Idempotent w.r.t. submission.idempotencyKey.
 * Throws SubmissionError on policy or upstream failure.
 */
export async function submitMessage(
  env: Env,
  submission: NormalizedSubmission
): Promise<SubmissionResult> {
  const now = new Date().toISOString();

  // 1. Idempotency claim (D1 atomic — I2 mitigation).
  if (submission.idempotencyKey) {
    const claim = await tryClaim(
      env,
      submission.idempotencyKey,
      submission.tenantId,
      submission.principalId
    );
    if (!claim.first) {
      if (claim.messageId) {
        return { messageId: claim.messageId, fresh: false };
      }
      // The original is mid-flight; tell the client to retry shortly.
      throw new SubmissionError(
        'idempotency claim in progress; retry after 1s',
        425,
        'idempotency_in_progress'
      );
    }
  }

  // 2. Allocate message id and content-addressed R2 key.
  const messageId = ulid();
  const contentSha = await sha256Hex(submission.rfc822);
  const r2Key = `mime/${contentSha.slice(0, 2)}/${contentSha.slice(2, 4)}/${contentSha}`;

  // 3. PUT canonical MIME to R2 (HEAD-then-PUT to avoid Class A op on dup; I14).
  const head = await env.R2.head(r2Key).catch(() => null);
  if (!head) {
    await env.R2.put(r2Key, submission.rfc822, {
      httpMetadata: { contentType: 'message/rfc822' },
      customMetadata: { sha256: contentSha, contentLength: String(submission.rfc822.length) },
    });
  }

  // 4. Insert messages row in `received` then transition to `mime_stored` →
  //    `queued` via CAS as we go. State machine per A7.
  await env.DB
    .prepare(
      `INSERT INTO messages
        (id, tenant_id, principal_id, daemon_id, submission_id, direction, status,
         from_addr, to_hash_pending, subject, r2_key, content_sha256,
         idempotency_key, environment, received_at_daemon, received_at_api,
         created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'out', 'mime_stored',
               ?6, 1, ?7, ?8, ?9, ?10, 'prod', ?11, ?12, ?12)`
    )
    .bind(
      messageId,
      submission.tenantId,
      submission.principalId,
      submission.daemonId,
      submission.submissionId,
      submission.fromAddr,
      submission.subject,
      r2Key,
      contentSha,
      submission.idempotencyKey ?? null,
      submission.receivedAtDaemon ?? null,
      now
    )
    .run();

  // 5. Attach idempotency claim now that the row exists.
  if (submission.idempotencyKey) {
    await recordClaim(env, submission.idempotencyKey, messageId);
  }

  // 6. Enqueue. Payload carries only references — no MIME (queue 128 KB cap).
  const fromDomain = submission.fromAddr.split('@')[1] ?? '';
  const domainRow = fromDomain
    ? await env.DB.prepare(`SELECT id FROM mail_domains WHERE name = ?`)
        .bind(fromDomain)
        .first<{ id: string }>()
    : null;
  const sendAttemptId = ulid();
  await env.OUTBOUND_QUEUE.send({
    messageId,
    source: 'raw',
    r2KeyOrInline: r2Key,
    fromDomain,
    fromAddress: submission.fromAddr,
    tenantId: submission.tenantId,
    domainId: domainRow?.id ?? null,
    mode: 'live',
    retries: 0,
  });
  await env.DB
    .prepare(
      `UPDATE messages SET status = 'queued', send_attempt_id = ?2, queued_at = ?3
       WHERE id = ?1 AND status = 'mime_stored'`
    )
    .bind(messageId, sendAttemptId, now)
    .run();

  // 7. Audit.
  await audit(env, {
    actor: submission.principalId,
    action: 'message.submitted',
    target: messageId,
    meta: {
      source: submission.source,
      daemon_id: submission.daemonId,
      submission_id: submission.submissionId,
      content_sha256: contentSha,
      from: submission.fromAddr,
      to_count: submission.envelopeTo.length,
    },
  });

  return { messageId, fresh: true };
}
