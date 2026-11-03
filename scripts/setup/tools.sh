#!/usr/bin/env bash
# tools.sh - installs the tools Luna needs with Homebrew, after one confirmation; elsewhere it
# lists what is missing with the command to run. Safe to run again: it skips what is there.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
USER_PATH="$PATH"
rust_path

usage() {
  cat <<EOF
Installs Luna's tools (Docker, Node 24+, pnpm, Rust, gh, herdr, and optionally gum, Codex, Claude Code).

Usage: scripts/setup/tools.sh [--all] [--help]

  --all   also install the optional tools without asking about each
EOF
}

ALL=false
for arg in "$@"; do
  case "$arg" in
    --all) ALL=true ;;
    --help|-h) usage; exit 0 ;;
    *) log_error "Unknown option: $arg"; usage; exit 1 ;;
  esac
done

required=()
optional=()
while IFS='|' read -r name cmd brew needed why; do
  tool_ok "$name" "$cmd" && continue
  if [ "$needed" = yes ]; then required+=("$name|$brew|$why"); else optional+=("$name|$brew|$why"); fi
done <<<"$TOOLS"

if [ ${#required[@]} -eq 0 ] && [ ${#optional[@]} -eq 0 ]; then
  success "Every tool is installed."
else
  if ! command -v brew &>/dev/null; then
    error "Homebrew is not installed, so nothing can be installed for you."
    info "Install it from https://brew.sh, or install these yourself:"
    for item in ${required[@]+"${required[@]}"} ${optional[@]+"${optional[@]}"}; do
      IFS='|' read -r name brew why <<<"$item"
      echo "  - $name ($why): brew install $brew"
    done
    [ ${#required[@]} -eq 0 ] || exit 1
    exit 0
  fi

  to_install=()
  if [ ${#required[@]} -gt 0 ]; then
    warn "Missing:"
    for item in "${required[@]}"; do IFS='|' read -r name _ why <<<"$item"; echo "  - $name: $why"; done
    ui_confirm "Install them with Homebrew?" yes || { error "Luna cannot run without them."; exit 1; }
    to_install+=("${required[@]}")
  fi
  for item in ${optional[@]+"${optional[@]}"}; do
    IFS='|' read -r name _ why <<<"$item"
    if $ALL || ui_confirm "Install $name too? ($why)" yes; then to_install+=("$item"); fi
  done

  for item in ${to_install[@]+"${to_install[@]}"}; do
    IFS='|' read -r name brew _ <<<"$item"
    # $brew is "formula" or "--cask name": split on purpose.
    # shellcheck disable=SC2086
    ui_spin "brew install $name" brew install $brew
    if [ "$name" = rust ]; then
      rust_path
      ui_spin "rustup default stable" rustup default stable
    fi
  done
fi

if command -v docker &>/dev/null && ! docker_running; then
  info "Starting Docker Desktop…"
  open -a Docker 2>/dev/null || true
  for _ in $(seq 1 60); do docker_running && break; sleep 2; done
  if docker_running; then success "Docker is running."; else warn "Docker is not answering yet; open Docker Desktop and run make doctor."; fi
fi

# Homebrew's rustup is keg-only: this run found cargo, but a new shell may not.
if command -v cargo &>/dev/null && ! PATH="$USER_PATH" command -v cargo &>/dev/null; then
  warn "Add Rust to your shell profile: export PATH=\"\$(brew --prefix rustup)/bin:\$HOME/.cargo/bin:\$PATH\""
fi
