#!/usr/bin/env bash
# credentials.sh - the credentials each engine runs on, in ~/.config/hardness/ (0600), where the
# machine reads them (docs/configuration.md#credentials): Claude (required), then the Codex login,
# an OpenAI key and a Jev key if you use them, the machine's API token and the GitHub login.
# Safe to run again: what is there is kept unless you replace it. Never prints a secret.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

claude_present() { [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] || cred_present claude-oauth-token || cred_present anthropic-api-key; }
jev_present() { [ -n "${AI_GATEWAY_API_KEY:-}${TYPESAFE_API_KEY:-}" ] || cred_present ai-gateway-api-key || cred_present typesafe-api-key; }

# paste NAME "Prompt" PREFIX: asks for a secret and writes it, warning when it does not look like one.
paste() {
  local name="$1" prompt="$2" prefix="$3" value
  value=$(ui_secret "$prompt")
  [ -n "$value" ] || { warn "Nothing pasted; $name left as it was."; return 1; }
  case "$value" in "$prefix"*) ;; *) warn "That does not start with $prefix; saved anyway." ;; esac
  cred_write "$name" "$value" && success "Saved $CONFIG_DIR/$name"
}

ui_header "Credentials" "Saved under $CONFIG_DIR, 0600. Nothing here is printed back."

# Claude: every stage's default engine.
if claude_present && ! ui_confirm "Claude credential found. Replace it?"; then
  success "claude:* keeps its credential"
else
  how=$(ui_choose "Claude: how should stages sign in?" \
    "Subscription token from claude setup-token (recommended)" \
    "Paste a subscription token I already have" \
    "Anthropic API key (metered)")
  case "$how" in
    Subscription*)
      if command -v claude &>/dev/null; then
        info "claude setup-token opens your browser and prints a token: copy it, then paste it below."
        claude setup-token || warn "claude setup-token did not finish; paste a token if you have one."
      else
        warn "Claude Code is not installed (make tools). Run claude setup-token where it is, then paste the token."
      fi
      paste claude-oauth-token "Claude subscription token" "sk-ant-oat" || true ;;
    Paste*) paste claude-oauth-token "Claude subscription token" "sk-ant-oat" || true ;;
    Anthropic*) paste anthropic-api-key "Anthropic API key" "sk-ant-api" || true ;;
  esac
fi

# The optional engines.
selected=""
[ -s "$CODEX_AUTH" ] && selected="Codex"
cred_present openai-api-key && selected="$selected,OpenAI"
jev_present && selected="$selected,Jev"
engines=$(ui_choose_many "Other engines you will use" "${selected#,}" Codex OpenAI Jev)

if grep -qx Codex <<<"$engines"; then
  if [ -s "$CODEX_AUTH" ]; then success "codex:* uses your Codex login ($CODEX_AUTH)"
  elif command -v codex &>/dev/null; then
    info "codex login opens your browser to sign in with ChatGPT."
    if codex login; then success "Codex login saved"; else warn "codex login did not finish; run it again later."; fi
  else warn "The Codex CLI is not installed (make tools), then run: codex login"; fi
fi

if grep -qx OpenAI <<<"$engines"; then
  if cred_present openai-api-key && ! ui_confirm "OpenAI key found. Replace it?"; then success "openai:* keeps its key"
  else paste openai-api-key "OpenAI API key" "sk-" || true; fi
fi

if grep -qx Jev <<<"$engines"; then
  if jev_present && ! ui_confirm "Jev key found. Replace it?"; then success "jev keeps its key"
  else
    case "$(ui_choose "Jev: which key?" "Vercel AI Gateway (recommended)" "TypeSafe")" in
      Vercel*) paste ai-gateway-api-key "Vercel AI Gateway API key" "vck_" || true ;;
      *) paste typesafe-api-key "TypeSafe API key" "" || true ;;
    esac
  fi
fi

# The machine's own API token: the board and Luna Notch send it.
if [ -n "${MACHINE_API_TOKEN:-}" ] || cred_present machine-api-token; then
  success "The machine's API token is there"
else
  cred_write machine-api-token "$(openssl rand -hex 32)" && success "Made the machine's API token ($CONFIG_DIR/machine-api-token)"
fi

# GitHub: pnpm start hands the machine `gh auth token`.
if ! command -v gh &>/dev/null; then warn "gh is not installed (make tools)"
elif gh auth status &>/dev/null; then success "GitHub: signed in as $(gh api user -q .login 2>/dev/null)"
elif ui_confirm "GitHub: sign in with gh now?" yes; then gh auth login
fi
