---
name: browser-qa
description: The canonical browser-QA protocol for web changes — target resolution, environment boot or attach, driver choice (Playwright primary, agent-browser fallback), the walk, the evidence packet
when_to_use: Use when running browser QA; the e2e stage delegates here.
---

# Browser QA

The single source of truth for driving browser QA — the e2e stage executes this protocol instead of restating it. Inputs from the stage: the task and the plan criteria to prove, `<qa-dir>` (`/out/files/qa/`), and the QA targets in the stage input's `context.qaTargets` when present.

## Step 0 — Resolve the target

Invoke `qa-targets`: a settled `target` decision, else `local`, else the first listed target. Result: a target **name**, its `baseUrl` (or the dev server URL once booted) and `guard`. Credential references are resolved only inline, inside the command that consumes them, and never printed. Remote target ⇒ probe; unreachable ⇒ every criterion `partial` with the reason in `summary`; never fall back to local silently.

## Step 1 — Boot or attach the environment (local target only)

Skip for remote targets. A local target with a `baseUrl` that already answers `curl -sf` is attached as is. Otherwise detect the dev command from `package.json` scripts `dev` or `start`, boot it in the background, wait for its URL (poll with `curl -sf` up to a sensible timeout), and record that URL as the target's `baseUrl`. Stop the server before the stage answers. Never run `docker`; the container is the environment. Init `<qa-dir>`.

## Step 1b — Choose the driver

In factory mode there is no driver gate. Use **Playwright (Driver P)** when `node` and `npx` are available and the repo has, or can host, a Playwright project; otherwise **agent-browser (Driver A)**. A live-browser driver that needs a person's own Chrome is unavailable in factory mode (see [DRIVER-B.md](references/DRIVER-B.md) for what it would have produced; never select it here).

## Step 2 — Load the acceptance criteria (all drivers)

Before driving anything, collect the plan criteria from the stage prompt (`mcp__luna__slice_list` gives the slice ledger when per-slice acceptance is needed). These are the scoring rubric — the walk exists to prove them, not to tour the app. Every criterion ends the run as `pass`, `fail`, or `partial` **with a stated reason**, each carrying the artifact that proves it. A criterion that cannot be reached (guarded target, missing fixture, unreachable route) is `partial` with a `note`, never dropped.

## Driver P — Playwright (delegate)

Invoke `playwright-qa` with the inputs listed in its header (feature description, `<qa-dir>`, the step-2 criteria, target name + `baseUrl` + `guard`, `isVisual`). It returns `pass|fail|partial` with `qa-manifest.json` written, or `fallback` (Node missing, Playwright cannot be installed, project cannot be created) — on `fallback` note the reason in `steps.md` and run **Driver A** below with the same inputs; never silently.

## Driver A — agent-browser (drive it yourself)

Drive the walk yourself with the `agent-browser` CLI and write `qa-manifest.json`. Read [DRIVER-A.md](references/DRIVER-A.md) when this driver runs: the full input list (base URL, criteria, visual flag) and the verdict handling.

## Iron rule

No "QA passed" claim without the evidence packet on disk — whichever driver ran. Every acceptance criterion from step 2 appears in `qa-manifest.json` with a result; `partial` requires a stated reason. The stage verdict is computed mechanically from the manifest rows (any `fail` ⇒ `fail`; else any `partial` ⇒ `partial`; else `pass`); this protocol's browser verdict is that computation's only input.
