// Cloudflare Worker bindings + vars for the polaris-email panel.
//
// Bindings come from wrangler.jsonc:
//   DB      — D1 (same `polaris-email` database used by services/api; better-auth tables live here)
//   API     — service binding to polaris-email-api (one-way, panel → api only)
//   ASSETS  — Workers Assets binding serving dist/client
//
// Vars are plain strings; secrets are uploaded with `wrangler secret put`.
export interface Env {
  DB: D1Database;
  API: Fetcher;
  ASSETS: Fetcher;

  // Vars
  OIDC_ADMIN_GROUP: string;
  COOKIE_PATH: string;
  COOKIE_DOMAIN?: string;
  /**
   * `DEV_MODE='1'` enables the /api/dev/login backdoor in routes/session.ts.
   * MUST never be set in production. The startup check in src/server/index.ts
   * refuses to serve traffic when this is set together with
   * `ENVIRONMENT='production'`.
   */
  DEV_MODE?: string;
  /** Free-form environment tag; `'production'` is the only value that gates
   *  the DEV_MODE refusal in src/server/index.ts. */
  ENVIRONMENT?: string;
  /**
   * Body-size limit for admin-proxy POST/PATCH/PUT bodies, in bytes.
   * Default 1 MiB. Phase 3e.2.
   */
  PANEL_BODY_LIMIT_BYTES?: string;

  // OIDC (Cloudflare Access default provider). Secrets in `wrangler secret put`.
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URL?: string;
  /**
   * Space-separated OIDC scopes. Must include `groups` (or your IdP's
   * equivalent) for role-sync to work. Empty → defaults to
   * "openid email profile groups" at sign-in time.
   */
  OIDC_SCOPES?: string;
  /**
   * Primary OIDC claim path that holds group membership. Defaults to
   * `groups`. Legacy alternates (`roles`, `cf-access-groups`,
   * `cf_access_groups`) are still checked as fallbacks.
   */
  OIDC_GROUPS_CLAIM?: string;

  // Better-auth signing secret.
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;

  // Optional API HMAC fallback (only used if the service binding is unavailable
  // or if we're calling out to a different host).
  PANEL_ADMIN_KEY_ID?: string;
  PANEL_ADMIN_KEY_SECRET?: string;
}
