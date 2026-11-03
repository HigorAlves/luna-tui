#!/usr/bin/env bash
# shellcheck disable=SC2034  # sourced: the colors are used by the scripts that source it
# colors.sh - ANSI color codes & formatting helpers

# Reset
NC='\033[0m' # No Color

# Regular Colors
BLACK='\033[0;30m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[0;37m'

# Bold
BOLD_BLACK='\033[1;30m'
BOLD_RED='\033[1;31m'
BOLD_GREEN='\033[1;32m'
BOLD_YELLOW='\033[1;33m'
BOLD_BLUE='\033[1;34m'
BOLD_PURPLE='\033[1;35m'
BOLD_CYAN='\033[1;36m'
BOLD_WHITE='\033[1;37m'

# Underline
UNDERLINE_BLACK='\033[4;30m'
UNDERLINE_RED='\033[4;31m'
UNDERLINE_GREEN='\033[4;32m'
UNDERLINE_YELLOW='\033[4;33m'
UNDERLINE_BLUE='\033[4;34m'
UNDERLINE_PURPLE='\033[4;35m'
UNDERLINE_CYAN='\033[4;36m'
UNDERLINE_WHITE='\033[4;37m'

# Backgrounds
BG_BLACK='\033[40m'
BG_RED='\033[41m'
BG_GREEN='\033[42m'
BG_YELLOW='\033[43m'
BG_BLUE='\033[44m'
BG_PURPLE='\033[45m'
BG_CYAN='\033[46m'
BG_WHITE='\033[47m'

# Emojis / Symbols for feedback
CHECK="✔"
CROSS="✖"
INFO="ℹ"
WARN="⚠"
ARROW="➜"

# Small helpers
colorize() {
  local color="$1"; shift
  echo -e "${color}$*${NC}"
}

success() { echo -e "${BOLD_GREEN}${CHECK} $*${NC}"; }
error()   { echo -e "${BOLD_RED}${CROSS} $*${NC}" >&2; }
warn()    { echo -e "${BOLD_YELLOW}${WARN} $*${NC}"; }
info()    { echo -e "${BOLD_BLUE}${INFO} $*${NC}"; }