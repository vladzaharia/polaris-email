// Bridge-scoped credential lookup.
//
// The mail-bridge calls GET /v1/bridge/credentials/lookup?protocol=&username=
// during IMAP LOGIN or SMTPS AUTH PLAIN to fetch the bcrypt hash for the
// matching mailbox-credential row. Bridge-auth only — never exposed to
// tenant API keys (returning the hash to a tenant would defeat the
// issue-once secret model).
//
// Polaris Mail is pre-production; this endpoint only knows about the
// new `<prefix><kid>` username form (`pmimap_<26-ULID>`,
// `pmsmtp_<26-ULID>`). Legacy email-address usernames are not honored.

import { Hono } from 'hono';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { requireScope } from '../../auth.js';

export const bridgeCredentialLookup = new Hono<{ Bindings: Env }>();

interface CredRow {
  id: string;
  mailbox_id: string;
  type: 'imap' | 'smtp';
  prefix: string;
  secret_hash: string;
  receiver_id: string | null;
  disabled_at: string | null;
  revoked_at: string | null;
}

// 26-char Crockford ULID — matches the kid format used everywhere
// (operator tokens, mailbox credentials, bearer tokens).
const KID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface ParsedTypedUsername {
  type: 'imap' | 'smtp';
  kid: string;
}

function parseTypedUsername(username: string): ParsedTypedUsername | null {
  if (username.startsWith('pmimap_')) {
    const kid = username.slice('pmimap_'.length);
    if (!KID_REGEX.test(kid)) return null;
    return { type: 'imap', kid };
  }
  if (username.startsWith('pmsmtp_')) {
    const kid = username.slice('pmsmtp_'.length);
    if (!KID_REGEX.test(kid)) return null;
    return { type: 'smtp', kid };
  }
  return null;
}

bridgeCredentialLookup.get(
  '/v1/bridge/credentials/lookup',
  requireScope('imap_bridge:read'),
  async (c) => {
    const protocol = c.req.query('protocol');
    const username = c.req.query('username');
    if (protocol !== 'imap' && protocol !== 'smtps') {
      return buildError(c, 'bad_request', 'protocol must be one of imap|smtps');
    }
    if (!username || username.length < 1) {
      return buildError(c, 'bad_request', 'username required');
    }
    const wantedType: 'imap' | 'smtp' = protocol === 'smtps' ? 'smtp' : 'imap';

    const typed = parseTypedUsername(username);
    if (!typed || typed.type !== wantedType) {
      return buildError(c, 'not_found', 'credential not found');
    }

    const row = await c.env.DB.prepare(
      `SELECT id, mailbox_id, type, prefix, secret_hash, receiver_id,
              disabled_at, revoked_at
       FROM mailbox_credentials
       WHERE id = ?1 AND type = ?2
         AND disabled_at IS NULL AND revoked_at IS NULL
       LIMIT 1`,
    )
      .bind(typed.kid, typed.type)
      .first<CredRow>();
    if (!row) return buildError(c, 'not_found', 'credential not found');

    // Response keeps the Go bridge's expected field names: `protocol`
    // (the wire-protocol offered) and `bcrypt_hash` (the bridge
    // bcrypt-compares it). IMAP/SMTP rows store bcrypt hashes in
    // `secret_hash`; we surface that under the legacy field name so
    // the bridge code can keep its existing verify path.
    return c.json({
      id: row.id,
      mailbox_id: row.mailbox_id,
      protocol,
      auth_type: 'password' as const,
      username,
      bcrypt_hash: row.secret_hash,
      receiver_id: row.receiver_id,
    });
  },
);
