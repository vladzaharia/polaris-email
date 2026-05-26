// Per-bridge Tailscale auth-key lifecycle.
//
// For bridges that deploy in the Tailscale-fronted compose tab, the
// TS sidecar needs an auth key to join the tailnet. Operators today
// procure these manually in the Tailscale admin; we mint them
// server-side via the Tailscale API at register/rotate time, surface
// them once alongside the HMAC key, and revoke on delete.
//
// Tailscale API auth: OAuth2 client-credentials. Operator provisions
// an OAuth client in the TS admin with `auth_keys` scope; the api
// worker holds the client id + secret as `TS_API_CLIENT_ID` +
// `TS_API_CLIENT_SECRET`. The flow:
//
//   1. POST https://api.tailscale.com/api/v2/oauth/token
//      → exchange client creds for a short-lived access token.
//   2. POST /api/v2/tailnet/-/keys with that token
//      → mints an ephemeral, reusable, tagged auth key.
//
// "Ephemeral" is the right default — bridges that get rotated leave
// no stale tailnet identity behind. We tag the key `tag:mail-bridge`
// so ACL rules can target the whole fleet uniformly.
//
// Falls open when TS env vars are missing — operators not using the
// Tailscale tab don't need this configured, and we return null from
// the mint helper so callers can plumb it through cleanly.

import type { Env } from './env.js';

const TS_API_BASE = 'https://api.tailscale.com/api/v2';
const TS_TAILNET = '-'; // alias for the OAuth client's owning tailnet

interface MintedTsKey {
  id: string;
  value: string;
}

interface MintTsKeyResult {
  /** null when TS API env is not configured — caller treats as no-op. */
  key: MintedTsKey | null;
}

/**
 * Mint a per-bridge Tailscale auth key. Returns `{key: null}` when
 * the api worker isn't configured for TS minting (no TS_API_* env).
 * Errors propagate from configured calls — callers treat them as
 * "registration failed" the same as CF token mint failures.
 */
export async function mintTsAuthKeyForBridge(
  env: Env,
  bridgeName: string,
): Promise<MintTsKeyResult> {
  if (!env.TS_API_CLIENT_ID || !env.TS_API_CLIENT_SECRET) {
    return { key: null };
  }
  const access = await fetchTsAccessToken(env.TS_API_CLIENT_ID, env.TS_API_CLIENT_SECRET);
  // Capabilities: ephemeral so a deregistered bridge's tailnet node
  // ages out automatically; reusable=false because each bridge gets a
  // unique key; tagged so ACLs can target `tag:mail-bridge`.
  const body = {
    capabilities: {
      devices: {
        create: {
          reusable: false,
          ephemeral: true,
          preauthorized: true,
          tags: ['tag:mail-bridge'],
        },
      },
    },
    // 90-day expiry. Bridges normally consume the key within minutes
    // of registration — this is the absolute upper bound, after which
    // the operator must rotate.
    expirySeconds: 90 * 24 * 60 * 60,
    description: `polaris-bridge ${bridgeName}`,
  };
  const res = await fetch(`${TS_API_BASE}/tailnet/${TS_TAILNET}/keys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ts auth-key mint: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { id: string; key: string };
  return { key: { id: json.id, value: json.key } };
}

/**
 * Revoke a previously-minted TS auth key by id. Best-effort: logs
 * and resolves on failure. No-op when TS env is missing — there's
 * nothing to revoke if we never minted.
 */
export async function revokeTsAuthKeyBestEffort(env: Env, keyId: string): Promise<void> {
  if (!env.TS_API_CLIENT_ID || !env.TS_API_CLIENT_SECRET) {
    return;
  }
  try {
    const access = await fetchTsAccessToken(env.TS_API_CLIENT_ID, env.TS_API_CLIENT_SECRET);
    const res = await fetch(`${TS_API_BASE}/tailnet/${TS_TAILNET}/keys/${keyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${access}` },
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          event: 'ts_key_revoke_failed',
          key_id: keyId,
          status: res.status,
          body: text,
        }),
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        event: 'ts_key_revoke_error',
        key_id: keyId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}

async function fetchTsAccessToken(clientId: string, clientSecret: string): Promise<string> {
  // OAuth2 client-credentials grant. The TS docs call it
  // `oauth/token`; the body is the same urlencoded shape every
  // OAuth provider uses, with the client creds in the
  // `client_id` / `client_secret` form params (not Basic auth).
  const form = new URLSearchParams();
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);
  form.set('grant_type', 'client_credentials');
  const res = await fetch(`${TS_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ts oauth token: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}
