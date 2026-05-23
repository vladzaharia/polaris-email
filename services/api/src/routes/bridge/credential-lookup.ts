// Bridge-scoped credential lookup.
//
// The mail-bridge calls GET /v1/bridge/credentials/lookup?protocol=&username=
// during IMAP LOGIN or SMTPS AUTH PLAIN to fetch the bcrypt hash for the
// matching mailbox-credential row. Bridge-auth only — never exposed to
// tenant API keys (returning the hash to a tenant would defeat the
// issue-once secret model).
//
// Phase 1 cred refactor: queries `mailbox_credentials_v2` instead of
// the legacy `mailbox_credentials` table. Accepts BOTH the new
// `<prefix><kid>` username form AND the migrated `legacy_username`
// (typically an email address) so existing MUA configurations keep
// working through the transition. The response shape keeps the
// `bcrypt_hash` field name the Go bridge expects; adds `receiver_id`
// so the bridge can scope an IMAP session to a single receiver
// (Phase 2 will start enforcing that filter).
import { Hono } from 'hono';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { requireScope } from '../../auth.js';

export const bridgeCredentialLookup = new Hono<{ Bindings: Env }>();

interface CredRowV2 {
  id: string;
  mailbox_id: string;
  type: 'imap' | 'smtp';
  prefix: string;
  secret_hash: string;
  receiver_id: string | null;
  legacy_username: string | null;
  disabled_at: string | null;
  revoked_at: string | null;
}

// Mirrors the parse-bearer Crockford regex so a malformed/typo'd
// username doesn't cause a SELECT-by-id with garbage. Length is the
// 26-char ULID size used everywhere (operator tokens included).
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

    // Two lookup strategies share the same SELECT projection. We try
    // the typed-username path first (cheap PK lookup) then fall back to
    // legacy_username (one indexed scan).
    const typed = parseTypedUsername(username);
    let row: CredRowV2 | null = null;
    if (typed && typed.type === wantedType) {
      row = await c.env.DB.prepare(
        `SELECT id, mailbox_id, type, prefix, secret_hash, receiver_id,
                legacy_username, disabled_at, revoked_at
         FROM mailbox_credentials_v2
         WHERE id = ?1 AND type = ?2
           AND disabled_at IS NULL AND revoked_at IS NULL
         LIMIT 1`,
      )
        .bind(typed.kid, typed.type)
        .first<CredRowV2>();
    }
    if (!row) {
      row = await c.env.DB.prepare(
        `SELECT id, mailbox_id, type, prefix, secret_hash, receiver_id,
                legacy_username, disabled_at, revoked_at
         FROM mailbox_credentials_v2
         WHERE legacy_username = ?1 AND type = ?2
           AND disabled_at IS NULL AND revoked_at IS NULL
         LIMIT 1`,
      )
        .bind(username, wantedType)
        .first<CredRowV2>();
    }
    if (!row) return buildError(c, 'not_found', 'credential not found');

    // Response keeps the Go bridge's expected field names: `protocol`
    // (the wire-protocol the bridge offered) and `bcrypt_hash` (the
    // bridge bcrypt-compares it). New rows + migrated rows store
    // bcrypt hashes in `secret_hash`; we surface that under the legacy
    // name so the bridge code doesn't change in Phase 1.
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
