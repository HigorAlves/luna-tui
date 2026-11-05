#!/usr/bin/env bash
# Checks the machine's layer (/opt/luna) of a runner image: that it is there, that the factory starts from it,
# and that it runs when copied onto another glibc Linux image (a stock python:slim, which has no Node, gh or rg).
# Usage: check-layer.sh <runner image> [foreign base, default python:3.13-slim]. Needs docker.
set -euo pipefail
image="${1:?usage: check-layer.sh <runner image> [foreign base]}"
foreign="${2:-python:3.13-slim}"
fail=0
check() { # name, command...
  local name="$1"; shift
  if out="$("$@" 2>&1)"; then echo "PASS  $name"; else echo "FAIL  $name: $(printf '%s' "$out" | tail -3)"; fail=1; fi
}
# The stage entry: it must start the factory (no input: the factory's own refusal, never a loader or a missing file).
starts() {
  local img="$1" out
  out="$(docker run --rm -i --entrypoint /opt/luna/bin/luna-stage "$img" </dev/null 2>&1 || true)"
  printf '%s' "$out" | grep -Eq "main.ts|^factory: " || { printf '%s\n' "$out" | tail -5; return 1; }
  if printf '%s' "$out" | grep -Eqi "not found|docker: |Error response|no such file|GLIBC|error while loading|cannot open shared|Cannot find module"; then printf '%s\n' "$out" | tail -5; return 1; fi
}
tools() {
  docker run --rm --entrypoint sh "$1" -c '/opt/luna/bin/node --version && /opt/luna/bin/rg --version | head -1 && /opt/luna/bin/gh --version | head -1 && /opt/luna/bin/graphify --help >/dev/null && test -f /opt/luna/graph-tools/build.py && /opt/luna/python/bin/python3 -c "import graphify"'
}
check "the image has the entrypoint /opt/luna/bin/luna-stage" docker run --rm --entrypoint test "$image" -x /opt/luna/bin/luna-stage
check "the factory starts from the layer in the runner image" starts "$image"
check "the layer's tools run in the runner image" tools "$image"

ctx="$(mktemp -d)"; tag="hardness-runner-test-layer-$$"
trap 'rm -rf "$ctx"; docker rmi -f "$tag" >/dev/null 2>&1 || true' EXIT
printf 'FROM %s\nCOPY --from=%s /opt/luna /opt/luna\n' "$foreign" "$image" > "$ctx/Dockerfile"
check "the layer copies onto $foreign" docker build -q -t "$tag" "$ctx"
check "the factory starts from the layer on $foreign" starts "$tag"
check "the layer's tools run on $foreign" tools "$tag"
exit "$fail"
