# polaris-email

Managed email service for the `polaris-*` family. One HMAC REST contract for outbound,
SMTPS/IMAP/JMAP on the Tailnet for legacy clients, signed webhooks for inbound, and a
managed admin panel for mailboxes, API keys, routing rules, secrets, and operations.

## Architecture

- `services/api` — control plane Cloudflare Worker. REST surface, admin API, audit chain.
- `services/out` — outbound queue consumer Worker that calls `send_email` bindings.
- `services/in` — Email Routing handler Worker that parses inbound MIME.
- `services/fanout` — signed-webhook delivery Worker.
- `services/forensic` — isolated Worker that holds the recipient AEAD key.
- `services/synthetic` — Cron-Triggered end-to-end health Worker.
- `services/janitor` — Cron-Triggered retention enforcer.
- `services/staleness` — Cron-Triggered control-plane secret age checker.
- `services/anchor` — Cron-Triggered audit hash-chain anchor publisher.
- `apps/bridge` — singleton Mox + sidecar + Tailscale Docker container (SMTPS/IMAP/JMAP/webhook proxy).
- `apps/panel` — Hono + React admin UI behind OIDC + WebAuthn step-up.
- `packages/hmac`, `packages/schema`, `packages/test-vectors` — shared.
- `packages/webhook-verify-node|go|python` — consumer-facing verifier libs.

See `/Users/vlad/.claude/plans/now-that-cloudflare-supports-snoopy-squid.md` for the full design,
and `RUNBOOKS/` for operational procedures.

## Local development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Each Worker has a `wrangler.jsonc` (committed, placeholder IDs) and expects a gitignored
`wrangler.local.jsonc` with real D1/R2/KV/Queue IDs. Those are generated automatically from
`services/*/wrangler.local.template.jsonc` + `.deploy-state.json` by
`bin/render-wrangler-local.sh`; `bin/deploy.sh` then merges the public + local configs before
`wrangler deploy`. Do not hand-edit the materialized files.

## Quick start

The full deploy flow is wrapped behind a single Makefile. See [`docs/DEPLOY.md`](docs/DEPLOY.md)
for the ordered runbook.

```sh
make preflight       # check tools + auth
make configure       # write .env.deploy interactively
make bootstrap       # cold-start: create CF resources, deploy, mint admin key
make dns DOMAIN=…    # print DNS records to add
make bridge-up       # (optional) bring up the Mox+sidecar bridge on the Tailnet
make smoke           # end-to-end health probe
```

Routine redeploys after the cold-start:

```sh
make deploy-changed                     # only services whose code (or deps) changed
make rollback SERVICE=api               # revert one service to its previous version
make issue-key NAME=acme SCOPES=mail:send
make register-consumer NAME=acme WEBHOOK=https://… KIND=external EVENTS=delivered,bounced
```

## Security

See `SECURITY.md` for the threat model and `RUNBOOKS/cf-account-compromise.md` for the kill switch.
