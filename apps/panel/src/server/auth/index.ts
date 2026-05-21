// Better-auth instance for the panel.
//
// Storage: drizzleAdapter(env.DB, { provider: 'sqlite' }) — same `polaris-mail`
// D1 database as services/api.
//
// Provider: the SSO plugin is used to delegate sign-in to an OIDC IdP. By
// default that's Cloudflare Access; the issuer/client-id/client-secret are
// supplied via wrangler secrets.
//
// Role sync: the hooks in ./role-sync.ts inspect the OIDC `groups` claim and
// set the panel's `admin` flag on the user row. We register the sync on THREE
// lifecycle events so that demotions propagate even if an IdP group change
// happens between sessions:
//
//   • `databaseHooks.user.create.after`  — first sign-up (profile is in-band).
//   • `databaseHooks.user.update.after`  — defensive: any user-row change.
//   • `databaseHooks.session.create.after` — every sign-in. Reads groups out
//     of the stored OIDC `id_token` on the user's `account` row, so removals
//     from the admin IdP group take effect on next login (no demotion event
//     is required from the IdP).
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../env.js';
import { syncRolesForUserId, syncRolesFromUserInfo } from './role-sync.js';
import * as schema from './schema.js';

// The `betterAuth(…)` return type is intentionally opaque here — bespoke
// inference would pull in the underlying zod schema types and pollute the
// declaration. We expose the runtime instance with a typed `handler` and `api`
// surface that's all we actually need at call sites.
export interface Auth {
  handler: (req: Request) => Promise<Response>;
  api: {
    getSession: (opts: { headers: Headers }) => Promise<{
      user: { id: string; email: string; admin?: boolean } | null;
      session: { id: string } | null;
    } | null>;
    signOut: (opts: { headers: Headers }) => Promise<unknown>;
    signInEmail: (opts: {
      body: { email: string; password: string };
      headers: Headers;
    }) => Promise<{ user?: { id: string; email: string } } | null>;
  };
}

// Phase 6d.5 — memoize per-env. Workers reuse `env` across requests in the
// same isolate; `betterAuth(...)` is heavyweight (drizzle adapter init,
// plugin construction, cookie config), so caching saves the rebuild on
// every /api/auth/* hit. WeakMap keys on the env reference and lets the
// instance get collected when the isolate recycles.
const authCache = new WeakMap<Env, Auth>();

export function makeAuth(env: Env): Auth {
  const cached = authCache.get(env);
  if (cached) return cached;
  const db = drizzle(env.DB, { schema });
  // Cookie path defaults to '/'. The panel is deployed as its own Worker
  // on its own hostname; every route hangs off the root, so a narrower
  // path scopes the session cookie OUT of the very requests that need it
  // (`/api/auth/get-session`, `/api/admin/*`). COOKIE_PATH stays as an
  // escape hatch for deployments that mount the panel on a subpath.
  const cookiePath = env.COOKIE_PATH || '/';
  const instance = betterAuth({
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        ssoProvider: schema.ssoProvider,
      },
    }),
    // Declare the panel-specific `admin` column so better-auth knows
    // to SELECT it and round-trip it on `getSession()`. Without this,
    // the column is written by the role-sync hook but stripped from
    // the session response — making `requireAdmin()` 403 every
    // request because `session.user.admin` is always undefined.
    // `input: false` prevents OAuth user-creation paths from carrying
    // a client-supplied admin value into the INSERT; the role-sync
    // hook is the only writer.
    user: {
      additionalFields: {
        admin: { type: 'boolean', defaultValue: false, input: false },
      },
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: 'oidc',
            discoveryUrl: env.OIDC_ISSUER
              ? `${env.OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`
              : '',
            clientId: env.OIDC_CLIENT_ID ?? '',
            clientSecret: env.OIDC_CLIENT_SECRET ?? '',
            // PKCE is required by most modern OIDC providers (including
            // Pocket ID's strict-mode clients). Without this, the IdP
            // returns "Invalid code verifier" on the token exchange and
            // the callback fails with `oauth_code_verification_failed`.
            // Better-auth ships PKCE off-by-default; we opt in so the
            // panel works against PKCE-required clients (the modern
            // default) and continues to work against optional ones.
            pkce: true,
            // Scopes are operator-configurable via OIDC_SCOPES
            // (space-separated). The `groups` scope is required for
            // role-sync; the configure wizard defaults to
            // "openid email profile groups", which yields the same set
            // as the historical hardcoded list.
            scopes: (env.OIDC_SCOPES ?? 'openid email profile groups').split(/\s+/).filter(Boolean),
            mapProfileToUser: (profile: Record<string, unknown>) => {
              // Defer the actual role-sync until after the user row exists.
              // We stash the raw profile on the returned object so the
              // signed-in hook below can read it back via the verification
              // value cache.
              return {
                email: String(profile.email ?? ''),
                name: typeof profile.name === 'string' ? profile.name : undefined,
                emailVerified: Boolean(profile.email_verified),
              };
            },
          },
        ],
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user, ctx) => {
            // First sign-in: the OIDC profile is in-band on the request
            // context, so we can sync directly without a DB round-trip for
            // the stored id_token.
            const userInfo = (ctx?.context?.session?.user ?? {}) as Record<string, unknown>;
            await syncRolesFromUserInfo(env, user.id, userInfo);
          },
        },
        update: {
          after: async (user) => {
            // Defensive re-sync on any user-row update. Idempotent and cheap
            // — it falls through to the account-table path internally.
            if (user?.id) await syncRolesForUserId(env, String(user.id));
          },
        },
      },
      session: {
        create: {
          // Every successful sign-in produces a new session row, so this is
          // the most reliable place to re-evaluate group membership on each
          // login. We read groups from the stored OIDC id_token (or fall
          // back to the userinfo endpoint) so a user removed from the admin
          // group at the IdP loses `admin=true` on their next sign-in.
          after: async (session) => {
            if (session?.userId) await syncRolesForUserId(env, String(session.userId));
          },
        },
      },
    },
    advanced: {
      cookies: {
        // Phase 3e.1 — session cookie security stance:
        //   * httpOnly: true   — JS in the SPA cannot read or steal the token.
        //   * secure:   true   — only sent over HTTPS; rejects plain http.
        //   * sameSite: 'lax'  — third-party top-level navigations are
        //     allowed (so OIDC redirects survive); cross-site form POSTs are
        //     blocked, which is sufficient for CSRF mitigation given the
        //     panel's same-origin XHR pattern.
        // `path` defaults to '/' (see cookiePath above) so the cookie is
        // sent on every panel request. Operators serving the panel on a
        // subpath (e.g. behind a path-routed proxy) set COOKIE_PATH to
        // narrow the scope.
        sessionToken: {
          name: 'polaris_panel_session',
          attributes: {
            path: cookiePath,
            sameSite: 'lax',
            httpOnly: true,
            secure: true,
            ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
          },
        },
      },
    },
  });
  const auth = instance as unknown as Auth;
  authCache.set(env, auth);
  return auth;
}
