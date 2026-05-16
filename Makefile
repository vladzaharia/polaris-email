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
        rollback smoke doctor tag-deployed state-rebuild

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
