#!/bin/sh
# Downloads one GitHub release asset to a file, for the machine's and the runner's images:
#   fetch-release.sh <owner/repo> <tag> <asset name> <output file>
# The release download is tried first, with retries; when github.com's release route itself fails (on 2026-11-08 it served 504 for hours,
# for cli/cli and then python-build-standalone, while the API served the same files), the asset is fetched through the API instead. It goes
# to a file, not a pipe: a retry after a partial body would hand tar a broken stream. The caller checks what it needs (a checksum, a run).
set -eu
repo="$1"
tag="$2"
name="$3"
out="$4"
retry="--retry 5 --retry-delay 3 --retry-all-errors"
encoded="$(printf '%s' "$name" | sed 's/+/%2B/g')"

# shellcheck disable=SC2086
if curl -fsSL $retry -o "$out" "https://github.com/${repo}/releases/download/${tag}/${encoded}"; then exit 0; fi
echo "fetch-release: the release download of ${name} failed; fetching it through the API" >&2
release="$(curl -fsSL $retry "https://api.github.com/repos/${repo}/releases/tags/${tag}")"
if command -v node >/dev/null 2>&1; then
  url="$(printf '%s' "$release" | NAME="$name" node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const a=(r.assets||[]).find((x)=>x.name===process.env.NAME);if(!a)process.exit(1);console.log(a.url)')"
else
  url="$(printf '%s' "$release" | NAME="$name" python3 -c 'import json,os,sys;a=[x for x in json.load(sys.stdin).get("assets",[]) if x["name"]==os.environ["NAME"]];print(a[0]["url"]) if a else sys.exit(1)')"
fi
# shellcheck disable=SC2086
curl -fsSL $retry -H "Accept: application/octet-stream" -o "$out" "$url"
