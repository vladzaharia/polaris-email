// Bridge HMAC auth for the bridge-facing API surface:
//   * `/v1/messages` (RFC822 submission), `/v1/messages-state`
//   * `/v1/bridge/config`
//   * `/v1/bridge/heartbeat`
//
// Identity is `bridge_id` from `X-Polaris-Bridge-Id`. The HMAC secret is
// the per-bridge secret minted at registration (stored as an argon2id
// hash in `bridges.hmac_key_secret_name`; plaintext cached in
// `KV_KEY_CACHE` under `bridge_plain:<bridge_id>` for verify).
//
// Heartbeat v2 (migration 0012) extends the lookup in two ways:
//
//   1. **Staged rotation grace.** During a `roll_hmac` window, both the
//      old and the new plaintext are valid. The new plaintext lives at
//      `bridge_plain_next:<bridge_id>`. `lookupBridgeSecrets()` returns
//      both candidates; `bridgeHmacAuth()` tries each in order and
//      records which one matched (callers can detect a bridge that
//      already applied the rotation by checking
//      `c.get('bridgeUsedKey') === 'next'`).
//
//   2. **`allowDisabled`.** Disabled bridges no longer have their KV
//      plaintext wiped — the heartbeat endpoint needs to authenticate
//      them so it can return `enabled: false` and the bridge can shut
//      its listeners. Other endpoints (`/v1/messages`, `/v1/bridge/
//      config`, `/v1/messages-state`) continue to reject disabled
//      bridges via an explicit `disabled_at IS NULL` check.
//
// On cache miss we DO NOT reload from D1 (the stored value is an argon2
// hash, one-way). The operator must roll the bridge to repopulate KV.

import type { MiddlewareHandler } from 'hono';
import { verify } from '@polaris-mail/hmac';
import type { Env } from './env.js';
import { buildError } from './errors.js';

declare module 'hono' {
  interface ContextVariableMap {
    bridgeId: string;
    submissionId: string;
    // Which key matched HMAC verification: 'current' from
    // `bridge_plain:<id>` or 'next' from `bridge_plain_next:<id>`.
    // Set by `bridgeHmacAuth()` on success.
    bridgeUsedKey: 'current' | 'next';
  }
}

/** KV key under which the plaintext per-bridge HMAC secret is cached. */
export function bridgePlainKvKey(bridgeId: string): string {
  return `bridge_plain:${bridgeId}`;
}

/**
 * KV key for the staged-rotation pending plaintext. Lives only during
 * the staged-roll grace window; promoted to `bridge_plain:<id>` on ack
 * (or by the expire cron after the grace deadline).
 */
export function bridgePlainNextKvKey(bridgeId: string): string {
  return `bridge_plain_next:${bridgeId}`;
}

/** TTL for the plaintext cache. Matches the api-key plaintext TTL convention. */
export const BRIDGE_PLAIN_KV_TTL_SECONDS = 60 * 60;

export type BridgeSecretsOk = {
  ok: true;
  current: string;
  /** Present only during a staged-rotation grace window. */
  next: string | null;
};
export type BridgeSecretsErr = {
  ok: false;
  code: 'unknown_bridge' | 'disabled' | 'key_propagating';
};
export type BridgeSecretsLookup = BridgeSecretsOk | BridgeSecretsErr;

export interface BridgeAuthOptions {
  /**
   * When true, disabled bridges (bridges.disabled_at IS NOT NULL) still
   * authenticate. Used by the heartbeat endpoint so the bridge can see
   * `enabled: false` in the response and suspend its listeners. Default
   * false — every other bridge-facing endpoint refuses disabled
   * bridges.
   */
  allowDisabled?: boolean;
  /**
   * When true (default), the middleware requires a valid
   * `X-Polaris-Submission-Id` header. The message-submission paths
   * carry one; the bridge-config and heartbeat paths don't.
   */
  requireSubmissionId?: boolean;
}

/**
 * Resolve verifying HMAC secret candidates for a bridge_id.
 *
 * Returns:
 *   - `{ ok: true, current, next }` where both are plaintexts (the
 *     middleware tries verify against each). `next` is non-null only
 *     during a staged-rotation grace window.
 *   - `{ ok: false, code: 'unknown_bridge' }` when no row exists.
 *   - `{ ok: false, code: 'disabled' }` when the row is disabled AND
 *     the caller didn't pass `allowDisabled`.
 *   - `{ ok: false, code: 'key_propagating' }` when the row exists and
 *     is active but the plaintext is missing from KV. The stored
 *     argon2 hash can't be reversed, so the operator must roll to
 *     repopulate KV.
 */
