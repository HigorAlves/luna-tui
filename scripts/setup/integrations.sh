#!/usr/bin/env bash
# integrations.sh - Jira, the Slack inbox and the machine's own settings, written to the root .env
# (0600), which compose reads for `pnpm start`; machine/.env links to it for `pnpm dev`. Each
# answer left empty keeps what is there, and each set of keys is tried against its service.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# keep_or_set KEY "Prompt" [default] [placeholder]: asks with the current value, else the default, filled in.
keep_or_set() {
  local current value
  current=$(env_get "$1")
  value=$(ui_input "$2" "${current:-${3:-}}" "${4:-}")
  [ -n "$value" ] && env_set "$1" "$value"
  return 0
}

# keep_or_paste KEY "Prompt": a secret; empty keeps the current one.
keep_or_paste() {
  local value hint=""
  [ -n "$(env_get "$1")" ] && hint=" (enter keeps the current one)"
  value=$(ui_secret "$2$hint")
  [ -n "$value" ] && env_set "$1" "$(printf '%s' "$value" | tr -d '[:space:]')"
  return 0
}

jira() {
  ui_section "Jira"
  info "Make an API token at https://id.atlassian.com/manage-profile/security/api-tokens (unscoped, up to a year)."
  keep_or_set MACHINE_JIRA_SITE "Jira site" "" "https://your-site.atlassian.net"
  keep_or_set MACHINE_JIRA_EMAIL "Your Atlassian email" "$(git config user.email 2>/dev/null)"
  keep_or_paste MACHINE_JIRA_TOKEN "Jira API token"
  local expires
  expires=$(ui_input "When the token expires (YYYY-MM-DD, so the machine warns you)" "$(env_get MACHINE_JIRA_TOKEN_EXPIRES)")
  if [[ "$expires" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then env_set MACHINE_JIRA_TOKEN_EXPIRES "$expires"
  elif [ -n "$expires" ]; then warn "Not a YYYY-MM-DD date; MACHINE_JIRA_TOKEN_EXPIRES left as it was."; fi

  local site name
  site=$(env_get MACHINE_JIRA_SITE)
  # The credentials through curl's config on a file descriptor, never in its argv.
  name=$(curl -fsS -m 10 -K <(printf 'user = "%s:%s"\n' "$(env_get MACHINE_JIRA_EMAIL)" "$(env_get MACHINE_JIRA_TOKEN)") \
    "${site%/}/rest/api/3/myself" 2>/dev/null | json_get 'j.displayName') || true
  if [ -n "$name" ]; then success "Jira answers: signed in as $name"; else warn "Jira did not accept these; check the site, email and token (make integrations again)."; fi
  info "Each repo then says what Jira does for it in its luna.yaml: make luna-yaml REPO=<path>"
}

slack() {
  ui_section "Slack inbox"
  info "One-time Slack app, only in your workspace:"
  echo "  1. https://api.slack.com/apps → Create New App → From a manifest → paste slack/manifest.json"
  echo "  2. Install to Workspace; copy the User OAuth Token (xoxp-…) from OAuth & Permissions"
  echo "  3. Basic Information → App-Level Tokens → one with connections:write (xapp-…)"
  if ui_confirm "Open api.slack.com/apps now?"; then open "https://api.slack.com/apps" 2>/dev/null || true; fi
  keep_or_paste MACHINE_SLACK_USER_TOKEN "User OAuth Token (xoxp-…)"
  keep_or_paste MACHINE_SLACK_APP_TOKEN "App-level token (xapp-…, optional: live reactions and replies)"

  local who
  who=$(curl -fsS -m 10 -H @<(printf 'authorization: Bearer %s\n' "$(env_get MACHINE_SLACK_USER_TOKEN)") https://slack.com/api/auth.test 2>/dev/null |
    json_get 'j.ok && j.user + " on " + j.team') || true
  if [ -n "$who" ]; then success "Slack answers: $who"; else warn "Slack did not accept the user token; check it (make integrations again)."; fi
  info "Then press S on the board, and W to add the handles and channels addressed to you."
}

machine_settings() {
  ui_section "Machine settings"
  keep_or_set LUNA_REPOS_DIR "Where your repos live (mounted into the machine; worktrees go under it)" "$HOME/Developer"
  info "Monthly caps per engine or credential, as key=usd pairs (codex=0,openai=20,jev=5). Empty: no caps."
  keep_or_set MACHINE_ENGINE_BUDGETS "Engine budgets" "" "codex=0,openai=20,jev=5"
  keep_or_set MACHINE_DAILY_BUDGET_USD "Daily spend ceiling in USD (empty: none)"
}

ui_header "Integrations" "Written to $ENV_FILE (0600). Empty answers keep what is there."
picked=$(ui_choose_many "What should the machine connect to?" "" "Jira" "Slack inbox" "Machine settings")
grep -qx "Jira" <<<"$picked" && jira
grep -qx "Slack inbox" <<<"$picked" && slack
grep -qx "Machine settings" <<<"$picked" && machine_settings
[ -z "$picked" ] && info "Nothing picked; run make integrations any time."

# `pnpm dev` runs the machine on the host, which reads machine/.env: point it at the same file.
if [ -f "$ENV_FILE" ] && [ "$ENV_FILE" = "$ROOT/.env" ] && [ ! -e "$ROOT/machine/.env" ]; then
  ln -s ../.env "$ROOT/machine/.env" && info "Linked machine/.env to .env for pnpm dev"
fi
if [ -n "$picked" ]; then info "The machine reads these when it starts: make up (or restart it) to apply."; fi
