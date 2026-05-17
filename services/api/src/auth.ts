// HMAC auth middleware: looks up the key, fetches its secret, verifies signature,
// performs nonce-dedup, and attaches the key record to the context.
import type { Context, MiddlewareHandler } from 'hono';
import { verify } from '@polaris-email/hmac';
import { revocationCheck } from '@polaris-email/revocation';
import type { Env } from './env.js';
import { buildError } from './errors.js';

export interface AuthenticatedKey {
  key_id: string;
  /** Mailbox id resolved via principals.mailbox_id (mailbox-centric model). */
  mailbox_id: string | null;
  /** Principal id (api_keys.principal_id → principals.id). */
  principal_id: string | null;
  /** ULIDs of mailbox_senders this key is restricted to (empty = unrestricted). */
  sender_scope_ids: string[];
  scopes_raw: string;
  rate_limit_per_min: number;
  status: 'primary' | 'secondary' | 'revoked';
  revoked_at: number | null;
}

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    apiKey: AuthenticatedKey;
  }
}

export const NONCE_TTL_SECONDS = 10 * 60; // 10 min

export function hmacAuth(direction: 'polaris-api'): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const env = c.env;
    const keyId = c.req.header('x-polaris-key-id');
    if (!keyId) return buildError(c, 'unauthorized', 'X-Polaris-Key-Id required');
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(keyId))
      return buildError(c, 'unauthorized', 'X-Polaris-Key-Id format');

    // Read body once; needed for HMAC verification and for downstream handlers.
    // The request is augmented with a `_cachedBody` slot so downstream
    // handlers can read the same bytes without consuming the stream twice.
    const bodyText = await c.req.text();
    (c.req as { _cachedBody?: string })._cachedBody = bodyText;

    // Load key from KV cache (warm path) or D1 (cold path). Cache miss is
    // expected and falls through to D1; transport errors are logged so they
    // show up in observability instead of disappearing into a `null`.
    const cacheKey = `key:${keyId}`;
    const cached = await env.KV_KEY_CACHE.get(cacheKey, 'json').catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('KV_KEY_CACHE.get failed', e instanceof Error ? e.message : 'unknown');
      return null;
    });
    type RowShape = {
      id: string;
      mailbox_id: string | null;
      principal_id: string | null;
      secret_argon2id: string;
      sender_scope_ids: string[];
      scopes: string;
      rate_limit_per_min: number;
      status: 'primary' | 'secondary' | 'revoked';
      revoked_at: number | null;
    };
    // KV `get(..., 'json')` returns `unknown`; validate the cached payload
    // before trusting its shape. A malformed cache entry (e.g. a leftover
    // from a prior schema) falls back to the D1 cold path; a forged
    // `status` would otherwise let a revoked key authenticate.
    function isRowShape(v: unknown): v is RowShape {
      if (typeof v !== 'object' || v === null) return false;
      const r = v as Record<string, unknown>;
      if (typeof r.id !== 'string') return false;
      if (typeof r.secret_argon2id !== 'string') return false;
      if (typeof r.scopes !== 'string') return false;
      if (typeof r.rate_limit_per_min !== 'number') return false;
      if (r.status !== 'primary' && r.status !== 'secondary' && r.status !== 'revoked') {
        return false;
      }
      if (!Array.isArray(r.sender_scope_ids)) return false;
      return true;
    }
    let row: RowShape | null = null;
    if (cached && isRowShape(cached)) {
      row = cached;
    } else {
      // Three-query lookup so the in-memory mock D1 (which doesn't parse JOINs)
      // can satisfy this path. Production D1 sees the queries against the
      // single-region SQLite store so the cost is two extra round-trips on
      // cold KV cache only (warm requests skip both via KV_KEY_CACHE).
      const keyRow = await env.DB.prepare(
        `SELECT id, principal_id, secret_argon2id, scopes,
                rate_limit_per_min, status, revoked_at
         FROM api_keys WHERE id = ?`,
      )
        .bind(keyId)
        .first<{
          id: string;
          principal_id: string | null;
          secret_argon2id: string;
          scopes: string;
          rate_limit_per_min: number;
          status: 'primary' | 'secondary' | 'revoked';
          revoked_at: number | null;
        }>();
      if (keyRow) {
        let mailboxId: string | null = null;
        if (keyRow.principal_id) {
          const principalRow = await env.DB.prepare(
            `SELECT mailbox_id, disabled_at FROM principals WHERE id = ?`,
          )
            .bind(keyRow.principal_id)
            .first<{ mailbox_id: string; disabled_at: string | null }>();
          if (!principalRow || principalRow.disabled_at) {
            return buildError(c, 'key_revoked', 'principal disabled');
          }
          mailboxId = principalRow.mailbox_id;
        }
        // Look up sender-scope junction rows. Empty set = unrestricted.
        const scopeRows = await env.DB.prepare(
          `SELECT sender_id FROM api_key_sender_scopes WHERE api_key_id = ?`,
        )
          .bind(keyRow.id)
          .all<{ sender_id: string }>()
          .catch(() => ({ results: [] as { sender_id: string }[] }));
        const senderScopeIds = (scopeRows.results ?? []).map((r) => r.sender_id);
        row = {
          id: keyRow.id,
          mailbox_id: mailboxId,
          principal_id: keyRow.principal_id,
          secret_argon2id: keyRow.secret_argon2id,
          sender_scope_ids: senderScopeIds,
          scopes: keyRow.scopes,
          rate_limit_per_min: keyRow.rate_limit_per_min,
          status: keyRow.status,
          revoked_at: keyRow.revoked_at,
        };
      } else {
        row = null;
      }
      if (row) {
        c.executionCtx.waitUntil(
          env.KV_KEY_CACHE.put(cacheKey, JSON.stringify(row), { expirationTtl: 60 }),
        );
      }
    }
    if (!row) {
      // Key not in DB might mean it was just issued and KV is propagating. Distinguish from
      // `bad_signature` so clients can retry.
      return buildError(c, 'key_propagating', 'unknown key id', { 'retry-after': '2' });
    }
    if (row.status === 'revoked' || row.revoked_at != null) {
      return buildError(c, 'key_revoked', 'key has been revoked');
    }

    // Per-principal revocation check (KV_REVOCATIONS, 60 s in-memory cache).
    // This is the authoritative revocation signal for generic HMAC auth: the
    // api_keys row may still read `primary` from a stale KV_KEY_CACHE entry
    // immediately after an admin revoke, but KV_REVOCATIONS keyed by
    // principal_id is invalidated synchronously by the revoke handler.
    if (row.principal_id) {
      const revoked = await revocationCheck(env, row.principal_id).catch(() => false);
      if (revoked) {
        return buildError(c, 'key_revoked', 'principal revoked');
      }
    }

    // We have a hashed secret on disk and a candidate header signature. We can't HMAC-verify
    // *without* the plaintext secret. The /admin/api-keys issue + rotate handlers stash the
    // plaintext under `plain:<key_id>` in KV_KEY_CACHE so other colos can verify recent
    // sigs without a DB hit.
    //
    // TTL: 1 hour (Phase 3c — was 1 year, which left the plaintext recoverable from a
    // KV snapshot indefinitely). 1h matches the per-bridge plaintext convention
    // (`bridge_plain:` in bridge-auth.ts) and is a deliberate trade-off:
    //   * long enough to absorb a colo restart or client-side propagation hiccup;
    //   * short enough that a leaked KV snapshot doesn't grant indefinite recovery
    //     of the API-key plaintext.
    // After expiry, this verifier returns `key_propagating` and the operator must
    // re-rotate to repopulate the plaintext. This is the same pre-launch trade-off
    // documented for the bridge cache.
    const plaintext = await env.KV_KEY_CACHE.get(`plain:${keyId}`);
    if (!plaintext) {
      return buildError(c, 'key_propagating', 'key plaintext not yet propagated', {
        'retry-after': '2',
      });
    }

    const path = new URL(c.req.url).pathname;
    // Phase 3b.2 — strip the leading `?` to match the convention used by
    // bridge-auth.ts / messages.ts / messages-state.ts. canonicalQuery in
    // @polaris-email/hmac normalises both forms identically; keeping every
    // call-site on the same form removes the chance of a future divergence.
    const query = new URL(c.req.url).search.slice(1);
    const result = await verify({
      direction,
      method: c.req.method,
      path,
      query,
      headers: {
        get: (n: string) => c.req.header(n) ?? null,
      },
      body: bodyText,
      secret: plaintext,
    });
    if (!result.ok) {
      // Structured log so observability backends can alert on per-principal
      // failure rates without re-parsing the freeform error message.
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          event: 'hmac_verification_failed',
          code: result.code,
          key_id: keyId,
          method: c.req.method,
          path: new URL(c.req.url).pathname,
        }),
      );
      if (result.code === 'clock_skew') return buildError(c, 'clock_skew', result.message);
      if (result.code === 'missing_header' || result.code === 'header_invalid')
        return buildError(c, 'bad_request', result.message);
      return buildError(c, 'bad_signature', 'hmac mismatch');
    }

    // Nonce dedup (namespaced by key_id to prevent cross-mailbox pollution).
    // Writing synchronously (rather than via waitUntil) closes a race where
    // two concurrent requests on different isolates both pass the GET check
    // before either's deferred PUT lands. Synchronous KV writes add ≤50ms
    // to the request path; on the auth hot path that's an acceptable trade
    // for not relying on best-effort replay protection.
    const nonceKey = `nonce:${keyId}:${result.nonce}`;
    const seen = await env.KV_NONCE.get(nonceKey);
    if (seen) {
      return buildError(c, 'nonce_replay', 'nonce already used for this key');
    }
    await env.KV_NONCE.put(nonceKey, '1', { expirationTtl: NONCE_TTL_SECONDS });

    c.set('apiKey', {
      key_id: row.id,
      mailbox_id: row.mailbox_id,
      principal_id: row.principal_id,
      sender_scope_ids: row.sender_scope_ids,
      scopes_raw: row.scopes,
      rate_limit_per_min: row.rate_limit_per_min,
      status: row.status,
      revoked_at: row.revoked_at,
    });

    await next();
  };
}

/** Authorise an action scope (`send` / `admin:rotate` / …) on the authenticated key. */
export function requireScope(scope: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const k = c.get('apiKey');
    if (!k) return buildError(c, 'unauthorized', 'no api key on context');
    let parsed: string[];
    try {
      parsed = JSON.parse(k.scopes_raw);
    } catch {
      return buildError(c, 'forbidden', 'scopes parse failed');
    }
    if (!parsed.includes(scope)) {
      return buildError(c, 'scope_violation', `missing scope ${scope}`);
    }
    await next();
  };
}

export function bodyText(c: Context): string {
  // Mirrors the `_cachedBody` slot populated in `hmacAuth` above.
  return (c.req as { _cachedBody?: string })._cachedBody ?? '';
}
