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
// Cache discipline (RFC 8461 §3.2):
//   * The sender computes its own cache TTL from `max_age` in the body.
//   * The HTTP response's `Cache-Control` is operator-facing only — it
//     lets the Cloudflare edge cache the small policy file to absorb
//     sender retry storms without hitting D1 on every fetch. Bumped to
//     86400s (1 day) with `public, s-maxage` because the policy is keyed
//     by Host header (intrinsically per-tenant) and changes only when an
//     operator toggles mta_sts_mode (rare, manual). On change, an
//     operator can purge the edge cache via the CF API — see
//     apps/docs/content/operators/day-2/cache-purge.md (TODO).
import { Hono } from 'hono';
import type { Env } from '../env.js';

export const mtaStsPolicy = new Hono<{ Bindings: Env }>();

mtaStsPolicy.get('/.well-known/mta-sts.txt', async (c) => {
  // RFC 7230 §5.4: Host header is case-insensitive. We normalise to
  // lowercase before any prefix or D1 lookup so callers can't bypass
  // the dispatch check with an unusual casing.
  const host = c.req.header('host')?.toLowerCase() ?? '';
  if (!host.startsWith('mta-sts.')) return c.notFound();
  const domain = host.slice('mta-sts.'.length);

  // Look up the tenant. Two short-circuits:
  //   * `disabled_at IS NOT NULL` → tenant offboarded; don't surface.
  //   * `mta_sts_mode = 'none'`   → policy explicitly disabled.
  // Both collapse to 404, indistinguishable from "domain we don't host".
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

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // Operator-facing edge cache TTL only; the sender ignores this
      // and trusts the in-body `max_age` field instead (RFC 8461 §3.2).
      // `public` so Cloudflare's anonymous edge caches it; `s-maxage`
      // applies to shared (CDN) caches specifically.
      'cache-control': 'public, s-maxage=86400, max-age=60',
    },
  });
});
