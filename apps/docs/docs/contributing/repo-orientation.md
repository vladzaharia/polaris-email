---
title: Repo orientation
description: Where things live in the polyglot polaris-email monorepo — the three Workers, the four apps, the shared packages, and a "where to look first" index.
sidebar_label: Repo orientation
sidebar_position: 2
---

# Repo orientation

polaris-email is a polyglot monorepo: TypeScript Workers, Go apps,
Terraform IaC, and a Docusaurus site. This page is the map.

## Top-level layout

```
polaris-email/
├── services/        # Cloudflare Workers (TypeScript + Hono)
│   ├── api/         # REST surface, webhook fan-out, all cron triggers
│   ├── in/          # Email Routing inbound handler
│   └── out/         # Outbound queue consumer driving Email Service
├── apps/            # User-facing apps (panel, bridge, CLI, docs)
│   ├── panel/       # Hono + React 19 admin UI (Worker)
│   ├── mail-bridge/ # Go on-prem SMTPS + IMAP4rev2 daemon
│   ├── polaris-cli/ # Go operator CLI (polaris-email / pml)
│   └── docs/        # This Docusaurus site (Worker)
├── packages/        # Shared TypeScript libraries + the Go SDK
├── infra/           # Terraform (DNS, Email Routing, Access apps)
├── bin/             # Shell orchestration scripts (deploy, bootstrap)
└── openapi/         # OpenAPI spec — single source of truth for the REST surface
```

## Three Workers, not five

The control plane is **three** Workers, not the five it briefly was
during early phases:

- **`services/api`** — REST surface, admin API, audit chain,
  idempotency, key auth, **plus** the webhook fan-out queue consumer
  and every cron trigger (hourly audit anchor, weekly secret staleness,
  per-minute synthetic, nightly retention janitor). Phase B1 folded the
  previous `services/fanout` and `services/cron` Workers in here.
- **`services/in`** — Email Routing handler. Parses inbound MIME via
  the unified `processMessage` pipeline.
- **`services/out`** — outbound queue consumer that drives the
  Cloudflare Email Service `send_email` per-domain bindings.

Don't re-split these. The `services/forensic` Worker was also removed
when the schema went zero-payload-by-default.

## Four apps

- **`apps/panel`** — the admin UI. Hono server + React 19 +
  TanStack Router, deployed as its own Worker with `dist/client/`
  mounted on the `ASSETS` binding. Talks to `services/api` over a
  **service binding** (`API`), not public fetch — no HMAC key needed
  on the happy path. Sessions live in D1 via better-auth + the drizzle
  adapter, sharing the `polaris-email` DB with `services/api`.
- **`apps/mail-bridge`** — Go 1.25, a single binary serving SMTPS
  (`:465`) and IMAP4rev2 (`:993`). Own `go.mod` and `Makefile`. Two
  equally-supported deployment modes (neither is "the default"):
  tailnet-fronted (`docker-compose.tailscale.yml`) and local /
  host-network (`docker-compose.local.yml`).
- **`apps/polaris-cli`** — Go 1.22, the operator CLI (`polaris-email`,
  alias `pml`). Own `go.mod`. Cold-start, day-2 ops, smoke checks. The
  Go binary is the operator surface; `bin/*.sh` scripts and the root
  Makefile are orchestration layers, not the day-to-day workflow.
- **`apps/docs`** — the Docusaurus v3 site you are reading, deployed
  as a Worker.

The CLI and the panel are deliberately distinct. The panel is a UI you
log into; the CLI is what you run from a workstation, what CI scripts
invoke, and what the cold-start uses to sign admin requests.

## Shared packages

Every TypeScript library under `packages/` is published as a workspace
package consumed by Workers and apps. Highlights:

- `packages/hmac` — signing primitives. Un-versioned `X-Polaris-Sig`
  scheme, domain-separated by tag (`polaris-api` vs.
  `polaris-webhook`).
- `packages/schema` — the unified `Message` model and other shared
  types.
- `packages/pipeline` — `processMessage()`, the **single** path mail
  takes through the system. Both `services/in` (Email Routing) and
  `services/api` (REST submission, JSON or `message/rfc822`) call it.
- `packages/ids` — ULID + request-id generator.
- `packages/mime` — canonicalisation, sender-policy, IDNA address
  normalisation.
- `packages/cf-api` — Cloudflare API wrapper (zones, DNS, Email
  Routing / Service, DKIM).
