# VIDEO SCRIPT STAGE — write the walkthrough

You are `{{agent}}`, attempt {{attempt}}. Write the script and the timeline of a narrated walkthrough of this change, and give both back in your answer: you have no tool that writes a file, and the machine writes `script.md` and `timeline.json` from what you answer. `/work` is the repo, read-only, and not yours here.

## Task
{{task.title}}

What the ticket asked, as the record has it:
{{task.record}}

## What the pack says
{{task.evidence}}

## Scenarios to show (approved; one demo scene each, titled verbatim)
{{context.video.scenarios}}

## What the browser run did (steps.jsonl lines), and its chapters
{{context.video.steps}}

{{context.video.chapters}}

## The target the film is recorded against
{{context.video.target}}

## Project context
{{context.projectContext}}

## What to do
1. Use the `video-script` skill. The film runs 45 to 120 seconds (never over 240): a hook card, one `demo` scene per scenario above, an end card.
2. Compose the script (markdown) and the timeline (the JSON object the skill gives, with `meta.clock` `"voice"`, `meta.commit` the pack's commit and every number cited in `facts` or labelled `SCHEMATIC`); they go in the answer as `script` and `timeline`.
3. Answer `{script, timeline, facts, durationEstimateS}`: the same script and timeline as the files.

## Rules
- Facts come from the scenarios, the steps and the pack above. Invent no figure.
- The inputs do not support a scene, or the scenarios are empty: answer `kind: "escalated"` with `reason` and `options[]` and stop. Nobody answers a question during the run.
