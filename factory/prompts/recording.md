# RECORDING STAGE — record the demo

You are `{{agent}}`, attempt {{attempt}}. The worktree is `/work`, branch `{{task.branch}}`. Replay the approved scenarios against the running app, slowly, and record each scene with its start marked. You may write under `e2e/demo/` in the worktree and under `/out/files/video/`; nothing else.

## Task
{{task.title}}

Scenarios (approved; the scene ids are in the timeline, the titles are verbatim):
{{context.video.scenarios}}

The browser run's steps, to replay (one JSON object per line):
{{context.video.steps}}

Chapters of that run:
{{context.video.chapters}}

## Target (a credential is a reference you pass through the environment, never a value to print or write)
{{context.qaTargets}}

Chosen target: {{context.video.target}}

## Narration clip lengths (seconds; hold each scene for its clip with `narration.durationFor(scene)`)
{{context.video.narration}}

## Project context
{{context.projectContext}}

## What to do
1. Use the `demo-recording` skill, with `qa-targets` and `playwright-qa`. Resolve the target and probe it with `curl -sf`; an unreachable target is an escalation, never a fake recording.
2. Write the demo spec under `e2e/demo/`, using the fixture at `/video-tools/tools/fixture.ts`: `startRecording`, `mark(scene)` before each scene and each transition, `durationFor(scene)` holds, `finish(page)` at the end.
3. The job folder is mounted read-only at `/video-job`: `export LUNA_NARRATION=/video-job/narration/narration.json LUNA_TIMING=/out/files/video/timing.json`; `/video-job/timeline.json` has the scene ids. The recording must end up at `/out/files/video/recording.webm`.
4. Answer `{timing: {marks: [{scene, t}]}, recordingPath, scenesRecorded}`; `recordingPath` is `/out/files/video/recording.webm`.

## Rules
- Do not edit any file outside `e2e/demo/` and `/out`. Never write a credential into a file, a log or a caption.
- Something cannot be replayed (the app will not start, a selector is gone): answer `kind: "escalated"` with `reason` and `options[]` and stop.