export async function lookupBridgeSecrets(
  env: Env,
  bridgeId: string,
  opts: { allowDisabled?: boolean } = {},
): Promise<BridgeSecretsLookup> {
  const row = await env.DB.prepare(`SELECT id, disabled_at FROM bridges WHERE id = ? LIMIT 1`)
    .bind(bridgeId)
    .first<{ id: string; disabled_at: string | null }>();
  if (!row) return { ok: false, code: 'unknown_bridge' };
  if (row.disabled_at != null && !opts.allowDisabled) {
    return { ok: false, code: 'disabled' };
  }
  const [current, next] = await Promise.all([
    env.KV_KEY_CACHE.get(bridgePlainKvKey(bridgeId)),
    env.KV_KEY_CACHE.get(bridgePlainNextKvKey(bridgeId)),
  ]);
  if (!current && !next) return { ok: false, code: 'key_propagating' };
  return { ok: true, current: current ?? next ?? '', next: current ? next : null };
}

export function bridgeHmacAuth(opts: BridgeAuthOptions = {}): MiddlewareHandler<{ Bindings: Env }> {
  const { allowDisabled = false, requireSubmissionId = true } = opts;
  return async (c, next) => {
    const env = c.env;
    const bridgeId = c.req.header('x-polaris-bridge-id');
    if (!bridgeId) return buildError(c, 'unauthorized', 'X-Polaris-Bridge-Id required');
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(bridgeId)) {
      return buildError(c, 'unauthorized', 'invalid bridge_id format');
    }

    let submissionId: string | undefined;
    if (requireSubmissionId) {
      submissionId = c.req.header('x-polaris-submission-id');
      if (!submissionId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(submissionId)) {
        return buildError(c, 'unauthorized', 'invalid submission_id format');
      }
    }

    const lookup = await lookupBridgeSecrets(env, bridgeId, { allowDisabled });
    if (!lookup.ok) {
      if (lookup.code === 'key_propagating') {
        return buildError(
          c,
          'key_propagating',
          'bridge plaintext not in cache; roll to repopulate',
          {
            'retry-after': '2',
          },
        );
      }
      return buildError(c, 'unauthorized', `bridge: ${lookup.code}`);
    }

    const bodyText = await c.req.text();
    (c.req as unknown as { _cachedBody: string })._cachedBody = bodyText;

    const url = new URL(c.req.url);
    const verifyInput = {
      direction: 'polaris-api' as const,
      method: c.req.method,
      path: url.pathname,
      query: url.search.slice(1),
      headers: {
        get(name: string) {
          return c.req.header(name) ?? null;
        },
      },
      body: bodyText,
    };

    let usedKey: 'current' | 'next' | null = null;
    const currentResult = await verify({ ...verifyInput, secret: lookup.current });
    if (currentResult.ok) {
      usedKey = 'current';
    } else if (lookup.next) {
      const nextResult = await verify({ ...verifyInput, secret: lookup.next });
      if (nextResult.ok) usedKey = 'next';
    }
    if (!usedKey) {
      return buildError(
        c,
        'unauthorized',
        `bridge HMAC: ${currentResult.ok ? 'unknown' : currentResult.code}`,
      );
    }

    // Best-effort liveness ping. Every authenticated bridge call drops a
    // fresh timestamp so `bridges.last_seen_at` is meaningful. Telemetry
    // path — never block the request on D1.
    c.executionCtx.waitUntil(
      env.DB.prepare(`UPDATE bridges SET last_seen_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), bridgeId)
        .run()
        .then(() => undefined)
        .catch(() => undefined),
    );

    c.set('bridgeId', bridgeId);
    if (submissionId) c.set('submissionId', submissionId);
    c.set('bridgeUsedKey', usedKey);
    await next();
  };
}

// Same liveness ping as `bridgeHmacAuth()`, exported separately for the
// two non-middleware bridge auth paths (POST /v1/messages with
// content-type message/rfc822, POST /v1/messages-state) that inline
// `authenticateBridge` instead of going through middleware. Keeps the
// `last_seen_at` write site colocated with the secret it just verified.
export function touchBridgeLastSeen(env: Env, ctx: ExecutionContext, bridgeId: string): void {
  ctx.waitUntil(
    env.DB.prepare(`UPDATE bridges SET last_seen_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), bridgeId)
      .run()
      .then(() => undefined)
      .catch(() => undefined),
  );
}

// --- Back-compat shims ---
// `lookupBridgeSecret()` is the legacy single-secret lookup used by
// inline auth in routes/messages.ts and routes/messages-state.ts.
// Forwards to the candidates lookup and returns just the current key;
// kept as a separate symbol so the call sites can adopt the staged-
// rotation tolerant variant gradually.
export type BridgeSecretLookupOk = { ok: true; secret: string };
export type BridgeSecretLookupErr = BridgeSecretsErr;
export type BridgeSecretLookup = BridgeSecretLookupOk | BridgeSecretLookupErr;

export async function lookupBridgeSecret(env: Env, bridgeId: string): Promise<BridgeSecretLookup> {
  const r = await lookupBridgeSecrets(env, bridgeId);
  if (!r.ok) return r;
  return { ok: true, secret: r.current };
}
