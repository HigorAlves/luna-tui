#!/usr/bin/env bash
# Manual check of the runner-video image (not a CI test): builds a 20-second synthetic job, runs
# narrate, cards, compose and measure inside the image the way the machine does (no network,
# read-only root, a writable job dir at /work), and asserts the film and its report exist.
#   pnpm --filter @hardness/machine runner-video:smoke
set -euo pipefail

image="${RUNNER_VIDEO_IMAGE:-hardness-runner-video:dev}"
job="$(mktemp -d "${TMPDIR:-/tmp}/luna-video-smoke.XXXXXX")"
trap 'rm -rf "$job"' EXIT
chmod 0777 "$job"

in_image() {
  docker run --rm --network none --read-only --tmpfs /tmp:rw,exec,size=512m --security-opt no-new-privileges \
    --memory 4g --cpus 2 --pids-limit 1024 --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$job:/work" -w /work \
    --entrypoint "$1" "$image" "${@:2}"
}

cat >"$job/timeline.json" <<'JSON'
{
  "meta": { "w": 1920, "h": 1080, "fps": 30, "dur": 20, "clock": "voice", "title": "Smoke", "commit": "0000000" },
  "scenes": [
    { "id": "hook", "title": "Smoke test", "kind": "card", "start": 0, "end": 4, "text": "This is a smoke test of the video tools.", "card": { "heading": "Smoke test", "role": "hook" } },
    { "id": "a", "title": "First scene", "kind": "demo", "start": 4, "end": 10, "text": "The first scene shows colour bars moving." },
    { "id": "b", "title": "Second scene", "kind": "demo", "start": 10, "end": 16, "text": "The second scene shows them again." },
    { "id": "end", "title": "Done", "kind": "card", "start": 16, "end": 20, "text": "That is all.", "card": { "heading": "Done", "role": "end" } }
  ],
  "texts": [{ "role": "hook", "text": "Smoke test", "px": 96, "from": 0, "to": 4 }],
  "terms": ["smoke"],
  "facts": []
}
JSON

in_image ffmpeg -v error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=14" -c:v libx264 -pix_fmt yuv420p /work/recording.mp4
printf '{ "marks": [ { "scene": "a", "t": 0.5 }, { "scene": "b", "t": 7 } ], "videoPath": "/work/recording.mp4" }\n' >"$job/timing.json"

tools=/video-tools/tools
in_image node $tools/narrate.ts --timeline /work/timeline.json --out /work/narration
in_image node $tools/cards.ts --timeline /work/timeline.json --narration /work/narration/narration.json --out /work/cards
in_image node $tools/compose.ts --job /work
in_image node $tools/measure.ts --video /work/walkthrough.mp4 --timeline /work/timeline.json --out /work/qa

fail() { echo "smoke FAILED: $1" >&2; exit 1; }
[ -s "$job/walkthrough.mp4" ] || fail "walkthrough.mp4 is missing"
[ -s "$job/qa/report.json" ] || fail "qa/report.json is missing"
verdict="$(in_image node -e 'console.log(JSON.parse(require("fs").readFileSync("/work/qa/report.json","utf8")).verdict ?? "")')"
[ -n "$verdict" ] || fail "report.json has no verdict"
dur="$(in_image ffprobe -v error -show_entries format=duration -of csv=p=0 /work/walkthrough.mp4)"
# The cards run longer than their slots when the voice does, so allow a second either way of the plan.
planned="$(in_image node -e 'console.log(JSON.parse(require("fs").readFileSync("/work/meta.json","utf8")).plannedS)')"
awk -v d="$dur" -v p="$planned" 'BEGIN { exit ((d - p) > 1 || (p - d) > 1) }' || fail "duration $dur is not within 1 s of the plan $planned"
for sheet in beats_sheet hook_sheet phone_sheet; do [ -s "$job/qa/$sheet.jpg" ] || fail "$sheet.jpg is missing"; done
echo "smoke passed: ${dur}s (plan ${planned}s), verdict $verdict"
