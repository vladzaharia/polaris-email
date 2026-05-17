---
title: Architecture deep-dive
description: Codebase navigation for new contributors — repo layout, the unifying pipeline (packages/pipeline/src/process-message.ts), the three-Worker topology rationale, HMAC un-versioned, webhook v2, and the zero-payload-by-default schema.
sidebar_label: Architecture deep-dive
sidebar_position: 3
---

# Architecture deep-dive (for contributors)

This page is the codebase tour. If you are an operator wanting the
system view without internal paths, read
[Operators → Architecture](/operators/concepts/architecture) instead;
this page assumes you are about to open the repo in an editor.

## Polyglot monorepo layout

```
services/{api,in,out}        — Cloudflare Workers (TypeScript + Hono)
apps/panel                   — Hono + React 19 + TanStack Router admin UI (Worker)
apps/mail-bridge             — Go 1.25, SMTPS + IMAP4rev2 in one binary
apps/polaris-cli             — Go 1.22, operator CLI (`polaris-email`, alias `pml`)
apps/docs                    — Docusaurus v3 site (this site), deployed as a Worker
apps/cli-installer           — installer Worker at cli.mail.plrs.im
packages/{hmac,schema,pipeline,ids,mime,cf-api,revocation,object-lock,test-vectors,sdk-node}
                             — TS workspace packages
packages/sdk-go              — the only Go package under packages/ (pure stdlib, no go.sum)
infra/terraform              — zone + access-app modules; per-env roots
bin/                         — orchestration scripts (legacy; being replaced by `polaris-email setup`)
```

The Workers are TypeScript + Hono. The on-prem bridge and the CLI are
Go. The panel is a Worker that serves a React client over the `ASSETS`
binding and talks to `services/api` via a service binding — no public
fetch, no HMAC key in the happy path.

## Three Workers, not five

| Worker         | Hosts                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `services/api` | REST surface, admin API, audit chain, idempotency, HMAC auth, **the webhook fan-out queue consumer**, and **every cron trigger**.                      |
| `services/in`  | Email Routing handler. Parses inbound MIME, runs the unified pipeline.                                                                                  |
| `services/out` | Outbound queue consumer. Drives the `send_email` binding per domain.                                                                                    |

**Topology rationale (B1 consolidation).** The previous standalone
`services/fanout` and `services/cron` Workers were folded into
`services/api`. At < 10k msg/day the operational overhead of three
extra Workers, three extra wrangler configs, and three extra deploy
targets dwarfed the isolation benefit. `services/forensic` was removed
entirely when the schema went zero-payload-by-default. Don't reintroduce
any of these — the consolidation is intentional and the tests assume it.

The previous separate `polaris-anchors` and `polaris-staging` Cloudflare
accounts were also collapsed (O1). Tamper-evidence is now anchored
externally via Backblaze B2; account separation was no longer pulling
its weight. Don't move audit-anchor writes inside CF.

## The single unified pipeline

`packages/pipeline/src/process-message.ts` exports `processMessage()`.
This is the **only** path mail takes through the system. Both
`services/in` (Email Routing inbound) and `services/api` (REST
submission, JSON or `message/rfc822`) call it. The previous parallel
implementations are exactly the bug unification fixed — don't fork it.

The pipeline:

1. Resolves `mailbox_id` (recipient match or principal scope).
2. Canonicalises MIME or the `SendRequest` JSON into the `Message`
   shape (defined in `packages/schema/src/index.ts`).
3. Writes inline-small bodies to D1, large bodies and attachments to R2
   under content-addressed keys (`mime/<aa>/<bb>/<sha256>` for bodies,
   `att/<sha256>/<filename>` for attachments).
4. Enqueues — inbound to the fan-out queue, outbound to the provider
   queue.
5. Appends a row to `audit_log` with `prev_hash` linking to the previous
   row.

When you change validation, address normalisation, attachment limits, or
audit semantics, change them here. Both directions pick the change up
automatically.

## Mailbox-centric schema

