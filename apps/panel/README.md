# polaris-email-panel

Hono + React admin UI deployed as a single Cloudflare Worker. The server
runtime is Hono on Workers, the client is React 19 + TanStack Router
served from the Workers Assets binding, and sessions are managed by
[better-auth](https://www.better-auth.com/) with its drizzle adapter
talking to the same `polaris-email` D1 database used by `services/api`.
Authentication is delegated to an OIDC IdP (Cloudflare Access by
default); the panel sits behind a Cloudflare Access app for an
additional zero-trust gate. Sensitive actions step up by re-prompting
through Access and surface as HTTP `428 Precondition Required` to the
client until the step-up cookie is present.

## Dev commands

```sh
# install (run once at the repo root)
pnpm install

# typecheck both client and server projects
pnpm --filter @polaris-email/panel typecheck

# build the production bundle (Vite client → dist/client/, then tsc server check)
pnpm --filter @polaris-email/panel build

# run the Worker locally against the merged wrangler.local.jsonc config
pnpm --filter @polaris-email/panel dev:server

# run the Vite dev server (client only, with HMR — useful while iterating on UI)
pnpm --filter @polaris-email/panel dev:client

# unit tests
pnpm --filter @polaris-email/panel test
```

`dev:server` is the recommended end-to-end loop because better-auth +
the D1 session store only run inside the Worker. Deploy with
`pnpm --filter @polaris-email/panel deploy`, which is a thin wrapper
around `../../bin/deploy.sh apps/panel` (merges the gitignored
`wrangler.local.jsonc` overlay before `wrangler deploy`).

## Environment

Bindings (declared in `wrangler.jsonc`):

- `DB` — the shared `polaris-email` D1 database. better-auth's
  `user`, `session`, `account`, `verification`, and `ssoProvider` tables
  live alongside the canonical schema.
- `API` — one-way service binding to `polaris-email-api`. All admin API
  calls go over this binding (no public HMAC key required in the happy
  path).
- `ASSETS` — Workers Assets binding serving `dist/client/`.

Vars (committed defaults in `wrangler.jsonc`, override in
`wrangler.local.jsonc`):

| Var             | Default          | Purpose                                                                    |
| --------------- | ---------------- | -------------------------------------------------------------------------- |
| `ADMIN_GROUP`   | `polaris-admins` | OIDC `groups` claim required for admin role-sync.                          |
| `COOKIE_PATH`   | `/panel`         | Session cookie `Path`. Override to `/` for subdomain deployment mode.      |
| `COOKIE_DOMAIN` | _(unset)_        | Set to `.example.com` when the panel and API live on different subdomains. |
| `DEV_MODE`      | _(unset)_        | When `"1"`, relaxes secure-cookie + step-up checks for local dev only.     |

Secrets (`wrangler secret put`):

| Secret                   | Required when              | Purpose                                                                       |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------------- |
| `OIDC_ISSUER`            | always                     | Issuer URL; better-auth derives `${issuer}/.well-known/openid-configuration`. |
| `OIDC_CLIENT_ID`         | always                     | OAuth client ID registered with the IdP / Access app.                         |
| `OIDC_CLIENT_SECRET`     | always                     | Matching client secret.                                                       |
| `OIDC_REDIRECT_URL`      | always                     | Callback URL, e.g. `https://panel.example.com/panel/api/auth/callback/oidc`.  |
| `BETTER_AUTH_SECRET`     | always                     | Signing secret for better-auth session tokens.                                |
| `BETTER_AUTH_URL`        | always                     | Public base URL the panel is served from.                                     |
| `PANEL_ADMIN_KEY_ID`     | only without `API` binding | Optional API-side HMAC key id (fallback when not using service binding).      |
| `PANEL_ADMIN_KEY_SECRET` | only without `API` binding | Matching API HMAC secret.                                                     |

See `wrangler.local.template.jsonc` (when present) for the full overlay
shape; copy it to `wrangler.local.jsonc` and fill in real values.

## Auth flow

The panel is a Cloudflare Access app first; only browsers that have
already cleared Access reach the Worker. Inside the Worker, better-auth
uses its `genericOAuth` plugin to delegate sign-in to the same OIDC
issuer Access exposes. On first sign-in the `databaseHooks.user.create.after`
hook runs `afterSignInRoleSync(env, userId, claims)`, which inspects the
OIDC `groups` claim against `ADMIN_GROUP` and writes the `admin` flag
onto the user row. Subsequent requests hit `auth.api.getSession`, which
returns the user + session from D1; a missing or expired session
short-circuits to a redirect. Sensitive actions (DLQ drop, two-person
operations, credential rotation) require a step-up cookie minted by
re-running through Access; the server returns `428 Precondition Required`
until that cookie is presented, at which point the route handler permits
the mutation.

## Route inventory

Routes are declared explicitly in
[`src/client/router.tsx`](src/client/router.tsx) (TanStack Router,
code-based for type-safety against the tsc-only client build):

- `/login` — sign-in landing page (lives outside the sidebar layout).
- `/` — Dashboard (health summary + recent activity).
- `/mailboxes` / `/mailboxes/$id` — mailbox list + detail.
- `/domains` / `/domains/$id` — domain list + detail.
- `/credentials` / `/credentials/$id` — outbound credentials.
- `/messages` / `/messages/$id` — message list + detail (inline body /
  attachment download).
- `/webhook-subs` / `/webhook-subs/$id` — webhook subscriptions.
- `/routing` / `/routing/$id` — inbound routing rules.
- `/dlq` — webhook DLQ browser (replay / drop with two-person gate).
- `/daemons` / `/daemons/$id` — submission-daemon registry.
- `/test-send` — interactive sender for smoke-testing live + test mode.
- `/settings/account` — current user profile + sign-out.
