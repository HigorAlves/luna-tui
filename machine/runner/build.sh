#!/usr/bin/env bash
# Builds the stage image with the orc plugin baked in at /orc.
#   ORC_SOURCE=path (default)  ORC_PATH=<orc checkout>   uses that checkout's committed HEAD
#     without ORC_PATH, looks for an orc checkout next to this repo, then ~/Developer/system/orc;
#     with neither, falls back to ORC_SOURCE=git at ORC_REF (default main).
#   ORC_SOURCE=git             ORC_REF=<tag|branch>      clones github.com/HigorAlves/orc at that ref
# Tags the image hardness-runner:dev and hardness-runner:<orc short sha>.
# With --qa it then builds hardness-runner-qa:dev on top (Playwright, chromium, ffmpeg, agent-browser).
set -euo pipefail

qa=0
[ "${1:-}" = "--qa" ] && qa=1

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_mode="${ORC_SOURCE:-path}"
if [ "$source_mode" = path ] && [ -z "${ORC_PATH:-}" ]; then
  for candidate in "$here/../../../orc" "$HOME/Developer/system/orc"; do
    if git -C "$candidate" rev-parse --git-dir >/dev/null 2>&1; then
      ORC_PATH="$(cd "$candidate" && pwd)"
      break
    fi
  done
  if [ -z "${ORC_PATH:-}" ]; then
    echo "build.sh: no local orc checkout; cloning HigorAlves/orc at ${ORC_REF:=main}" >&2
    source_mode=git
  fi
fi
vendor="$here/vendor"
rm -rf "$vendor"
mkdir -p "$vendor"

case "$source_mode" in
  path)
    orc_path="$ORC_PATH"
    git -C "$orc_path" rev-parse --git-dir >/dev/null 2>&1 || { echo "build.sh: $orc_path is not a git checkout" >&2; exit 2; }
    sha="$(git -C "$orc_path" rev-parse --short=12 HEAD)"
    # The plugin is the repo's orc/ folder, so it unpacks to /orc. Archiving the commit (not
    # the HEAD:orc tree) stamps files with the commit time, so the tar, and Docker's cache of
    # every layer after it, only change when orc does.
    git -C "$orc_path" archive --format=tar HEAD orc > "$vendor/orc.tar"
    ;;
  git)
    : "${ORC_REF:?ORC_REF is required with ORC_SOURCE=git (a tag or branch)}"
    clone="$(mktemp -d)"
    trap 'rm -rf "$clone"' EXIT
    git clone --quiet --depth 1 --branch "$ORC_REF" https://github.com/HigorAlves/orc "$clone"
    sha="$(git -C "$clone" rev-parse --short=12 HEAD)"
    git -C "$clone" archive --format=tar HEAD orc > "$vendor/orc.tar"
    ;;
  *)
    echo "build.sh: ORC_SOURCE must be path or git, got '$source_mode'" >&2
    exit 2
    ;;
esac

# Each image carries a key over orc's commit and its own build files. An image that already
# has the current key is left alone, so `pnpm dev` and `pnpm start` cost ~nothing when
# nothing changed. REBUILD=1 builds anyway (Docker's layer cache still applies).
key_of() { { echo "$1"; shift; cat "$@"; } | shasum | cut -c1-16; }
current_key() { docker image inspect -f '{{index .Config.Labels "dev.hardness.build"}}' "$1" 2>/dev/null || true; }

key="$(key_of "$sha" "$here/Dockerfile" "$here/runner.mjs")"
if [ "${REBUILD:-}" != 1 ] && [ "$(current_key hardness-runner:dev)" = "$key" ]; then
  echo "hardness-runner:dev is up to date (orc $sha)"
else
  docker build --build-arg "ORC_SHA=$sha" --label "dev.hardness.build=$key" \
    -t hardness-runner:dev -t "hardness-runner:$sha" "$here"
  echo "built hardness-runner:dev and hardness-runner:$sha (orc $sha)"
fi

if [ "$qa" = 1 ]; then
  qa_key="$(key_of "$key" "$here/../runner-qa/Dockerfile")"
  if [ "${REBUILD:-}" != 1 ] && [ "$(current_key hardness-runner-qa:dev)" = "$qa_key" ]; then
    echo "hardness-runner-qa:dev is up to date (orc $sha)"
  else
    docker build --build-arg "BASE=hardness-runner:$sha" --label "dev.hardness.build=$qa_key" \
      -t hardness-runner-qa:dev -t "hardness-runner-qa:$sha" "$here/../runner-qa"
    echo "built hardness-runner-qa:dev and hardness-runner-qa:$sha"
  fi
fi
