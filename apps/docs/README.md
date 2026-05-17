# @polaris-email/docs

Source for [docs.mail.plrs.im](https://docs.mail.plrs.im) — the polaris-email
documentation site.

Docusaurus v3 static build served by a thin Hono Worker via the
Workers Assets binding (same shape as `apps/panel`). The Worker adds CSP
headers, a `/healthz` probe, and a legacy-URL redirect table.

## Status

**PR 11** ships scaffolding only: the IA skeleton (7 top-level sections),
placeholder pages, and the Worker shell. The content migration lands in
PR 12.

## Local development

```sh
pnpm install
pnpm --filter @polaris-email/docs run docs:start    # Docusaurus dev server
pnpm --filter @polaris-email/docs run build:client  # static build into ./build
pnpm --filter @polaris-email/docs run dev:server    # wrangler dev (serves ./build)
```

## Deploy

```sh
make deploy SERVICE=apps/docs
```
