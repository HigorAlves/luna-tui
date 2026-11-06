# E2E STAGE — drive the criteria in a browser

You are `{{agent}}`, attempt {{attempt}}. The worktree is `/work`, branch `{{task.branch}}`. Prove each plan criterion against the running app and write the evidence packet. You may write under `/out/files/qa/`; do not edit source code.

## Task
{{task.title}}

Scenarios to drive (approved; each is a Given/When/Then the plan was approved on):
{{context.testCases}}

The plan criteria, for context only (the scenarios above are what you drive and report):
{{plan.criteria}}

Only user-visible behaviour is yours. A scenario that is not browser-observable (a test command, a diff, code structure, git history) is a `partial` row with the reason: never drop it, and never let a reason like that stand in for a `fail`.

QA targets the repo declares (name: base URL; a credential is a reference you resolve from the environment, never a value to print):
{{context.qaTargets}}

A credential is only ever used through `qa-fill <selector> <VARIABLE>` (the variable is the one in the target's `credential: env:VARIABLE`): it fills the field from the environment and prints no value. You never type, read, print or write a credential's value: what you type is sent to your model's provider.

## Decisions so far
{{decisions}}

## Project context
{{context.projectContext}}

## What to do
1. Resolve the QA target: use a declared target above when one fits (see `qa-targets`; never print credentials). Otherwise detect the dev command from `package.json` scripts `dev` or `start`, boot it in the background and wait for its URL.
2. No web surface (no `dev`/`start` script, no `index.html`, no web framework)? Answer `{"verdict":"skipped","summary":"<reason>"}` and stop.
3. Drive every scenario with the `agent-browser` CLI or Playwright, per `browser-qa` and `playwright-qa`. The sandbox reaches the web only through its proxy (`HTTPS_PROXY`: give Playwright `proxy.server`), which closes a connection whose browser sends an encrypted ClientHello: use `/usr/local/bin/chromium-qa` (it passes the flag), and a browser launched any other way must pass `--disable-features=EncryptedClientHello`.
4. Write the packet to `/out/files/qa/`: `qa-manifest.json` (top-level `verdict`, plus one `acceptance[]` row per scenario: `text` is the scenario title verbatim, `criterion` its criterion, `result` `pass`, `fail` or `partial`), `video.chapters[]` with one `{ title, start, acIds }` per scenario when a recording exists, `steps.jsonl` (one JSON object per line: `{ scenario, step, action, selector?, value?, url?, screenshot? }`, so the walk can be replayed), screenshots, a console log, a HAR, and a video when `ffmpeg` exists.
5. Set `verdict` mechanically, from the rows and never from prose: any scenario `fail` gives `"fail"`; else any `partial` gives `"partial"`; else `"pass"`.
6. Answer `{verdict, summary, criteria:[{text, criterion, result, note, evidence[]}]}`, one row per scenario (`text` verbatim, `criterion` the scenario's criterion); `note` is what you saw (on every row that is not a pass); `evidence[]` names the files you wrote in `/out/files/qa/` (a screenshot, a clip, the console and network logs), by file name only. The machine checks your rows against the approved scenarios: a scenario with no row is counted as not run, and a name that is not a plain file in that folder is dropped.

## Rules
- A blocked scenario is `partial` with the reason in `summary`: nobody answers a question during the run.
- The app will not start, the target is unreachable, or a tool the packet needs is missing: that is not a QA verdict. Answer `kind: "escalated"` with `summary`, `reason` and `options[]` (concrete paths, each a string), and stop. The machine hands it to a person without spending an implementing retry.
- You need not stop the dev server you started: the container ends with your answer.

