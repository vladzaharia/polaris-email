# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`polaris-email` is a managed email service for the `polaris-*` family.
Cloudflare Workers control plane (REST API, webhook fan-out, cron) + a Go
on-prem mail bridge (SMTPS + IMAP) + a Go operator CLI + a Hono/React admin
panel deployed as a Worker. Three Workers, three apps, ~12 packages.

Start with: `README.md` (component map), `docs/architecture.md` (system view),
`docs/messages.md` (unified `Message` data model), `SECURITY.md` (threat model
— required reading before changing anything touching R2 public URLs, audit
anchors, or HMAC).

## Repository layout (polyglot monorepo)

- `services/{api,in,out}` — Cloudflare Workers (TypeScript + Hono).
  `services/api` ALSO hosts the webhook fan-out queue consumer and all cron
  triggers; the previous `services/fanout` and `services/cron` Workers were
  folded into it. The previous `services/forensic` Worker was
  removed when the schema went zero-payload-by-default. Don't reintroduce
  any of these.
- `apps/panel` — Hono + React 19 + TanStack Router admin UI; deployed as a
  Worker with `dist/client/` mounted on the `ASSETS` binding.
- `apps/mail-bridge` — Go 1.25, on-prem SMTPS (:465) + IMAP4rev2 (:993) in
  one binary. Its own `go.mod` + `Makefile`.
- `apps/polaris-cli` — Go 1.22, operator CLI (`polaris-email`, alias `pml`).
  Own `go.mod`.
- `packages/{hmac,schema,pipeline,ids,mime,cf-api,revocation,object-lock,test-vectors,sdk-node}`
  TypeScript libs published as workspace packages.
- `packages/sdk-go` — the only Go package under `packages/` (its own
  `go.mod`, **no `go.sum`** — pure-stdlib). CI disables module cache for
  this job; if you add an external dep, update `.github/workflows/ci.yml`.
- `infra/terraform/` — zone + access-app modules; per-env roots.
- `bin/` — orchestration scripts (`deploy.sh`, `bootstrap.sh`,
  `configure.sh`, `smoke.sh`, `killswitch-*.sh`). Invoke via Makefile
  targets, not directly.

## Commands

Toolchain: Node 22+, pnpm 9 (`corepack enable && corepack prepare pnpm@9 --activate`),
Go 1.22 for `polaris-cli`, Go 1.25 for `mail-bridge`, wrangler 4.

```sh
pnpm install                 # bootstrap workspace
pnpm -r build                # all TS workspaces
pnpm -r typecheck            # all TS workspaces
pnpm -r test                 # vitest in every workspace
pnpm lint                    # oxlint (errors fail, warnings ok)
pnpm fmt                     # oxfmt --write
pnpm check                   # typecheck + lint + fmt:check (pre-PR gate)
```

Per-workspace:

```sh
pnpm --filter @polaris-email/api test                   # one Worker's tests
pnpm --filter @polaris-email/panel dev:server           # panel Worker (recommended dev loop)
pnpm --filter @polaris-email/panel dev:client           # Vite HMR (client-only)
pnpm --filter @polaris-email/panel typecheck            # client + server tsc
pnpm --filter @polaris-email/test-vectors run generate  # MUST run before go-test
```

Single test file: `pnpm --filter <workspace> exec vitest run path/to/file.test.ts`.

Go:

```sh
cd apps/mail-bridge && make build test vet   # Go 1.25; CI runs `go test -race ./...`
cd apps/polaris-cli && make build test vet   # builds bin/polaris-email + bin/pml symlink
cd packages/sdk-go  && go test ./...         # needs test-vectors generated first
```

Cold-start (Go CLI — canonical from PR 7 onwards):

