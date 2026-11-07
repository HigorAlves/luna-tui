#!/usr/bin/env bash
# shellcheck disable=SC2034  # sourced: its variables are used by the steps
# lib.sh - what every setup step shares: where things live, the root .env, the credential files
# and the tools the machine needs. Sourced, never run. Written for macOS's bash 3.2.
SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SETUP_DIR/../.." && pwd)"
source "$SETUP_DIR/helpers/logging.sh"
source "$SETUP_DIR/helpers/ui.sh"

# Where the machine reads its credentials (docs/configuration.md#credentials) and its env
# (compose reads the root .env; `pnpm dev` reads machine/.env, a link to it).
CONFIG_DIR="${LUNA_CONFIG_DIR:-$HOME/.config/hardness}"
ENV_FILE="${LUNA_ENV_FILE:-$ROOT/.env}"
CODEX_AUTH="${CODEX_HOME:-$HOME/.codex}/auth.json"

# env_get KEY: the value the .env file gives KEY, empty when unset.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1) || true
  printf '%s' "${line#*=}"
}

# env_set KEY VALUE: sets KEY in the .env file, keeping every other line and its place; 0600.
env_set() {
  local key="$1" value="$2" tmp
  (umask 077 && touch "$ENV_FILE")
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  if grep -qE "^$key=" "$ENV_FILE"; then
    # awk, not sed: a token may hold any character sed would read as syntax.
    KEY="$key" VALUE="$value" awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"] } index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next } { print }' "$ENV_FILE" >"$tmp"
  else
    cat "$ENV_FILE" >"$tmp"
    [ -s "$tmp" ] && [ -n "$(tail -c 1 "$tmp")" ] && echo >>"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# cred_present NAME: the credential file ~/.config/hardness/NAME exists and is not empty.
cred_present() { [ -s "$CONFIG_DIR/$1" ]; }

# cred_write NAME VALUE: writes the credential file, 0600 in a 0700 folder, surrounding whitespace dropped.
cred_write() {
  local name="$1" value
  value=$(printf '%s' "$2" | tr -d '[:space:]')
  [ -n "$value" ] || { error "$name: empty, nothing written"; return 1; }
  (umask 077 && mkdir -p "$CONFIG_DIR" && printf '%s\n' "$value" >"$CONFIG_DIR/$name.tmp" && mv "$CONFIG_DIR/$name.tmp" "$CONFIG_DIR/$name")
}

# The tools, one per line: name|command|brew formula or "--cask name"|required|what it is for.
TOOLS="docker|docker|--cask docker|yes|Postgres, the machine and every stage run in containers
node|node|node|yes|the machine and the factory (Node 24 or newer)
pnpm|pnpm|pnpm|yes|the workspace's package manager
rust|cargo|rustup|yes|builds the board
gh|gh|gh|yes|the machine's GitHub token and PRs
herdr|herdr|herdr|yes|runs the board as a plugin
gum|gum|gum|no|nicer prompts for these scripts
codex|codex|--cask codex|no|the ChatGPT login behind the codex:* engines
claude|claude|--cask claude-code|no|claude setup-token makes the Claude credential"

# tool_ok NAME COMMAND: the tool is installed and new enough.
tool_ok() {
  command -v "$2" &>/dev/null || return 1
  case "$1" in
    node) [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" -ge 24 ] 2>/dev/null ;;
    *) return 0 ;;
  esac
}

# tool_version COMMAND: one short version string, or nothing.
tool_version() {
  case "$1" in
    docker) docker version --format '{{.Client.Version}}' 2>/dev/null ;;
    node) node -v 2>/dev/null ;;
    cargo) cargo -V 2>/dev/null | awk '{print $2}' ;;
    *) "$1" --version 2>/dev/null | head -n 1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1 ;;
  esac
}

docker_running() { docker info &>/dev/null; }

# json_get EXPR: reads JSON on stdin and prints EXPR of it (the parsed value is j), nothing when it is
# empty or the input is not JSON: curl … | json_get 'j.ok && j.user'
json_get() {
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { const v = new Function("j", "return " + process.argv[1])(JSON.parse(s)); if (v) console.log(v); } catch {} });' "$1"
}

# Rust from Homebrew's rustup is keg-only: put its proxies and cargo's bin on PATH for this run.
rust_path() {
  local prefix
  prefix=$(brew --prefix rustup 2>/dev/null) && [ -d "$prefix/bin" ] && PATH="$prefix/bin:$PATH"
  [ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
  export PATH
}

# company_docs_path INPUT: the company folder as the machine needs it (docs/configuration.md "Memory"): one absolute folder,
# `~` expanded, no trailing slash. A relative path, a `:` list (the machine in Docker mounts one folder) or `/` is refused.
company_docs_path() {
  local dir="$1"
  # shellcheck disable=SC2088  # a literal ~ typed at the prompt is what is matched and expanded here
  case "$dir" in "~") dir="$HOME" ;; "~/"*) dir="$HOME/${dir#\~/}" ;; esac
  while [ "${#dir}" -gt 1 ] && [ "${dir%/}" != "$dir" ]; do dir="${dir%/}"; done
  case "$dir" in
    *:*) echo "one folder only (no ':' list): the machine in Docker mounts a single folder" >&2; return 1 ;;
    /) echo "not the root folder" >&2; return 1 ;;
    /*) printf '%s' "$dir" ;;
    *) echo "an absolute folder (/… or ~/…), got: $1" >&2; return 1 ;;
  esac
}
