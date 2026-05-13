// POST /v1/send/raw — daemon-only RFC822 submission endpoint.
//
// Accepts pre-built RFC822 from the submission daemon. The daemon has already
// authenticated the SMTP client and validated MAIL FROM against its credential
// allow-list, but we re-validate everything server-side because the API is
// truth (defense-in-depth at the daemon).
//
// C1 mitigation: parse the MIME, validate From:/Sender:/Reply-To: against the
// principal's allow-list, strip Return-Path and re-author server-side, reject
// forbidden submitter headers.
//
// C2 mitigation: parse with strict canonicalizer; re-serialize to canonical
// CRLF before storing in R2 (which is what the provider sees).

import { Hono } from 'hono';
import { parseStrict, serialize, getHeader, setHeader, MimeError } from '@polaris-email/mime';
import { enforceSenderPolicy, SenderPolicyError } from '@polaris-email/mime';
import type { Env } from '../env.js';
import { daemonHmacAuth } from '../daemon-auth.js';
import { buildError } from '../errors.js';
import { submitMessage, SubmissionError } from '../submit-message.js';

interface SendRawRequest {
  envelope_from: string;
  envelope_to: string[];
  /** RFC822 message, base64-encoded. */
  rfc822_b64: string;
  /** ULID minted by the daemon for this SMTP session. */
  submission_id: string;
  /** Optional client IP (Tailnet identity). */
  client_ip?: string;
  /** Daemon's receipt timestamp (RFC3339). */
  received_at_daemon?: string;
}

export const sendRaw = new Hono<{ Bindings: Env }>();
sendRaw.use('/v1/send/raw', daemonHmacAuth());

sendRaw.post('/v1/send/raw', async (c) => {
  let body: SendRawRequest;
  try {
    body = JSON.parse(((c.req as unknown as { _cachedBody: string })._cachedBody) ?? '');
  } catch {
    return buildError(c, 'bad_request', 'invalid JSON body');
  }
  if (!body.envelope_from || !Array.isArray(body.envelope_to) || !body.rfc822_b64) {
    return buildError(c, 'bad_request', 'envelope_from, envelope_to, rfc822_b64 required');
  }
  if (body.envelope_to.length === 0 || body.envelope_to.length > 1000) {
    return buildError(c, 'bad_request', 'envelope_to length out of bounds');
  }

  // Decode base64 → bytes.
  let rfc822: Uint8Array;
  try {
    const bin = atob(body.rfc822_b64);
    rfc822 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) rfc822[i] = bin.charCodeAt(i);
  } catch {
    return buildError(c, 'bad_request', 'rfc822_b64 not valid base64');
  }

  // C2: strict parse + canonical re-serialize.
  let mime;
  try {
    mime = parseStrict(rfc822);
  } catch (e) {
    if (e instanceof MimeError) {
      return buildError(c, 'bad_request', `MIME: ${e.code}`);
    }
    throw e;
  }

  // Look up the daemon's principal binding to get the allow-list. For v1 we
  // resolve via the username embedded in the daemon's auth context — the
  // daemon includes the SMTP-authenticated username in submission metadata.
  // The principal's allowed_senders list lives in principal_sender_scopes ⋈
  // email_senders.
  //
  // For the migration window we accept the daemon's submitted envelope_from as
  // the principal hint and look up the allow-list via the username header.
  const username = c.req.header('x-polaris-smtp-username');
  if (!username) {
    return buildError(c, 'bad_request', 'X-Polaris-SMTP-Username header required');
  }
  const principal = await c.env.DB.prepare(
    `SELECT p.id AS principal_id, p.tenant_id
       FROM principals p
       JOIN submission_credentials sc ON sc.principal_id = p.id
      WHERE sc.username = ?1 AND sc.disabled_at IS NULL AND p.disabled_at IS NULL
      LIMIT 1`
  )
    .bind(username)
    .first<{ principal_id: string; tenant_id: string }>()
    .catch(() => null);

  if (!principal) {
    return buildError(c, 'unauthorized', 'unknown principal for SMTP username');
  }

  // I2 mitigation: re-check revocation state against the Durable Object (truth).
  // For now (DO not yet wired) we just check the disabled_at column above; once
  // REVOCATION_DO is bound we'll add the synchronous DO check.

  // C1 mitigation: load allowed_senders for this principal and enforce on MIME.
  const allowedSenders = await c.env.DB.prepare(
    `SELECT es.address
       FROM principal_sender_scopes pss
       JOIN email_senders_v2 es ON es.id = pss.sender_id
      WHERE pss.principal_id = ?1 AND es.disabled_at IS NULL`
  )
    .bind(principal.principal_id)
    .all<{ address: string }>()
    .catch(() => ({ results: [] as { address: string }[] }));

  try {
    enforceSenderPolicy(mime, {
      allowedSenders: (allowedSenders.results ?? []).map((r) => r.address),
    });
  } catch (e) {
    if (e instanceof SenderPolicyError) {
      return buildError(c, 'forbidden', `sender policy: ${e.code}`);
    }
    throw e;
  }

  // Strip and re-author Return-Path server-side (C1).
  setHeader(mime, 'Return-Path', `<${body.envelope_from}>`);

  const fromAddr = getHeader(mime, 'from') ?? body.envelope_from;
  const subject = getHeader(mime, 'subject') ?? '';
  const canonical = serialize(mime);

  // Idempotency key: use submission_id (each SMTP session is uniquely identified
  // by its ULID, so retries from the same daemon use the same key).
  const idempotencyKey = `smtp-${body.submission_id}`;

  try {
    const result = await submitMessage(c.env, {
      tenantId: principal.tenant_id,
      principalId: principal.principal_id,
      daemonId: c.var.daemonId,
      submissionId: body.submission_id,
      envelopeFrom: body.envelope_from,
      envelopeTo: body.envelope_to,
      fromAddr: extractAddrSpec(fromAddr) ?? body.envelope_from,
      subject,
      idempotencyKey,
      source: 'smtp',
      clientIp: body.client_ip,
      receivedAtDaemon: body.received_at_daemon,
      rfc822: canonical,
    });
    return c.json({ message_id: result.messageId, status: 'queued', fresh: result.fresh }, 202);
  } catch (e) {
    if (e instanceof SubmissionError) {
      return c.json({ error: e.code, message: e.message }, e.httpStatus as 400 | 425 | 500);
    }
    throw e;
  }
});

function extractAddrSpec(headerValue: string): string | null {
  const angleStart = headerValue.lastIndexOf('<');
  const angleEnd = headerValue.lastIndexOf('>');
  if (angleStart >= 0 && angleEnd > angleStart) {
    return headerValue.slice(angleStart + 1, angleEnd).toLowerCase();
  }
  const trimmed = headerValue.trim().toLowerCase();
  return /@/.test(trimmed) ? trimmed : null;
}
