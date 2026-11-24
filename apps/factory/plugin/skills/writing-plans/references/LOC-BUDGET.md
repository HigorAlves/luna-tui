# LOC budget — estimating est_loc and the split signal

Disclosed from `writing-plans`. Read when filling `est_loc` on a slice, when a Graphify graph is available for blast-radius, or when a slice's decomposition exceeds the budget.

Every slice carries `est_loc: <int>`. Heuristic for the estimate:

```
est_loc ≈ (new_files * 80) + (modified_files * 30) + boilerplate_test_lines
```

Adjust upward for known-large files (config, fixtures), downward for one-line tweaks. The budget is **300 LOC** per slice, additions + deletions, after excluding lockfiles, generated code, snapshots and migrations.

When a Graphify code graph is available (per `code-discovery`), sharpen the `modified_files` term with real blast-radius: `graphify affected "<symbol-you'll-change>" --depth 2` lists the call sites that ripple from a change. Count each caller you'll actually have to touch as ~+30 LOC, and treat a symbol with many affected callers as a split signal *before* implementation, not a surprise at ship time. `affected` is a lead, not proof — it doesn't expose per-edge confidence — so read each cited caller to confirm it needs to change before counting it. Fall back to `Grep` for callers when no graph is available.

When a slice's natural decomposition would exceed **1.5× the budget** (~450 LOC), that's a planning signal:

- **Split the slice further.** Usually there's a refactor-then-feature seam that hasn't been surfaced yet.
- **OR say so.** If it genuinely cannot be split (a generated migration, a lockstep rename), keep the honest `est_loc`, record why in `assumptions[]`, and let it weigh on `risk`. Don't quietly accept a 600-LOC slice.

The estimate is a **budget contract**, not a precision prediction — the implementing stage escalates when actual exceeds `est_loc * 1.5` rather than ballooning silently.
