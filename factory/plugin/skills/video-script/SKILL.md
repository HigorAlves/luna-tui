---
name: video-script
description: Write the script and the timeline of a narrated walkthrough from the approved scenarios, or fix named scenes of an earlier one; the timeline shape, the rules the machine checks, and the files to write
when_to_use: Use in the video_script and video_fix stages of Evidence.
---

# Video script

**Announce at start:** "I'm using the video-script skill to write the walkthrough."

## Files

Write both under `/out/files/video/`: `script.md` (per scene: id, title, the narration, one line on what is on screen) and `timeline.json`. Never edit `/work`.

## timeline.json

```json
{
  "meta": { "w": 1920, "h": 1080, "fps": 30, "dur": 60, "clock": "voice", "title": "Discounts in the cart", "commit": "<sha7>" },
  "scenes": [
    { "id": "hook", "title": "Discounts in the cart", "kind": "card", "start": 0, "end": 4, "text": "<narration>", "card": { "heading": "Discounts in the cart", "role": "hook" } },
    { "id": "add-coupon", "title": "<the approved scenario's title, verbatim>", "kind": "demo", "start": 4, "end": 30, "text": "<narration>" },
    { "id": "end", "title": "That is the change", "kind": "card", "start": 56, "end": 60, "text": "<narration>", "card": { "heading": "Shipped", "role": "end" } }
  ],
  "texts": [{ "role": "hook", "text": "Discounts in the cart", "px": 96, "from": 0, "to": 4 }],
  "terms": ["coupon"],
  "facts": [{ "claim": "Saves 30% on the sample cart", "source": "qa-manifest.json: total row" }]
}
```

Scene ids are lowercase letters, digits, `-` and `_`. Scenes are contiguous: each starts where the last ended, the first at 0, the last ends at `meta.dur`.

## Rules the machine checks (an error stops the film)

- One `demo` scene per approved scenario, titled verbatim. Duration at most 240 s.
- A `hook` text starts by 3 s; px at least 84 for the hook and 48 for `cta` and `term` (at 1080).
- A digit in any on-screen text or caption needs a `facts` entry that contains it, or the text must say `SCHEMATIC` or `Example data`.

Warnings the critic sees: read time under `max(1.5, 1 + 0.3 x words)` seconds, narration over 3 words a second, a film under 30 s, no `terms`.

## Narration

Sentences of 8 to 18 words. Describe what the viewer sees now. Define a term the first time. Write `{shown|spoken}` where an identifier is shown one way and said another.

## Answer

`{ script, timeline, facts, durationEstimateS }` with the same content as the files. When the inputs do not support a scene, answer `kind: "escalated"` with `reason` and `options`.

## Fixing

Given fix cards (a time, a scene, an element, the problem, a priority), change only the scenes they name. Keep every other scene's id, text and times.