The schema is rooted at `mailboxes`. `principals`, `mailbox_senders`,
`mailbox_receivers`, `webhook_subs`, and `messages` all hang off it.
Every message has exactly one `mailbox_id`. Any `tenant` reference in
the codebase is legacy alias plumbing (warn-only in the CLI) — the unit
of authority is the mailbox.

## Zero-payload-by-default

The schema deliberately does not retain plaintext recipient lists or
message contents server-side beyond what's needed to deliver the
message. That decision is what let `services/forensic` go away: there is
no escrowed key material for it to manage. Consumer-side outbound
logging is the expected pattern for subpoena response. See
[CONSUMER-CONTRACT](/reference/consumer-contract).

## HMAC is un-versioned

The HMAC header is `X-Polaris-Sig: <hex>` — bare lowercase hex, **no
`v1=` / `v2=` prefix, no algorithm prefix**. The historical versioned
envelope tags were removed; there is one canonical-string shape and one
header shape forever.

Two domain tags exist:

- `polaris-api` — HTTP requests to the REST surface.
- `polaris-webhook` — outgoing webhook deliveries.

The implementation lives in `packages/hmac/src/index.ts`. The single
verifier is used by `services/api/src/auth.ts` for inbound requests and
by `services/api/src/queue/fanout.ts` for signing outgoing webhooks. The
formal canonical-string spec is the [HMAC reference](/security/hmac-reference);
the developer-facing concept is [HMAC concept](/developers/authentication/concept).

Verifiers MUST refuse anything that doesn't match `^[0-9a-f]+$` —
signatures shaped like `v1=…` are rejected by this rule.

## Webhook envelope is v2

The webhook envelope inlines the full `Message`. Receivers do not need a
follow-up `GET /v1/messages/:id` — everything they need is in the body.

Signing happens in `services/api/src/queue/fanout.ts` and **only**
there. The queue consumer is the single point where outgoing webhooks
are signed; do not sign webhooks from anywhere else.

## Credential revocation is KV-backed

`packages/revocation` queries `KV_REVOCATIONS` on every authenticated
request. Propagation budget: ≤60 seconds (KV write + 60 s per-Worker
cache TTL). The previous Durable Object that fronted this was retired —
KV is simpler, cheaper, and meets the propagation target. Don't bring
the DO back.

## R2 public domain is intentionally unauthenticated

The R2 bucket is fronted by the public custom domain `r2.mail.plrs.im`.
SHA-256 keys provide unguessability; there is no signed-URL layer, no
CDN, no per-object HMAC header. Treating a URL as a capability token is
the explicit design.

