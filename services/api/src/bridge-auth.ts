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
    // The plaintext secret that just verified the request. Stashed so
    // the heartbeat handler can re-`put` it into KV with a fresh dynamic
    // TTL without re-reading the cache. Set by `bridgeHmacAuth()`.
    bridgeSecret: string;
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

// --- Dynamic plaintext-cache TTL ---------------------------------------------
// The `bridge_plain:<id>` cache is re-`put` on every successful heartbeat
// (see routes/bridge/heartbeat.ts). The TTL ramps from an 8h floor to a
// 7d ceiling as the bridge earns reliability, so a long-lived, reliably
// up bridge can survive a longer outage before the api forgets it (and
// the operator has to roll). A fresh bridge gets the floor; a bridge up
// ~30d at ~100% availability gets the ceiling.

/** Floor TTL (seconds) — a freshly-registered bridge gets this. 8h. */
export const FLOOR_S = 8 * 60 * 60;
/** Ceiling TTL (seconds) — a tenured, reliably-up bridge earns this. 7d. */
export const CEIL_S = 7 * 24 * 60 * 60;
/** Tenure (ms) at which the tenure factor saturates to 1.0. 30d. */
export const TENURE_FULL_MS = 30 * 24 * 60 * 60 * 1000;
/** EWMA time constant (ms) — older availability state decays with the gap. ~30d. */
export const TAU_MS = 30 * 24 * 60 * 60 * 1000;
/** Heartbeat gaps at or under this count as fully "up" (normal cadence). 10min. */
export const GAP_GRACE_MS = 10 * 60 * 1000;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Fold a new heartbeat gap into the rolling availability EWMA.
 *
 * `prev` is the stored EWMA (NULL on the first heartbeat ⇒ start at
 * 1.0). `gapMs` is the wall-clock gap since the previous heartbeat. A
 * normal ~60s gap is treated as fully "up" (uptimeFrac ≈ 1); a multi-day
 * gap counts as mostly down (the bridge was unreachable for most of it),
 * pulling the EWMA below 1. `alpha = exp(-gapMs/TAU)` decays the prior
 * state proportionally to the gap, so a long silence both weights the
 * new (low) sample heavily AND ages out stale optimism.
 */
export function updateAvailabilityEwma(prev: number | null, gapMs: number): number {
  if (prev == null) return 1.0;
  if (gapMs <= 0) return clamp(prev, 0, 1);
  const up = Math.min(gapMs, GAP_GRACE_MS);
  const uptimeFrac = up / gapMs;
  const alpha = Math.exp(-gapMs / TAU_MS);
  return clamp(alpha * prev + (1 - alpha) * uptimeFrac, 0, 1);
}

/**
 * Map availability + tenure to a plaintext-cache TTL in seconds.
 *
 * `factor` blends earned reliability (`ewma`, 0..1) with tenure
 * (saturating at `TENURE_FULL_MS`). A fresh bridge → FLOOR_S regardless
 * of EWMA; a 30d bridge at ~100% availability → CEIL_S; a flaky bridge
 * climbs slower because its EWMA holds the factor down.
 */
export function bridgePlainTtlSeconds(ewma: number, tenureMs: number): number {
  const factor = clamp(ewma, 0, 1) * Math.min(1, Math.max(0, tenureMs) / TENURE_FULL_MS);
  return Math.round(FLOOR_S + (CEIL_S - FLOOR_S) * factor);
}

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
    c.set('bridgeSecret', usedKey === 'current' ? lookup.current : (lookup.next ?? lookup.current));
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
