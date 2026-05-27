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
import { bridgeTsAuthkeyPlainKvKey } from '../../bridge-ts-token.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const bridgeConfig = new Hono<{ Bindings: Env }>();

// requireSubmissionId is false because /v1/bridge/config is a
// startup/bootstrap call — not a message-submission path. The
// submission_id header is only meaningful for /v1/messages, and
// surfacing a 401 here breaks the bridge's startup sequence before it
// can even reach the heartbeat endpoint.
bridgeConfig.use('/v1/bridge/config', bridgeHmacAuth({ requireSubmissionId: false }));

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

  // CF DNS plaintext is OPTIONAL. Two cases:
  //   - Operator never configured CF on the api worker (CF_API_TOKEN
  //     etc. unset). Register/rotate skipped the mint and we return
  //     `cf_dns_token: null` so the bridge falls back to plaintext
  //     listeners / operator-managed PEMs.
  //   - Operator did configure CF, the mint succeeded, but the KV
  //     cache expired (90d TTL) before the bridge restarted. Return
  //     `key_propagating` (retryable) — operator rotates to repopulate.
  //
  // We distinguish via the row's `cf_dns_token_id`: NULL = never minted
  // → return null. Non-null but KV miss = expired → key_propagating.
  const tokenRow = await c.env.DB.prepare(`SELECT cf_dns_token_id FROM bridges WHERE id = ?`)
    .bind(bridgeId)
    .first<{ cf_dns_token_id: string | null }>();
  let cfDnsToken: string | null = null;
  if (tokenRow?.cf_dns_token_id) {
    cfDnsToken = await c.env.KV_KEY_CACHE.get(bridgeCfDnsPlainKvKey(bridgeId));
    if (!cfDnsToken) {
      return buildError(
        c,
        'key_propagating',
        'cf dns token plaintext not in cache; rotate the bridge to repopulate',
        { 'retry-after': '5' },
      );
    }
  }

  // TS authkey plaintext — same nullable-by-non-config story as the CF
  // token. When the api worker isn't configured for TS minting (no
  // `TS_API_CLIENT_*`), register/rotate never minted, KV is empty, and
  // we return null. Bridges treat null as "no automated TS bootstrap"
  // and the operator falls back to whatever path they prefer.
  const tsRow = await c.env.DB.prepare(`SELECT ts_authkey_id FROM bridges WHERE id = ?`)
    .bind(bridgeId)
    .first<{ ts_authkey_id: string | null }>();
  let tsAuthkey: string | null = null;
  if (tsRow?.ts_authkey_id) {
    tsAuthkey = await c.env.KV_KEY_CACHE.get(bridgeTsAuthkeyPlainKvKey(bridgeId));
    // KV miss = expired cache. Don't 401 the whole config call for it;
    // a stale TS key isn't fatal (the bridge falls back to whatever's
    // already in its persistent TS state). Return null so the bootstrap
    // container logs "no key available" and exits cleanly.
  }

  return c.json({
    cf_dns_token: cfDnsToken,
    cf_zone: 'mail.plrs.im',
    fqdn: `${row.name}.mail.plrs.im`,
    acme_email: c.env.ACME_EMAIL ?? '',
    ts_authkey: tsAuthkey,
  });
});
