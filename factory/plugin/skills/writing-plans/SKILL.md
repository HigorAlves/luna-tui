---
name: writing-plans
description: Write a comprehensive implementation plan of bite-sized TDD slices that an engineer with zero codebase context could execute — exact files, acceptance per slice, LOC estimates, and verification steps
when_to_use: Use when you have a ticket or requirements for a multi-step task, before touching code. The triage stage invokes it to produce its JSON brief.
license: MIT
metadata:
  author: Jesse Vincent
  source: Derived from https://github.com/obra/superpowers
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each slice, what to test, which docs to check, how to prove it. Give them the whole plan as bite-sized slices. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** In factory mode (LUNA_FACTORY=1) the triage stage runs this skill read-only against the worktree at `/work`. The plan is not a file: the stage answers with a JSON `brief` — `summary`, `criteria[]`, `assumptions[]`, `slices[]` of `{title, est_loc, touchpoints[], acceptance[]}`, `confidence`, `risk`. Read [TEMPLATE.md](references/TEMPLATE.md) for the shape and the field semantics before drafting it. Everything below is the craft that fills those fields.

## Scope Check

If the ticket covers multiple independent subsystems, say so: plan the one the ticket is actually about, record the split as an assumption (`assumptions[]`), and keep the out-of-scope subsystem out of `slices[]`. Each plan produces working, testable software on its own.

## File Structure

Before defining slices, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in. In an existing codebase, follow `code-discovery` to locate the relevant files cheaply — when a Graphify code graph is available, `graphify query`/`path` surfaces which modules a change touches and how they connect, so you map the file list without reading the whole tree; fall back to Glob/Grep otherwise.

- Design units with clear boundaries and well-defined interfaces. Each file has one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the slice decomposition. Each slice produces self-contained changes that make sense independently — a **vertical slice** (test → implementation → commit for one behaviour), never a horizontal layer. The first slice is the **tracer bullet**: the thinnest end-to-end path that proves the approach before the rest is built on it.

## Bite-Sized Granularity

**Each step the implementer takes is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

A slice is the smallest unit that survives that loop on its own: one or a few such cycles, one commit, suite green at the end.

## LOC Budget Heuristic

Each slice produces a diff small enough to review in one sitting. Target **≤ 300 LOC per slice** (additions + deletions, post-exclusion — lockfiles, generated code, snapshots, and migrations don't count).

Every slice carries `est_loc: <int>`. Read [LOC-BUDGET.md](references/LOC-BUDGET.md) for the estimate heuristic, the Graphify blast-radius refinement, the **1.5× budget** signal (split further, or state in `assumptions[]` why it cannot be split), and the budget-contract rule the implementing stage escalates on.

## Per-slice annotations (mandatory)

Every slice in `slices[]` carries the same four fields, so one contract covers the planner, the implementer, the verifier and browser QA:

```json
{
  "title": "POST /export endpoint",
  "est_loc": 140,
  "touchpoints": ["src/routes/export.ts", "test/export.test.ts"],
  "acceptance": [
    "POST /export returns 202 + a Location header",
    "row-stream test covers a 10k-row report"
  ]
}
```

Field semantics (`touchpoints` evidence rule, testable `acceptance`, ordering as the dependency expression): [TEMPLATE.md](references/TEMPLATE.md), "Slice fields".

Consumers read the brief's `slices[]` and `criteria[]`, not the prose in `summary` — anything only said in prose is lost.

## No Placeholders

Every slice must contain the actual content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without naming the behaviour and the seam the test asserts at)
- "Similar to slice N" (repeat it — the engineer may be reading slices out of order)
- Acceptance that describes what to do without saying how it is observed ("works correctly")
- References to types, functions, or methods not introduced by any slice or already present in the code you read

## Remember
- Exact, repo-relative file paths always
- Every acceptance names a command to run or a behaviour to observe, with the expected result
- Gaps you filled with a default go in `assumptions[]`, not in prose
- DRY, YAGNI, TDD, frequent commits

## Self-Review

After drafting the complete brief, look at the ticket with fresh eyes and check the brief against it. This is a checklist you run yourself, before answering — not a review someone else does. The full checklist, with the calibration rule, is [plan-document-reviewer-prompt.md](plan-document-reviewer-prompt.md). In short:

**1. Ticket coverage:** Skim each requirement in the ticket. Can you point to a slice that implements it and a criterion that proves it? List any gaps.

**2. Placeholder scan:** Search your brief for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Name consistency:** Do the types, method signatures, file paths and property names you used in later slices match what earlier slices introduce? A function called `clearLayers()` in slice 3 but `clearFullLayers()` in slice 7 is a bug.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a ticket requirement with no slice, add the slice.

## Execution Handoff

There is no handoff prompt in factory mode: the stage answers with the JSON brief and the implementing stage does the work itself, slice by slice. [HANDOFF.md](references/HANDOFF.md) says which field each downstream stage reads.
