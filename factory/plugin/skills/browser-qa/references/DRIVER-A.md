# Driver A — agent-browser (drive it yourself)

Disclosed from `browser-qa`. Read when the driver choice resolved to `agent-browser`, or when Driver P returned `fallback`.

## Driver A — agent-browser

You are the validator: there is no subagent to dispatch in factory mode. Gather these inputs before the first browser command:

- The feature description.
- **`baseUrl`** from the resolved target (the booted dev server URL for `local`). Never boot a second server when one already answers; attach.
- The artifact directory `<qa-dir>` (`/out/files/qa/`).
- **The acceptance criteria from step 2**, each tagged with its index — capture a dedicated `ac-<idx>-<slug>.png` at the moment each criterion is observable and score it evidence-cited, instead of narrating vibes.
- **Whether the change is visual** (the diff touches a rendered surface) — when it is, record the walk via `agent-browser record`. That recorder wraps `ffmpeg`: with ffmpeg installed the WebM is a required artifact; without it the run passes on stills and says so in one line. Never a silent omission, never an install.

Walk the golden path + edge cases, capture the evidence, write `steps.md` and **`qa-manifest.json`** (top-level `verdict`, `driver: "agent-browser"`, `artifacts[]`, `curated[]`, one `acceptance[]` row per criterion with `result`, `evidence[]` and a `note` on every `partial`). **The manifest is the contract: the stage answer's `criteria[]` is built from its rows, not from `steps.md`.** `pass` → answer; `fail`/`partial` → answer with the artifact named in the failing acceptance row and the reason in `summary`.
