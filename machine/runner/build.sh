#!/usr/bin/env bash
# Builds the stage image from this checkout: the factory runner (factory/) and the contracts
# package, installed with the workspace lockfile. Tags the image hardness-runner:dev and
# hardness-runner:<key>. With --qa it then builds hardness-runner-qa:dev on top (Playwright,
# chromium, ffmpeg, agent-browser).
set -euo pipefail

qa=0
[ "${1:-}" = "--qa" ] && qa=1

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

# Each image carries a key over everything that goes into it. An image that already has the
# current key is left alone, so `pnpm dev` and `pnpm start` cost ~nothing when nothing
# changed. REBUILD=1 builds anyway (Docker's layer cache still applies).
key_of() { { printf '%s\n' "$@"; cat "$@"; } | shasum | cut -c1-16; }
current_key() { docker image inspect -f '{{index .Config.Labels "dev.hardness.build"}}' "$1" 2>/dev/null || true; }
tree_files() { (cd "$root" && find "$@" -type f -not -path '*/node_modules/*' | LC_ALL=C sort | sed "s#^#$root/#"); }

ref="$(git -C "$root" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
inputs=()
while IFS= read -r f; do inputs+=("$f"); done < <(tree_files factory contracts/src contracts/package.json; echo "$root/package.json"; echo "$root/pnpm-lock.yaml"; echo "$root/pnpm-workspace.yaml"; echo "$here/Dockerfile")
key="$(key_of "${inputs[@]}")"
if [ "${REBUILD:-}" != 1 ] && [ "$(current_key hardness-runner:dev)" = "$key" ]; then
  echo "hardness-runner:dev is up to date (factory $key)"
else
  docker build --build-arg "FACTORY_REF=$ref" --label "dev.hardness.build=$key" \
    -t hardness-runner:dev -t "hardness-runner:$key" -f "$here/Dockerfile" "$root"
  echo "built hardness-runner:dev and hardness-runner:$key (factory $key, commit $ref)"
fi

if [ "$qa" = 1 ]; then
  qa_key="$(key_of <(echo "$key") "$here/../runner-qa/Dockerfile")"
  if [ "${REBUILD:-}" != 1 ] && [ "$(current_key hardness-runner-qa:dev)" = "$qa_key" ]; then
    echo "hardness-runner-qa:dev is up to date (factory $key)"
  else
    docker build --build-arg "BASE=hardness-runner:$key" --label "dev.hardness.build=$qa_key" \
      -t hardness-runner-qa:dev -t "hardness-runner-qa:$key" "$here/../runner-qa"
    echo "built hardness-runner-qa:dev and hardness-runner-qa:$key"
  fi
fi
