# polaris-email

Managed email service for the `polaris-*` family. One HMAC REST contract for outbound,
signed webhooks for inbound, an on-prem SMTPS submission daemon for legacy clients, and a
managed admin panel for tenants, API keys, routing rules, secrets, and operations.

## Architecture

Cloudflare Workers (control plane):

- `services/api` — REST surface, admin API, audit chain, idempotency, key auth.
- `services/out` — outbound queue consumer that drives the chosen Provider (Cloudflare
  `send_email`, Postmark, SES, etc. — see `packages/providers`).
- `services/in` — Email Routing handler that parses inbound MIME and dispatches to fanout.
- `services/fanout` — signed-webhook delivery (external, tailnet, retry/DLQ).
- `services/forensic` — isolated Worker holding the recipient AEAD key.
- `services/synthetic` — cron end-to-end health probe.
- `services/janitor` — cron retention enforcer.
- `services/staleness` — cron control-plane secret-age checker.
- `services/anchor` — cron audit hash-chain anchor publisher.

On-prem (per host):

- `apps/submission-daemon` — Go SMTPS daemon (implicit TLS on :465) that authenticates
  clients against a SQLite credential mirror and forwards canonicalised RFC 5322 to
  `/v1/send/raw`. Replaces the previous Mox bridge. See `apps/submission-daemon/README.md`.

Operator tooling:

- `apps/polaris-cli` — Go CLI (`polaris-email`, aliased `pml`) for tenants, domains,
  routes, credentials, daemons, webhooks, audit, cost, bootstrap. See
  `apps/polaris-cli/README.md`.
- `apps/panel` — Hono + React admin UI.

Shared packages:

- `packages/hmac`, `packages/schema`, `packages/test-vectors` — signing primitives + types.
- `packages/webhook-verify-{node,go,python}` — consumer-facing verifier libs.
- `packages/mime` — canonicalisation + sender-policy + IDNA address normalisation.
- `packages/providers` — Provider interface + Cloudflare/Postmark/SES adapters.
- `packages/cf-api` — Cloudflare API wrapper (zones, DNS, Email Routing/Service, DKIM).
- `packages/crypto-utils` — pepper, timing-safe compare, argon2-deferred helpers.
- `packages/migrations` — D1 migration runner.
- `packages/observability` — structured logger, analytics, tracing.
- `packages/revocation-do` — revocation Durable Object.
- `packages/url-guard` — SSRF guard.

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

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for the ordered runbook and
[`docs/OPERATOR.md`](docs/OPERATOR.md) for day-to-day workflows.

```sh
make preflight      # verify required tools and env
make configure      # write .env.deploy interactively
make bootstrap      # cold-start: create CF resources, deploy, mint admin key
make smoke          # end-to-end health probe
make deploy-changed # deploy only services whose code (or deps) changed
make rollback SERVICE=api
```

Operator workflows that previously lived in `bin/*.sh` (issue-key, register-consumer,
onboard, rotate-secret, sync-bindings, …) are migrating to the `polaris-email` CLI;
see `apps/polaris-cli/README.md` for the current subcommand tree.

## Status

The codebase is mid-migration from the legacy single-service-per-Worker layout to a
modular monolith. `docs/PROGRESS.md` tracks phase-by-phase status; legacy and v1
endpoints run side-by-side until each cutover is verified.

## Security

See [`SECURITY.md`](SECURITY.md) for the threat model,
[`RUNBOOKS/cf-account-compromise.md`](RUNBOOKS/cf-account-compromise.md) for the kill
switch, and [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for incident response.
