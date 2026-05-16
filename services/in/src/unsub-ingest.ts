// W4 — Mailto-form RFC 8058 unsubscribe handler.
//
// Invoked from services/in/src/index.ts when an inbound message lands at
// `unsub+<token>@<UNSUB_MAILTO_HOST>`. Parses the token and inserts a
// recipient suppression row scoped to the sender_domain.

import { normalizeAddress } from '@polaris-email/suppressions';
import { ulid } from '@polaris-email/ids';

// Minimal D1 surface, kept Worker-runtime-agnostic.
interface D1Stmt {
  bind(...params: unknown[]): D1Stmt;
  run(): Promise<unknown>;
}
interface D1 {
  prepare(sql: string): D1Stmt;
}

interface TokenPayload {
  recipient: string;
  sender_domain: string;
  message_id: string;
  issued_at: number;
}

const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;

function b64uDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

async function hmacHex(key: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body));
  const arr = new Uint8Array(sig);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  return hex;
}

async function verifyToken(token: string, secret: string): Promise<TokenPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacHex(secret, body);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  let p: TokenPayload;
  try {
    p = JSON.parse(b64uDecode(body)) as TokenPayload;
  } catch {
    return null;
  }
  if (
    typeof p.recipient !== 'string' ||
    typeof p.sender_domain !== 'string' ||
    typeof p.message_id !== 'string' ||
    typeof p.issued_at !== 'number'
  ) {
    return null;
  }
  if (Date.now() - p.issued_at > TOKEN_TTL_MS) return null;
  return p;
}

/**
 * Top-level entry. Returns the suppression id when the token was valid and
 * the row was inserted; returns null when the token was invalid (silently
 * dropped — RFC 8058 makes no guarantee that mailto replies get a response).
 */
export async function handleUnsubMailto(
  db: D1,
  secret: string,
  token: string,
): Promise<string | null> {
  if (!secret) return null;
  const decodedToken = decodeURIComponent(token);
  const payload = await verifyToken(decodedToken, secret);
  if (!payload) return null;

  const recipient = normalizeAddress(payload.recipient);
  if (!recipient) return null;
  const suppressionId = ulid();
  const nowIso = new Date().toISOString();

  try {
    await db
      .prepare(
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
        payload.sender_domain.toLowerCase(),
        payload.message_id,
        nowIso,
        `RFC 8058 mailto unsubscribe from sender_domain=${payload.sender_domain}`,
      )
      .run();
  } catch {
    // Race or other transient — ON CONFLICT covers the duplicate case.
  }
  return suppressionId;
}
