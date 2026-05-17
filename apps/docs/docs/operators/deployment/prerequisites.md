---
title: Deployment prerequisites
description: The Cloudflare scopes, off-platform accounts, and local tooling you need before running the polaris-email cold-start.
sidebar_label: Prerequisites
sidebar_position: 1
---

# Deployment prerequisites

This page lists what has to exist **before** you run the cold-start. The
target is a release engineer with shell access on a workstation, the
Cloudflare account, and the target DNS zone in hand. If everything below
is in place, you are roughly 15 minutes from a clean clone to a green
smoke.

For day-to-day operator workflows (issue API keys, onboard domains,
register bridges, replay webhook DLQ entries) jump to the
[on-call runbook](/operators/runbooks) and the
[polaris-email CLI](/reference/cli) — none of those depend on this page
once the cold-start has run.

## Cloudflare account

You need a Cloudflare account with an API token that holds these scopes:

- Account → **Workers** → Edit
- Account → **D1** → Edit
- Account → **R2** → Edit
- Account → **Queues** → Edit
- Account → **Workers KV** → Edit
- Account → **Email Routing** → Edit
- Account → **Workers Email Sending** → Edit
- Account → **Zone** → Read (account-wide)
- Zone → **Zone** → Edit
- Zone → **DNS** → Edit

The account-wide `Zone: Read` is required by the panel's `/cf-zones`
discover view, which lists every zone in the account and inspects each
one's Email Routing and sender state. The older "Email Routing on a
specific zone" scope is no longer sufficient.

You also need at least one domain on Cloudflare DNS for inbound mail.

## OIDC provider (optional)

The admin panel (`apps/panel`) authenticates operators via better-auth +
generic OIDC. Cloudflare Access is the default and recommended IdP. If
you want the panel, mint a client up-front and capture:

- `OIDC_ISSUER`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`

Leave them blank during `polaris-email setup infra configure` to skip
the panel — the API and the CLI still work without it.

## Backblaze B2 anchor target (required)

Audit anchors live **off Cloudflare**. The hourly cron in `services/api`
signs each anchor and pushes it to a Backblaze B2 bucket with
**Object Lock COMPLIANCE mode** and ~7-year retention. A fully
compromised Cloudflare account can stop new anchors from being written
(denial of service) but cannot rewrite history, because the B2
write-only Application Key lives outside Cloudflare.

Before bootstrapping, create:

- The B2 bucket itself with Object Lock COMPLIANCE enabled and the
  retention window set to 7 years.
- A **write-only** Application Key scoped to that bucket
  (`writeFiles` only — no `listFiles`, `readFiles`, `deleteFiles`, or
  `bypassGovernance`).

Capture these values; bootstrap refuses to deploy `services/api`
without them:

- `ANCHOR_S3_ENDPOINT`
- `ANCHOR_S3_BUCKET`
- `ANCHOR_S3_REGION`
- `ANCHOR_S3_ACCESS_KEY_ID`
- `ANCHOR_S3_SECRET_ACCESS_KEY`

Step-by-step setup lives in [`infra/terraform/README.md`](https://github.com/polaris/polaris-email/blob/main/infra/terraform/README.md)
under "Audit anchors are NOT on Cloudflare". See also the
[threat model](/security/threat-model) for the integrity properties this
arrangement provides.

## Local tooling

Install on the workstation that will run the cold-start:

- `git`
- `pnpm` ≥ 9 (`corepack enable && corepack prepare pnpm@9 --activate`)
- `wrangler` (installed transitively by `pnpm install`)
- `jq`
- `openssl`
- `curl`
- `go` ≥ 1.22

You also need the **`polaris-email` Go CLI** on `$PATH`. Pick one of:

- `go install github.com/vladzaharia/polaris-email/apps/polaris-cli/cmd/polaris-email@latest`
- `brew install vladzaharia/tap/polaris-email`
- Grab a release binary from the GitHub releases page.

The CLI is the entire operator surface: cold-start, deploy, rollback,
smoke, and every day-2 workflow live in `polaris-email setup infra` and
the other `polaris-email` subcommands.

## Validate

Run these two commands. `polaris-email setup infra preflight` is a hard
gate; each failing check prints its remediation on the next line.

```sh
wrangler login
polaris-email setup infra preflight
```

When `preflight` is green you are ready to start the
[cold-start bootstrap](/operators/deployment/cold-start-bootstrap).

## Terraform sequencing (optional but recommended)

The cold-start CLI (`polaris-email setup infra`) makes the minimum
Cloudflare API calls needed to spin up Workers, D1, KV, R2, and Queues.
It is **not** the same surface as `infra/terraform/`, which manages the
slow-moving, state-shaped resources inside the same account:

- DNS records
- Email Routing rules
- Email Service onboarding
- Cloudflare Access apps
- The R2 public custom domain (`r2.mail.plrs.im`)

For a first-time cold start on a new account, run Terraform **before**
the cold-start so the zone-level resources exist:

```sh
cd infra/terraform/envs/prod
terraform init
terraform apply
cd -
```

Existing operators who manage zone resources by hand can skip Terraform;
the rest of the cold-start does not depend on it. See
[`infra/terraform/README.md`](https://github.com/polaris/polaris-email/blob/main/infra/terraform/README.md)
for the full Terraform-managed vs. Wrangler-managed split.

<!-- Verified against: docs/deploy.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
