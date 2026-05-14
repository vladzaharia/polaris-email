// POST /v1/send/raw — daemon-only RFC822 submission endpoint (Phase D6 alias).
//
// Thin wrapper that validates daemon auth + Content-Type, then delegates the
// entire pipeline to `processMessage()`. The daemon already canonicalizes MIME
// before forwarding, but processMessage re-validates server-side.
//
// NOTE: this file is scheduled for deletion in Phase F7 once the daemon
// migrates to POST /v1/messages with `Content-Type: message/rfc822`.

import { Hono } from 'hono';
import { parseStrict, MimeError, enforceSenderPolicy, SenderPolicyError } from '@polaris-email/mime';
import type { Env } from '../env.js';
import { daemonHmacAuth } from '../daemon-auth.js';
import { buildError } from '../errors.js';
import { processMessage, ProcessMessageError } from '../process-message.js';

interface SendRawRequest {
  envelope_from: string;
  envelope_to: string[];
  rfc822_b64: string;
  submission_id: string;
  client_ip?: string;
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

  let rfc822: Uint8Array;
  try {
    const bin = atob(body.rfc822_b64);
    rfc822 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) rfc822[i] = bin.charCodeAt(i);
  } catch {
    return buildError(c, 'bad_request', 'rfc822_b64 not valid base64');
  }

  let mime;
  try {
    mime = parseStrict(rfc822);
  } catch (e) {
    if (e instanceof MimeError) {
      return buildError(c, 'bad_request', `MIME: ${e.code}`);
    }
    throw e;
  }

  const username = c.req.header('x-polaris-smtp-username');
  if (!username) {
    return buildError(c, 'bad_request', 'X-Polaris-SMTP-Username header required');
  }
  const credRow = await c.env.DB.prepare(
    `SELECT principal_id, sender_id FROM submission_credentials
      WHERE username = ?1 AND disabled_at IS NULL
      LIMIT 1`,
  )
    .bind(username)
    .first<{ principal_id: string; sender_id: string }>();
  if (!credRow) {
    return buildError(c, 'unauthorized', 'unknown principal for SMTP username');
  }
  const principalRow = await c.env.DB.prepare(
    `SELECT id, mailbox_id, disabled_at FROM principals WHERE id = ?1 LIMIT 1`,
  )
    .bind(credRow.principal_id)
    .first<{ id: string; mailbox_id: string; disabled_at: string | null }>();
  if (!principalRow || principalRow.disabled_at) {
    return buildError(c, 'unauthorized', 'unknown principal for SMTP username');
  }

  // Revocation DO truth check.
  const doId = c.env.REVOCATION_DO.idFromName(principalRow.id);
  const doStub = c.env.REVOCATION_DO.get(doId);
  const revRes = await doStub.fetch('https://revocation-do/check');
  if (revRes.ok) {
    const revBody = (await revRes.json().catch(() => null)) as { revoked?: boolean } | null;
    if (revBody?.revoked) {
      return buildError(c, 'key_revoked', 'principal revoked');
    }
  }

  // C1: allow-list enforcement on the From/Sender/Reply-To headers.
  const senderRow = await c.env.DB.prepare(
    `SELECT address FROM mailbox_senders
      WHERE id = ?1 AND disabled_at IS NULL LIMIT 1`,
  )
    .bind(credRow.sender_id)
    .first<{ address: string }>()
    .catch(() => null);
  const allowedSenders: string[] = senderRow?.address ? [senderRow.address] : [];
  try {
    enforceSenderPolicy(mime, { allowedSenders });
  } catch (e) {
    if (e instanceof SenderPolicyError) {
      return buildError(c, 'forbidden', `sender policy: ${e.code}`);
    }
    throw e;
  }

  // Idempotency key: SMTP session id is unique per session, retries reuse it.
  const idempotencyKey = `smtp-${body.submission_id}`;

  try {
    const result = await processMessage(c.env, {
      direction: 'out',
      mailboxId: principalRow.mailbox_id,
      principalId: principalRow.id,
      daemonId: c.var.daemonId,
      rawMime: rfc822,
      source: 'smtp',
      idempotencyKey,
      envelopeTo: body.envelope_to,
    });
    return c.json(
      { message_id: result.messageId, status: result.status, fresh: result.fresh },
      202,
    );
  } catch (e) {
    if (e instanceof ProcessMessageError) {
      return c.json({ error: e.code, message: e.message }, e.httpStatus as 400 | 425 | 500);
    }
    throw e;
  }
});
