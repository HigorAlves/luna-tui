#!/usr/bin/env bash
# ui.sh - prompts, menus and spinners: gum (charmbracelet) when it is installed and we talk to a
# terminal, plain `read` otherwise, so every script also runs piped (the tests) and before gum is in.
source "$(dirname "${BASH_SOURCE[0]}")/utils.sh"

has_gum() { command -v gum &>/dev/null && [ -t 0 ] && [ -t 1 ]; }

# ui_header "Title" ["one line under it"]
ui_header() {
  if has_gum; then
    gum style --border rounded --border-foreground 141 --padding "0 2" --margin "1 0" --bold "🌙 $1" ${2:+"$2"}
  else
    show_header "$1"
    [ -n "${2:-}" ] && echo "$2"
  fi
}

# ui_section "Jira"
ui_section() {
  echo
  colorize "$BOLD_PURPLE" "$1"
  show_separator
}

# ui_step 2 6 "Credentials"
ui_step() { ui_section "[$1/$2] $3"; }

# ui_confirm "Question" [yes]: exit 0 for yes. The default is no unless the second argument is yes.
ui_confirm() {
  local default="${2:-no}"
  if has_gum; then
    gum confirm --default="$([ "$default" = yes ] && echo true || echo false)" "$1"
    return
  fi
  local hint="[y/N]"
  [ "$default" = yes ] && hint="[Y/n]"
  local answer
  # No answer at all (end of input) is a no, whatever the default: only Enter takes the default.
  read -rp "❓ $1 $hint: " answer || return 1
  case "$answer" in
    [yY]|[yY][eE][sS]) return 0 ;;
    "") [ "$default" = yes ] ;;
    *) return 1 ;;
  esac
}

# value=$(ui_input "Prompt" ["default"] ["placeholder"]): an empty answer takes the default.
ui_input() {
  local prompt="$1" default="${2:-}" placeholder="${3:-}" value
  if has_gum; then
    value=$(gum input --header "$prompt" --value "$default" --placeholder "$placeholder") || return 1
  else
    # read -p prompts on stderr, so the answer alone reaches the caller's $(…).
    read -rp "👉 $prompt${default:+ [$default]}: " value || value=""
    value="${value:-$default}"
  fi
  printf '%s' "$value"
}

# value=$(ui_secret "Prompt"): typed hidden; never echoed back.
ui_secret() {
  local value
  if has_gum; then
    value=$(gum input --password --header "$1" --placeholder "paste it here") || return 1
  else
    if [ -t 0 ]; then read -rsp "🔑 $1: " value || value=""; echo >&2; else read -r value || value=""; fi
  fi
  printf '%s' "$value"
}

# choice=$(ui_choose "Header" option...): one of the options.
ui_choose() {
  local header="$1"; shift
  if has_gum; then
    gum choose --header "$header" "$@"
    return
  fi
  echo "$header" >&2
  local i=1 option
  for option in "$@"; do echo "  $i. $option" >&2; i=$((i + 1)); done
  local pick
  while true; do
    read -rp "👉 number: " pick || return 1
    if [ "$pick" -ge 1 ] 2>/dev/null && [ "$pick" -le "$#" ]; then
      eval "printf '%s' \"\${$pick}\""
      return
    fi
  done
}

# picked=$(ui_choose_many "Header" "preselected,comma,list" option...): the picked options, one per line.
ui_choose_many() {
  local header="$1" selected="$2"; shift 2
  if has_gum; then
    gum choose --no-limit --header "$header" --selected="$selected" "$@"
    return
  fi
  echo "$header" >&2
  local option default
  for option in "$@"; do
    default=no
    case ",$selected," in *",$option,"*) default=yes ;; esac
    if ui_confirm "  $option?" "$default" >&2; then echo "$option"; fi
  done
}

# ui_spin "Title" command [args...]: runs the command quietly; on failure prints its last lines.
ui_spin() {
  local title="$1"; shift
  local log; log=$(mktemp)
  local status=0
  if has_gum; then
    # shellcheck disable=SC2016  # expanded by the inner bash, not here
    gum spin --spinner dot --title "$title" -- bash -c '"$@" >"$0" 2>&1' "$log" "$@" || status=$?
  else
    info "$title"
    "$@" >"$log" 2>&1 || status=$?
  fi
  if [ $status -eq 0 ]; then
    success "$title"
  else
    error "$title failed (exit $status). Last lines:"
    tail -n 20 "$log" >&2
  fi
  rm -f "$log"
  return $status
}
