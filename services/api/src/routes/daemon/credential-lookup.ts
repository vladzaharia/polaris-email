// Daemon-scoped credential lookup (Phase L slice L.4 + B6).
//
// The mail-bridge calls GET /v1/daemon/credentials/lookup?protocol=&username=
// during IMAP LOGIN or SMTPS AUTH PLAIN to fetch the bcrypt hash for the
// matching `mailbox_credentials` row. Daemon-auth only — never exposed to
// tenant API keys (returning bcrypt hashes to tenants would defeat the
// issue-once secret model).
//
// JMAP / bearer_token was deleted by C1 + B6.
import { Hono } from 'hono';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { requireScope } from '../../auth.js';

export const daemonCredentialLookup = new Hono<{ Bindings: Env }>();

interface CredRow {
  id: string;
  mailbox_id: string;
  protocol: 'smtps' | 'imap';
  auth_type: 'password';
  username: string;
  bcrypt_hash: string;
  disabled_at: string | null;
}

daemonCredentialLookup.get(
  '/v1/daemon/credentials/lookup',
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
    const row = await c.env.DB.prepare(
      `SELECT id, mailbox_id, protocol, auth_type, username, bcrypt_hash, disabled_at
       FROM mailbox_credentials
       WHERE protocol = ?1 AND username = ?2 AND disabled_at IS NULL
       LIMIT 1`,
    )
      .bind(protocol, username)
      .first<CredRow>();
    if (!row) return buildError(c, 'not_found', 'credential not found');
    return c.json({
      id: row.id,
      mailbox_id: row.mailbox_id,
      protocol: row.protocol,
      auth_type: row.auth_type,
      username: row.username,
      bcrypt_hash: row.bcrypt_hash,
    });
  },
);
