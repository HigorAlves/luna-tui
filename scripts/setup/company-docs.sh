#!/usr/bin/env bash
# company-docs.sh - the company folder memory reads (RFC 0007): one folder of md, txt and pdf files (subfolders too, hidden ones
# skipped), sent to the `company` dataset, which every repository may recall and no public reply ever quotes. Written to the root
# .env as MACHINE_MEMORY_DOCS; compose mounts that folder read-only into the machine at the same path. Safe to run again.
# Usage: make company-docs [DIR=~/Developer/company-docs]   (DIR=none clears it)
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DEFAULT_DIR="$HOME/Developer/company-docs"

starter_readme() {
  cat <<'EOF'
# Company documents

What Luna's memory knows about the company: handbooks, architecture notes, runbooks, decisions, policies.

- Put **Markdown, text and PDF** files here, in any subfolders. Other types, hidden files and anything over 20 MB are skipped.
- The machine reads this folder every 10 minutes (`MACHINE_MEMORY_DOCS_INTERVAL`) and sends what changed to Cognee's `company`
  dataset. A deleted file is forgotten.
- Every repository's cards may recall these documents, and so can the board's ask pane (`Q`), Slack replies and Claude Code
  through the `luna-memory` MCP server. A reply posted in public (a GitHub issue or PR) never quotes them.
- With an OpenAI key in `~/.config/hardness/cognee-openai-key`, Cognee sends their text to OpenAI to build its graph. Without
  one, everything stays on this computer. Keep here only what you are willing to send.

Change the folder with `make company-docs` in the Luna repository.
EOF
}

company_docs() {
  ui_section "Company documents"
  info "One folder of md, txt and pdf files that memory reads for every repository (never quoted in a public reply)."
  if [ -s "$CONFIG_DIR/cognee-openai-key" ]; then
    warn "Cognee has an OpenAI key: the text of these documents is sent to OpenAI to build the graph."
  else
    info "No OpenAI key for Cognee: the documents stay on this computer (local mode)."
  fi

  local current answer dir
  current=$(env_get MACHINE_MEMORY_DOCS)
  answer="${1:-}"
  [ -n "$answer" ] || answer=$(ui_input "Company folder (none to turn it off)" "${current:-$DEFAULT_DIR}")
  if [ "$answer" = none ]; then
    env_set MACHINE_MEMORY_DOCS ""
    success "No company folder: memory reads only your repositories."
    restart_machine
    return 0
  fi
  dir=$(company_docs_path "$answer") || { error "Not changed."; return 1; }

  if [ ! -d "$dir" ]; then
    if ui_confirm "$dir does not exist. Create it, with a README and a git repository?" yes; then
      mkdir -p "$dir"
      starter_readme >"$dir/README.md"
      if command -v git >/dev/null && [ ! -e "$dir/.git" ]; then git -C "$dir" init -q && git -C "$dir" add README.md && git -C "$dir" -c commit.gpgsign=false commit -qm "Company documents for Luna's memory" || true; fi
      success "Created $dir"
    else
      error "Not changed: the folder must exist."
      return 1
    fi
  fi
  case "$dir/" in "$HOME/.config/"* | "$HOME/.ssh/"* | "$HOME/.local/state/hardness/"*) error "Not a folder of documents: $dir"; return 1 ;; esac

  env_set MACHINE_MEMORY_DOCS "$dir"
  success "Memory reads $dir (MACHINE_MEMORY_DOCS in $ENV_FILE)"
  restart_machine
}

# The machine reads the folder's path and mount when its container is made: recreate it if it runs.
restart_machine() {
  if ! (cd "$ROOT" && docker compose ps --status running --services 2>/dev/null | grep -qx machine); then
    info "The machine is not running; make up starts it with the folder."
    return 0
  fi
  if ui_confirm "Recreate the machine now so it reads the new folder? (cards in a stage are stopped and resumed)" yes; then
    (cd "$ROOT" && docker compose up -d --no-deps --wait machine)
    success "The machine is up with the new folder; its first read is within a minute of memory connecting."
  else
    info "Run make up (or docker compose up -d machine) when ready."
  fi
}

company_docs "${1:-}"
