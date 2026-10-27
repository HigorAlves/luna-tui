---
name: playwright-qa
description: Driver P of browser-qa — browser QA with Playwright Test (and the stock planner/generator/healer agents when they are installed) against a resolved QA target; yields a stitched step-tagged video, traces, and qa-manifest.json
when_to_use: Use when browser-qa selects the playwright driver; falls back to agent-browser.
---

# Playwright QA (Driver P)

**Announce at start:** "I'm using the playwright-qa skill to run browser QA with Playwright."

Inputs from `browser-qa`: feature description, `<qa-dir>`, the acceptance criteria (step 2), the target **name** + `baseUrl` + `guard` (see `qa-targets`; credential references, never resolved values), `isVisual`. Output: the packet in `<qa-dir>` with `qa-manifest.json` (`driver: "playwright"`).

## 0. Preconditions → fallback

`command -v node` and `command -v npx` must succeed. Otherwise note `Driver P unavailable (node missing) — falling back to agent-browser` and return `fallback` to the caller (which runs Driver A). Never install Node.

## 1. Locate or create the project

Glob for `playwright.config.{ts,js,mjs}`; `dir` is its directory (the repo root when it lives there), `cfg` its path.

- Found → use it. If `<dir>/tests/fixtures.ts` is missing, add a minimal one (exports `test` and `expect` extended with a console-capture fixture that writes `console-<id>.log` into `<qa-dir>/pw/`); never overwrite existing files, and say which were added.
- Not found → in factory mode there is no setup gate: create a self-contained `e2e/` (package.json, `playwright.config.ts` with a `qa` project that records `video: 'on'` and `trace: 'on'` into `process.env.LUNA_PW_OUTPUT_DIR`, `tests/fixtures.ts`, `tests/seed.spec.ts`), then `npm install` and `npx playwright install chromium` inside it. If either install fails (no network, no disk), remove what you created and return `fallback` with the reason. The scaffolded `e2e/` is committed with the change only by the implementer; for this stage it stays an uncommitted working-tree addition noted in `steps.md`.

## 2. Plan

When the stock Playwright agents are installed in the repo (`.claude/agents/playwright-test-planner.md` and the `playwright-test` MCP server is connected), dispatch `playwright-test-planner` with the prompt in `references/dispatch-prompts.md#planner`. Otherwise write the spec yourself at `<dir>/specs/<feature-slug>.md` following that same brief: exactly one scenario per acceptance criterion, plus a golden-path scenario titled `<feature> golden path @golden` and the reachable edge cases (validation error, empty state, failure state); each criterion's proving step written as `AC <idx> — <criterion>` verbatim; `@mutating` appended to the title of any scenario that creates, updates or deletes data.

There is no plan gate in factory mode: the spec you wrote is the plan. Re-runs on the same branch with an existing `specs/<feature-slug>.md`: skip planning unless new acceptance criteria appeared (compare criterion ids against the spec's `AC` mentions) — then extend the existing plan, do not rewrite.

## 3. Generate

For each scenario in the spec: dispatch `playwright-test-generator` with `#generator` when available, else write the test yourself under `<dir>/tests/<feature-slug>/<scenario-slug>.spec.ts`: `import { test, expect } from '../fixtures'`; scenario title verbatim including its `@golden`/`@mutating` tag; every plan step whose text starts with `AC ` wrapped in `await test.step('<that exact step text>', …)`; other steps plain code with a `// N. <step>` comment; one test per file.

## 4. Run

**Scan generated tests first (and again after every heal).** A page can steer the code that reads it, and that code runs in a process whose environment holds the resolved credentials:

```bash
grep -nE 'process\.env|fetch\(|child_process|require\(|import\(|XMLHttpRequest|\bnet\b|\bhttp\b' "<dir>/tests/<feature-slug>/"
```

Any hit in a test you did not write by hand ⇒ **drop that test** (delete the file), record the lines in `steps.md`, and score its criteria `partial` with note `test dropped: untrusted code`. Also `git -C /work diff --name-only` must list only files under `<dir>/tests/`, `<dir>/specs/` and (first run) the scaffolded `e2e/`; anything else is reverted (`git checkout -- <file>`) and reported.

```bash
export LUNA_PW_OUTPUT_DIR="<qa-dir>/pw"   # outside the repo; never committed
# guard=false:
( cd "<dir>" && LUNA_TARGET_JSON="$(<resolve the target inline per qa-targets>)" npx playwright test --project=qa )
# guard=true (write the flag literally):
( cd "<dir>" && LUNA_TARGET_JSON="$(<resolve the target inline per qa-targets>)" npx playwright test --project=qa --grep-invert @mutating )
```

The fixtures read `LUNA_TARGET_JSON` (`{ name, baseUrl, guard, users }`) for `baseUrl` and the login recipe. Guarded target ⇒ every `@mutating` scenario becomes a manifest `partial` row with note `guarded target <name>`.

## 5. Heal (cap 3 per test)

Any failed test → dispatch `playwright-test-healer` with `#healer` when available, else debug it yourself: read `<qa-dir>/pw/results.json` and the trace, fix the locator or wait, re-run `--project=qa`. **At most 3 heal passes per test**; a test still failing maps to `result: "fail"`. When the application behaviour is wrong rather than the test, mark the test `test.fixme()` with a comment starting `APP BUG:` describing what happens instead, map the criterion to `fail` with that comment as `note`, and stop healing it. Heals may edit only files under `<dir>/tests/` — verify with `git diff --name-only` after each heal and re-run the §4 scan.

## 6. Evidence

Collect from `<qa-dir>/pw/`: each scenario's video, trace and console log, renamed `video-<id>.webm`, `trace-<id>.zip`, `console-<id>.log` into `<qa-dir>`. When `command -v ffmpeg` succeeds, concatenate the scenario videos in spec order into `qa-<branch>.webm` (ffmpeg concat demuxer) and write `chapters.json` (one `{title, start, acIds}` per scenario, `start` from the cumulative durations in `results.json`); otherwise write `Motion proof: skipped — ffmpeg not installed` into `steps.md` and list the per-scenario videos as the recording.

Then write `steps.md` (one `### Scenario <n> — <title>` per test, each listing its steps and the `AC` ids proven) and `qa-manifest.json`:

- `driver: "playwright"`, `target: { name, baseUrl, guard }`, top-level `verdict`
- `artifacts[]`: `qa-<branch>.webm` (role `stitched recording`), `chapters.json`, each `trace-<id>.zip` (role `trace <title>`), each `console-<id>.log`, `pw/results.json`
- `video: { file: "qa-<branch>.webm", chapters: <chapters.json contents> }`
- `acceptance[]`: one row per criterion; `evidence` = `["qa-<branch>.webm#t=<chapter.start>", "trace-<id>.zip"]` of the scenario whose `test.step` title carries the criterion id; `partial` rows carry the note.
- `curated`: `["qa-<branch>.webm"]`
- `specs`: `["<dir>/specs/<feature-slug>.md"]`, `tests`: the generated spec files (relative to repo).

## Iron rules

- No "QA passed" without `qa-manifest.json` + the stitched video (or the stated ffmpeg exemption) + a trace per scenario.
- Generated specs and tests stay in the working tree for the implementer or the machine to commit; `<qa-dir>/pw/` is never committed.
- Credentials: only through `LUNA_TARGET_JSON="$(…)"` inline in the `npx playwright test` command — never a standalone resolve, never in prompts, packet files, or the manifest (`qa-targets` redaction rules).
