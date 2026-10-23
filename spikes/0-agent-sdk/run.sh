#!/bin/sh
# Builds the spike image and runs one stage against this repo, mounted read-only.
#
#   CLAUDE_CODE_OAUTH_TOKEN=... ./run.sh   # subscription token from `claude setup-token`
#   ANTHROPIC_API_KEY=...       ./run.sh   # API key from the Claude Console
#
# Without either variable, it reads one from a private file (chmod 600) if present:
#   ~/.config/hardness/claude-oauth-token   or   ~/.config/hardness/anthropic-api-key
#
# The credential is forwarded by name only, so it never appears in the command line.
set -eu

secrets="$HOME/.config/hardness"
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  if [ -r "$secrets/claude-oauth-token" ]; then
    # Tokens never contain whitespace; copying from a terminal can wrap them across lines.
    CLAUDE_CODE_OAUTH_TOKEN=$(tr -d '[:space:]' < "$secrets/claude-oauth-token")
    export CLAUDE_CODE_OAUTH_TOKEN
  elif [ -r "$secrets/anthropic-api-key" ]; then
    ANTHROPIC_API_KEY=$(tr -d '[:space:]' < "$secrets/anthropic-api-key")
    export ANTHROPIC_API_KEY
  fi
fi

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
out="$here/out"
mkdir -p "$out"

docker build -q -t hardness-spike-agent-sdk "$here" >/dev/null

docker run --rm \
  --name "hardness-spike-$$" \
  -e CLAUDE_CODE_OAUTH_TOKEN \
  -e ANTHROPIC_API_KEY \
  -e SPIKE_PROMPT \
  -v "$repo:/work:ro" \
  -v "$out:/out" \
  hardness-spike-agent-sdk || status=$?

echo "--- $out/result.json"
cat "$out/result.json"
exit "${status:-0}"
