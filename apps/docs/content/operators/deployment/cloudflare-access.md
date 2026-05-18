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

## 2. Wire the `access-app` Terraform module

The
[`infra/terraform/modules/access-app`](https://github.com/vladzaharia/polaris-email/tree/main/infra/terraform/modules/access-app)
module wraps `cloudflare_access_application` and a single allow-by-email
policy. Reference it from a per-environment root:

```hcl
module "panel_access" {
  source = "../../modules/access-app"

  cf_account_id = var.cf_account_id
  cf_zone_id    = var.panel_zone_id

  app_name = "polaris-email-panel"
  domain   = "panel.example.com"

  # Keep short for an admin surface — the panel itself runs an
  # independent better-auth session, so a 1h Access session is plenty.
  session_duration = "1h"

  # Whitelist the IdP IDs from step 1. Fetch via the
  # cloudflare_access_identity_provider data source or copy from
  # the Access dashboard.
  identity_provider_ids = [
    var.idp_google_oidc_id,
    var.idp_github_oidc_id,
  ]

  # Comma-list of operator emails permitted through. Prefer
  # group-based policies once you've validated the IdP claim shape.
  allowed_emails = [
    "ops@example.com",
    "secops@example.com",
  ]

  # See §3 below. Defaults to true.
  require_webauthn_step_up = true
}
```

Inputs are declared in
[`variables.tf`](https://github.com/vladzaharia/polaris-email/blob/main/infra/terraform/modules/access-app/variables.tf):

| Variable                   | Required | Default | Purpose                                                                     |
| -------------------------- | -------- | ------- | --------------------------------------------------------------------------- |
| `cf_account_id`            | yes      | —       | Account hosting the Access app.                                             |
| `cf_zone_id`               | yes      | —       | Zone the app is bound to. Must be in the same account.                      |
| `app_name`                 | yes      | —       | Shown in the Access dashboard and on the login page.                        |
| `domain`                   | yes      | —       | Fully-qualified domain Access protects (e.g. `panel.example.com`).          |
| `session_duration`         | no       | `1h`    | Keep short for admin surfaces.                                              |
| `identity_provider_ids`    | yes      | —       | List of allowed IdP IDs.                                                    |
| `allowed_emails`           | no       | `[]`    | Email-based allow policy. Use sparingly; prefer group policies once stable. |
| `require_webauthn_step_up` | no       | `true`  | Adds an `auth_method = "swk"` require-block (see §3).                       |

Outputs:

| Output           | Purpose                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `application_id` | Used elsewhere to wire `cloudflare_access_service_token`.                   |
| `aud`            | The AUD claim. Workers verifying `Cf-Access-Jwt-Assertion` must match this. |
| `domain`         | Echoed for convenience.                                                     |

Apply with `terraform plan` → `terraform apply` per environment. The
panel hostname now redirects unauthenticated requests to the Access
login page; only post-auth traffic reaches the Worker.

## 3. WebAuthn step-up for sensitive actions

The module defaults `require_webauthn_step_up = true`, which adds a
`require { auth_method = "swk" }` block to the allow policy. `swk` is
the SAML AuthnContext URI for software-backed hardware keys; in
practice this means **YubiKey, Apple Touch ID, Windows Hello, or any
WebAuthn-capable authenticator** must be presented at session start.

Disable it (`require_webauthn_step_up = false`) only if you have a
specific operational reason — e.g. you're running an emergency
break-glass app in a separate environment where the WebAuthn ceremony
is itself the blocker.

:::warning Out of date
The panel's `apps/panel/README.md` still describes a server-side
`withApproval(action)` two-person co-sign for destructive actions.
That flow was removed — real deployments are single-operator, and
the second-admin co-sign was unusable. Destructive actions are now
gated **client-side** via `DestructiveActionDialog`
(type-the-resource-name confirmation) inside the panel; the
chained-hash `audit_log` table remains the canonical record of who did
what. WebAuthn step-up at the Access layer is the right place to
enforce hardware-key presence for admin sessions.
:::

Inside the Worker, the panel verifies the `Cf-Access-Jwt-Assertion`
header against the JWKS published at `https://<your-team>.cloudflareaccess.com/cdn-cgi/access/certs`.
The `aud` output above is what the Worker checks against the JWT's
`aud` claim — wire it in via a Terraform output → wrangler var so the
panel can validate end-to-end.

## 4. Service tokens for daemons

Daemons that need to reach the admin API behind Access (e.g. a
custom data-export job, a CI runner that mints synthetic credentials)
authenticate with a **Cloudflare Access service token**. Mint one per
caller — never share.

```hcl
resource "cloudflare_access_service_token" "exporter" {
  account_id = var.cf_account_id
  name       = "polaris-export-job"
}

resource "cloudflare_access_policy" "exporter_allow" {
  account_id     = var.cf_account_id
  zone_id        = var.panel_zone_id
  application_id = module.panel_access.application_id
  name           = "${module.panel_access.app_name}-svc-exporter"
  precedence     = 10
  decision       = "non_identity"

  include {
    service_token = [cloudflare_access_service_token.exporter.id]
  }
}
```

The `non_identity` decision lets a service token bypass the
human-identity policy. The caller presents the token's
`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers on every
request; Access validates them before the request reaches the
Worker. **Inside** the Worker, the API still requires its own HMAC
signature — Access only gates _who can knock_; polaris-email's HMAC
auth is what actually authorises the action.

This compounds nicely: a stolen service token is useless without an
HMAC key, and a stolen HMAC key is useless against the admin
endpoints (which sit behind Access) without a service token.

Rotation: regenerate the service token via Terraform (the resource
is replace-only on rotation) and push the new credentials to the
caller. Old token revokes immediately.

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

After `terraform apply`:

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

<!-- Verified against: infra/terraform/modules/access-app/main.tf, infra/terraform/modules/access-app/variables.tf, infra/terraform/modules/access-app/outputs.tf, apps/panel/README.md, apps/panel/src/server/auth/role-sync.ts, services/api/src/auth.ts @ eeee222cdf8359f8f2bf1013a103abdb3c705f06 -->
