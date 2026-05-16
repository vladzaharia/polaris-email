// W4 — RFC 8058 one-click unsubscribe token mint + verify.
//
// Stateless HMAC-signed tokens. Each token encodes:
//   * `recipient` — the address that should be suppressed if this token is
//     submitted.
//   * `sender_domain` — the scope the suppression targets (so an unsub from
//     `news.example.com` doesn't also block `tx.example.com`).
//   * `message_id` — for audit (which message did the user unsubscribe from).
//   * `issued_at` — epoch ms; rejected if older than UNSUB_TOKEN_TTL_MS.
//
// Token format:
//   <base64url(payload_json)>.<hex(hmac_sha256(payload))>
//
// The HMAC key is env.UNSUB_HMAC_SECRET — separate from operator API keys
// so it can be rotated independently and a leaked admin key can't forge
// unsubscribe tokens.

const TOKEN_TTL_MS = 90 * 24 * 3_600 * 1000; // 90 days; per RFC 8058 the URL needs to remain valid for a long time

export interface UnsubTokenPayload {
  recipient: string;
  sender_domain: string;
  message_id: string;
  issued_at: number;
}

function b64uEncode(s: string): string {
  // Btoa works for ASCII; we ensure the payload is ASCII via JSON
  // serialization of structured fields (no Unicode in mailbox/domain after
  // normalization).
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

export async function mintUnsubToken(
  payload: Omit<UnsubTokenPayload, 'issued_at'>,
  secret: string,
  nowMs = Date.now(),
): Promise<string> {
  const full: UnsubTokenPayload = { ...payload, issued_at: nowMs };
  const body = b64uEncode(JSON.stringify(full));
  const sig = await hmacHex(secret, body);
  return `${body}.${sig}`;
}

export async function verifyUnsubToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): Promise<{ ok: true; payload: UnsubTokenPayload } | { ok: false; reason: string }> {
  const dot = token.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = await hmacHex(secret, body);
  if (expectedSig.length !== sig.length) return { ok: false, reason: 'bad_signature' };
  let diff = 0;
  for (let i = 0; i < expectedSig.length; i++)
    diff |= expectedSig.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: 'bad_signature' };

  let payload: UnsubTokenPayload;
  try {
    payload = JSON.parse(b64uDecode(body)) as UnsubTokenPayload;
  } catch {
    return { ok: false, reason: 'malformed_payload' };
  }
  if (
    typeof payload.recipient !== 'string' ||
    typeof payload.sender_domain !== 'string' ||
    typeof payload.message_id !== 'string' ||
    typeof payload.issued_at !== 'number'
  ) {
    return { ok: false, reason: 'incomplete_payload' };
  }
  if (nowMs - payload.issued_at > TOKEN_TTL_MS) {
    return { ok: false, reason: 'expired' };
  }
  if (payload.issued_at - nowMs > 60_000) {
    return { ok: false, reason: 'future_issued_at' };
  }
  return { ok: true, payload };
}

/**
 * Build the `List-Unsubscribe` + `List-Unsubscribe-Post` header values for
 * a marketing-stream message.
 *
 * Returns `null` when the stream_type is not 'marketing' (caller should not
 * inject anything in that case).
 *
 * Per RFC 8058 §4, the header values are:
 *   List-Unsubscribe: <mailto:unsub+<token>@plrs.im>, <https://unsub-url/...>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * The DKIM signer MUST include both header names in its `h=` list — this
 * is what makes the One-Click verb cryptographically attributable. See
 * RFC 8058 §3.2.
 */
export interface UnsubHeaders {
  'List-Unsubscribe': string;
  'List-Unsubscribe-Post': string;
}

export async function buildUnsubHeaders(
  payload: Omit<UnsubTokenPayload, 'issued_at'>,
  secret: string,
  baseUrl: string,
  mailtoHost: string,
  nowMs = Date.now(),
): Promise<UnsubHeaders> {
  const token = await mintUnsubToken(payload, secret, nowMs);
  const httpsUrl = `${baseUrl.replace(/\/+$/, '')}/v1/unsub/${encodeURIComponent(token)}`;
  const mailto = `mailto:unsub+${token}@${mailtoHost}`;
  return {
    'List-Unsubscribe': `<${mailto}>, <${httpsUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
