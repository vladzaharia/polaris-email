// Per-bridge Cloudflare DNS-01 token lifecycle.
//
// The bridge's embedded Lego loop needs a CF API token scoped to
// `Zone:DNS:Edit` + `Zone:Read` on the `mail.plrs.im` zone. Operators
// don't see this token — it flows over the wire from
// `GET /v1/bridge/config` (bridgeHmacAuth-gated) into the bridge's
// in-memory ACME loop. Plaintext is cached in KV_KEY_CACHE under
// `bridge_cf_dns_plain:<bridge_id>` for the lifetime of the token,
// mirroring the HMAC plaintext cache pattern in `bridge-auth.ts`.
//
// Lifecycle hooks (all in `routes/admin/bridges.ts`):
//   * Register: mint → store token id on the row → cache plaintext → audit
//   * Rotate:   mint new → swap token id → cache new plaintext →
//               best-effort revoke previous token id → audit
//   * Delete:   best-effort revoke before the DELETE FROM bridges
//
// Failures during mint at register/rotate propagate (we don't want a
// half-provisioned bridge). Revoke failures are logged and swallowed;
// the row delete is the source of truth.
//
// "Token plaintext lifetime" — CF tokens have no default expiry, so the
// KV TTL is what governs how long a bridge can run without a rotate.
// Set at 90d initially; bridges call /v1/bridge/config on every
// startup, so this is far longer than typical reboot intervals.

import { CloudflareApiClient, mintBridgeDnsToken, revokeToken } from '@polaris-mail/cf-api';
import type { Env } from './env.js';

/** KV key under which the per-bridge CF DNS token plaintext is cached. */
export function bridgeCfDnsPlainKvKey(bridgeId: string): string {
  return `bridge_cf_dns_plain:${bridgeId}`;
}

/** 90 days. CF tokens don't expire; we re-cache them on every register/rotate. */
export const BRIDGE_CF_DNS_PLAIN_KV_TTL_SECONDS = 90 * 24 * 60 * 60;

interface MintForBridgeResult {
  tokenId: string;
  /** Plaintext is returned for the caller to cache in KV. Don't log it. */
  plaintext: string;
}

/**
 * Mint a fresh per-bridge CF DNS token. Names it after the bridge so
 * the CF dashboard is greppable; the suffix is a short slice of the
 * bridge ULID for collision avoidance after deregister + re-register.
 */
export async function mintCfDnsTokenForBridge(
  env: Env,
  bridgeName: string,
  bridgeId: string,
): Promise<MintForBridgeResult> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_ZONE_ID_MAIL_PLRS_IM) {
    throw new Error('cf_token_mint: required CF_* env vars are not configured');
  }
  const client = new CloudflareApiClient({
    apiToken: env.CF_API_TOKEN,
    accountId: env.CF_ACCOUNT_ID,
  });
  // Last 6 chars of the ULID — Crockford base32 so case-insensitive and
  // legible. CF dashboard column shows the full name, so we keep it
  // identifiable but not eye-watering.
  const shortId = bridgeId.slice(-6).toLowerCase();
  const minted = await mintBridgeDnsToken(client, {
    name: `polaris-bridge-${bridgeName}-${shortId}`,
    zoneId: env.CF_ZONE_ID_MAIL_PLRS_IM,
  });
  return { tokenId: minted.id, plaintext: minted.value };
}

/**
 * Best-effort revoke. Logs on failure and resolves — the caller has
 * already passed the point where it can refuse the request.
 */
export async function revokeCfDnsTokenBestEffort(env: Env, tokenId: string): Promise<void> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        event: 'cf_token_revoke_skipped',
        reason: 'cf_env_missing',
        token_id: tokenId,
      }),
    );
    return;
  }
  const client = new CloudflareApiClient({
    apiToken: env.CF_API_TOKEN,
    accountId: env.CF_ACCOUNT_ID,
  });
  try {
    await revokeToken(client, tokenId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        event: 'cf_token_revoke_failed',
        token_id: tokenId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}
