---
name: ci-routing
description: The canonical route-on-verdict protocol for a red CI diagnosis — fixable/flake/infra/needs-debug handling, the single-render rule, and the fix-then-re-watch loop
when_to_use: Use when the CI investigator classifies a red run; the ci_watch stage and the machine's post-open CI loop follow it.
---

# CI Routing

The single source of truth for acting on a CI investigator diagnosis — the ci_watch stage emits the verdict, the machine routes on it, and neither restates the rules. Input: the diagnosis (verdict + evidence table + fix list). In factory mode there is nobody to ask: the stage answers with its JSON result and the machine takes the matching branch below.

**Single-render rule:** the diagnosis is never echoed wholesale. It gets ONE capped rendering in `summary`: the fix list + one evidence line per root cause + the run URL. Quotes are capped at 3 evidence lines.

## `green`

Say so — one line, run ID cited. The stage passes.

## `fixable`

Render the one preview in `summary` (N root causes across M jobs, then the numbered `<file>:<line> — <change> — clears <job>` list) and carry each item as a `review-contract` finding. The stage fails; the machine loops to implementing with the findings. The implementer applies each fix at its source, with a test, in a new commit; the machine pushes and the next ci_watch run re-watches. A fix that comes back red returns to the investigator as new evidence (it sees the failed attempt); the loop continues until green or the machine's attempt budget escalates.

## `flake`

Quote up to 3 run-history evidence lines proving intermittency. The stage passes with the note; the machine performs exactly one re-run of the failed jobs and watches it. Never run `gh run rerun` yourself. Not convinced by the history ⇒ it is `fixable` or `needs_debug`, not `flake`.

## `infra`

No code changes to make. The stage fails and escalates through `requested[]` with the recommendation (pin the action version, report to the platform team, wait out the outage) and its capped evidence. A re-run is suggested only when the investigator recommended one.

## `needs_debug`

The failure needs root-cause work beyond the diff. The stage fails and escalates through `requested[]` with the classification, the run URL and the evidence, so the diagnosis seeds the debugging that follows instead of starting from zero.

## Iron rules

- **No fix without the investigator's diagnosis.** The implementer only ever receives an evidence-cited fix list — never "CI is red, go fix it".
- **Re-runs belong to the machine.** The stage never re-runs; a `flake` verdict without run-history evidence is not a `flake`.
- **Never `git push --force`** — a red pipeline is not a license for history rewrites.
