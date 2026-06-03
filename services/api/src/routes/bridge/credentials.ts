// Bridge credential mirror: GET /v1/bridge/credentials.
//
// The mail-bridge's credstore poller calls this on startup and every
// poll interval to mirror SMTP credentials into its local SQLite store.
// Returns a full snapshot each call (the `since` query parameter is
// accepted but currently unused — the bridge treats the response as an
// authoritative replace, not a delta):
//
//   {
//     updates:        Credential[],  // active creds
//     deletions:      string[],      // disabled/revoked cred ids
//     mirror_version: number,        // epoch ms; bridge stores for next `since`
//   }
//
// Where Credential is { id, username, bcrypt_hash, allowed_senders }.
//
// Auth: bridge HMAC (`bridgeHmacAuth`), same as /v1/bridge/heartbeat
// and /v1/bridge/config. This endpoint must NOT go through the operator
// API-key middleware — the bridge has no operator key.

import { Hono } from 'hono';
import { bridgeHmacAuth } from '../../bridge-auth.js';
import type { Env } from '../../env.js';

export const bridgeCredentials = new Hono<{ Bindings: Env }>();

bridgeCredentials.use('/v1/bridge/credentials', bridgeHmacAuth({ requireSubmissionId: false }));

bridgeCredentials.get('/v1/bridge/credentials', async (c) => {
  type CredRow = {
    id: string;
    mailbox_id: string;
    prefix: string;
    secret_hash: string;
    disabled_at: string | null;
    revoked_at: string | null;
  };
  type SenderRow = { mailbox_id: string; address: string };

  let credRows: { results: CredRow[] } = { results: [] };
  let senderRows: { results: SenderRow[] } = { results: [] };
  try {
    credRows = await c.env.DB.prepare(
      `SELECT id, mailbox_id, prefix, secret_hash, disabled_at, revoked_at
       FROM mailbox_credentials
       WHERE type = 'smtp'`,
    ).all<CredRow>();
    senderRows = await c.env.DB.prepare(
      `SELECT mailbox_id, address FROM mailbox_senders WHERE disabled_at IS NULL`,
    ).all<SenderRow>();
  } catch {
    // Tables absent (degraded environment). Treat as empty.
  }

  const sendersByMailbox = new Map<string, string[]>();
  for (const s of senderRows.results) {
    const list = sendersByMailbox.get(s.mailbox_id) ?? [];
    list.push(s.address);
    sendersByMailbox.set(s.mailbox_id, list);
  }

  const mirrorVersion = Date.now();
  const updates = credRows.results
    .filter((r) => r.disabled_at == null && r.revoked_at == null)
    .map((r) => ({
      id: r.id,
      username: `${r.prefix}${r.id}`,
      bcrypt_hash: r.secret_hash,
      allowed_senders: sendersByMailbox.get(r.mailbox_id) ?? [],
      mirror_version: mirrorVersion,
    }));
  const deletions = credRows.results
    .filter((r) => r.disabled_at != null || r.revoked_at != null)
    .map((r) => r.id);

  return c.json({ updates, deletions, mirror_version: mirrorVersion });
});
