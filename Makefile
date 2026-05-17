# polaris-email — orchestration entrypoint.
#
# Orchestration commands have moved to the polaris-email Go CLI.
#
#   make bootstrap        → polaris-email setup infra
#   make preflight        → polaris-email setup infra preflight
#   make configure        → polaris-email setup infra configure
#   make deploy           → polaris-email setup infra deploy
#   make deploy-changed   → polaris-email setup infra deploy changed
#   make rollback         → polaris-email setup infra rollback
#   make smoke            → polaris-email setup infra smoke
#   make state-rebuild    → polaris-email setup infra state rebuild
#
# Install the CLI with:
#   curl -fsSL cli.mail.plrs.im | sh
#
# Day-to-day operator workflows (issue keys, onboard domains, rotate creds,
# replay DLQ) also live in the `polaris-email` CLI — see
# apps/polaris-cli/README.md.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

ROOT := $(shell pwd)

.DEFAULT_GOAL := help

.PHONY: help tag-deployed

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make \033[36m<target>\033[0m [VAR=value...]\n\nTargets:\n"} \
		/^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf '\nOrchestration commands now live in the polaris-email Go CLI:\n'
	@printf '  make bootstrap        → polaris-email setup infra\n'
	@printf '  make preflight        → polaris-email setup infra preflight\n'
	@printf '  make configure        → polaris-email setup infra configure\n'
	@printf '  make deploy           → polaris-email setup infra deploy\n'
	@printf '  make deploy-changed   → polaris-email setup infra deploy changed\n'
	@printf '  make rollback         → polaris-email setup infra rollback\n'
	@printf '  make smoke            → polaris-email setup infra smoke\n'
	@printf '  make state-rebuild    → polaris-email setup infra state rebuild\n\n'
	@printf 'Install the CLI: curl -fsSL cli.mail.plrs.im | sh\n'

tag-deployed: ## Move the deployed/main git tag to HEAD (used by CI after a successful deploy).
	@git tag -f deployed/main HEAD
	@echo "tagged deployed/main at $$(git rev-parse HEAD)"
