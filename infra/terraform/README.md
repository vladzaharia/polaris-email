# Polaris Terraform

Cloudflare resources for Polaris: DNS, Email Routing rules, Email Service
onboarding, Cloudflare Access apps, and the R2 public-custom-domain wiring
for `r2.mail.plrs.im`. This directory deliberately does NOT manage Workers,
D1, KV, R2 buckets, Queues, or Durable Objects — those live in Wrangler
configs in `services/*/wrangler.jsonc` / `apps/*/wrangler.jsonc`. See
`infra/README.md` for the rationale behind the split.

## Layout

```
infra/terraform/
  versions.tf            # provider pinning (cloudflare ~> 4.52)
  variables.tf           # canonical variable declarations
  providers.tf           # single (un-aliased) Cloudflare provider
  backend.tf             # R2-backed remote state (S3-compatible)
  modules/
    zone/                # per-zone DNS + Email Routing + Email Service
    access-app/          # CF Access self-hosted app + WebAuthn-step-up policy
    r2-public/           # R2 bucket + custom-domain (r2.mail.plrs.im)
  envs/
    prod/                # composition for `polaris-prod` (the only env)
```

## Single-account topology

There is one Cloudflare account: **`polaris-prod`**. It owns every Polaris
runtime — Workers, D1, KV, R2, Queues, DNS, Email Routing, Email Service,
Access. The previous three-account layout (`polaris-staging`, `polaris-anchors`)
was retired in Phase O1: `polaris-staging` was an empty stub, and audit
anchors moved off-Cloudflare entirely to an external Object-Lock target (see
**Audit anchors** below).

## Audit anchors are NOT on Cloudflare

Hourly audit anchors are written to **Backblaze B2** with Object Lock
COMPLIANCE mode and a default 7-year retention. This is the integrity fence
for the single-account model: even a fully-compromised Cloudflare account
cannot rewrite history, because the B2 credentials live in the operator's
password vault (NOT as Cloudflare Workers Secrets) and the B2 Application
Key is scoped write-only to the anchor bucket.

Operator setup, once per deployment:

1. **Create a B2 bucket** with Object Lock enabled in COMPLIANCE mode and a
   default retention of 2555 days (7 years). Pick a region near the
   operator (default suggestion: `us-west-005`). Bucket files are NEVER
   served publicly — keep it private and skip the public-bucket option.
2. **Mint a B2 Application Key** scoped to that bucket only. Required
   capabilities: `writeFiles`, `listFiles` (latter is optional but useful
   for the verification step below). DO NOT grant `deleteFiles` — Object
   Lock would block deletes anyway, but principle of least authority.
3. **Capture the S3-compatible endpoint** B2 prints for the bucket. It will
   look like `https://s3.us-west-005.backblazeb2.com`. Note the region tag
   (the part after `s3.`) — that becomes `ANCHOR_S3_REGION`.
4. **Push the config to the Worker**:
   ```sh
   # Non-secret bindings live in services/api/wrangler.jsonc `vars`:
   #   ANCHOR_S3_ENDPOINT, ANCHOR_S3_BUCKET, ANCHOR_S3_REGION
   # The two secrets go through wrangler secret put:
   cd services/api
   wrangler secret put ANCHOR_S3_ACCESS_KEY_ID      # B2 keyID
   wrangler secret put ANCHOR_S3_SECRET_ACCESS_KEY  # B2 applicationKey
   ```
5. **Optional override**: the SigV4 signer accepts `ANCHOR_RETENTION_DAYS`
   as a `var` to bump or lower the per-object retain-until date. Default is
   2555 days; the B2 bucket's _default_ retention enforces the floor.

Backblaze B2 is the recommended target (cheapest, mature S3 Object Lock,
decoupled blast radius). AWS S3 and Wasabi work too — point
`ANCHOR_S3_ENDPOINT`/`ANCHOR_S3_REGION` at the right place and the same
SigV4 signer carries you through.

## Why Terraform here, Wrangler there

Cloudflare resources split cleanly by deploy cadence and drift posture:

- **Wrangler-managed (Workers/D1/KV/R2/Queues/DOs)**: redeployed every commit,
  rolled back via `wrangler rollback`, schema migrations applied by app code.
  These move at code velocity. Terraform would fight the deploy pipeline.
- **Terraform-managed (DNS/Email Routing/Email Service/Access/R2 custom domain)**:
  rarely change, and have drift consequences (a wrong MX record drops mail;
  a wrong Access policy locks ops out). They want `plan`/`apply` review and
  shared state.

The boundary is reinforced by token scoping: the Wrangler CI token cannot
edit zones; the Terraform token cannot deploy Workers.

## Bootstrap

1. **Create the state bucket** in `polaris-prod`:

   ```sh
   wrangler r2 bucket create polaris-tfstate --location ENAM
   ```

   Enable versioning (Cloudflare dashboard → R2 → polaris-tfstate → Settings).

2. **Mint a scoped API token.** Minimum scopes for the one prod token:
   - `Zone:Edit` on every Polaris-managed zone (DNS, Email Routing records).
   - `Account.Email Routing:Edit` on `polaris-prod`.
   - `Account.Access: Apps and Policies:Edit` on `polaris-prod`.
   - `Account:Read` on `polaris-prod`.

   Plus an R2 access key (id + secret) on `polaris-prod` scoped to the
   `polaris-tfstate` bucket only — used by the s3 backend for state storage.

3. **Set environment variables** before running terraform:

   ```sh
   export CLOUDFLARE_API_TOKEN=...
   export TF_VAR_cloudflare_api_token=$CLOUDFLARE_API_TOKEN
   export TF_VAR_cloudflare_account_id=...
   export AWS_ACCESS_KEY_ID=<R2 access key id>
   export AWS_SECRET_ACCESS_KEY=<R2 access key secret>
   ```

4. **Init the env** with backend overrides (the `bucket`/`key`/`endpoints`
   values are intentionally left out of `backend.tf` so they're explicit at
   bootstrap time):

   ```sh
   terraform -chdir=infra/terraform/envs/prod init \
     -backend-config=bucket=polaris-tfstate \
     -backend-config=key=prod/terraform.tfstate \
     -backend-config=region=auto \
     -backend-config=endpoints='{"s3":"https://<ACCOUNT_ID>.r2.cloudflarestorage.com"}'
   ```

5. **Plan before apply**, always:
   ```sh
   terraform -chdir=infra/terraform/envs/prod plan -out=prod.tfplan
   terraform -chdir=infra/terraform/envs/prod apply prod.tfplan
   ```

## Drift policy

**Dashboard changes are forbidden.** Anything Terraform manages MUST be
changed via a PR that updates this directory and goes through `plan` review.
Specifically:

- Adding/removing a zone? Edit `envs/prod/main.tf`.
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

1. **Account ID** (`TF_VAR_cloudflare_account_id`) — set per operator's CF
   org structure.
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
6. **Backblaze B2 anchor bucket** — provisioned out-of-band per the
   "Audit anchors are NOT on Cloudflare" section above. Not in Terraform
   because the B2 vendor relationship is intentionally separate from the
   CF account credentials and lifecycle.
7. **Worker handler reference** (`inbound_worker_name`) — defaults to
   `polaris-email-in` (matches `services/in/wrangler.jsonc`). Override only
   if you renamed the deployed Worker.
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
