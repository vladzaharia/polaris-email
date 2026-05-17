---
title: Custom domains
description: The public hostnames polaris-email serves on — R2 attachment domain, panel, API, docs, and the per-tenant MTA-STS Workers custom domains. Where each one is configured and which scopes it needs.
sidebar_label: Custom domains
sidebar_position: 3
---

# Custom domains

polaris-email exposes its surfaces on Cloudflare custom hostnames rather
than the default `*.workers.dev` URLs. This page lists the hostnames the
control plane uses, which Worker each one fronts, and how the configuration
is split between Terraform and wrangler.

The cold-start does **not** provision custom hostnames — it deploys
Workers on `*.workers.dev` so the smoke test can pass. Pointing the
production hostnames at the deployed Workers is a follow-up step.

## Hostname inventory

| Hostname (default)      | Worker / target          | Owner       | Required? |
| ----------------------- | ------------------------ | ----------- | --------- |
| `r2.mail.plrs.im`       | R2 bucket `polaris-email` | Terraform   | Yes       |
| `polaris-email-api.workers.dev` (or your custom API host) | `polaris-email-api` | Wrangler    | Yes       |
| `panel.mail.plrs.im` (or your panel host) | `polaris-email-panel` | Wrangler    | Optional  |
| `docs.mail.plrs.im`     | `polaris-email-docs`     | Wrangler    | Optional  |
| `mta-sts.<tenant>`      | `polaris-email-api`      | Per-domain admin endpoint | Per onboarded domain |

## R2 public domain (`r2.mail.plrs.im`)

Message bodies and per-attachment R2 objects are served from a **public**
Cloudflare custom hostname pointed at the `polaris-email` R2 bucket.
Object keys are content-addressed (`mime/<aa>/<bb>/<sha256>` for bodies,
`att/<sha256>/<filename>` for attachments), so the SHA-256 in the URL
provides the unguessability boundary — there is no signature, no expiry,
no HMAC header.

The hostname is referenced by `services/api` via the `R2_PUBLIC_HOST`
var (default `r2.mail.plrs.im`). Override it in
`services/api/wrangler.local.jsonc` if you serve attachments under a
different domain.

This domain is **intentionally unauthenticated**. The privacy implication
is that a polaris-email URL **is** a capability token — anyone with the
URL can read the bytes forever. Read the
[threat model](/security/threat-model) before placing a CDN, signing
layer, or authenticated proxy in front of it.

Terraform under `infra/terraform/` owns the DNS record and the R2 custom
hostname binding.

## API and panel hostnames

Both Workers ship with route placeholders that are off by default. To
front them on a custom hostname:

1. Add the zone to Cloudflare DNS (typically already done as part of the
   Email Routing onboarding).
2. Set the `routes` field in `services/api/wrangler.local.jsonc` or
   `apps/panel/wrangler.local.jsonc`. The committed `wrangler.jsonc`
   carries an example like:

   ```jsonc
   "routes": [
     { "pattern": "api.polaris.example.com/panel/*", "zone_name": "polaris.example.com" }
   ]
   ```

3. Redeploy the Worker (`make deploy SERVICE=services/api` or
   `SERVICE=apps/panel`).

In CI, the production hostname lands via the
`POLARIS_API_HOSTNAME` repo variable consumed by `.env.deploy`.

## Docs hostname (`docs.mail.plrs.im`)

The docs Worker (`apps/docs`) mirrors the panel layout — Hono server,
Docusaurus static build served through the `ASSETS` binding. Its route
placeholder is in `apps/docs/wrangler.jsonc`; set the real value in
`apps/docs/wrangler.local.jsonc`:

```jsonc
"routes": [{ "pattern": "docs.mail.plrs.im/*", "zone_name": "mail.plrs.im" }]
```

## MTA-STS Workers custom domains (per onboarded domain)

When you enable MTA-STS for an onboarded domain via
`POST /v1/admin/domains/:id/mta-sts/enable`, the control plane creates
**three** records — two DNS rows and one Workers custom hostname:

1. DNS `TXT` at `_mta-sts.{tenant}` → `v=STSv1; id={policyId}`
2. Workers custom domain `mta-sts.{tenant}` → `polaris-email-api` —
   serves the policy body at
   `https://mta-sts.{tenant}/.well-known/mta-sts.txt`.
3. DNS `TXT` at `_smtp._tls.{tenant}` → `v=TLSRPTv1; rua=mailto:tlsrpt@plrs.im`

The `polaris-email` CLI / admin endpoints handle this automatically per
domain. The Workers custom domain in (2) reuses the `polaris-email-api`
Worker; you do not register a separate Worker per tenant. Cloudflare
issues and renews the TLS cert for each `mta-sts.{tenant}` hostname on
its own.

`bin/backfill-mta-sts.sh` enables MTA-STS + TLS-RPT across every
verified, inbound-enabled domain in one pass. Idempotent.

## Terraform vs. wrangler

The infrastructure-as-code split runs along a deploy-cadence boundary:

- **Terraform** (`infra/terraform/`) owns the slow-moving, state-shaped
  Cloudflare resources inside the polaris-prod account — DNS, Email
  Routing, Email Service onboarding, Cloudflare Access apps, and the
  R2 public custom-domain wiring.
- **Wrangler** (each `services/*/wrangler.jsonc` and
  `apps/*/wrangler.jsonc`) owns the code-velocity resources within the
  same account: Workers, D1, KV, R2 buckets, Queues, and any per-Worker
  custom-domain routes.

The two never overlap, and the API tokens that drive each pipeline are
scoped so they cannot. See
[`infra/terraform/README.md`](https://github.com/polaris/polaris-email/blob/main/infra/terraform/README.md)
for the full inventory and the drift policy.

## Routine redeploy

Once hostnames are pointed at the Workers, day-to-day deploys do not
need to touch DNS or the route config. The preferred path after the
initial bootstrap is the changed-only deploy:

```sh
make deploy-changed
```

`bin/deploy.sh --changed` computes
`git diff --name-only $(deployed/main)..HEAD`, maps:

- files under `services/<svc>/...` → deploy that service
- files under `packages/<pkg>/...` → look up which services import
  `<pkg>` (via every `services/*/package.json`'s workspace deps) and
  deploy them transitively
- changes to `bin/`, `Makefile`, `.env.deploy` → no Worker redeploy

On success, the new HEAD SHA is written to `.deploy-state.last-sha` and
(in CI) the `deployed/main` tag is moved.

To force-deploy everything: `make deploy-all`. To redeploy a single
service: `make deploy SERVICE=services/api`.

## Rollback

```sh
make rollback SERVICE=api
```

Runs `wrangler rollback` inside `services/<svc>`. Cloudflare tracks the
previous version ID; `.deploy-state.json` also records the last
deployed version per service for human reference. After rollback,
re-run `make smoke` to confirm.

## CI

`.github/workflows/deploy.yml` runs `make deploy-changed` + `make smoke`
after the `ci` workflow succeeds on `main`, then moves the
`deployed/main` tag. Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN` — same scopes as
  [prerequisites](/operators/deployment/prerequisites).
- `CF_ACCOUNT_ID`
- `DEPLOY_STATE_JSON` — contents of `.deploy-state.json`.
- `BOOTSTRAP_OUTPUT_JSON` — contents of `.bootstrap-output.json`.

Repo variables (non-secret): `POLARIS_API_HOSTNAME`, `ALERT_WEBHOOK`.

Workflow-dispatch with `all=true` forces `make deploy-all` instead of
`--changed`.

<!-- Verified against: docs/deploy.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
