# Polaris Terraform

Cross-account Cloudflare resources for Polaris: DNS, Email Routing rules,
Email Service onboarding, Cloudflare Access apps, and the audit-anchor R2
bucket. This directory deliberately does NOT manage Workers, D1, KV, R2 (in
prod), Queues, or Durable Objects — those live in Wrangler configs in
`apps/*/wrangler.jsonc`. See `infra/README.md` for the rationale behind the
split.

## Layout

```
infra/terraform/
  versions.tf            # provider pinning (cloudflare ~> 4.52)
  variables.tf           # canonical variable declarations
  providers.tf           # three aliased providers (prod / anchors / staging)
  backend.tf             # R2-backed remote state (S3-compatible)
  modules/
    zone/                # per-zone DNS + Email Routing + Email Service
    access-app/          # CF Access self-hosted app + WebAuthn-step-up policy
  envs/
    prod/                # composition for `polaris-prod`
    staging/             # composition for `polaris-staging`
    anchors/             # composition for `polaris-anchors` (R2 only)
```

## Workspaces / accounts

We run three independent Terraform compositions, one per Cloudflare account.
They are _not_ Terraform CLI workspaces — they're separate root modules under
`envs/`. Each has its own state file in the shared R2 backend bucket.

| Env       | Cloudflare account | Owns                                                                |
| --------- | ------------------ | ------------------------------------------------------------------- |
| `prod`    | `polaris-prod`     | All sender/recipient zones, Access apps for admin + `/v1/send/raw`. |
| `staging` | `polaris-staging`  | Mirror of prod for staging tenants.                                 |
| `anchors` | `polaris-anchors`  | Audit-anchor R2 bucket, compliance-locked.                          |

## Why Terraform here, Wrangler there

Cloudflare resources split cleanly by deploy cadence and drift posture:

- **Wrangler-managed (Workers/D1/KV/R2/Queues/DOs)**: redeployed every commit,
  rolled back via `wrangler rollback`, schema migrations applied by app code.
  These move at code velocity. Terraform would fight the deploy pipeline.
- **Terraform-managed (DNS/Email Routing/Email Service/Access)**: rarely
  change, span multiple accounts, and have drift consequences (a wrong MX
  record drops mail; a wrong Access policy locks ops out). They want
  `plan`/`apply` review and shared state.

The boundary is reinforced by token scoping: the Wrangler CI token cannot
edit zones; the Terraform token cannot deploy Workers.

## Bootstrap

1. **Create the state bucket** in `polaris-prod`:

   ```sh
   wrangler r2 bucket create polaris-tfstate --location ENAM
   ```

   Enable versioning (Cloudflare dashboard → R2 → polaris-tfstate → Settings).
   Do NOT use the `polaris-anchors` account for state — it's compliance-locked.

2. **Mint scoped API tokens.** One token per env if practical; minimum scopes:
   - prod token: `Zone:Edit` + `Account.Email Routing:Edit` + `Account.Access:Edit` on `polaris-prod`.
   - staging token: same scopes on `polaris-staging`.
   - anchors token: `Account.R2:Edit` on `polaris-anchors`.
     Plus an R2 access key (id + secret) on `polaris-prod` scoped to the
     `polaris-tfstate` bucket only — used by the s3 backend.

3. **Set environment variables** before running terraform:

   ```sh
   export CLOUDFLARE_API_TOKEN=...
   export TF_VAR_cloudflare_api_token=$CLOUDFLARE_API_TOKEN
   export TF_VAR_cloudflare_account_id_prod=...
   export TF_VAR_cloudflare_account_id_staging=...
   export TF_VAR_cloudflare_account_id_anchors=...
   export AWS_ACCESS_KEY_ID=<R2 access key id>
   export AWS_SECRET_ACCESS_KEY=<R2 access key secret>
   ```

4. **Init each env** with backend overrides (the `bucket`/`key`/`endpoints`
   values are intentionally left out of `backend.tf` so they're explicit at
   bootstrap time):

   ```sh
   terraform -chdir=infra/terraform/envs/prod init \
     -backend-config=bucket=polaris-tfstate \
     -backend-config=key=prod/terraform.tfstate \
     -backend-config=region=auto \
     -backend-config=endpoints='{"s3":"https://<PROD_ACCOUNT_ID>.r2.cloudflarestorage.com"}'
   ```

   Repeat with `key=staging/...` and `key=anchors/...` for the other envs.

5. **Plan before apply**, always:
   ```sh
   terraform -chdir=infra/terraform/envs/prod plan -out=prod.tfplan
   terraform -chdir=infra/terraform/envs/prod apply prod.tfplan
   ```

## Drift policy

**Dashboard changes are forbidden.** Anything Terraform manages MUST be
changed via a PR that updates this directory and goes through `plan` review.
Specifically:

- Adding/removing a zone? Edit `envs/<env>/main.tf`.
- Tweaking DKIM selectors / DMARC policy? Edit the zone module call.
- Changing Access policies? Edit `modules/access-app` consumers.

CI runs `terraform plan` on every PR against `main` and posts the diff. If
`plan` shows changes that the PR didn't intend (because someone clicked
something in the dashboard), revert the dashboard change rather than
absorbing it into terraform.

`terraform plan` is the source of truth.

## What's deliberately TODO for the operator

The scaffold leaves the following unfilled because they're operator-specific
and/or depend on Cloudflare API surface that's still in flux as of writing:

1. **Account IDs** (`TF_VAR_cloudflare_account_id_prod` etc.) — set per
   operator's CF org structure.
2. **R2 backend bucket coordinates** — the `bucket` / `key` / `endpoints`
   values are commented placeholders; pass via `-backend-config=` at init.
3. **IdP IDs** (`identity_provider_ids` in access-app calls) — fetch from
   the CF Access dashboard or via `cloudflare_access_identity_provider`
   data source after the operator configures their WebAuthn/OIDC IdP.
4. **DKIM CNAME targets** (`dkim_cname_target` in zone module) — Cloudflare
   Email Service mints these per-domain after onboarding. Onboard one
   domain manually first to learn the format, then wire it back here.
5. **Email Service onboarding API call** — there is no first-class
   `cloudflare_email_service_domain` resource in provider 4.x. The zone
   module includes a `null_resource` placeholder. Replace the placeholder
   `local-exec` with a real curl call once the API surface is finalized,
   or remove the `null_resource` once a real provider resource exists.
6. **R2 bucket lock + lifecycle** for `anchors` — provider resources for
   object lock are still landing. Configure via Wrangler CLI for now.
7. **Worker handler reference** (`inbound_worker_name`) — defaults to
   `polaris-in`. Confirm the actual deployed name in `apps/in/wrangler.jsonc`
   and update the module call if it differs.
8. **Initial zone import** — if the operator already has zones with
   hand-rolled DNS records, run `terraform import cloudflare_record.<name>
<zone_id>/<record_id>` for each before the first apply, or terraform
   will create duplicates.

## Provider version notes

We pin `cloudflare/cloudflare ~> 4.52`. The 5.x rewrite is available but
many resources we depend on (`cloudflare_email_routing_*`,
`cloudflare_access_application`/`policy`) underwent rename/refactor in v5
that's still settling. Migrate in a dedicated PR once the v5 surface
stabilizes.

If the provider gains a `cloudflare_email_service_domain` (or similar)
resource, replace the `null_resource.email_service_onboard` block in
`modules/zone/main.tf` with the real resource and bump the version pin.