```sh
polaris-email setup infra            # full happy path: preflight → configure →
                                     # plan → apply → render → migrate →
                                     # secrets seed → deploy → genesis-seal →
                                     # smoke. Each phase records to
                                     # .deploy-state.json so --resume short-
                                     # circuits past completed phases.
polaris-email setup infra --resume   # pick up after a partial run
polaris-email setup infra --phase migrate    # start at a specific phase
polaris-email setup infra <leaf>     # run one phase ad-hoc (e.g.
                                     # `setup infra migrate`)
```

Orchestration (root `Makefile` — soak-window fallback, retired in PR 14):

```sh
make preflight                    # verify tooling + .env.deploy
make configure                    # rebuild .env.deploy + re-render wrangler.local.jsonc files
make bootstrap                    # cold-start CF resources + deploy + mint admin key
make deploy SERVICE=services/api
make deploy-all
make deploy-changed               # only services whose code/deps changed since deployed/main
make rollback SERVICE=api
make smoke                        # signed diagnostics + synthetic send
```

Day-to-day operator workflows (issue keys, onboard domains, rotate creds,
replay DLQ) run via the `polaris-email` Go CLI — not `bin/*` scripts and
not the Makefile. See `apps/polaris-cli/README.md`.

## Lint, format, hooks

- **Oxc only** (`oxlint` + `oxfmt`). Do NOT add ESLint, Prettier, husky, or
  any rival tooling — explicit project policy (see `CONTRIBUTING.md`,
  `LINTING.md`).
- Test files relax `typescript/no-explicit-any` and `no-console` to off.
- `services/in/**`, `services/out/**` relax `typescript/no-floating-promises`
  to warn — Workers commonly fire-and-forget via `ctx.waitUntil`-adjacent
  paths.
- `**/generated/**` has no rules — never hand-edit generated code.
- Pre-commit: `pnpm exec lefthook install` registers `oxlint` and
  `oxfmt --check` on staged files. Don't bypass with `--no-verify`; fix
  the underlying issue.
- CI required jobs: `lint`, `fmt-check`, `typecheck`, `test`, `go-test`,
  `mail-bridge-test`, `openapi-validate`, `sql-validate`.

## Architecture seams to know before editing

1. **Mailbox-centric, not tenant-centric.** Schema is rooted at
   `mailboxes`; `principals`, `mailbox_senders`, `mailbox_receivers`,
   `webhook_subs`, and `messages` all hang off it. Every message has
   exactly one `mailbox_id`. Any `tenant` reference is legacy alias plumbing
   (warn-only in the CLI).

2. **One unified pipeline.** `packages/pipeline/src/process-message.ts`
   exports `processMessage()` — the _single_ path mail takes through the
   system. Both `services/in` (Email Routing inbound) and `services/api`
   (REST submission, JSON or RFC822) call it. Don't fork it — the previous
   parallel implementations are exactly the bug unification fixed.

3. **HMAC is un-versioned ().** Header is `X-Polaris-Sig: <hex>`
   with no `v2=` prefix. Domain tags: `polaris-api` (API requests),
   `polaris-webhook` (outgoing webhook signing). See
   `docs/hmac-reference.md`.

4. **Webhook envelope is v2.** The full `Message` is inlined in the event.
   Signing happens in the queue consumer inside `services/api`
   (`src/queue/fanout.ts`) — the only place outgoing webhooks are signed.

5. **Three Workers, not five.** B1 folded fanout + cron into `services/api`;
   O1 collapsed the staging + anchor CF accounts into one production
   account; forensic was removed with zero-payload-by-default. Don't
   re-add any of these.

6. **Audit anchors live OFF Cloudflare.** Hourly cron in `services/api`
   pushes signed anchors to Backblaze B2 with Object Lock COMPLIANCE mode
   (~7 yr retention). The B2 key is operator-vault-only — a fully-
   compromised CF account cannot rewrite history. Don't move anchor
   writes inside CF.

7. **R2 public domain `r2.mail.plrs.im` is intentionally unauthenticated.**
   SHA-256 keys are the unguessability boundary (per). Don't add
   a CDN or per-object signed-URL layer in front — read `SECURITY.md` first.

