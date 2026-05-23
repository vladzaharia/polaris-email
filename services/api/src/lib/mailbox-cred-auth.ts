// bearerAuth — Hono middleware that authenticates a request via a
// mailbox-credential Bearer token (pmtk_/pmmcp_/pmcli_).
//
// Verification path:
//   1. Read `Authorization: Bearer …` header.
//   2. Parse with `parseBearer` (returns null on malformed/unknown prefix).
//   3. Optionally restrict by type (`opts.allowTypes`) so e.g. the future
//      MCP endpoint can refuse REST tokens.
//   4. Look up the row from `mailbox_credentials_v2` — KV cache (`mc:row:`)
//      checked first; D1 fallback writes back to cache for 60s.
//   5. Reject if `disabled_at`/`revoked_at` is set, or if the row's
//      `type` doesn't match the parsed prefix (defence in depth).
//   6. Constant-time verify the candidate secret against `secret_hash`
//      (cred-hash dispatches bcrypt vs PBKDF2). secret_prev_hash is
//      also tried so an in-flight client survives a planned rotate.
//   7. On success, stash a minimal credential descriptor on the context:
//      `c.set('mailboxCredential', { id, mailbox_id, type, prefix,
//      receiver_id })`. Downstream handlers read it via
//      `c.get('mailboxCredential')`.
//
// Failure modes — *all* return 401 with a generic message; the wrong-
// header / wrong-prefix / wrong-secret cases must not be distinguishable
// to a caller (else an attacker can probe the kid space).

import type { Context, MiddlewareHandler } from 'hono';
import { parseBearer, type BearerType } from './parse-bearer.js';
import { verifyHash } from './cred-hash.js';
import type { Env } from '../env.js';
import { buildError } from '../errors.js';

export type MailboxCredentialType = 'imap' | 'smtp' | BearerType;

export interface MailboxCredentialContext {
  id: string;
  mailbox_id: string;
  type: MailboxCredentialType;
  prefix: string;
  receiver_id: string | null;
}

declare module 'hono' {
  // The Hono ContextVariableMap declaration merges with existing
  // bindings (`apiKey`, `actor`, etc.). Downstream handlers can read
  // this with full type safety.
  interface ContextVariableMap {
    mailboxCredential?: MailboxCredentialContext;
  }
}

interface CachedRow {
  id: string;
  mailbox_id: string;
  type: MailboxCredentialType;
  prefix: string;
  secret_hash: string;
  secret_prev_hash: string | null;
  receiver_id: string | null;
  status: 'primary' | 'secondary' | 'revoked';
  disabled_at: string | null;
  revoked_at: string | null;
}

async function loadRow(env: Env, kid: string): Promise<CachedRow | null> {
  const cached = await env.KV_KEY_CACHE.get(`mc:row:${kid}`, 'json');
  if (cached) return cached as CachedRow;
  const row = await env.DB.prepare(
    `SELECT id, mailbox_id, type, prefix, secret_hash, secret_prev_hash,
            receiver_id, status, disabled_at, revoked_at
     FROM mailbox_credentials
     WHERE id = ?1
     LIMIT 1`,
  )
    .bind(kid)
    .first<CachedRow>();
  if (!row) return null;
  // Cache warm-write — short TTL because revocation must propagate
  // within ~60s and the KV_REVOCATIONS namespace doesn't gate this
  // path (the cred-cache key isn't keyed by principal_id).
  await env.KV_KEY_CACHE.put(`mc:row:${kid}`, JSON.stringify(row), { expirationTtl: 60 });
  return row;
}

export interface BearerAuthOptions {
  /** Restrict accepted credential types. Defaults to all three bearer types. */
  allowTypes?: ReadonlyArray<BearerType>;
}

export function bearerAuth(opts: BearerAuthOptions = {}): MiddlewareHandler<{ Bindings: Env }> {
  const allow = new Set<BearerType>(opts.allowTypes ?? ['rest', 'mcp', 'cli']);
  return async (c, next) => {
    const failed = () => buildError(c, 'unauthorized', 'invalid or expired credential');
    const header = c.req.header('authorization') ?? c.req.header('Authorization');
    if (!header) return failed();
    const space = header.indexOf(' ');
    if (space <= 0) return failed();
    if (header.slice(0, space).toLowerCase() !== 'bearer') return failed();
    const parsed = parseBearer(header.slice(space + 1));
    if (!parsed) return failed();
    if (!allow.has(parsed.type)) return failed();

    const row = await loadRow(c.env, parsed.kid);
    if (!row) return failed();
    // Type discriminator must match the prefix the operator presented;
    // a `pmtk_<kid>` masquerading as an MCP token row should fail even
    // if the kid happens to match.
    if (row.type !== parsed.type) return failed();
    if (row.disabled_at || row.revoked_at) return failed();
    if (row.status === 'revoked') return failed();

    // Constant-time-ish verify. secret_prev_hash gives a grace window
    // for planned rotations; either match is accepted.
    const candidate = parsed.secret;
    const matches =
      (await verifyHash(row.secret_hash, candidate, c.env)) ||
      (row.secret_prev_hash !== null && (await verifyHash(row.secret_prev_hash, candidate, c.env)));
    if (!matches) return failed();

    setMailboxCredential(c, {
      id: row.id,
      mailbox_id: row.mailbox_id,
      type: row.type,
      prefix: row.prefix,
      receiver_id: row.receiver_id,
    });
    await next();
  };
}

function setMailboxCredential(c: Context<{ Bindings: Env }>, cred: MailboxCredentialContext): void {
  c.set('mailboxCredential', cred);
}
