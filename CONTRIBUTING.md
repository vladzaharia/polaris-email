# Contributing to polaris-email

## Toolchain

- Node 22+ via [Volta](https://volta.sh) or [fnm](https://github.com/Schniz/fnm).
- pnpm 9 (`corepack enable && corepack prepare pnpm@9 --activate`).
- Cloudflare Wrangler for Workers (`pnpm dlx wrangler ...`).

## Common commands

```
pnpm install
pnpm -r run build
pnpm -r run typecheck
pnpm -r run test

# Lint + format (Oxc toolchain — see LINTING.md)
pnpm lint
pnpm fmt
pnpm check     # typecheck + lint + fmt:check
```

## Editor setup

Install the [Oxc VS Code extension](https://marketplace.visualstudio.com/items?itemName=oxc.oxc).
The repo's `.vscode/settings.json` enables format-on-save with oxfmt.

## Git hooks

```
pnpm exec lefthook install
```

This registers a pre-commit hook running `oxlint` and `oxfmt --check` on staged
JS/TS/JSON files. See `lefthook.yml`.

## Pull requests

- CI must be green: `lint`, `fmt-check`, `typecheck`, `test`, `go-test`,
  `python-test`, `openapi-validate`, `sql-validate`.
- Keep PRs scoped; foundation phases (schema, services pipeline, panel UI) each
  ship as their own commit per the architecture plan.
- Do not add `eslint`, `prettier`, or other rival tooling — the project uses
  Oxc exclusively.

See `LINTING.md` for rule overrides and `docs/runbooks/` for operational guidance.
