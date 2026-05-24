// HMAC auth middleware: looks up the key, fetches its secret, verifies signature,
// performs nonce-dedup, and attaches the key record to the context.
import type { Context, MiddlewareHandler } from 'hono';
import { verify } from '@polaris-mail/hmac';
import { revocationCheck } from '@polaris-mail/revocation';
import type { Env } from './env.js';
import { buildError } from './errors.js';

export interface AuthenticatedKey {
  key_id: string;
  /** Operator id resolved via api_keys.operator_id. */
  operator_id: string;
  /**
   * Set when the request carried `X-Polaris-OBO: operator:<id>` AND the
   * signing key has `admin:impersonate`. `requireScope` evaluates against
   * the *impersonated* operator's scopes; the audit actor reflects the
   * impersonated operator id.
   */
  impersonated_operator_id: string | null;
  scopes_raw: string;
  rate_limit_per_min: number;
  status: 'primary' | 'secondary' | 'revoked';
  revoked_at: number | null;
}

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    apiKey: AuthenticatedKey;
    /**
     * Audit actor for the current request. One of:
     *   * `key:<api_key_id>`   — normal HMAC auth
     *   * `operator:<id>`      — impersonation header honored
     *   * `bridge:<bridge_id>` — bridge HMAC auth (set in bridge-auth.ts)
     *   * `system:<service>`   — scheduled jobs (set by the cron dispatcher)
     * Use `actorOf(c)` from `./audit.js` to read this with a safe fallback.
     */
    actor: string;
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
      operator_id: string;
      secret_argon2id: string;
      scopes: string;
      rate_limit_per_min: number;
      status: 'primary' | 'secondary' | 'revoked';
      revoked_at: number | null;
    };
    // KV `get(..., 'json')` returns `unknown`; validate the cached payload
    // before trusting its shape. A malformed cache entry falls back to the
    // D1 cold path; a forged `status` would otherwise let a revoked key
    // authenticate.
    function isRowShape(v: unknown): v is RowShape {
      if (typeof v !== 'object' || v === null) return false;
      const r = v as Record<string, unknown>;
      if (typeof r.id !== 'string') return false;
      if (typeof r.operator_id !== 'string') return false;
      if (typeof r.secret_argon2id !== 'string') return false;
      if (typeof r.scopes !== 'string') return false;
      if (typeof r.rate_limit_per_min !== 'number') return false;
      if (r.status !== 'primary' && r.status !== 'secondary' && r.status !== 'revoked') {
        return false;
      }
      return true;
    }
    let row: RowShape | null = null;
    if (cached && isRowShape(cached)) {
      row = cached;
    } else {
      // After the principals split, api_keys is operator-owned; a single
      // JOIN gives us the operator's disabled flag for the inline check.
      const keyRow = await env.DB.prepare(
        `SELECT k.id, k.operator_id, k.secret_argon2id, k.scopes,
                k.rate_limit_per_min, k.status, k.revoked_at,
                o.disabled_at AS operator_disabled_at
         FROM api_keys k
         JOIN operators o ON o.id = k.operator_id
         WHERE k.id = ?`,
      )
        .bind(keyId)
        .first<{
          id: string;
          operator_id: string;
          secret_argon2id: string;
          scopes: string;
          rate_limit_per_min: number;
          status: 'primary' | 'secondary' | 'revoked';
          revoked_at: number | null;
          operator_disabled_at: string | null;
        }>();
      if (keyRow) {
        if (keyRow.operator_disabled_at) {
          return buildError(c, 'key_revoked', 'operator disabled');
        }
        row = {
          id: keyRow.id,
          operator_id: keyRow.operator_id,
          secret_argon2id: keyRow.secret_argon2id,
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

    // Per-operator revocation check (KV_REVOCATIONS, 60s in-memory cache).
    // The api_keys row may still read `primary` from a stale KV_KEY_CACHE
    // entry right after an admin revoke, but KV_REVOCATIONS keyed by
    // operator_id is invalidated synchronously by the revoke handler.
    const revoked = await revocationCheck(env, row.operator_id).catch(() => false);
    if (revoked) {
      return buildError(c, 'key_revoked', 'operator revoked');
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
    // @polaris-mail/hmac normalises both forms identically; keeping every
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

    // Impersonation (`X-Polaris-OBO`): when the signing key holds
    // `admin:impersonate`, it may attribute this request to an operator in
    // the `operators` table. The Wish/SSH server uses this to record each
    // SSH-fronted action under the connecting operator's identity instead
    // of the shared host's bootstrap key.
    //
    // Invariants:
    //   * The header is OUTSIDE the HMAC canonical string. Spoofing it
    //     requires breaking TLS, in which case the body is also game-over.
    //     The trade-off lets us avoid forking `packages/hmac`.
    //   * After successful impersonation, `requireScope()` runs against
    //     the OPERATOR'S scopes — not the bootstrap key's.
    const obo = c.req.header('x-polaris-obo');
    let effectiveScopesRaw = row.scopes;
    let effectiveOperatorId: string | null = null;
    if (obo) {
      if (!obo.startsWith('operator:')) {
        return buildError(c, 'bad_request', 'unsupported impersonation subject');
      }
      const opId = obo.slice('operator:'.length);
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(opId)) {
        return buildError(c, 'bad_request', 'operator id format');
      }
      let bootstrapScopes: string[];
      try {
        bootstrapScopes = JSON.parse(row.scopes);
      } catch {
        return buildError(c, 'forbidden', 'scopes parse failed');
      }
      if (!bootstrapScopes.includes('admin:impersonate')) {
        return buildError(c, 'scope_violation', 'missing scope admin:impersonate');
      }
      const opRow = await env.DB.prepare(
        `SELECT o.id, o.disabled_at,
                k.id AS api_key_id, k.operator_id, k.scopes,
                k.status, k.revoked_at
         FROM operators o
         JOIN api_keys k ON k.operator_id = o.id AND k.status = 'primary'
         WHERE o.id = ?`,
      )
        .bind(opId)
        .first<{
          id: string;
          disabled_at: string | null;
          api_key_id: string;
          operator_id: string;
          scopes: string;
          status: 'primary' | 'secondary' | 'revoked';
          revoked_at: number | null;
        }>();
      if (!opRow) {
        return buildError(c, 'not_found', 'operator not found');
      }
      if (opRow.disabled_at) {
        return buildError(c, 'key_revoked', 'operator disabled');
      }
      if (opRow.status === 'revoked' || opRow.revoked_at != null) {
        return buildError(c, 'key_revoked', 'operator key revoked');
      }
      const revokedOp = await revocationCheck(env, opRow.operator_id).catch(() => false);
      if (revokedOp) {
        return buildError(c, 'key_revoked', 'operator revoked');
      }
      effectiveScopesRaw = opRow.scopes;
      effectiveOperatorId = opId;
      c.executionCtx.waitUntil(
        env.DB.prepare(`UPDATE operators SET last_seen_at = ? WHERE id = ?`)
          .bind(new Date().toISOString(), opId)
          .run()
          .catch(() => undefined),
      );
    }

    c.set('apiKey', {
      key_id: row.id,
      operator_id: row.operator_id,
      impersonated_operator_id: effectiveOperatorId,
      // `scopes_raw` is what `requireScope` reads. When impersonating, we
      // splice the operator's scopes so per-route `admin:rotate` etc. checks
      // evaluate against the operator's grant.
      scopes_raw: effectiveScopesRaw,
      rate_limit_per_min: row.rate_limit_per_min,
      status: row.status,
      revoked_at: row.revoked_at,
    });
    c.set(
      'actor',
      effectiveOperatorId ? `operator:${effectiveOperatorId}` : `operator:${row.operator_id}`,
    );

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
