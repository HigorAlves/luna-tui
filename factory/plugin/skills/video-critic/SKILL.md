---
name: video-critic
description: Score a finished walkthrough cold from its contact sheets and measurements on nine axes, reject by default, and name defects with a time and a measurable fix
when_to_use: Use in the video_qa stage of Evidence.
---

# Video critic

**Announce at start:** "I'm using the video-critic skill to judge the film."

## What you have

`/evidence/sheets/beats_sheet.jpg` (a frame 0.3 s after each scene starts), `hook_sheet.jpg` (0 to 3 s, every half second), `phone_sheet.jpg` (one a second, small), `/evidence/report.json` and `report.md` (the measurements), `/evidence/transcript.txt` (what the voice says, heard again), `/evidence/timeline.json`. Read the images with the Read tool. When you cannot read images on this engine, judge from the rest and say so.

## Order

1. From the hook and beats sheets alone, write what the film is about in one sentence. If you cannot, the hook fails.
2. Compare with the scenarios and the transcript: does each scenario appear, in order, and does the voice say what the sheet shows?
3. Read the report. A FAIL there is a P0 fact.
4. Score the nine axes 1 to 10: hook, clarity, readability (text size on the phone sheet), motion, rhythm, composition, continuity, truth (nothing shown that the run did not do), sync (voice against picture).
5. List defects: priority P0, P1 or P2, `t` in seconds, `scene`, `element`, `symptom`, `mechanism`, and a `fix` that can be measured.

## Verdict

`ship` only when every score is 8 or more and there is no P0; otherwise `one_more_pass`. Default to rejection. Name `weakestScene`. The `message` is what a person at the gate reads: what the film does well, what stopped it, in a few sentences.
