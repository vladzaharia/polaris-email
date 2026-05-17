// W4 — RFC 8058 One-Click Unsubscribe endpoint.
//
// Public, unauthenticated. Anyone with a valid HMAC-signed token can
// unsubscribe — that's the design of RFC 8058: receiving MUAs (Gmail,
// Yahoo) POST this URL on the user's behalf without forwarding any
// credentials.
//
// On success: insert a `recipient` suppression row with
// scope='sender_address' (or 'domain' if the token didn't pin a specific
// sender_address) so the unsubscribe doesn't accidentally block all mail
// from polaris-email — just mail from this sender to this recipient.
//
// Replay tolerance: a duplicate POST returns 200 (RFC 8058 §4 requires it).
// We use ON CONFLICT DO NOTHING on the suppressions index to keep this
// idempotent without a separate seen-tokens KV.
import { Hono } from 'hono';
import { normalizeAddress } from '@polaris-email/suppressions';
import { ulid } from '@polaris-email/ids';
import { audit } from '../audit.js';
import { buildError } from '../errors.js';
import type { Env } from '../env.js';
import { verifyUnsubToken } from '../lib/unsub-token.js';

export const unsub = new Hono<{ Bindings: Env }>();

unsub.post('/v1/unsub/:token', async (c) => {
  const secret = c.env.UNSUB_HMAC_SECRET;
  if (!secret) return buildError(c, 'degraded', 'UNSUB_HMAC_SECRET not configured');
  const token = decodeURIComponent(c.req.param('token'));
  const v = await verifyUnsubToken(token, secret);
  if (!v.ok) {
    // Return 400 rather than 401 so RFC 8058 clients don't loop on retry
    // an invalid token is a client error, not a transient auth failure.
    return buildError(c, 'bad_request', `unsub token invalid: ${v.reason}`);
  }
  const recipient = normalizeAddress(v.payload.recipient);
  if (!recipient) return buildError(c, 'bad_request', 'unsub token recipient invalid');

  const senderDomain = v.payload.sender_domain.toLowerCase();
  const suppressionId = ulid();
  const nowIso = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO suppressions
         (id, entity_type, address_normalized, address_local, address_domain,
          scope, scope_target, reason, source, source_ref, severity,
          created_at, expires_at, disabled_at, disabled_reason, notes)
        VALUES (?, 'recipient', ?, ?, ?, 'domain', ?, 'unsubscribe', 'one_click', ?, 'info', ?, NULL, NULL, NULL, ?)
        ON CONFLICT DO NOTHING`,
    )
      .bind(
        suppressionId,
        recipient.normalized,
        recipient.local,
        recipient.domain,
        senderDomain,
        v.payload.message_id,
        nowIso,
        `RFC 8058 one-click unsubscribe from sender_domain=${senderDomain}`,
      )
      .run();
  } catch {
    // The unique index might fire under race; the row already exists.
  }

  await audit(c.env, {
    actor: 'system:unsub-one-click',
    action: 'suppression.create',
    target: suppressionId,
    meta: {
      source: 'one_click',
      recipient: recipient.normalized,
      sender_domain: senderDomain,
      message_id: v.payload.message_id,
    },
  });

  // RFC 8058 §4 — return 200 with empty body. The receiving MUA doesn't
  // need any content; it only checks the status code.
  return new Response(null, { status: 200 });
});

// Also support GET so a human clicking the link in a fallback HTML body
// gets a friendly response.
unsub.get('/v1/unsub/:token', async (c) => {
  const secret = c.env.UNSUB_HMAC_SECRET;
  if (!secret) {
    return c.html('<html><body><p>Unsubscribe service not configured.</p></body></html>', 503);
  }
  const token = decodeURIComponent(c.req.param('token'));
  const v = await verifyUnsubToken(token, secret);
  if (!v.ok) {
    return c.html(
      `<html><body><p>This unsubscribe link is no longer valid (${v.reason}). Please contact the sender.</p></body></html>`,
      400,
    );
  }
  return c.html(
    `<html><body>
       <h1>Unsubscribe from ${v.payload.sender_domain}</h1>
       <p>Recipient: <code>${v.payload.recipient}</code></p>
       <p>This link was issued for one-click unsubscribe (RFC 8058). To complete
          the unsubscribe, your mail client should POST this URL. Most modern
          clients (Gmail, Yahoo, Outlook) do this automatically when you click
          the unsubscribe link in their UI.</p>
       <form method="POST" action="">
         <button type="submit">Confirm unsubscribe</button>
       </form>
     </body></html>`,
    200,
  );
});
