#!/usr/bin/env bash
# utils.sh - Handy bash helpers (from HigorAlves/workbench scripts/helpers, trimmed to what setup uses)
source "$(dirname "${BASH_SOURCE[0]}")/colors-style.sh"

# Ask user for yes/no
confirm() {
  read -rp "❓ $1 [y/N]: " response
  case "$response" in
    [yY][eE][sS]|[yY]) return 0 ;;
    *) return 1 ;;
  esac
}

# Run a command and check if it exists
require_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "❌ Required command '$1' not found. Please install it." >&2
    exit 1
  fi
}

# Show a header with title
show_header() {
    local title="$1"
    echo
    colorize "$BOLD_CYAN" "====================================="
    colorize "$BOLD_WHITE" "    $title"
    colorize "$BOLD_CYAN" "====================================="
    echo
}

# Show a separator line
show_separator() {
    colorize "$CYAN" "─────────────────────────────────────────"
}
