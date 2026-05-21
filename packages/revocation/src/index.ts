// KV-backed credential revocation primitive for polaris-mail.
//
// Replaces the per-principal RevocationDO. At ~tens of mailboxes and
// <10k msg/day, the synchronous, single-region guarantees of a Durable
// Object are over-engineered. KV's eventually-consistent reads are
// acceptable when bounded by a short in-memory cache (60 s) and a
// belt-and-braces `KV_KEY_CACHE` invalidation on revoke.
//
// Shape:
//   key   = principal_id
//   value = revocation timestamp (epoch ms, as a string)
//   absence = not revoked
//
// `revocationCheck` is hot-path (every authenticated request). The
// module-level cache holds the boolean result with a 60 s TTL keyed by
// principal_id so steady-state traffic doesn't pay KV round-trip cost.
// The cache lives per-isolate; new isolates do a cold KV read once.

export interface RevocationEnv {
  KV_REVOCATIONS: KVNamespace;
  KV_KEY_CACHE: KVNamespace;
}

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;

// Module-level cache, shared by all callers within a single Worker isolate.
const cache = new Map<string, CacheEntry>();

/**
 * Returns `true` if `principalId` is revoked. Reads `KV_REVOCATIONS` and
 * caches the result in-memory for 60 s. Absence of the key (KV returns
 * `null`) is interpreted as not-revoked.
 */
export async function revocationCheck(env: RevocationEnv, principalId: string): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(principalId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const raw = await env.KV_REVOCATIONS.get(principalId);
  const revoked = raw !== null;
  cache.set(principalId, { value: revoked, expiresAt: now + CACHE_TTL_MS });
  return revoked;
}

/**
 * Marks `principalId` as revoked. Writes the current epoch-ms timestamp
 * to `KV_REVOCATIONS` and also primes the in-memory cache so subsequent
 * `revocationCheck` calls in this isolate see the revocation immediately
 * (other isolates pay one KV read per 60 s).
 *
 * Phase 3g — `keysToInvalidate` lets the caller hand back the matching
 * KV_KEY_CACHE entries (`key:<id>` / `plain:<id>` for api keys,
 * `bridge_plain:<id>` for bridges, etc.) and have them deleted in the
 * same call. The mapping `principal_id → key_id(s)` is not stored in this
 * package so the caller must compute the list, but routing every
 * cache-bust through `revoke()` removes the easy-to-forget second step.
 * Failures of individual cache deletes are swallowed (logged at warn)
 * the KV_REVOCATIONS write is the authoritative signal and revoking with
 * a stale cache entry is a soft failure (the next revocationCheck
 * within 60 s catches it).
 */
export async function revoke(
  env: RevocationEnv,
  principalId: string,
  keysToInvalidate?: string[],
): Promise<void> {
  const ts = Date.now();
  await env.KV_REVOCATIONS.put(principalId, String(ts));
  cache.set(principalId, { value: true, expiresAt: ts + CACHE_TTL_MS });
  if (keysToInvalidate && keysToInvalidate.length > 0) {
    for (const k of keysToInvalidate) {
      try {
        await env.KV_KEY_CACHE.delete(k);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          'revoke: KV_KEY_CACHE.delete failed',
          k,
          e instanceof Error ? e.message : 'unknown',
        );
      }
    }
  }
}

/**
 * Internal helper exposed for tests: clears the module-level cache so
 * tests can assert KV-read behaviour without isolate restarts.
 */
export function _clearRevocationCacheForTests(): void {
  cache.clear();
}
