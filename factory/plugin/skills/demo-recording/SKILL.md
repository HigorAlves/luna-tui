---
name: demo-recording
description: Record the demo of the approved scenarios with Playwright and argo's narration fixture, marking each scene and holding it for its narration clip
when_to_use: Use in the recording stage of Evidence, after the narration exists.
---

# Demo recording

**Announce at start:** "I'm using the demo-recording skill to record the demo."

Resolve the target per `qa-targets` and drive with Playwright per `playwright-qa`, but slowly, as a person would show it.

## The fixture

```ts
import { narration } from "/video-tools/tools/fixture.ts";

const page = await context.newPage();
narration.startRecording(page);              // right after the page exists
narration.mark("add-coupon");                // before the scene's first action
await narration.cursorTo(page, "#coupon");
await page.fill("#coupon", "SAVE10");
await narration.highlight(page, "#apply", 800);
await page.click("#apply");
await page.waitForTimeout(narration.durationFor("add-coupon"));  // ms: the scene lasts as long as the timeline plans (end - start)
await narration.finish(page);                // closes the page, writes timing.json
```

`caption(page, text, ms)` puts an in-world caption on the page for `ms`. The scene ids are the timeline's; `durationFor` uses the narration file named by `LUNA_NARRATION` when it exists, else the timeline at `LUNA_TIMELINE` (the recorder runs beside the voice, so it usually has only the timeline). `cta(page, text, ms)` is an overlay like `caption`.

## Environment

`export LUNA_NARRATION=/video-job/narration/narration.json LUNA_TIMING=/out/files/video/timing.json` (the job folder is mounted read-only at `/video-job`; `/video-job/timeline.json` has the scene ids). Configure Playwright's video to record into `/out/files/video/`; copy or rename the result to `/out/files/video/recording.webm`.

## Where to write

Specs go under `e2e/demo/` in the worktree; nothing else in the repo changes. Output goes to `/out/files/video/`. A credential is an `env:NAME` reference: pass it through the environment, never into a file, a log or a caption.

## Answer

`{ timing: { marks: [{ scene, t }] }, recordingPath, scenesRecorded }`, the marks as `timing.json` has them. If a step cannot be replayed, answer `kind: "escalated"` with the reason.
