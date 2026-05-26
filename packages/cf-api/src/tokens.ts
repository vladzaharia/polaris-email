// Cloudflare API token mint + revoke wrappers, scoped for per-bridge
// DNS-01 / A-record management.
//
// The token returned by `mintBridgeDnsToken` has:
//   * Zone:DNS:Edit — Lego writes _acme-challenge TXT and the bridge
//                     writes its own A record (per the deployment
//                     convention).
//   * Zone:Read     — Lego does a GET /zones lookup to resolve the
//                     zone id from the host suffix. Without it the
//                     ACME loop fails at provider startup.
// Both scoped to a single zone (mail.plrs.im) — never account-wide.
//
// CF permission-group IDs are stable, documented values; pinning them
// here avoids a chicken-and-egg fetch on every mint. Source:
// https://developers.cloudflare.com/fundamentals/api/reference/permissions/

import { CloudflareApiClient } from './client.js';

// "Zone DNS Edit"
const PG_ZONE_DNS_EDIT = '4755a26eedb94da69e1066d98aa820be';
// "Zone Read"
const PG_ZONE_READ = 'c8fed203ed3043cba015a93ad1616f1f';

export interface MintedToken {
  /** Permanent identifier. Store this on the bridge row to revoke later. */
  id: string;
  /** Plaintext. Returned exactly once by Cloudflare — cache it now or rotate. */
  value: string;
}

export interface MintBridgeDnsTokenSpec {
  /** Display name on the CF dashboard, eg `polaris-bridge-<name>-<short>`. */
  name: string;
  /** Target zone id — the per-bridge token is scoped only to this one zone. */
  zoneId: string;
}

interface TokenCreateResponse {
  id: string;
  value: string;
}

/**
 * Mint a new Cloudflare API token narrowly scoped to a single zone's
 * DNS records. The returned `value` is plaintext-only-once; the caller
 * persists it (or re-issues it) before the response leaves scope.
 *
 * Throws `CloudflareApiError` on non-2xx. The error is bubbled by the
 * underlying `CloudflareApiClient` retry loop after the configured
 * retry budget is exhausted.
 */
export async function mintBridgeDnsToken(
  client: CloudflareApiClient,
  spec: MintBridgeDnsTokenSpec,
): Promise<MintedToken> {
  // The CF token-create body uses the same "policies" shape documented
  // for the dashboard — one or more policies, each binding permission
  // groups to resource scopes. We use one combined policy: DNS:Edit +
  // Zone:Read against the single target zone.
  const body = {
    name: spec.name,
    policies: [
      {
        effect: 'allow',
        resources: { [`com.cloudflare.api.account.zone.${spec.zoneId}`]: '*' },
        permission_groups: [{ id: PG_ZONE_DNS_EDIT }, { id: PG_ZONE_READ }],
      },
    ],
  };
  const res = await client.post<TokenCreateResponse>('/user/tokens', body);
  return { id: res.id, value: res.value };
}

/**
 * Revoke a previously-minted token by id. Best-effort caller pattern:
 * a failed revoke leaves an orphan token on the CF dashboard that can
 * be cleaned up manually. The catch sites are documented inline at
 * each caller.
 */
export async function revokeToken(client: CloudflareApiClient, tokenId: string): Promise<void> {
  // `DELETE /user/tokens/:id` — CF returns `{ id: <id> }` on success.
  // We don't need the body; we just care that the request succeeded.
  await client.delete(`/user/tokens/${tokenId}`);
}
