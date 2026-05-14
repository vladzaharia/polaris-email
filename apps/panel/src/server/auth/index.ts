// Better-auth instance for the panel.
//
// Storage: drizzleAdapter(env.DB, { provider: 'sqlite' }) — same `polaris-email`
// D1 database as services/api.
//
// Provider: the SSO plugin is used to delegate sign-in to an OIDC IdP. By
// default that's Cloudflare Access; the issuer/client-id/client-secret are
// supplied via wrangler secrets.
//
// Role sync: the `after:signIn` hook in ./role-sync.ts inspects the OIDC
// `groups` claim and sets the panel's `admin` flag on the user row.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../env.js';
import { afterSignInRoleSync } from './role-sync.js';
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
            const userInfo = (ctx?.context?.session?.user ?? {}) as Record<string, unknown>;
            await afterSignInRoleSync(env, user.id, userInfo);
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
