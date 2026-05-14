#!/usr/bin/env bash
# Regenerate all three SDK surfaces from openapi/polaris-email.yaml.
#
# Each step is optional — if the toolchain is missing the step warns and
# continues. CI's `sdk-regen-check` job installs everything before running.
#
# Run from anywhere: paths are resolved relative to the script.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/.."

step() { printf '\n==> %s\n' "$1"; }
warn() { printf 'WARN: %s\n' "$1" >&2; }

step "TypeScript (Hey API → packages/sdk-node/src/generated)"
if command -v pnpm >/dev/null 2>&1 && [ -d node_modules/@hey-api/openapi-ts ]; then
  pnpm exec hey-api-openapi-ts --config configs/hey-api.config.ts || warn "hey-api failed"
else
  warn "@hey-api/openapi-ts not installed; skipping TS regen (run pnpm install --filter @polaris/sdk-codegen first)"
fi

step "Python (openapi-generator-cli → packages/sdk-python/polaris_sdk/generated)"
if command -v pnpm >/dev/null 2>&1 && [ -d node_modules/@openapitools/openapi-generator-cli ]; then
  pnpm exec openapi-generator-cli generate -g python -c configs/openapi-python.yaml \
    -i ../../openapi/polaris-email.yaml -o ../sdk-python/polaris_sdk/generated || warn "openapi-generator failed (Java JRE required)"
else
  warn "@openapitools/openapi-generator-cli not installed; skipping Python regen"
fi

step "Go (oapi-codegen → packages/sdk-go/generated.go)"
if command -v oapi-codegen >/dev/null 2>&1; then
  oapi-codegen -config configs/openapi-go.yaml ../../openapi/polaris-email.yaml
elif command -v go >/dev/null 2>&1; then
  go run github.com/deepmap/oapi-codegen/v2/cmd/oapi-codegen@latest \
    -config configs/openapi-go.yaml ../../openapi/polaris-email.yaml || warn "oapi-codegen (via go run) failed"
else
  warn "Neither oapi-codegen nor go available; skipping Go regen"
fi

step "Done. Diff summary:"
( cd ../.. && git diff --stat packages/sdk-node packages/sdk-python packages/sdk-go || true )
