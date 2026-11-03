#!/usr/bin/env bash
# doctor.sh - what this Mac has and lacks to run Luna: tools, credentials, integrations, the
# images and the machine. Reads only; never prints a secret. Exits 1 when something required is missing.
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
rust_path

MISSING=0
ok()    { echo -e "  ${GREEN}${CHECK}${NC} $1${2:+ ${CYAN}$2${NC}}"; }
off()   { echo -e "  ${YELLOW}–${NC} $1${2:+ ${YELLOW}$2${NC}}"; }
bad()   { echo -e "  ${RED}${CROSS}${NC} $1${2:+ ${RED}$2${NC}}"; MISSING=$((MISSING + 1)); }
section() { echo; colorize "$BOLD_WHITE" "$1"; }

ui_header "Luna doctor" "$ROOT"

section "Tools"
while IFS='|' read -r name cmd _ required why; do
  if tool_ok "$name" "$cmd"; then ok "$name" "$(tool_version "$cmd")"
  elif [ "$required" = yes ]; then bad "$name" "missing: $why"
  else off "$name" "not installed: $why"; fi
done <<<"$TOOLS"
if command -v docker &>/dev/null; then
  if docker_running; then ok "docker daemon" "running"; else bad "docker daemon" "not running: open Docker Desktop"; fi
fi
if command -v gh &>/dev/null; then
  if gh auth status &>/dev/null; then ok "gh login" "$(gh api user -q .login 2>/dev/null)"; else bad "gh login" "run: gh auth login"; fi
fi

section "Credentials ($CONFIG_DIR)"
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] || cred_present claude-oauth-token || cred_present anthropic-api-key; then
  ok "claude:*" "Claude credential"
else bad "claude:*" "no claude-oauth-token: make credentials"; fi
if [ -s "$CODEX_AUTH" ]; then ok "codex:*" "Codex login"; else off "codex:*" "no Codex login (codex login)"; fi
if [ -n "${OPENAI_API_KEY:-}" ] || cred_present openai-api-key; then ok "openai:*" "OpenAI key"; else off "openai:*" "no OpenAI key (optional, metered)"; fi
if [ -n "${AI_GATEWAY_API_KEY:-}${TYPESAFE_API_KEY:-}" ] || cred_present ai-gateway-api-key || cred_present typesafe-api-key; then
  ok "jev" "Gateway or TypeSafe key"
else off "jev" "no key: intake classification is off"; fi
if [ -n "${MACHINE_API_TOKEN:-}" ] || cred_present machine-api-token; then ok "machine API token"; else bad "machine API token" "make credentials"; fi

section "Integrations ($ENV_FILE)"
if [ -n "$(env_get MACHINE_JIRA_SITE)" ] && [ -n "$(env_get MACHINE_JIRA_EMAIL)" ] && [ -n "$(env_get MACHINE_JIRA_TOKEN)" ]; then
  ok "Jira" "$(env_get MACHINE_JIRA_SITE)"
  expires=$(env_get MACHINE_JIRA_TOKEN_EXPIRES)
  [ -n "$expires" ] && ok "Jira token expires" "$expires"
else off "Jira" "not set: make integrations"; fi
if [ -n "$(env_get MACHINE_SLACK_USER_TOKEN)" ]; then
  if [ -n "$(env_get MACHINE_SLACK_APP_TOKEN)" ]; then ok "Slack inbox" "live socket"; else ok "Slack inbox" "polling (no app token)"; fi
else off "Slack inbox" "not set: make integrations"; fi

section "Running"
if docker_running; then
  for image in hardness-runner:dev hardness-runner-qa:dev; do
    if docker image inspect "$image" &>/dev/null; then ok "$image"; else off "$image" "not built: pnpm images"; fi
  done
fi
port="$(env_get MACHINE_DOCKER_PORT)"; port="${port:-4318}"
token="${MACHINE_API_TOKEN:-$(tr -d '[:space:]' <"$CONFIG_DIR/machine-api-token" 2>/dev/null)}"
# The header from a file descriptor, so the token is never in curl's argv.
if curl -fsS -m 3 -H @<(printf 'authorization: Bearer %s\n' "$token") "http://127.0.0.1:$port/health" &>/dev/null; then
  ok "machine" "http://127.0.0.1:$port"
else off "machine" "not answering on :$port (make up)"; fi
if command -v herdr &>/dev/null && herdr plugin list 2>/dev/null | grep -q '^- hardness.board '; then ok "board" "linked in herdr"; else off "board" "not linked (make board)"; fi

echo
if [ "$MISSING" -eq 0 ]; then success "Ready."; else error "$MISSING required item(s) missing. make setup walks you through them."; exit 1; fi
