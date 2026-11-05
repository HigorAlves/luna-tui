#!/usr/bin/env bash
# Builds the stage image from this checkout: the factory runner (factory/) and the contracts
# package, installed with the workspace lockfile. Tags the image hardness-runner:dev and
# hardness-runner:<key>. With --qa it then builds hardness-runner-qa:dev on top (Playwright,
# chromium, ffmpeg, agent-browser). With --video it builds hardness-runner-video:dev on top of that
# (kokoro-js, whisper and the video tools; builds the QA image first when it is not current).
set -euo pipefail

qa=0
video=0
for arg in "$@"; do
  case "$arg" in
    --qa) qa=1 ;;
    --video) qa=1; video=1 ;;
    *) echo "unknown option: $arg (use --qa and/or --video)" >&2; exit 2 ;;
  esac
done

# RUNNER_REPO renames the images (default hardness-runner), so a test or a parallel checkout never touches the
# shared hardness-runner:dev: RUNNER_REPO=hardness-runner-test-x gives hardness-runner-test-x:dev and -qa, -video.
runner="${RUNNER_REPO:-hardness-runner}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

# Each image carries a key over everything that goes into it. An image that already has the
# current key is left alone, so `pnpm dev` and `pnpm start` cost ~nothing when nothing
# changed. REBUILD=1 builds anyway (Docker's layer cache still applies).
key_of() { { printf '%s\n' "$@"; cat "$@"; } | shasum | cut -c1-16; }
current_key() { docker image inspect -f '{{index .Config.Labels "dev.hardness.build"}}' "$1" 2>/dev/null || true; }
tree_files() { (cd "$root" && find "$@" -type f -not -path '*/node_modules/*' -not -path '*/.eve-agents*' | LC_ALL=C sort | sed "s#^#$root/#"); }

ref="$(git -C "$root" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
inputs=()
while IFS= read -r f; do inputs+=("$f"); done < <(tree_files factory contracts/src contracts/package.json machine/runner/graph; echo "$root/package.json"; echo "$root/pnpm-lock.yaml"; echo "$root/pnpm-workspace.yaml"; echo "$root/.pnpmfile.cjs"; echo "$here/Dockerfile"; echo "$here/luna-stage"; echo "$here/layer-wrapper")
key="$(key_of "${inputs[@]}")"
if [ "${REBUILD:-}" != 1 ] && [ "$(current_key "$runner:dev")" = "$key" ]; then
  echo "$runner:dev is up to date (factory $key)"
else
  docker build --build-arg "FACTORY_REF=$ref" --build-arg "LAYER_REV=$key" --label "dev.hardness.build=$key" \
    -t "$runner:dev" -t "$runner:$key" -f "$here/Dockerfile" "$root"
  echo "built $runner:dev and $runner:$key (factory $key, commit $ref)"
fi

if [ "$qa" = 1 ]; then
  qa_key="$(key_of <(echo "$key") "$here/../runner-qa/Dockerfile")"
  if [ "${REBUILD:-}" != 1 ] && [ "$(current_key "$runner-qa:dev")" = "$qa_key" ]; then
    echo "$runner-qa:dev is up to date (factory $key)"
  else
    docker build --build-arg "BASE=$runner:$key" --label "dev.hardness.build=$qa_key" \
      -t "$runner-qa:dev" -t "$runner-qa:$key" "$here/../runner-qa"
    echo "built $runner-qa:dev and $runner-qa:$key"
  fi
fi

if [ "$video" = 1 ]; then
  video_inputs=()
  while IFS= read -r f; do video_inputs+=("$f"); done < <(tree_files machine/runner-video)
  video_key="$(key_of <(echo "$qa_key") "${video_inputs[@]}")"
  if [ "${REBUILD:-}" != 1 ] && [ "$(current_key "$runner-video:dev")" = "$video_key" ]; then
    echo "$runner-video:dev is up to date (factory $key)"
  else
    docker build --build-arg "BASE=$runner-qa:$key" --label "dev.hardness.build=$video_key" \
      -t "$runner-video:dev" -t "$runner-video:$key" -f "$here/../runner-video/Dockerfile" "$root"
    echo "built $runner-video:dev and $runner-video:$key"
  fi
fi
