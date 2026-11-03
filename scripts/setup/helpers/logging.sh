#!/usr/bin/env bash
# logging.sh - Logging utilities with colors
source "$(dirname "${BASH_SOURCE[0]}")/colors-style.sh"

log_debug() { echo -e "${BOLD_PURPLE}[DEBUG]${NC} $*"; }
log_info()  { echo -e "${BOLD_BLUE}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${BOLD_YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${BOLD_RED}[ERROR]${NC} $*" >&2; }
log_success(){ echo -e "${BOLD_GREEN}[ OK ]${NC}  $*"; }