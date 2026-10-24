#!/usr/bin/env bash
# Builds the stage image with the orc plugin baked in at /orc.
#   ORC_SOURCE=path (default)  ORC_PATH=<orc checkout>   uses that checkout's committed HEAD
#     default assumes a sibling checkout at ~/Developer/system/orc; override with ORC_PATH=/your/path
#     if orc lives somewhere else, or use ORC_SOURCE=git below instead.
#   ORC_SOURCE=git             ORC_REF=<tag|branch>      clones github.com/HigorAlves/orc at that ref
# Tags the image hardness-runner:dev and hardness-runner:<orc short sha>.
# With --qa it then builds hardness-runner-qa:dev on top (Playwright, chromium, ffmpeg, agent-browser).
set -euo pipefail

qa=0
[ "${1:-}" = "--qa" ] && qa=1

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_mode="${ORC_SOURCE:-path}"
vendor="$here/vendor"
rm -rf "$vendor"
mkdir -p "$vendor"

case "$source_mode" in
  path)
    orc_path="${ORC_PATH:-$HOME/Developer/system/orc}"
    git -C "$orc_path" rev-parse --git-dir >/dev/null 2>&1 || { echo "build.sh: $orc_path is not a git checkout" >&2; exit 2; }
    sha="$(git -C "$orc_path" rev-parse --short=12 HEAD)"
    # The plugin is the repo's orc/ folder; --prefix makes it unpack to /orc.
    git -C "$orc_path" archive --format=tar --prefix=orc/ "HEAD:orc" > "$vendor/orc.tar"
    ;;
  git)
    : "${ORC_REF:?ORC_REF is required with ORC_SOURCE=git (a tag or branch)}"
    clone="$(mktemp -d)"
    trap 'rm -rf "$clone"' EXIT
    git clone --quiet --depth 1 --branch "$ORC_REF" https://github.com/HigorAlves/orc "$clone"
    sha="$(git -C "$clone" rev-parse --short=12 HEAD)"
    git -C "$clone" archive --format=tar --prefix=orc/ "HEAD:orc" > "$vendor/orc.tar"
    ;;
  *)
    echo "build.sh: ORC_SOURCE must be path or git, got '$source_mode'" >&2
    exit 2
    ;;
esac

docker build --build-arg "ORC_SHA=$sha" -t hardness-runner:dev -t "hardness-runner:$sha" "$here"
echo "built hardness-runner:dev and hardness-runner:$sha (orc $sha)"

if [ "$qa" = 1 ]; then
  docker build --build-arg "BASE=hardness-runner:$sha" -t hardness-runner-qa:dev -t "hardness-runner-qa:$sha" "$here/../runner-qa"
  echo "built hardness-runner-qa:dev and hardness-runner-qa:$sha"
fi
