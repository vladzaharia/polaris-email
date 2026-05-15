# polaris-email

Managed email service for the `polaris-*` family. One HMAC REST contract for
both inbound retrieval and outbound submission (unified `Message` model),
v2-envelope signed webhooks for inbound events, an on-prem Go mail bridge
(SMTPS + IMAP) for legacy clients, and a managed admin panel for
mailboxes, API keys, routing, secrets, and operations.

See [`docs/architecture.md`](docs/architecture.md) for the system view,
[`docs/messages.md`](docs/messages.md) for the data model, and
[`docs/sdk.md`](docs/sdk.md) for the three first-party SDKs.

## Architecture

Cloudflare Workers (control plane):

- `services/api` — REST surface, admin API, audit chain, idempotency, key auth, hosts
  the revocation Durable Object.
- `services/out` — outbound queue consumer that drives the chosen Provider (Cloudflare
  `send_email` per-domain bindings — see `packages/providers`).
- `services/in` — Email Routing handler that parses inbound MIME via the unified
  `processMessage` pipeline and dispatches to fanout.
- `services/fanout` — signed webhook delivery (external, tailnet, retry/DLQ). Uses
  the **v2 envelope** (`{event_id, event, occurred_at, message}` inlined; signed with
  `X-Polaris-Sig: v2=…`).
- `services/cron` — one Worker with four cron triggers: hourly audit anchor, weekly
  control-plane secret staleness check, per-minute `/healthz` synthetic, nightly
  retention janitor.

On-prem (per host):

- `apps/mail-bridge` — single Go binary serving SMTPS (:465) and IMAP4rev2 (:993).
  Renamed and absorbed from the old `apps/submission-daemon`. See
  `apps/mail-bridge/README.md` and [`docs/mail-bridge.md`](docs/mail-bridge.md).

  Two equally-supported deployment modes (neither is "the default"):
  - **Tailnet-fronted** — `tailscale/tailscale` sidecar; MagicDNS hostname; TLS via
    `tsnet.ListenTLS` (Lego ACME-DNS-01 fallback). Compose:
    `apps/mail-bridge/docker-compose.tailscale.yml`.
  - **Local / host-network** — the bridge binds 465/993/443 directly on the host;
    operator owns firewall + TLS termination. Compose:
    `apps/mail-bridge/docker-compose.local.yml`.

Operator tooling:

- `apps/polaris-cli` — Go CLI (`polaris-email`, aliased `pml`) for mailboxes, domains,
  zones, routes, credentials, bridges, webhooks, audit, status, bootstrap. See
  `apps/polaris-cli/README.md`.
- `apps/panel` — Hono + React admin UI deployed as a Cloudflare Worker. better-auth
  with OIDC (Cloudflare Access by default); sessions in D1.

Shared packages:

- `packages/hmac`, `packages/schema`, `packages/test-vectors` — signing primitives + types.
- `packages/sdk-node`, `packages/sdk-go` — first-party SDKs (hand-written REST client
  - embedded webhook verifier). See [`docs/sdk.md`](docs/sdk.md).
- `packages/pipeline` — the unified `processMessage` pipeline shared by
  `services/in` and `services/api`.
- `packages/ids` — ULID + request-id generator (shared between services).
- `packages/mime` — canonicalisation + sender-policy + IDNA address normalisation.
- `packages/providers` — Provider interface + Cloudflare adapter.
- `packages/cf-api` — Cloudflare API wrapper (zones, DNS, Email Routing/Service, DKIM).
- `packages/revocation` — KV-backed credential revocation primitive (≤60s propagation).

Infrastructure: `infra/terraform/` defines zone + access-app modules and per-environment
roots (staging / prod / anchors).

## Endpoint summary

Unified `Message` model. Bodies inline up to 64 KiB; larger ones surface as signed
R2 URLs (`SIGNED_URL_TTL_SECONDS`, default 10 min).

| Method   | Path                                         | Purpose                                                        |
| -------- | -------------------------------------------- | -------------------------------------------------------------- |
| `POST`   | `/v1/messages`                               | Submit (Content-Type: `application/json` or `message/rfc822`). |
| `GET`    | `/v1/messages`                               | List (filter by mailbox_id, direction, status, since, …).      |
| `GET`    | `/v1/messages/:id`                           | Fetch one message + signed attachment URLs.                    |
| `POST`   | `/v1/messages/get`                           | Bulk fetch by id.                                              |
| `GET`    | `/v1/mailboxes/:id/changes`                  | Delta cursor for sync.                                         |
| `GET`    | `/v1/mailboxes/:id/messages?fields=metadata` | Metadata-only listing.                                         |
| `GET`    | `/v1/messages/:id/attachments/:n`            | Attachment download (URL is itself signed).                    |
| `PATCH`  | `/v1/messages/:id`                           | Update flags (seen, flagged, keywords). No webhook.            |
| `DELETE` | `/v1/messages/:id`                           | Soft-delete. No webhook.                                       |
| `POST`   | `/v1/mailboxes/:id/expunge`                  | Hard-delete soft-deleted rows. No webhook.                     |

`/v1/send/raw` was retired in favor of `POST /v1/messages` with
`Content-Type: message/rfc822`. The full surface (admin, daemon, webhooks) is
described in [`openapi/polaris-email.yaml`](openapi/polaris-email.yaml).

## Local development

```sh
pnpm install
pnpm -r test
pnpm -r build

# Go modules
(cd apps/mail-bridge   && go test ./... && go build ./...)
(cd apps/polaris-cli   && go vet ./... && go build ./...)
```

Each Worker has a `wrangler.jsonc` (committed, placeholder IDs) and expects a gitignored
`wrangler.local.jsonc` with real D1/R2/KV/Queue IDs. Those are generated from
`services/*/wrangler.local.template.jsonc` + `.deploy-state.json` by
`bin/render-wrangler-local.sh`; `bin/deploy.sh` then merges the public + local configs
before `wrangler deploy`. Do not hand-edit the materialised files.

The panel (`apps/panel`) is a Worker too. For local panel dev:

```sh
pnpm --filter @polaris-email/panel wrangler-dev
```

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

Day-to-day operator workflows (issue api keys, onboard domains, register bridges,
rotate credentials, replay webhook DLQ entries, …) run through the `polaris-email`
CLI — see `apps/polaris-cli/README.md` for the subcommand tree.

## Security

See [`SECURITY.md`](SECURITY.md) for the threat model,
[`RUNBOOKS/cf-account-compromise.md`](RUNBOOKS/cf-account-compromise.md) for the kill
switch, and [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for incident response.
