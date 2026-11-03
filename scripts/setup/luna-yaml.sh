#!/usr/bin/env bash
# luna-yaml.sh - writes or updates a repo's luna.yaml by asking: Jira, engines, policy, budgets and
# SLAs. Answers go through machine/scripts/luna-yaml.ts, which validates them as the machine reads
# the file and keeps an existing file's comments. Checks and services are proposed and proven by
# the board's `:setup <repo>` instead. No secret goes in this file: it is committed with the repo.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

LUNA_YAML_TS="$ROOT/machine/scripts/luna-yaml.ts"
ANSWERS=$(mktemp)
NEW=$(mktemp)
trap 'rm -f "$ANSWERS" "$NEW" "${CURRENT:-}"' EXIT

repo="${1:-${REPO:-}}"
[ -n "$repo" ] || repo=$(ui_input "Path to the repo" "$PWD")
repo="${repo/#\~/$HOME}"
[ -d "$repo/.git" ] || [ -f "$repo/.git" ] || { error "$repo is not a git checkout"; exit 1; }
repo=$(cd "$repo" && pwd)

CURRENT=$(mktemp)
node "$LUNA_YAML_TS" dump --repo "$repo" >"$CURRENT"
# now KEY: the file's current value at a path, empty when unset.
now() { grep -E "^$(printf '%s' "$1" | sed 's/[.[\*^$]/\\&/g')=" "$CURRENT" | head -n 1 | cut -d= -f2- || true; }
# now_or KEY SUGGESTION: the current value, else the suggestion, as a prompt's default.
now_or() { local v; v=$(now "$1"); printf '%s' "${v:-$2}"; }
answer() { printf '%s=%s\n' "$1" "$2" >>"$ANSWERS"; }

if [ -f "$repo/luna.yaml" ]; then
  ui_header "luna.yaml" "Updating $repo/luna.yaml; sections you skip stay as they are."
else
  ui_header "luna.yaml" "Writing $repo/luna.yaml."
fi
info "Checks and services: press : on the board and run setup $(basename "$repo"); an agent proposes them and proves each one."

# Jira statuses of a project, one per line, when integrations has the Jira keys.
jira_statuses() {
  local site
  site=$(env_get MACHINE_JIRA_SITE)
  [ -n "$site" ] && [ -n "$(env_get MACHINE_JIRA_TOKEN)" ] || return 0
  curl -fsS -m 10 -K <(printf 'user = "%s:%s"\n' "$(env_get MACHINE_JIRA_EMAIL)" "$(env_get MACHINE_JIRA_TOKEN)") \
    "${site%/}/rest/api/3/project/$1/statuses" 2>/dev/null |
    json_get '[...new Set(j.flatMap((t) => t.statuses.map((s) => s.name)))].join("\n")' || true
}

