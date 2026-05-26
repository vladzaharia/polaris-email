// Bridge self-fetch: GET /v1/bridge/config.
//
// On startup, the bridge calls this endpoint over its own HMAC channel
// (bridgeHmacAuth — same auth surface as /v1/bridge/heartbeat). The
// response carries the operational secrets that drive the bridge's
// embedded ACME loop: the per-bridge CF DNS-01 token plaintext, the
// FQDN convention, the ACME contact email, and the zone name. Nothing
// here is operator-procured; nothing here leaves the service ↔ bridge
// channel.
//
// CF DNS token plaintext lifecycle:
//   * Minted by routes/admin/bridges.ts on register/rotate. The mint
//     response is cached in KV_KEY_CACHE under
//     `bridge_cf_dns_plain:<bridge_id>` for 90 days. See
//     `bridge-cf-token.ts` for the cache key + TTL constants.
//   * Reads on this endpoint hit KV — never the CF API. KV miss is the
//     unrecoverable state: the operator must rotate the bridge to
//     re-mint and re-cache. We return `key_propagating` so the bridge's
//     ticker treats it as a retryable transient, not a hard failure.
//   * Same `key_propagating` recovery story as the HMAC plaintext
//     cache (`bridge-auth.ts:18-22`).
//
// Like the heartbeat endpoint, this sits OUTSIDE the admin router so
// it can use bridgeHmacAuth() directly. The admin middleware at
// `routes/admin.ts` bypasses /v1/bridge/heartbeat already — extending
// the bypass list to include /v1/bridge/config keeps the auth surface
// consistent.
import { Hono } from 'hono';
import { bridgeHmacAuth } from '../../bridge-auth.js';
import { bridgeCfDnsPlainKvKey } from '../../bridge-cf-token.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const bridgeConfig = new Hono<{ Bindings: Env }>();

bridgeConfig.use('/v1/bridge/config', bridgeHmacAuth());

bridgeConfig.get('/v1/bridge/config', async (c) => {
  const bridgeId = c.get('bridgeId');

  // Look up the bridge name — feeds the FQDN convention
  // `<name>.mail.plrs.im`. We don't trust env or the caller for this;
  // the source of truth is the row.
  const row = await c.env.DB.prepare(`SELECT name, disabled_at FROM bridges WHERE id = ?`)
    .bind(bridgeId)
    .first<{ name: string; disabled_at: string | null }>();
  if (!row || row.disabled_at != null) {
    // bridgeHmacAuth() would normally 401 disabled bridges via its
    // own lookup, but the row could have been disabled between auth
    // and this read. Treat both as unauthorized to avoid leaking the
    // shape of "real but disabled" identifiers.
    return buildError(c, 'unauthorized', 'bridge disabled or unknown');
  }

  const cfDnsToken = await c.env.KV_KEY_CACHE.get(bridgeCfDnsPlainKvKey(bridgeId));
  if (!cfDnsToken) {
    return buildError(
      c,
      'key_propagating',
      'cf dns token plaintext not in cache; rotate the bridge to repopulate',
      { 'retry-after': '5' },
    );
  }

  // Both required for the response to be useful. Misconfiguration
  // surfaces here rather than later inside the bridge's ACME loop.
  if (!c.env.ACME_EMAIL) {
    return buildError(c, 'degraded', 'ACME_EMAIL env not configured on api worker');
  }
  if (!c.env.CF_ZONE_ID_MAIL_PLRS_IM) {
    return buildError(c, 'degraded', 'CF_ZONE_ID_MAIL_PLRS_IM env not configured on api worker');
  }

  return c.json({
    cf_dns_token: cfDnsToken,
    cf_zone: 'mail.plrs.im',
    fqdn: `${row.name}.mail.plrs.im`,
    acme_email: c.env.ACME_EMAIL,
  });
});
