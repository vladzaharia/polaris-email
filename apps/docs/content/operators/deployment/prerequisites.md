---
title: Deployment prerequisites
description: The Cloudflare scopes and local tooling you need before running the polaris-email cold-start.
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

## Manual setup before cold-start

`polaris-email setup infra` provisions everything account-scoped (D1,
R2 buckets + lifecycle + Object Lock, KV, queues, Logpush, R2 tokens,
and the R2 public custom-domain binding). A few resources sit outside
that scope and require manual setup once per environment:

- **The Cloudflare zone(s)** that you'll send/receive mail through must
  already exist under your CF account, with their nameservers delegated
  from the registrar. The cold-start does not create or delegate zones.
- **Cloudflare Access** for the admin panel is configured manually in
  the Zero Trust dashboard. See
  [Cloudflare Access setup](./cloudflare-access.md).

Per-domain DNS records (MX, SPF, DKIM, DMARC) + Email Routing rules +
Email Service onboarding all happen later, automatically, when you
onboard each domain via `polaris-email domain onboard <name>` (which
calls `POST /v1/admin/domains` → `packages/cf-api/`).

<!-- Verified against: docs/deploy.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
