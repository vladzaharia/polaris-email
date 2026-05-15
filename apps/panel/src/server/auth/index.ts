// Better-auth instance for the panel.
//
// Storage: drizzleAdapter(env.DB, { provider: 'sqlite' }) — same `polaris-email`
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

export function makeAuth(env: Env): Auth {
  const db = drizzle(env.DB, { schema });
  const cookiePath = env.COOKIE_PATH || '/panel';
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
            scopes: ['openid', 'email', 'profile', 'groups'],
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
  return instance as unknown as Auth;
}
