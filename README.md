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
`wrangler.local.jsonc` with real D1/R2/KV/Queue IDs. `bin/deploy.sh` merges the two before
`wrangler deploy`.

## Bootstrap a fresh install

```sh
bin/bootstrap.sh
```

Idempotent. Creates D1/R2/KV/Queues, deploys Workers, seeds the first admin key (revealed once
via a WebAuthn-gated URL), prints the DNS records and `tailscale cert` invocation needed.

## Security

See `SECURITY.md` for the threat model and `RUNBOOKS/cf-account-compromise.md` for the kill switch.