8. **Credential revocation is KV-backed.** `packages/revocation` queries
   `KV_REVOCATIONS` on every authenticated request; propagation is ≤60s
   (KV write + 60s per-Worker cache). The previous Durable Object was
   retired.

## mail-bridge: two equally-supported deployment modes

**Critical:** the Tailscale sidecar mode is **not** the default. Both
compose files are first-class — neither is canonical:

- `apps/mail-bridge/docker-compose.tailscale.yml` — tailnet-fronted,
  MagicDNS hostname, TLS via `tsnet.ListenTLS` (Lego ACME-DNS-01 fallback).
- `apps/mail-bridge/docker-compose.local.yml` — host-network, operator
  owns firewall + TLS termination (PEM mounted at
  `/etc/polaris-bridge/tls/`, or Lego).

Both modes use the same image, same `bridge.toml`, same env-var overrides.
Only the network mode and TLS source differ. Don't refactor as if one path
were the canonical one.

## Wrangler config convention

- Every Worker has a committed `wrangler.jsonc` (placeholder IDs) and a
  gitignored `wrangler.local.jsonc` (real IDs).
- `wrangler.local.jsonc` is **generated** from
  `services/*/wrangler.local.template.jsonc` + `.deploy-state.json` via
  `bin/render-wrangler-local.sh`. **Do not hand-edit the materialised file.**
- `bin/deploy.sh` merges the two with `jq -s '.[0] * .[1]'` into a
  throwaway `.wrangler.merged.json` before `wrangler deploy`, then deletes
  it. Don't commit `.wrangler.merged.json`.

## Panel specifics

- Server: Hono on Workers. Client: React 19 + TanStack Router served via
  the `ASSETS` binding. Sessions in D1 via better-auth + drizzle adapter
  (shares the `polaris-email` DB with `services/api`).
- Talks to the API via a **service binding** (`API`), not public fetch.
  No HMAC key needed in the happy path.
- Destructive actions are gated **client-side** via
  `DestructiveActionDialog` (type-the-resource-name confirmation). The
  prior two-person `withApproval(...)` flow and `approvals` D1 table
  were removed — real deployments are single-operator and the second
  admin co-sign was unusable. The `audit_log` chained-hash table
  (anchored hourly to Backblaze B2 with Object Lock) remains the
  canonical record of who did what.
- Auth flow: Cloudflare Access → Worker → better-auth `genericOAuth` →
  OIDC. The `databaseHooks.user.create.after` hook role-syncs from the
  OIDC `groups` claim against the `ADMIN_GROUP` var. The claim is
  capped at 200 entries to bound the sign-in path.

## Things to avoid

- Adding ESLint, Prettier, husky, or any non-Oxc lint/format tool.
- Hand-editing materialised `wrangler.local.jsonc` or
  `.wrangler.merged.json`.
- Treating the Tailscale compose file as the mail-bridge default.
- Re-splitting `services/api` into `fanout` / `cron` / `forensic` Workers.
- Moving audit-anchor writes inside Cloudflare.
- Skipping lefthook with `--no-verify`; fix the underlying lint/fmt issue.

## Where to look first for X

- "How does outbound submission work?" →
  `packages/pipeline/src/process-message.ts` +
  `services/api/src/routes/messages.ts` + `services/out/src/index.ts`.
- "How is a webhook signed?" → `services/api/src/queue/fanout.ts` +
  `packages/hmac/`.
- "How does IMAP read from D1?" →
  `apps/mail-bridge/internal/store/mirror.go` (bridge-local SQLite mirror
  of `mailbox_messages_state`).
- "How is a request authenticated?" → `services/api/src/auth.ts` +
  `packages/revocation/` (KV-backed, ≤60s propagation).
- "How do I onboard a domain end-to-end?" →
  `apps/polaris-cli/internal/cmds/domain.go` and the wizard in
  `apps/polaris-cli/internal/wizards/`.
