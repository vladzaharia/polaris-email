// public MTA-STS policy handler.
//
// Sender MTAs fetch `https://mta-sts.{tenant}/.well-known/mta-sts.txt`
// without credentials to learn the receiving domain's STS policy
// (RFC 8461 §3.3). This Worker is the policy origin: per-tenant
// `mta-sts.{tenant}` hostnames are mapped here by a Workers Routes
// provision in Phase C.4/C.6, and dispatch happens off the request
// `Host` header rather than the path (the path is fixed by the RFC).
//
// Why this lives at app root and not under any auth middleware:
//   * The RFC mandates anonymous fetches — adding HMAC/Bearer auth
//     would prevent senders from getting a policy at all.
//   * The handler short-circuits with `c.notFound()` for any Host that
//     does not start with `mta-sts.`, so mounting it at `/` is safe
//     even though `/.well-known/...` is a well-known path family that
//     other routes might also use (none currently do).
//
// Cache discipline (RFC 8461 §3.2 + Workers Cache API):
//   * The sender computes its own cache TTL from `max_age` in the body.
//   * The HTTP response's `Cache-Control` is operator-facing only — it
//     lets the Cloudflare edge cache the small policy file to absorb
//     sender retry storms without hitting D1 on every fetch. Set to
//     86400s (1 day) with `public, s-maxage`.
//   * We *also* wrap the handler in `caches.default.match`/`.put` with
//     a canonicalised cache key. Two reasons: (1) the incoming Host
//     header is case-insensitive (RFC 7230 §5.4) but the Cache API keys
//     on the URL byte-for-byte, so without canonicalisation a mixed-case
//     Host would miss the cache for the lowercase variant. (2) the
//     Workers Cache API gives explicit semantics so the cache holds
//     even if a future fronting Worker mutates Cache-Control. On
//     mta_sts_mode change, an operator can purge via the CF API — see
//     apps/docs/content/operators/day-2/cache-purge.md (TODO).
import { Hono } from 'hono';
import type { Env } from '../env.js';

export const mtaStsPolicy = new Hono<{ Bindings: Env }>();

// Canonical cache-key URL. Internal hostname (never resolves on the
// public internet), domain segment is the lowercased per-tenant key.
// Keeps cache entries stable across mixed-case Host headers, custom
// ports, query strings, and any other request variability that the
// underlying handler ignores.
function cacheKeyFor(domain: string): Request {
  return new Request(`https://mta-sts-cache.polaris.internal/${domain}/policy`, {
    method: 'GET',
  });
}

// `caches` is a Workers-runtime global; FakeD1 unit tests run in plain
// Node where it's undefined. Resolve through `globalThis` so the unit
// suite can fall through to the D1 path without a ReferenceError.
function workersCache(): Cache | undefined {
  return (globalThis as { caches?: CacheStorage }).caches?.default;
}

mtaStsPolicy.get('/.well-known/mta-sts.txt', async (c) => {
  // RFC 7230 §5.4: Host header is case-insensitive. We normalise to
  // lowercase before any prefix or D1 lookup so callers can't bypass
  // the dispatch check with an unusual casing.
  const host = c.req.header('host')?.toLowerCase() ?? '';
  if (!host.startsWith('mta-sts.')) return c.notFound();
  const domain = host.slice('mta-sts.'.length);

  const cache = workersCache();
  const cacheKey = cacheKeyFor(domain);
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  // Look up the tenant. Two short-circuits:
  //   * `disabled_at IS NOT NULL` → tenant offboarded; don't surface.
  //   * `mta_sts_mode = 'none'`   → policy explicitly disabled.
  // Both collapse to 404, indistinguishable from "domain we don't host".
  // We deliberately do NOT cache the 404 path — it has no body cost on
  // D1 and caching negative responses would delay a freshly-enabled
  // tenant's first policy fetch.
  const row = await c.env.DB.prepare(
    `SELECT mta_sts_mode, mta_sts_max_age FROM mail_domains
     WHERE name = ? AND disabled_at IS NULL`,
  )
    .bind(domain)
    .first<{ mta_sts_mode: string; mta_sts_max_age: number }>();
  if (!row || row.mta_sts_mode === 'none') return c.notFound();

  // RFC 8461 §3.2: policy file is CRLF-separated key/value pairs.
  // `mx: *.mx.cloudflare.net` matches Cloudflare Email Routing's
  // inbound MX hostname pattern, which is the receive substrate for
  // every onboarded tenant in this codebase.
  const body =
    `version: STSv1\r\n` +
    `mode: ${row.mta_sts_mode}\r\n` +
    `mx: *.mx.cloudflare.net\r\n` +
    `max_age: ${row.mta_sts_max_age}\r\n`;

  const response = new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // Operator-facing edge cache TTL only; the sender ignores this
      // and trusts the in-body `max_age` field instead (RFC 8461 §3.2).
      // `public` so Cloudflare's anonymous edge caches it; `s-maxage`
      // applies to shared (CDN) caches specifically. The Workers Cache
      // API also honours `s-maxage` for its own TTL.
      'cache-control': 'public, s-maxage=86400, max-age=60',
    },
  });

  // Clone before put — the original is what we hand back to the caller,
  // and a Response body can only be consumed once. Skip silently on
  // non-Workers runtimes (unit tests against FakeD1) where the Cache
  // API isn't available.
  if (cache) c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});
