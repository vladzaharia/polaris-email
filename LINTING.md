# Linting & formatting

Polaris uses the [Oxc](https://oxc.rs) toolchain:

- **[oxlint](https://oxc.rs/docs/guide/usage/linter.html)** — fast Rust-based linter, ESLint-compatible config (`.oxlintrc.json`).
- **[oxfmt](https://oxc.rs/docs/guide/usage/formatter.html)** — Prettier-compatible formatter (`.oxfmtrc.json`).

## Commands

```
pnpm lint          # lint the whole repo (warnings ok, errors fail)
pnpm lint:fix      # auto-fix what can be fixed
pnpm fmt           # format in place
pnpm fmt:check     # CI-style check, no writes
pnpm check         # typecheck + lint + fmt:check
```

CI runs `lint` and `fmt:check` as required jobs.

## Pre-commit

`lefthook.yml` configures a pre-commit hook running `oxlint` and `oxfmt --check`
on staged JS/TS/JSON files. Activate it after cloning:

```
pnpm exec lefthook install
```

## Editor (VS Code)

Install the [Oxc extension](https://marketplace.visualstudio.com/items?itemName=oxc.oxc).
`.vscode/settings.json` wires it as default formatter with format-on-save.

## Scoped rule overrides

Documented in `.oxlintrc.json`:

| Scope                               | Rule changes                                           | Reason                                                                                          |
| ----------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `**/test/**`, `**/*.test.ts`        | `typescript/no-explicit-any` → off, `no-console` → off | Tests routinely cast to `any` for mocks and log to aid debugging.                               |
| `services/in/**`, `services/out/**` | `typescript/no-floating-promises` → warn               | Workers handlers commonly fire-and-forget logging / metrics via `ctx.waitUntil`-adjacent paths. |
| `**/generated/**`                   | all rules empty (no extra constraints)                 | Generated code is not hand-edited; do not noise diffs.                                          |

## Per-rule notes

- `import/no-unresolved` was requested in the plan but is **not** implemented in
  oxlint's `import` plugin (only ESLint's full plugin has it). TypeScript's
  `moduleResolution` already catches unresolved imports at `pnpm typecheck`, so
  this rule is omitted from `.oxlintrc.json`. Re-add if oxlint ports it.

## Currently allowed warnings

Run `pnpm lint`; warnings are tolerated and not blocking. Current warnings:

- `services/api/src/auth.ts` — two `typescript/no-explicit-any` warnings on
  `c.req as any` body caching shim; planned cleanup once Hono types expose a
  cached-body API.
- `services/api/src/index.ts` — one `no-console` warning in the `onError`
  handler for top-level error visibility.

No bulk-disables; no `// oxlint-disable` directives present in the tree.
