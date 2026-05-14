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
  ADMIN_GROUP: string;
  COOKIE_PATH: string;
  COOKIE_DOMAIN?: string;
  DEV_MODE?: string;

  // OIDC (Cloudflare Access default provider). Secrets in `wrangler secret put`.
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URL?: string;

  // Better-auth signing secret.
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;

  // Optional API HMAC fallback (only used if the service binding is unavailable
  // or if we're calling out to a different host).
  PANEL_ADMIN_KEY_ID?: string;
  PANEL_ADMIN_KEY_SECRET?: string;
}
