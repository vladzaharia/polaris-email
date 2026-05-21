# polaris-mail

Managed email service for the `polaris-*` family. One HMAC REST contract for
both inbound retrieval and outbound submission (unified `Message` model),
v2-envelope signed webhooks for inbound events, an on-prem Go mail bridge
(SMTPS + IMAP) for legacy clients, and a managed admin panel for
mailboxes, API keys, routing, secrets, and operations.

Documentation lives at <https://docs.mail.plrs.im>.

## Quick start

```sh
# Install the polaris-mail Go CLI.
curl -fsSL cli.mail.plrs.im | sh

# Cold-start from zero: preflight → configure → plan → apply → render →
# migrate → secrets seed → deploy → genesis-seal → smoke.
polaris-mail setup infra
```

`polaris-mail setup infra --resume` picks up after a partial run; each
phase records to `.deploy-state.json`. See `apps/polaris-cli/README.md`
for the full subcommand tree.

## Architecture

Cloudflare Workers (control plane — three Workers + the panel):

- `services/api` — REST surface, admin API, audit chain, idempotency, key auth.
  **Also** hosts the webhook fan-out queue consumer (signed webhook delivery
  external + tailnet, retry + DLQ; v2 envelope inlines the full `Message`,
  signed with the un-versioned `X-Polaris-Sig: <hex>`) and the cron triggers
  (weekly secret staleness check, 5-minute `/healthz` synthetic, nightly
  retention janitor, nightly audit-chain verify). Phase B1 folded the
  previous separate `services/fanout` and `services/cron` Workers in here.
  Credential revocation is backed by the `KV_REVOCATIONS` namespace
  (≤60 s propagation); the previous Durable Object was retired.
- `services/out` — outbound queue consumer that drives Cloudflare Email
  Service `send_email` per-domain bindings.
- `services/in` — Email Routing handler that parses inbound MIME via the
  unified `processMessage` pipeline and persists.

On-prem (per host):

- `apps/mail-bridge` — single Go binary serving SMTPS (:465) and IMAP4rev2 (:993).
  Renamed and absorbed from the old `apps/submission-daemon`. See
  `apps/mail-bridge/README.md` and the mail-bridge guide at
  <https://docs.mail.plrs.im/operators/concepts/mail-bridge>.

  Two equally-supported deployment modes (neither is "the default"):
  - **Tailnet-fronted** — `tailscale/tailscale` sidecar; MagicDNS hostname; TLS via
    `tsnet.ListenTLS` (Lego ACME-DNS-01 fallback). Compose:
    `apps/mail-bridge/docker-compose.tailscale.yml`.
  - **Local / host-network** — the bridge binds 465/993/443 directly on the host;
    operator owns firewall + TLS termination. Compose:
    `apps/mail-bridge/docker-compose.local.yml`.

Operator tooling:

- `apps/polaris-cli` — Go CLI (`polaris-mail`, aliased `pml`). Day-2 ops
  surface: the same binary ships a **fullscreen tabbed TUI** (`polaris-mail
tui` or `polaris-mail` with no args), an SSH-fronted server
  (`polaris-mail serve --ssh` via Wish), unified auth (`polaris-mail
login` stores tokens in the OS keychain), and an operator-identity
  registry (`polaris-mail operator add`). Cobra subcommands for mailboxes,
  domains, zones, routes, credentials, bridges, webhooks, audit, status,
  setup. See `apps/polaris-cli/README.md` and [`docs/tui.md`](docs/tui.md).
- `apps/panel` — Hono + React admin UI deployed as a Cloudflare Worker. better-auth
  with OIDC (Cloudflare Access by default); sessions in D1.

Shared packages:

- `packages/hmac`, `packages/schema`, `packages/test-vectors` — signing primitives + types.
- `packages/sdk-node`, `packages/sdk-go` — first-party SDKs (hand-written REST client
  - embedded webhook verifier). See <https://docs.mail.plrs.im/developers/sdks/>.
- `packages/pipeline` — the unified `processMessage` pipeline shared by
  `services/in` and `services/api`.
- `packages/ids` — ULID + request-id generator (shared between services).
- `packages/mime` — canonicalisation + sender-policy + IDNA address normalisation.
- `packages/cf-api` — Cloudflare API wrapper (zones, DNS, Email Routing/Service, DKIM).
- `packages/revocation` — KV-backed credential revocation primitive (≤60s propagation).

Infrastructure provisioning lives entirely in the Go CLI's `setup infra`
phases — the account-level Cloudflare resources (D1, R2 buckets, KV,
queues, Logpush, R2 tokens) are created by `polaris-mail setup infra
apply`; per-Worker bindings + custom domains are declared in each
service's `wrangler.jsonc`. Per-domain DNS records, Email Routing, and
Email Service onboarding flow through `POST /v1/admin/domains` and the
shared `packages/cf-api/` wrapper.

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
described in [`openapi/polaris-mail.yaml`](openapi/polaris-mail.yaml).

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
`polaris-mail setup infra render`; `polaris-mail setup infra deploy` then merges
the public + local configs before `wrangler deploy`. Do not hand-edit the materialised
files.

The panel (`apps/panel`) is a Worker too. For local panel dev:

```sh
pnpm --filter @polaris-mail/panel wrangler-dev
```

## Operator workflows

Day-to-day operator workflows (cold-start, deploy, smoke, rollback, issue
api keys, onboard domains, register bridges, rotate credentials, replay
webhook DLQ entries, …) all run through the `polaris-mail` CLI.

```sh
polaris-mail setup infra preflight          # verify required tools and env
polaris-mail setup infra configure          # write .env.deploy interactively
polaris-mail setup infra                    # cold-start: create CF resources, deploy, mint admin key
polaris-mail setup infra smoke              # end-to-end health probe
polaris-mail setup infra deploy changed     # deploy only services whose code (or deps) changed
polaris-mail setup infra rollback api       # roll one Worker back to its previous version
```

The same binary is dual-mode — with no args (and a TTY) it opens the
fullscreen tabbed admin TUI; with subcommands it operates non-interactively
for scripting. It also ships an SSH-fronted server so the same TUI can be
published over Wish/Wishlist:

```sh
polaris-mail login                                 # one-time: paste your operator login token
polaris-mail                                       # → fullscreen TUI
polaris-mail tui --theme=mocha                     # explicit subcommand + theme override
polaris-mail operator add                          # mint a new operator (huh wizard)
polaris-mail serve --ssh --bootstrap-token …       # publish the TUI over SSH
```

See `apps/polaris-cli/README.md` for the full subcommand tree, and
<https://docs.mail.plrs.im> for the full operator + developer guides.

## Security

See [`SECURITY.md`](SECURITY.md) for the threat model and
<https://docs.mail.plrs.im/operators/runbooks/> for incident-response
runbooks (account compromise, on-call triage, DLQ replay,
D1 backup/recovery).
