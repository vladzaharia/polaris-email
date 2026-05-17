---
title: Contributing
description: Toolchain, common commands, integration-test tiers, and the pull-request gates for polaris-email contributors.
sidebar_label: Overview
sidebar_position: 1
---

# Contributing to polaris-email

## Toolchain

- Node 22+ via [Volta](https://volta.sh) or [fnm](https://github.com/Schniz/fnm).
- pnpm 9 (`corepack enable && corepack prepare pnpm@9 --activate`).
- Cloudflare Wrangler for Workers (`pnpm dlx wrangler ...`).

## Common commands

```bash
pnpm install
pnpm -r run build
pnpm -r run typecheck
pnpm -r run test

# Lint + format (Oxc toolchain — see Linting & formatting)
pnpm lint
pnpm fmt
pnpm check     # typecheck + lint + fmt:check
```

## Integration tests with Wrangler local-dev

Phase B introduced a second tier of TypeScript tests that run inside a real
Cloudflare runtime (Miniflare + workerd) via
`@cloudflare/vitest-pool-workers`. No Cloudflare account, no real D1 / R2 /
KV / queues, and no network calls — Miniflare simulates every binding
in-process with per-test-file isolated storage.

### When to use each suite

- `*.test.ts` (unit, Node env): pure-logic tests, fast feedback. Use for
  `packages/mime`, `packages/schema`, and similar libraries with no
  Cloudflare runtime dependency.
- `*.integration.test.ts` (mock-backed integration, Node env): cover route
  flows in `services/api` with hand-rolled `FakeD1` / `FakeR2` / `FakeKV`.
  Keep using these for fast-iteration tests where the FakeX semantics are
  sufficient.
- `*.workers.test.ts` (pool-workers, real Miniflare + workerd): use when
  the bug class is a Cloudflare runtime contract — queue retry semantics,
  R2 conditional writes, D1 transaction shape, `send_email` shape,
  `ForwardableEmailMessage` handling, cross-binding behavior. Slower
  (~5 s pool boot per file) but real-runtime fidelity.

### How to run

```bash
pnpm test:unit                              # All Node-env unit tests
pnpm test:integration                       # All pool-workers tests
pnpm test                                   # Both, sequenced

pnpm test:integration --project in-workers  # Just one service
bin/dev.sh                                  # Watch mode (all three workers projects)
bin/dev.sh --project out-workers            # Watch mode (specific service)
```

### Writing a `*.workers.test.ts` — quirks

These were learned the hard way while landing B.5 / B.7 / B.8 and are worth
internalizing before adding new pool-workers tests:

1. **Do NOT `import` `@cloudflare/vitest-pool-workers` inside a test file.**
   That package is Node-only; importing it from a file that runs inside
   workerd segfaults the runtime with no diagnostic. Read migrations in a
   Node-side `globalSetup.ts` and pipe them through vitest's
   `provide` / `inject` channel. See
   `services/in/test/integration/global-setup.ts` for the pattern.

2. **Strip `CREATE VIEW` and `CREATE TRIGGER` from D1 migrations before
   `applyD1Migrations`.** Workerd's bundled SQLite is stricter than real D1
   about view-reference rewriting across `ALTER TABLE ... RENAME`. None of
   the workers query the views, so stripping them is safe.

3. **Migration `0006`'s `messages_old` rename leaves dangling FK
   references.** Tables `idempotency_keys`, `message_attempts`, and
   `message_deliveries` still reference `messages_old` after the rename.
   Workerd errors on subsequent inserts with
   `"no such table: main.messages_old"`. Drop + recreate those tables with
   corrected FK references in `beforeAll`.

4. **`SELF.fetch('/cdn-cgi/handler/email?...')` does NOT route to the email
   handler.** Pool-workers' `SELF` bypasses the `cdn-cgi` simulator layer.
   For email-only workers, import the worker module directly and call
   `worker.email!(msg, env, ctx)` with a forged
   `ForwardableEmailMessage`.

5. **For HTTP fetch workers, prefer `worker.fetch(req, env, ctx)` over
   `SELF.fetch()`.** `SELF` works for plain routing but doesn't preserve
   in-isolate binding overrides (e.g. setting
   `env.OUTBOUND_QUEUE = recorderStub`). Direct invocation keeps the
   override visible.

6. **`createMessageBatch` entry shape is undertyped.** Each message MUST
   include `id`, `timestamp`, `attempts`, AND `body`. Missing fields
   produce misleading error messages that name the wrong field.

7. **Per-test binding overrides via direct env mutation.** Pool-workers has
   no `getRecordedEmails()` helper. To capture `send_email` or queue
   producer sends, declare the binding statically in
   `wrangler.test.jsonc` and replace its value in-test:
   `(env as Record<string, unknown>).EMAIL_VERIFIED_TEST = stubBinding`.

8. **Bootstrap auth (signs with `POLARIS_SECRET_A`) must NOT carry
   `x-polaris-key-id`.** Routing in `services/api` branches on header
   presence; bootstrap requests with the api-key header end up in the
   wrong middleware.

9. **`POST /v1/messages` 202 response shape is
   `{message_id, status, fresh}`** — not `{id, status}`.

10. **Each `wrangler.test.jsonc` is test-only.** Production deploys consume
    `wrangler.jsonc`. The test variants use placeholder IDs
    (`test-local`, `test-local-kv-*`) — Miniflare simulates each binding
    per-test-file with isolated storage, so the IDs only need to be unique
    within the config, not real.

11. **Set up a `tsconfig.json` per `test/integration/` directory.** Without
    it, the package's root tsconfig (which only includes `src/**/*`)
    doesn't typecheck the integration tests, hiding real type errors.
    Reference `services/in/test/integration/tsconfig.json` for the
    canonical shape (extends the parent, adds
    `@cloudflare/vitest-pool-workers/types` to `types[]`).

12. **Module augmentation for `inject('migrations')`.** Add a `types.d.ts`
    declaring `ProvidedContext.migrations: D1Migration[]` so the inject
    call is typed.

13. **`services/api` integration `tsconfig` must scope `include` to only
    `*.workers.test.ts`.** A broad `../**/*.ts` glob picks up the
    pre-existing mock-backed `*.integration.test.ts` files which have
    benign TS errors the main tsconfig excludes.

### See also

- `services/in/test/integration/email-handler.workers.test.ts` — email
  handler pattern (direct `worker.email!` invocation).
- `services/out/test/integration/queue-consumer.workers.test.ts` — queue
  consumer + binding stub recorder.
- `services/api/test/integration/send-roundtrip.workers.test.ts` — HTTP
  roundtrip + bootstrap auth + `POST /v1/messages` flow.

## Editor setup

Install the [Oxc VS Code extension](https://marketplace.visualstudio.com/items?itemName=oxc.oxc).
The repo's `.vscode/settings.json` enables format-on-save with oxfmt.

## Git hooks

```bash
pnpm exec lefthook install
```

This registers a pre-commit hook running `oxlint` and `oxfmt --check` on staged
JS/TS/JSON files. See `lefthook.yml`.

## Pull requests

- CI must be green: `lint`, `fmt-check`, `typecheck`, `test`, `go-test`,
  `mail-bridge-test`, `openapi-validate`, `sql-validate`.
- Keep PRs scoped; foundation phases (schema, services pipeline, panel UI) each
  ship as their own commit per the architecture plan.
- Do not add `eslint`, `prettier`, or other rival tooling — the project uses
  Oxc exclusively.

See [Linting & formatting](/contributing/linting) for rule overrides and
the [Operators](/operators) section for runbooks and operational guidance.

<!-- Verified against: CONTRIBUTING.md @ 022520fd49a135eaf4685a09668439d58257ec95 -->
