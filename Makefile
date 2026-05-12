# polaris-email — orchestration entrypoint.
# All real logic lives in bin/*.sh. This Makefile is a thin wrapper so
# every common operation has a single discoverable verb.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

ROOT := $(shell pwd)
BIN  := $(ROOT)/bin

.DEFAULT_GOAL := help

.PHONY: help preflight configure bootstrap deploy deploy-all deploy-changed \
        rollback smoke issue-key register-consumer bridge-up bridge-down \
        dns rotate-secret doctor tag-deployed state-rebuild

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
	@cd services/$(SERVICE) && wrangler rollback

smoke: ## End-to-end health check: /healthz, signed diagnostics, optional bridge, synthetic send.
	@$(BIN)/smoke.sh

issue-key: ## Issue an API key. NAME=acme SCOPES=mail:send[,...] [SENDER_SCOPES=...] [OUT=file:path].
	@if [ -z "$(NAME)" ] || [ -z "$(SCOPES)" ]; then echo "usage: make issue-key NAME=acme SCOPES=mail:send" >&2; exit 2; fi
	@$(BIN)/issue-key.sh --name "$(NAME)" --scopes "$(SCOPES)" $(if $(SENDER_SCOPES),--sender-scopes "$(SENDER_SCOPES)") $(if $(OUT),--out "$(OUT)")

register-consumer: ## Register a webhook consumer. NAME=acme WEBHOOK=https://... KIND=external EVENTS=delivered,bounced.
	@if [ -z "$(NAME)" ] || [ -z "$(WEBHOOK)" ] || [ -z "$(KIND)" ] || [ -z "$(EVENTS)" ]; then \
		echo "usage: make register-consumer NAME=acme WEBHOOK=https://... KIND=external EVENTS=delivered,bounced" >&2; exit 2; fi
	@$(BIN)/register-consumer.sh --name "$(NAME)" --webhook-url "$(WEBHOOK)" --kind "$(KIND)" --events "$(EVENTS)"

bridge-up: ## Bring the Mox+sidecar bridge up on this host (requires Tailscale auth key in .env.deploy).
	@$(BIN)/bridge-up.sh

bridge-down: ## Stop the bridge containers without removing volumes.
	@cd apps/bridge && docker compose stop

dns: ## Print (or with APPLY=1, apply) the DNS records for DOMAIN. usage: make dns DOMAIN=example.com [APPLY=1].
	@if [ -z "$(DOMAIN)" ]; then echo "usage: make dns DOMAIN=example.com" >&2; exit 2; fi
	@$(BIN)/dns-records.sh $(if $(filter 1,$(APPLY)),--apply) $(DOMAIN)

rotate-secret: ## Two-phase rotation of POLARIS_SECRET_A. NAME=POLARIS_SECRET_A.
	@if [ -z "$(NAME)" ]; then echo "usage: make rotate-secret NAME=POLARIS_SECRET_A" >&2; exit 2; fi
	@$(BIN)/rotate-secret.sh --name "$(NAME)"

doctor: ## Re-run preflight + smoke + secret-age check against the live stack.
	@$(BIN)/preflight.sh
	@$(BIN)/smoke.sh
	@$(BIN)/rotate-secret.sh --name POLARIS_SECRET_A --check-only || true

tag-deployed: ## Move the deployed/main git tag to HEAD (used by CI after a successful deploy).
	@git tag -f deployed/main HEAD
	@echo "tagged deployed/main at $$(git rev-parse HEAD)"

state-rebuild: ## Reconstruct .deploy-state.json from live Cloudflare resources (DR). [--dry-run via DRY=1]
	@$(BIN)/state-rebuild.sh $(if $(filter 1,$(DRY)),--dry-run)