Audit-log readers implicitly gain content read access; this is acceptable
at the internal-deployment scale polaris-email targets. Read
[SECURITY.md](https://github.com/vladzaharia/polaris-email/blob/main/SECURITY.md)
before changing anything in this area.

## Audit anchors live off Cloudflare

Hourly cron in `services/api` pushes signed anchors to Backblaze B2 with
Object Lock COMPLIANCE mode (~7-year retention). The B2 application key
is scoped `writeFiles`-only and lives in the operator's password
vault — not in the Cloudflare account. A fully-compromised CF account
cannot rewrite history.

Don't move anchor writes inside Cloudflare. The external bucket is the
tamper-evidence anchor.

## Wrangler config convention

Every Worker has:

- A committed `wrangler.jsonc` with placeholder IDs (safe to read).
- A gitignored `wrangler.local.jsonc` with real IDs.

The local file is **generated** from
`services/*/wrangler.local.template.jsonc` plus `.deploy-state.json` via
`bin/render-wrangler-local.sh` (being replaced by
`polaris-email setup infra` in Go). **Do not hand-edit the materialised
file.** `bin/deploy.sh` merges committed + local with
`jq -s '.[0] * .[1]'` into a throwaway `.wrangler.merged.json` for the
`wrangler deploy` call, then deletes it. Do not commit
`.wrangler.merged.json`.

## Panel specifics

- Server: Hono on Workers. Client: React 19 + TanStack Router served via
  the `ASSETS` binding.
- Sessions in D1 via better-auth + drizzle adapter (shares the
  `polaris-email` D1 database with `services/api`).
- Talks to `services/api` via a service binding (`API`). No public fetch,
  no HMAC key in the happy path.
- Destructive actions are gated **client-side** via
  `DestructiveActionDialog` (type-the-resource-name confirmation). The
  prior two-person `withApproval(...)` flow and the `approvals` D1 table
  were removed — single-operator deployments made the second-admin
  co-sign unusable. The hash-chained `audit_log` (anchored hourly to
  Backblaze B2) remains the canonical record of who did what.
- Auth flow: Cloudflare Access → Worker → better-auth `genericOAuth` →
  OIDC. The `databaseHooks.user.create.after` hook role-syncs from the
  OIDC `groups` claim against the `ADMIN_GROUP` var. The claim is
  capped at 200 entries to bound the sign-in path against a hostile or
  misconfigured IdP.

## mail-bridge: two equally-supported deployment modes

The Tailscale sidecar mode is **not** the default. Both compose files
are first-class — neither is canonical:

- `apps/mail-bridge/docker-compose.tailscale.yml` — tailnet-fronted,
  MagicDNS hostname, TLS via `tsnet.ListenTLS` (Lego ACME-DNS-01
  fallback).
- `apps/mail-bridge/docker-compose.local.yml` — host-network, operator
  owns firewall + TLS termination.

Both modes use the same image, same `bridge.toml`, same env-var
overrides. Only the network mode and the TLS source differ. Don't
refactor as if one path were canonical.

## Where to look first for X

| Question                                       | Start here                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| "How does outbound submission work?"           | `packages/pipeline/src/process-message.ts` + `services/api/src/routes/messages.ts` + `services/out/src/index.ts`                      |
| "How is a webhook signed?"                     | `services/api/src/queue/fanout.ts` + `packages/hmac/src/index.ts`                                                                     |
| "How does IMAP read from D1?"                  | `apps/mail-bridge/internal/store/mirror.go` (bridge-local SQLite mirror of `mailbox_messages_state`)                                  |
| "How is a request authenticated?"              | `services/api/src/auth.ts` + `packages/revocation/` (KV-backed, ≤60 s propagation)                                                    |
| "How do I onboard a domain end-to-end?"        | `apps/polaris-cli/internal/cmds/domain.go` and the wizard in `apps/polaris-cli/internal/wizards/`                                     |
| "Where does outbound mail actually leave CF?"  | `services/out/src/index.ts` — the `send_email` binding invocation                                                                     |
| "What is the unified `Message` shape?"         | `packages/schema/src/index.ts` (Zod) — normative wire format is `openapi/polaris-email.yaml`                                          |

## Things contributors should not do

- Add ESLint, Prettier, husky, or any non-Oxc lint/format tool. The
  project uses `oxlint` + `oxfmt` exclusively. See [Linting](/contributing/linting).
- Hand-edit materialised `wrangler.local.jsonc` or `.wrangler.merged.json`.
- Treat the Tailscale compose file as the mail-bridge default.
- Re-split `services/api` into `fanout` / `cron` / `forensic` Workers.
- Move audit-anchor writes inside Cloudflare.
- Skip lefthook with `--no-verify`. Fix the underlying lint/fmt issue.

## See also

- [Operators → Architecture](/operators/concepts/architecture) — same
  system, operator framing, no internal file paths.
- [HMAC concept](/developers/authentication/concept) — developer view of
  the signing scheme.
- [HMAC reference](/security/hmac-reference) — the formal spec, for
  implementing a verifier from scratch.
- [Threat model](/security/threat-model) — trust boundaries and
  mitigations.
- [Unified Message model](/developers/messages/unified-model) — the
  schema-level shape.

<!-- Verified against: docs/architecture.md, CLAUDE.md, packages/pipeline/src/process-message.ts, services/api/src/queue/fanout.ts, services/api/src/auth.ts, packages/hmac/src/index.ts @ eeee222cdf8359f8f2bf1013a103abdb3c705f06 -->
