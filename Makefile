# Luna's front door: `make setup` once, `make doctor` whenever something looks off.
# Every target is a script under scripts/setup/ (or a pnpm script), safe to run again.
SHELL := /bin/bash
.DEFAULT_GOAL := help
SETUP := scripts/setup

.PHONY: help setup doctor tools credentials integrations luna-yaml up down board

help: ## Show these targets
	@LUNA_NO_ANIMATION=1 bash -c 'source $(SETUP)/helpers/banner.sh && banner_show "make <target>"'
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN { FS = ":.*## " } { printf "  \033[1;36m%-14s\033[0m %s\n", $$1, $$2 }'
	@echo

setup: ## Everything, step by step: tools, credentials, integrations, the machine, the board, your repos
	@bash $(SETUP)/setup.sh

doctor: ## Check tools, credentials, integrations and the running machine
	@bash $(SETUP)/doctor.sh

tools: ## Install the tools Luna needs (Homebrew)
	@bash $(SETUP)/tools.sh

credentials: ## Engine credentials (Claude, Codex, OpenAI, Jev), the API token, GitHub
	@bash $(SETUP)/credentials.sh

integrations: ## Jira, the Slack inbox and machine settings, into .env
	@bash $(SETUP)/integrations.sh

luna-yaml: ## Write or update a repo's luna.yaml (make luna-yaml REPO=~/Developer/app)
	@bash $(SETUP)/luna-yaml.sh $(REPO)

up: ## Build the stage images and start Postgres + the machine (pnpm start)
	@pnpm start

down: ## Stop the machine and Postgres, keeping their data
	@pnpm stop

board: ## Build the board and link it into herdr
	@pnpm board:link