jira() {
  ui_section "Jira"
  local project state status
  project=$(ui_input "Jira project key" "$(now jira.project)" "PLAT")
  [ -n "$project" ] || { warn "No project: Jira skipped."; return; }
  answer jira.project "$project"
  if ui_confirm "Import issues from Jira as tickets (intake)?" "$([ -n "$(now jira.intake.jql)" ] && echo yes || echo no)"; then
    answer jira.intake.jql "$(ui_input "Which issues (JQL)" "$(now_or jira.intake.jql "project = $project AND labels = luna AND status = Ready")")"
    answer jira.intake.every "$(ui_input "How often to look" "$(now_or jira.intake.every 5m)")"
  else
    answer jira.intake ""
  fi
  # Status names have spaces (In Progress): one array entry per line.
  statuses=()
  while IFS= read -r status; do [ -n "$status" ] && statuses+=("$status"); done < <(jira_statuses "$project")
  if [ ${#statuses[@]} -gt 0 ]; then success "Read $project's statuses from Jira"
  else info "Type the Jira status names as your workflow spells them (with make integrations done, the wizard lists them)."; fi
  answer jira.on ""
  for state in triage implementing awaiting_ship closed escalated; do
    if [ ${#statuses[@]} -gt 0 ]; then
      status=$(ui_choose "When a task enters $state, move the issue to" "(leave it)" "${statuses[@]}") || status="(leave it)"
      [ "$status" = "(leave it)" ] && status=""
    else
      status=$(ui_input "When a task enters $state, move the issue to (empty: leave it)" "$(now "jira.on.$state")")
    fi
    [ -n "$status" ] && answer "jira.on.$state" "$status"
  done
  answer jira.comments "$(ui_choose "Comments on the issue" milestones gates none)"
  answer jira.branch "$(ui_input "Branch pattern ({type}, {key}, {id}, {slug})" "$(now_or jira.branch "{type}/{key}")")"
}

engines() {
  ui_section "Engines"
  local pack def options pick line packs=()
  # Read the list first: a prompt inside a loop fed by it would read the list, not you.
  while IFS= read -r line; do packs+=("$line"); done < <(node "$LUNA_YAML_TS" engines)
  for line in ${packs[@]+"${packs[@]}"}; do
    IFS='|' read -r pack def options <<<"$line"
    # Engine ids have no spaces: split the list on purpose.
    # shellcheck disable=SC2046
    pick=$(ui_choose "$pack runs on" $(tr ',' ' ' <<<"$options"))
    # The pack's default is no key at all, so a later change of default reaches this repo too.
    if [ "$pick" = "$def" ]; then answer "engines.$pack" ""; else answer "engines.$pack" "$pick"; fi
  done
}

policy() {
  ui_section "Policy (empty removes a key)"
  answer policy.qa "$(ui_choose "End-to-end QA in a browser" web none)"
  answer policy.monthly_budget_usd "$(ui_input "This repo's monthly budget in USD" "$(now policy.monthly_budget_usd)")"
  answer policy.max_concurrent "$(ui_input "Tasks this repo may run at once" "$(now policy.max_concurrent)")"
  answer policy.auto_approve_plan_minutes "$(ui_input "Approve a high-confidence, low-risk plan by itself after (minutes)" "$(now policy.auto_approve_plan_minutes)")"
}

budgets() {
  ui_section "Engine budgets for this repo"
  local caps pair
  caps=$(ui_input "Monthly caps as key=usd pairs (openai:sol=10,codex=0; never Claude)" "$(grep -E '^budget\.engines\.' "$CURRENT" | sed 's/^budget\.engines\.//' | paste -sd, - || true)")
  answer budget.engines ""
  for pair in ${caps//,/ }; do answer "budget.engines.${pair%%=*}" "${pair#*=}"; done
}

sla() {
  ui_section "SLAs (30m, 4h, 3d or off; empty removes)"
  answer sla.gate "$(ui_input "How long a gate may wait on you" "$(now sla.gate)")"
  answer sla.cycle "$(ui_input "Created to closed" "$(now sla.cycle)")"
}

sections=$(ui_choose_many "What should this file say?" "Jira,Engines" "Jira" "Engines" "Policy" "Budgets" "SLAs")
grep -qx Jira <<<"$sections" && jira
grep -qx Engines <<<"$sections" && engines
grep -qx Policy <<<"$sections" && policy
grep -qx Budgets <<<"$sections" && budgets
grep -qx SLAs <<<"$sections" && sla
[ -s "$ANSWERS" ] || { info "Nothing to change."; exit 0; }

if ! node "$LUNA_YAML_TS" apply --repo "$repo" --answers "$ANSWERS" >"$NEW"; then
  error "The machine would refuse that file; nothing written. Run make luna-yaml again."
  exit 1
fi
ui_section "Preview"
if [ -f "$repo/luna.yaml" ]; then diff -u "$repo/luna.yaml" "$NEW" --label "luna.yaml (now)" --label "luna.yaml (new)" || true; else cat "$NEW"; fi
echo
if ui_confirm "Write $repo/luna.yaml?" yes; then
  cp "$NEW" "$repo/luna.yaml"
  success "Wrote $repo/luna.yaml. The machine reads it at every stage; commit it with the repo."
else
  info "Nothing written."
fi
