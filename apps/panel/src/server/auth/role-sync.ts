// OIDC role-sync.
//
// Computes the panel's cached `admin` flag from the IdP's `groups` claim and
// writes it onto the user row. The flag is then read by middleware on every
// request without a roundtrip to the IdP.
//
// This module exports a single idempotent core (`syncRolesFromGroups`) plus a
// handful of thin wrappers that locate the groups claim in different sign-in
// contexts:
//
//   • `syncRolesFromUserInfo` — the OIDC profile is available in-band (e.g.
//     during the OAuth callback / `databaseHooks.user.create.after`).
//   • `syncRolesForUserId` — the profile is NOT in-band (e.g. on every later
//     sign-in via `databaseHooks.session.create.after`). Reads `id_token` from
//     the user's `account` row, decodes the JWT payload, and uses the groups
//     claim from there. Falls back to the OIDC userinfo endpoint with the
//     stored access token if `id_token` is absent or lacks the claim.
//
// `afterSignInRoleSync` is kept as a backwards-compatible alias.
//
// If your IdP emits groups under a different claim name (e.g.
// `cf-access-groups`, `roles`), extend `GROUP_CLAIMS` below.
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { and, eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import * as schema from './schema.js';

// Default claim search order when `env.OIDC_GROUPS_CLAIM` is unset.
// First match wins. Includes Cloudflare Access's `cf-access-groups`
// shape (both hyphen and underscore variants because IdPs differ on
// JSON-claim canonicalisation).
const DEFAULT_GROUP_CLAIMS = ['groups', 'roles', 'cf-access-groups', 'cf_access_groups'] as const;

type Db = DrizzleD1Database<typeof schema>;

/**
 * Update a user row's cached `admin` flag from the supplied groups list.
 *
 * Idempotent: writing the same value twice is a no-op (modulo `updated_at`).
 * Safe to call from any hook — never throws on missing rows.
 */
export async function syncRolesFromGroups(
  env: Env,
  userId: string,
  groups: string[],
  db?: Db,
): Promise<void> {
  if (!userId) return;
  const isAdmin = groups.includes(env.OIDC_ADMIN_GROUP);
  const database = db ?? drizzle(env.DB, { schema });
  await database
    .update(schema.user)
    .set({ admin: isAdmin, updatedAt: new Date() })
    .where(eq(schema.user.id, userId));
}

// claimsToSearch returns the ordered list of claim keys to inspect. If
// the operator has set OIDC_GROUPS_CLAIM we try it first; the legacy
// alternates remain as fallbacks so an IdP swap that goes from `groups`
// to `roles` (or vice versa) doesn't immediately lock everyone out.
function claimsToSearch(env: Env): readonly string[] {
  const configured = env.OIDC_GROUPS_CLAIM?.trim();
  if (!configured) return DEFAULT_GROUP_CLAIMS;
  if (DEFAULT_GROUP_CLAIMS.includes(configured as (typeof DEFAULT_GROUP_CLAIMS)[number])) {
    // Already in the legacy list; just promote it to the front.
    return [configured, ...DEFAULT_GROUP_CLAIMS.filter((c) => c !== configured)];
  }
  return [configured, ...DEFAULT_GROUP_CLAIMS];
}

/**
 * Run a role-sync given the raw OIDC userinfo payload. Used when the IdP
 * profile is available in-band (sign-up / sign-in callback path).
 */
export async function syncRolesFromUserInfo(
  env: Env,
  userId: string,
  userInfo: Record<string, unknown> | undefined,
  db?: Db,
): Promise<void> {
  if (!userInfo) {
    // Profile not provided in-band — fall back to the account-table path so a
    // demotion still propagates if we have a stored id_token.
    await syncRolesForUserId(env, userId, db);
    return;
  }
  const groups = extractGroups(userInfo, claimsToSearch(env));
  await syncRolesFromGroups(env, userId, groups, db);
}

/**
 * Run a role-sync for a user ID when the OIDC profile is NOT in-band.
 *
 * Resolves the groups claim by, in order:
 *   1. Decoding the `id_token` JWT stored on the user's `account` row.
 *   2. Calling the IdP userinfo endpoint with the stored `access_token`.
 *
 * Used by the `session.create.after` hook so every sign-in re-evaluates group
 * membership and demotions take effect on the next login.
 */
export async function syncRolesForUserId(env: Env, userId: string, db?: Db): Promise<void> {
  if (!userId) return;
  const database = db ?? drizzle(env.DB, { schema });
  // We only care about OIDC-provider accounts. The generic-oauth plugin uses
  // `providerId = 'oidc'` per ./index.ts.
  const accountRow = await database
    .select({
      idToken: schema.account.idToken,
      accessToken: schema.account.accessToken,
    })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'oidc')))
    .limit(1);
  const row = accountRow[0];
  if (!row) return;

  const claims = claimsToSearch(env);
  let groups: string[] | null = null;
  if (row.idToken) {
    const payload = decodeJwtPayload(row.idToken);
    if (payload) groups = extractGroups(payload, claims);
  }
  if (!groups || groups.length === 0) {
    // Fall back to userinfo if we have an access token + issuer.
    if (row.accessToken && env.OIDC_ISSUER) {
      const userInfo = await fetchUserInfo(env.OIDC_ISSUER, row.accessToken);
      if (userInfo) groups = extractGroups(userInfo, claims);
    }
  }
  await syncRolesFromGroups(env, userId, groups ?? [], database);
}

/**
 * Back-compat alias used by the existing `user.create.after` hook in
 * ./index.ts. New call sites should prefer `syncRolesFromUserInfo` or
 * `syncRolesForUserId` directly.
 */
export async function afterSignInRoleSync(
  env: Env,
  userId: string,
  userInfo: Record<string, unknown> | undefined,
): Promise<void> {
  await syncRolesFromUserInfo(env, userId, userInfo);
}

// ----------------------------------------------------------------------------
// Helpers

// Cap the OIDC `groups` claim at a reasonable number of entries. A hostile
// or misconfigured IdP can emit megabyte-sized arrays and we'd spend the
// rest of the sign-in turning them into strings. 200 is well above any
// realistic group membership for a single user.
const MAX_GROUPS = 200;

function extractGroups(
  claims: Record<string, unknown>,
  claimOrder: readonly string[] = DEFAULT_GROUP_CLAIMS,
): string[] {
  for (const claim of claimOrder) {
    const v = claims[claim];
    if (Array.isArray(v)) {
      if (v.length > MAX_GROUPS) return [];
      return v.map((x) => String(x));
    }
    if (typeof v === 'string') {
      const parts = v.split(/[\s,]+/).filter(Boolean);
      if (parts.length > MAX_GROUPS) return [];
      return parts;
    }
  }
  return [];
}

/**
 * Decode a JWT payload WITHOUT signature verification. Safe here because:
 *   • The token came back from better-auth's verified OIDC sign-in flow.
 *   • We only read the `groups` claim — we never grant trust on its presence
 *     alone; the `admin` flag is recomputed every sign-in.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  const payload = parts[1];
  if (!payload) return null;
  try {
    // base64url → base64
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

async function fetchUserInfo(
  issuer: string,
  accessToken: string,
): Promise<Record<string, unknown> | null> {
  try {
    const discoveryUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const discRes = await fetch(discoveryUrl);
    if (!discRes.ok) return null;
    const disc = (await discRes.json()) as { userinfo_endpoint?: string };
    const userInfoUrl = disc.userinfo_endpoint;
    if (!userInfoUrl) return null;
    const res = await fetch(userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
