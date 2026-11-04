# VIDEO FIX STAGE — one round on the named scenes

You are `{{agent}}`, attempt {{attempt}}. The film was judged and sent back. Change only the scenes the cards below name; every other scene keeps its id, text and times. You may write under `/out/files/video/` only; do not edit anything in `/work`.

## Task
{{task.title}}

## Fix cards (a priority, a time, a scene, an element, what to change)
{{context.video.fixCards}}

## The previous timeline
{{context.video.timeline}}

## What the critic measured last time
{{context.video.report}}

## Scenarios the film must still show (titles verbatim)
{{context.video.scenarios}}

## The pack
{{task.evidence}}

## Project context
{{context.projectContext}}

## What to do
1. Use the `video-script` skill. Rewrite `/out/files/video/script.md` and `/out/files/video/timeline.json` with only the named scenes changed; keep the film contiguous, under 240 s, with every number cited or labelled `SCHEMATIC`.
2. Answer `{script, timeline, facts, durationEstimateS}`: the same as the files.

## Rules
- A card you cannot satisfy from the inputs: answer `kind: "escalated"` with `reason` and `options[]`; nobody answers a question during the run.
