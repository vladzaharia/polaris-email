---
title: Cloudflare Access setup
description: Wire Cloudflare Access in front of the admin panel — OIDC IdP setup, the `access-app` Terraform module, WebAuthn step-up policies, service tokens for daemons, and group-based role sync via the OIDC groups claim.
sidebar_label: Cloudflare Access setup
sidebar_position: 2
---

# Cloudflare Access in front of the panel

The panel is a Cloudflare Access app first. Only browsers that have
already cleared Access reach the Worker. Inside the Worker,
[better-auth](https://www.better-auth.com/) runs a second OIDC sign-in
to derive the panel session. That two-stage flow is intentional: the
outer Access app does zero-trust gating, the inner OIDC sign-in
populates the admin role from the OIDC `groups` claim.

This walkthrough covers:

1. Picking and configuring an OIDC identity provider at the
   Cloudflare Access level.
2. Wiring the `access-app` Terraform module so the panel hostname is
   protected by Access.
3. WebAuthn step-up on sensitive actions.
4. Service tokens for daemons that need to reach the admin API
   behind Access.
5. Group-based role sync via the OIDC `groups` claim and the
   `OIDC_ADMIN_GROUP` env var the panel reads.

:::note
We've validated this with Google OIDC and GitHub OIDC. Other IdPs
(Okta, Auth0, JumpCloud, etc.) likely work — Cloudflare Access
supports them as generic OIDC sources — but aren't documented here.
WebAuthn and one-time PIN are also supported as standalone IdPs at
the Access level.
:::

## 1. Configure the OIDC IdP in Cloudflare Access

Cloudflare dashboard → **Zero Trust** → **Settings** → **Authentication**
→ **Login methods** → **Add new**.

Pick the relevant template and fill in the IdP's client id, client
secret, and (for generic OIDC) the issuer / discovery URL. Required
scopes for polaris-email:

| Scope                    | Why                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openid`                 | Required for OIDC.                                                                                                                                    |
| `email`                  | Better-auth uses the email as the user's primary identifier.                                                                                          |
| `profile`                | Optional but recommended for display name + avatar.                                                                                                   |
| `groups` (or equivalent) | The panel's `OIDC_ADMIN_GROUP` check reads this claim. Configure the IdP to include group membership in either the id_token or the userinfo endpoint. |

**Important:** the panel's role-sync code accepts the groups claim
under any of these names: `groups`, `roles`, `cf-access-groups`,
`cf_access_groups`. If your IdP emits a non-standard claim name, add
it to `GROUP_CLAIMS` in
[`apps/panel/src/server/auth/role-sync.ts`](https://github.com/vladzaharia/polaris-email/blob/main/apps/panel/src/server/auth/role-sync.ts)
rather than renaming the IdP-side claim. The claim is capped at 200
entries so a hostile or misconfigured IdP can't DoS the sign-in path
with a megabyte-sized array.

Save the IdP. Cloudflare assigns it an **identity provider ID**
(`uuid` shaped) — you'll plug this into the Terraform module below.

### Google OIDC specifics

Google issues groups via [Cloud Identity / Workspace groups
sync](https://support.google.com/a/answer/9039196). Configure the
"Google Workspace" IdP type in Access if your account uses it;
otherwise the generic Google OIDC IdP works but you'll need a
sidecar groups source.

### GitHub OIDC specifics

GitHub doesn't emit a `groups` claim natively. Access can synthesize
one from GitHub team membership when you use the GitHub IdP type;
pick the org and add the teams you intend to use as `OIDC_ADMIN_GROUP`
values. The synthesised claim arrives under `cf-access-groups`.

## 2. Create the Access application

In the Cloudflare Zero Trust dashboard, **Access → Applications →
Add an application → Self-hosted**:

| Field                    | Value                                                       |
| ------------------------ | ----------------------------------------------------------- |
| Application name         | `polaris-email-panel`                                       |
| Session duration         | `1 hour` (keep short for admin surfaces)                    |
| Application domain       | `panel.example.com` (the FQDN you'll front the panel on)    |
| Identity providers       | Tick the IdPs configured in step 1                          |

Then add **one allow policy** with:

- Decision: **Allow**
- Include rule: either an explicit email list (`Emails: ops@example.com, …`)
  or a group rule once your IdP's `groups` claim is wired
- (Recommended) Require rule: **Authentication method = WebAuthn**
  (`swk` AuthnContext) to force a hardware-key prompt at session start
  — see §3

When you save the application, Cloudflare prints the **Application
AUD tag** — copy this; it goes into the panel Worker's
`CF_ACCESS_AUD` env var so the panel can validate the `Cf-Access-Jwt-Assertion`
header end-to-end.

The panel hostname now redirects unauthenticated requests to the Access
login page; only post-auth traffic reaches the Worker.

## 3. WebAuthn step-up for sensitive actions

The recommended policy above adds an
**Authentication method = WebAuthn** require-block, which forces
**YubiKey, Apple Touch ID, Windows Hello, or any WebAuthn-capable
authenticator** to be presented at session start.

Disable this require-block only if you have a specific operational
reason — e.g. an emergency break-glass app in a separate environment
where the WebAuthn ceremony is itself the blocker.

Destructive actions inside the panel are gated **client-side** via
`DestructiveActionDialog` (type-the-resource-name confirmation); the
chained-hash `audit_log` table remains the canonical record of who did
what. WebAuthn step-up at the Access layer is the right place to
enforce hardware-key presence for admin sessions.

Inside the Worker, the panel verifies the `Cf-Access-Jwt-Assertion`
header against the JWKS published at
`https://<your-team>.cloudflareaccess.com/cdn-cgi/access/certs`. The
AUD tag from the application setup is what the Worker checks against
the JWT's `aud` claim — set it as `CF_ACCESS_AUD` in
`apps/panel/wrangler.local.jsonc` and redeploy.

## 4. Service tokens for daemons

Daemons that need to reach the admin API behind Access (e.g. a custom
data-export job, a CI runner that mints synthetic credentials)
authenticate with a **Cloudflare Access service token**. Mint one per
caller — never share.

In the Zero Trust dashboard, **Access → Service Auth → Service Tokens
→ Create Service Token**:

- Token name: `polaris-export-job` (one per caller)
- Duration: e.g. 1 year

Cloudflare prints the **Client ID** and **Client Secret** once; save
both immediately. Then add a non-identity policy to the panel
application (or a separate Access app) with:

- Decision: **Service Auth**
- Include rule: **Service Token = polaris-export-job**

The caller presents the token's `CF-Access-Client-Id` and
`CF-Access-Client-Secret` headers on every request; Access validates
them before the request reaches the Worker. **Inside** the Worker, the
API still requires its own HMAC signature — Access only gates _who can
knock_; polaris-email's HMAC auth is what actually authorises the
action.

This compounds nicely: a stolen service token is useless without an
HMAC key, and a stolen HMAC key is useless against the admin endpoints
(which sit behind Access) without a service token.

Rotation: rotate the service token from the same dashboard surface.
The old credentials revoke immediately when you generate the new pair.

## 5. Group-based role sync via the OIDC groups claim

Inside the Worker, better-auth's `databaseHooks.user.create.after`
and `databaseHooks.session.create.after` hooks call
[`syncRolesFromUserInfo` / `syncRolesForUserId`](https://github.com/vladzaharia/polaris-email/blob/main/apps/panel/src/server/auth/role-sync.ts).
The flow:

1. Extract the `groups` claim from either the OIDC userinfo response
   or the decoded id_token JWT payload.
2. Check whether `env.OIDC_ADMIN_GROUP` (default `polaris-admins`) appears
   in the list.
3. Write the boolean to the `user.admin` column in D1.

Every sign-in re-evaluates group membership. **Demotions take effect
on the next login**, not retroactively on the current session — if
you need to revoke a session immediately, delete the row from the
`session` table (or have the user sign out).

Configure `OIDC_ADMIN_GROUP` per environment in the panel's
`wrangler.local.jsonc` (committed default in
`wrangler.jsonc` is `polaris-admins`):

```jsonc
{
  "vars": {
    "OIDC_ADMIN_GROUP": "polaris-admins",
  },
}
```

The same wrangler vars surface in
[`apps/panel/README.md`](https://github.com/vladzaharia/polaris-email/blob/main/apps/panel/README.md)
under "Environment".

### Multi-tier roles

The panel ships with a single `admin` bool. If you need a more
granular role model:

- Add columns to the `user` table (D1 migration in
  `apps/panel/migrations/`).
- Extend `syncRolesFromGroups` in
  [`apps/panel/src/server/auth/role-sync.ts`](https://github.com/vladzaharia/polaris-email/blob/main/apps/panel/src/server/auth/role-sync.ts)
  to read additional group names and set the new columns.
- Read the new columns in the panel's middleware
  (`apps/panel/src/server/auth/middleware.ts`).

This is a deliberate v1 choice — most polaris-email deployments have
one operator wearing all the hats. Don't grow the role model until
you have a concrete second hat.

## Verifying the wiring

After saving the application and redeploying the panel Worker:

1. Open the panel URL in a private window. Expect the Access login
   page, then your IdP's sign-in flow, then (if WebAuthn step-up is
   on) the hardware-key prompt, then better-auth's OIDC bounce,
   then the panel dashboard.
2. Tail the panel Worker: `wrangler tail polaris-email-panel --status error`.
   A misconfigured `OIDC_REDIRECT_URL` shows up here immediately.
3. Sign in as a non-admin. The panel should accept the session but
   refuse to render any admin route (every admin route runs the
   `requireAdmin(OIDC_ADMIN_GROUP)` middleware).
4. Service-token check: `curl -H 'CF-Access-Client-Id: …' -H 'CF-Access-Client-Secret: …' https://<panel-host>/api/healthz`
   should return `200 ok`. Drop the headers, expect a redirect to
   the Access login page.

If any of those misbehave, the
[panel auth loops row in the troubleshooting matrix](/operators/troubleshooting/decision-matrix)
covers the common failures.

<!-- Verified against: apps/panel/src/server/auth/role-sync.ts, services/api/src/auth.ts @ eeee222cdf8359f8f2bf1013a103abdb3c705f06 -->
