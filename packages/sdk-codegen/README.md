# @polaris/sdk-codegen

Tooling-only package. Regenerates the three published SDKs from
`openapi/polaris-email.yaml`:

| Target package          | Path                                         | Generator              |
| ----------------------- | -------------------------------------------- | ---------------------- |
| `@polaris/sdk` (TS)     | `packages/sdk-node/src/generated/`           | Hey API                |
| `polaris-sdk` (Python)  | `packages/sdk-python/polaris_sdk/generated/` | `openapi-generator-cli` |
| `polaris-sdk-go` (Go)   | `packages/sdk-go/generated.go`               | `oapi-codegen`         |

## When to regen

Whenever `openapi/polaris-email.yaml` changes. CI has an
`sdk-regen-check` job that runs `bin/regen.sh` and `git diff --exit-code` —
if you forget, CI fails.

## How to regen

```bash
pnpm install
pnpm --filter @polaris/sdk-codegen run generate
```

The script is `bin/regen.sh`. Each generator step is independent and warns
(instead of failing the script) if its toolchain is missing, so partial
regenerations are possible during local iteration.

### Toolchain caveats

- **Hey API** — pure node, runs anywhere `pnpm` does.
- **openapi-generator-cli** — Java-based. CI installs a JRE. Local dev needs
  Java 11+; the cli will auto-fetch the generator JAR on first run (network
  required).
- **oapi-codegen** — a Go binary. `bin/regen.sh` falls back to
  `go run github.com/deepmap/oapi-codegen/v2/cmd/oapi-codegen@latest`
  when the binary isn't on PATH, so any machine with Go installed works.

If a developer's machine lacks one of the toolchains, they should regenerate
on a CI runner (or another machine) before pushing. The `sdk-regen-check`
job is the source of truth.

## What's hand-written vs generated

| Package         | Hand-written                                              | Generated                              |
| --------------- | --------------------------------------------------------- | -------------------------------------- |
| `@polaris/sdk`  | `src/index.ts` (`Polaris` client class), `src/webhook.ts` (`verifyWebhook`), `src/node.ts` (file uploads), `src/react.ts` (placeholder) | `src/generated/index.ts` (types + low-level fetch client) |
| `polaris-sdk`   | `polaris_sdk/webhook.py` (`verify_webhook`), `polaris_sdk/__init__.py` | `polaris_sdk/generated/` (httpx client + Pydantic models) |
| `polaris-sdk-go`| `webhook.go` (`VerifyWebhook`), `client.go` (HMAC `Client`) | `generated.go` (types + low-level operations) |

The hand-written verifier mirrors the canonical-string algorithm from
`packages/schema` + `services/api` and accepts both `v1=` and `v2=` signature
tags. The v2 tag is the format the fanout worker emits today; v1 is kept on
the allowlist so subscribers can verify old deliveries.

## Test vectors

All three verifiers share `packages/test-vectors/vectors.json`. Regen the
vectors with `pnpm --filter @polaris-email/test-vectors run generate` —
the SDK tests load the JSON directly so any drift between generator and
verifier shows up immediately.
