# polaris-email

Managed email service for the `polaris-*` family. One HMAC REST contract for outbound,
signed webhooks for inbound, an on-prem SMTPS submission daemon for legacy SMTP/IMAP
clients, and a managed admin panel for tenants, API keys, routing rules, secrets, and
operations.

## Architecture

Cloudflare Workers (control plane):

- `services/api` — REST surface, admin API, audit chain, idempotency, key auth, hosts
  the revocation Durable Object.
- `services/out` — outbound queue consumer that drives the chosen Provider (Cloudflare
  `send_email` per-domain bindings — see `packages/providers`).
- `services/in` — Email Routing handler that parses inbound MIME and dispatches to fanout.
- `services/fanout` — signed-webhook delivery (external, tailnet, retry/DLQ).
- `services/forensic` — isolated Worker holding the recipient AEAD key.
- `services/cron` — one Worker with four cron triggers: hourly audit anchor, weekly
  control-plane secret staleness check, per-minute `/healthz` synthetic, nightly
  retention janitor.

On-prem (per host):

- `apps/submission-daemon` — Go SMTPS daemon (implicit TLS on :465) that authenticates
  clients against a SQLite credential mirror and forwards canonicalised RFC 5322 to
  `/v1/send/raw`. See `apps/submission-daemon/README.md`.

Operator tooling:

- `apps/polaris-cli` — Go CLI (`polaris-email`, aliased `pml`) for tenants, domains,
  zones, routes, credentials, daemons, webhooks, audit, status, bootstrap. See
  `apps/polaris-cli/README.md`.
- `apps/panel` — Hono + React admin UI.

Shared packages:

- `packages/hmac`, `packages/schema`, `packages/test-vectors` — signing primitives + types.
- `packages/webhook-verify-{node,go,python}` — consumer-facing verifier libs.
- `packages/ids` — ULID + request-id generator (shared between services).
- `packages/mime` — canonicalisation + sender-policy + IDNA address normalisation.
- `packages/providers` — Provider interface + Cloudflare adapter.
- `packages/cf-api` — Cloudflare API wrapper (zones, DNS, Email Routing/Service, DKIM).
- `packages/migrations` — D1 migration runner.
- `packages/revocation-do` — revocation Durable Object class (bound by `services/api`).

Infrastructure: `infra/terraform/` defines zone + access-app modules and per-environment
roots (staging / prod / anchors).

## Local development

```sh
pnpm install
pnpm -r test
pnpm -r build

# Go modules
(cd apps/submission-daemon && go test ./... && go build ./...)
(cd apps/polaris-cli       && go vet ./... && go build ./...)
```

Each Worker has a `wrangler.jsonc` (committed, placeholder IDs) and expects a gitignored
`wrangler.local.jsonc` with real D1/R2/KV/Queue IDs. Those are generated from
`services/*/wrangler.local.template.jsonc` + `.deploy-state.json` by
`bin/render-wrangler-local.sh`; `bin/deploy.sh` then merges the public + local configs
before `wrangler deploy`. Do not hand-edit the materialised files.

## Quick start

See [`docs/OPERATOR.md`](docs/OPERATOR.md) for day-to-day workflows. The cold-start
bootstrap + infra runbook lives in [`docs/DEPLOY.md`](docs/DEPLOY.md).

```sh
make preflight      # verify required tools and env
make configure      # write .env.deploy interactively
make bootstrap      # cold-start: create CF resources, deploy, mint admin key
make smoke          # end-to-end health probe
make deploy-changed # deploy only services whose code (or deps) changed
make rollback SERVICE=api
```

Day-to-day operator workflows (issue api keys, onboard domains, register daemons,
rotate credentials, replay webhook DLQ entries, …) run through the `polaris-email`
CLI — see `apps/polaris-cli/README.md` for the subcommand tree.

## Security

See [`SECURITY.md`](SECURITY.md) for the threat model,
[`RUNBOOKS/cf-account-compromise.md`](RUNBOOKS/cf-account-compromise.md) for the kill
switch, and [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for incident response.
