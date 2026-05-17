# polaris-email — orchestration entrypoint.
# Bootstrap, deploy, smoke, rollback, kill-switch only. Day-to-day operator
# workflows (issue-key, register-consumer, onboard, rotate-secret, …) live in
# the `polaris-email` Go CLI — see apps/polaris-cli/README.md.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

ROOT := $(shell pwd)
BIN  := $(ROOT)/bin

.DEFAULT_GOAL := help

.PHONY: help preflight configure bootstrap deploy deploy-all deploy-changed \
        deploy-changed-go rollback smoke doctor tag-deployed state-rebuild parity compare-render

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make \033[36m<target>\033[0m [VAR=value...]\n\nTargets:\n"} \
		/^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

preflight: ## Verify required tools and env (pnpm, wrangler login, jq, openssl, .env.deploy).
	@$(BIN)/preflight.sh

configure: ## Interactively (re)build .env.deploy and re-render wrangler.local.jsonc files.
	@$(BIN)/configure.sh

bootstrap: ## Cold-start: preflight -> configure (if needed) -> create CF resources -> deploy -> admin key.
	@$(BIN)/preflight.sh
	@if [ ! -f $(ROOT)/.env.deploy ]; then $(BIN)/configure.sh; fi
	@$(BIN)/bootstrap.sh

deploy: ## Deploy a single service (SERVICE=services/api). Alias for bin/deploy.sh.
	@if [ -z "$(SERVICE)" ]; then echo "usage: make deploy SERVICE=services/api" >&2; exit 2; fi
	@$(BIN)/deploy.sh $(SERVICE)

deploy-all: ## Deploy every service in dependency order.
	@$(BIN)/deploy.sh --all

deploy-changed: ## Deploy only services whose code (or transitive package deps) changed since the last deploy SHA.
	@$(BIN)/deploy.sh --changed

# Go-native equivalent of deploy-changed. PR 5 ships both side-by-side
# during the soak window; CI runs `deploy-changed` then `deploy-changed-go`
# in --dry-run-like read modes and asserts identical plan output before
# PR 14 retires the shell.
deploy-changed-go: ## Run the Go `setup infra deploy changed` (PR 5 transition).
	@$(ROOT)/apps/polaris-cli/bin/polaris-email setup infra deploy changed

rollback: ## Roll back one service (SERVICE=api) to the previous Worker version using wrangler rollback.
	@if [ -z "$(SERVICE)" ]; then echo "usage: make rollback SERVICE=api" >&2; exit 2; fi
	@bash -c 'source $(BIN)/_lib.sh && cd "$$(polaris_service_path $(SERVICE))" && wrangler rollback'

smoke: ## End-to-end health check: /healthz, signed diagnostics, synthetic send.
	@$(BIN)/smoke.sh

doctor: ## Re-run preflight + smoke against the live stack.
	@$(BIN)/preflight.sh
	@$(BIN)/smoke.sh

tag-deployed: ## Move the deployed/main git tag to HEAD (used by CI after a successful deploy).
	@git tag -f deployed/main HEAD
	@echo "tagged deployed/main at $$(git rev-parse HEAD)"

state-rebuild: ## Reconstruct .deploy-state.json from live Cloudflare resources (DR). [--dry-run via DRY=1]
	@$(BIN)/state-rebuild.sh $(if $(filter 1,$(DRY)),--dry-run)

# parity: a CI gate that diffs the legacy shell preflight against the Go port.
# Both implementations must agree on whether the environment passes; without
# this gate the two flows can quietly drift apart. We compare *summary
# counts* (pass/warn/fail), not free-text output — the table renderer is
# allowed to differ in cosmetic ways, but the operator-visible verdict cannot.
# Exit codes: 0 on agreement, 1 on divergence.
#
# Requires `apps/polaris-cli/bin/polaris-email` to be built (run `make build`
# inside apps/polaris-cli first if not).
parity: ## Diff legacy bin/preflight.sh against `polaris-email setup infra preflight` (CI gate).
	@SHELL_LOG=$$(mktemp); GO_LOG=$$(mktemp); \
	  $(BIN)/preflight.sh > $$SHELL_LOG 2>&1; shell_rc=$$?; \
	  $(ROOT)/apps/polaris-cli/bin/polaris-email setup infra preflight \
	    --no-cf-probe --no-b2-probe -o json > $$GO_LOG 2>&1; go_rc=$$?; \
	  shell_fails=$$(grep -c '^  FAIL' $$SHELL_LOG || true); \
	  go_fails=$$(jq -r '.summary.fail' $$GO_LOG 2>/dev/null || echo "?"); \
	  echo "parity: shell exit=$$shell_rc fails=$$shell_fails  go exit=$$go_rc fails=$$go_fails"; \
	  if [ "$$shell_rc" -eq 0 ] && [ "$$go_rc" -eq 0 ]; then \
	    echo "PARITY OK: both flows pass."; rc=0; \
	  elif [ "$$shell_rc" -ne 0 ] && [ "$$go_rc" -ne 0 ]; then \
	    echo "PARITY OK: both flows fail."; rc=0; \
	  else \
	    echo "PARITY MISMATCH: shell-rc=$$shell_rc go-rc=$$go_rc"; \
	    echo "--- shell log ---"; cat $$SHELL_LOG; \
	    echo "--- go log ---"; cat $$GO_LOG; rc=1; \
	  fi; \
	  rm -f $$SHELL_LOG $$GO_LOG; exit $$rc

compare-render: ## Diff the Go renderer's output against the legacy envsubst path for every service (parity gate; PR 14 retires).
	@$(BIN)/compare-render.sh
