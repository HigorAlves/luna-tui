# Luna's front door: `make setup` once, `make doctor` whenever something looks off.
# Every target is a script under scripts/setup/ (or a pnpm script), safe to run again.
SHELL := /bin/bash
.DEFAULT_GOAL := help
SETUP := scripts/setup

.PHONY: help doctor tools up down board

help: ## Show these targets
	@printf "\n\033[1;35m🌙 Luna\033[0m  make <target>\n\n"
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN { FS = ":.*## " } { printf "  \033[1;36m%-14s\033[0m %s\n", $$1, $$2 }'
	@echo

doctor: ## Check tools, credentials, integrations and the running machine
	@bash $(SETUP)/doctor.sh

tools: ## Install the tools Luna needs (Homebrew)
	@bash $(SETUP)/tools.sh

up: ## Build the stage images and start Postgres + the machine (pnpm start)
	@pnpm start

down: ## Stop the machine and Postgres, keeping their data
	@pnpm stop

board: ## Build the board and link it into herdr
	@pnpm board:link
