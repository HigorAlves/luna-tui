#!/usr/bin/env bash
# lib.test.sh - the .env and credential writes in lib.sh, on temp files. Run: bash scripts/setup/lib.test.sh
set -uo pipefail
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export LUNA_ENV_FILE="$TMP/.env" LUNA_CONFIG_DIR="$TMP/config"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh" </dev/null

FAILED=0
check() { # check "name" expected actual
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1"; echo "       expected: $(printf '%q' "$2")"; echo "       actual:   $(printf '%q' "$3")"; FAILED=$((FAILED + 1)); fi
}
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

echo "env_set / env_get"
env_set MACHINE_JIRA_SITE https://acme.atlassian.net
check "creates the file with the key" "MACHINE_JIRA_SITE=https://acme.atlassian.net" "$(cat "$LUNA_ENV_FILE")"
check "the file is 0600" 600 "$(mode "$LUNA_ENV_FILE")"
printf '# mine\nOTHER=1' >>"$LUNA_ENV_FILE"
env_set MACHINE_JIRA_EMAIL you@acme.com
check "appends after a last line without a newline" $'MACHINE_JIRA_SITE=https://acme.atlassian.net\n# mine\nOTHER=1\nMACHINE_JIRA_EMAIL=you@acme.com' "$(cat "$LUNA_ENV_FILE")"
env_set MACHINE_JIRA_SITE 'https://b.atlassian.net/&|\1'
check "replaces in place, any character kept as is" 'https://b.atlassian.net/&|\1' "$(env_get MACHINE_JIRA_SITE)"
check "other lines and their order stay" $'# mine\nOTHER=1' "$(sed -n 2,3p "$LUNA_ENV_FILE")"
env_set MACHINE_JIRA_TOKEN 'a=b=c'
check "a value with = reads back whole" 'a=b=c' "$(env_get MACHINE_JIRA_TOKEN)"
check "a key that is only a prefix is not read" "" "$(env_get MACHINE_JIRA)"
check "an unset key is empty" "" "$(env_get NOPE)"

echo "cred_write / cred_present"
cred_write claude-oauth-token $'  sk-ant-oat01-abc\n'
check "writes the value without surrounding whitespace" "sk-ant-oat01-abc" "$(cat "$LUNA_CONFIG_DIR/claude-oauth-token")"
check "the file is 0600" 600 "$(mode "$LUNA_CONFIG_DIR/claude-oauth-token")"
check "the folder is 0700" 700 "$(mode "$LUNA_CONFIG_DIR")"
cred_present claude-oauth-token && present=yes || present=no
check "cred_present sees it" yes "$present"
cred_write openai-api-key "   " 2>/dev/null && wrote=yes || wrote=no
check "an empty value writes nothing" "no:no" "$wrote:$( [ -e "$LUNA_CONFIG_DIR/openai-api-key" ] && echo yes || echo no)"

echo "prompts without gum (input piped)"
answer() { "$@" && echo yes || echo no; }
check "end of input is a no, even when the default is yes" no "$(answer ui_confirm q yes </dev/null 2>/dev/null)"
check "Enter takes a yes default" yes "$(printf '\n' | answer ui_confirm q yes 2>/dev/null)"
check "Enter takes the no default" no "$(printf '\n' | answer ui_confirm q 2>/dev/null)"
check "y is yes" yes "$(printf 'y\n' | answer ui_confirm q 2>/dev/null)"
check "Enter keeps the input's default" def "$(printf '\n' | ui_input p def 2>/dev/null)"
check "a typed value wins" mine "$(printf 'mine\n' | ui_input p def 2>/dev/null)"
check "a choice by number" b "$(printf '2\n' | ui_choose h a b c 2>/dev/null)"
check "out-of-range numbers are asked again" c "$(printf '9\nx\n3\n' | ui_choose h a b c 2>/dev/null)"
check "many: y, n, and Enter on a preselected one" $'a\nc' "$(printf 'y\nn\n\n' | ui_choose_many h c a b c 2>/dev/null)"
check "a secret reads whole" 'xoxp-1/2=3' "$(printf 'xoxp-1/2=3\n' | ui_secret k 2>/dev/null)"

echo "company_docs_path"
# shellcheck disable=SC2088  # the literal ~ a person types is the input under test
check "a home-relative folder is made absolute" "$HOME/company-docs" "$(company_docs_path '~/company-docs')"
check "an absolute folder stays, its trailing slash dropped" "/srv/handbook" "$(company_docs_path /srv/handbook/)"
check "a relative folder is refused" "refused" "$(company_docs_path docs 2>/dev/null || echo refused)"
check "a list is refused: the machine in Docker mounts one folder" "refused" "$(company_docs_path /a:/b 2>/dev/null || echo refused)"
check "the root itself is refused" "refused" "$(company_docs_path / 2>/dev/null || echo refused)"

echo "banner"
still=$(banner_show "tickets in, pull requests out" | cat)
check "off a terminal it is plain text: no escape codes" 0 "$(printf '%s' "$still" | LC_ALL=C grep -c $'\033' || true)"
check "LUNA beside the mark" 1 "$(printf '%s\n' "$still" | grep -c '███████╗╚██████╔╝██║ ╚████║██║  ██║')"
check "the tagline under it" 1 "$(printf '%s\n' "$still" | grep -c 'tickets in, pull requests out')"

echo
if [ "$FAILED" -eq 0 ]; then echo "all passed"; else echo "$FAILED failed"; exit 1; fi