- `packages/revocation` — KV-backed credential revocation primitive
  (≤60 s propagation; the previous Durable Object was retired).
- `packages/object-lock` — Backblaze B2 anchor writer.
- `packages/test-vectors` — fixtures shared between SDK suites.
- `packages/sdk-node` — first-party Node SDK.

`packages/sdk-go` is the **only** Go package under `packages/`. It has
its own `go.mod` and intentionally **no `go.sum`** — pure stdlib. CI
disables the Go module cache for that job; if you add an external
dependency, update `.github/workflows/ci.yml` too.

## Infrastructure

`infra/terraform/` owns the slow-moving, state-shaped Cloudflare
resources — DNS, Email Routing rules, Email Service onboarding,
Cloudflare Access apps, and the R2 public custom-domain wiring —
inside the single `polaris-prod` account. (Phase O1 collapsed the
previous three-account topology to one.)

Wrangler (per-Worker `wrangler.jsonc` / `wrangler.local.jsonc`) owns
the code-velocity resources within the same account: Workers, D1, KV,
R2 buckets, Queues. The two never overlap, and the API tokens that
drive each pipeline are scoped so they can't.

Audit anchors live **off-Cloudflare** in Backblaze B2 with Object
Lock COMPLIANCE; a fully-compromised CF account cannot rewrite
history. See [`infra/terraform/README.md`](https://github.com/polaris/polaris-email/blob/main/infra/terraform/README.md)
for the full split and the anchor-target setup.

## Toolchain

You need all of:

- **Node** 22+ (via [Volta](https://volta.sh) or [fnm](https://github.com/Schniz/fnm))
- **pnpm** 9 (`corepack enable && corepack prepare pnpm@9 --activate`)
- **Go** 1.22 (for `polaris-cli`) **and** 1.25 (for `mail-bridge`)
- **Wrangler** 4 (installed transitively by `pnpm install`)

Lint and format use **Oxc only** (`oxlint` + `oxfmt`). **Do not add
ESLint, Prettier, husky, or any rival tooling** — that is explicit
project policy. Pre-commit hooks register through `pnpm exec lefthook
install`; don't bypass them with `--no-verify`, fix the underlying
issue. See [Linting & formatting](/contributing/linting) for the
rule overrides.

## Where to look first

When you have a specific question, start here:

- **"How does outbound submission work?"** →
  `packages/pipeline/src/process-message.ts` plus
  `services/api/src/routes/messages.ts` and `services/out/src/index.ts`.
- **"How is a webhook signed?"** →
  `services/api/src/queue/fanout.ts` and `packages/hmac/`. Signing
  happens in the queue consumer inside `services/api` — the only place
  outgoing webhooks are signed.
- **"How does IMAP read from D1?"** →
  `apps/mail-bridge/internal/store/mirror.go`. The bridge keeps a
  local SQLite mirror of `mailbox_messages_state`.
- **"How is a request authenticated?"** →
  `services/api/src/auth.ts` and `packages/revocation/` (KV-backed,
  ≤60 s propagation).
- **"How do I onboard a domain end-to-end?"** →
  `apps/polaris-cli/internal/cmds/domain.go` plus the wizards in
  `apps/polaris-cli/internal/wizards/`.
- **"What's the data model?"** →
  [Unified Message model](/developers/messages/unified-model). The
  schema is **mailbox-centric**, not tenant-centric — every message
  has exactly one `mailbox_id`.

## Common commands

```sh
pnpm install                 # bootstrap workspace
pnpm -r build                # all TypeScript workspaces
pnpm -r typecheck            # all TypeScript workspaces
pnpm -r test                 # vitest in every workspace
pnpm lint                    # oxlint (errors fail, warnings ok)
pnpm fmt                     # oxfmt --write
pnpm check                   # typecheck + lint + fmt:check
```

Go:

```sh
cd apps/mail-bridge && make build test vet
cd apps/polaris-cli && make build test vet
cd packages/sdk-go  && go test ./...     # run pnpm --filter @polaris-email/test-vectors run generate first
```

For more on the integration-test tiers and the pull-request gates,
see [Contributing overview](/contributing/overview).

<!-- Verified against: README.md @ c3c1b5048dd5bfe92facdce24982141a07446042; infra/README.md @ 175c8d8dd2b77cdc44f501ebcf5ff03000faeff1 -->
