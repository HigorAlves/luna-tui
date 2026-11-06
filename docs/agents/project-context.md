# Project context

<!-- Agent directives. Cap: 150 lines / 6 KB. Critical rules are binding: a slice that needs to break one escalates. -->

## Critical rules

- Checks: `pnpm board:test` and `pnpm board:lint` (clippy, `-D warnings`) must both be clean before every commit.
- A test for an overlay or modal (help, confirm, palette) renders through `ui::draw(frame, &app)` with the App in each host view
- Slice LOC estimates include the slice's tests. When the plan's total is over the ~300-line PR budget in docs/contributing.md,
- A test for an overlay or modal (help, confirm, palette) renders through `ui::draw(frame, &app)` with the App in each host view <!-- FIX: sentence truncated; restore its ending. -->
- Slice LOC estimates include the slice's tests. When the plan's total is over the ~300-line PR budget in docs/contributing.md, <!-- FIX: sentence truncated; restore its ending. -->
- Moving, renaming or deleting a file: grep the repo for the old path and its basename (links, backticked paths, prose), make every hit a touchpoint, and count deleted lines and those edits in the slice estimate.
- Markdown references to repo files are relative links resolved from the referencing file's own directory (e.g. `../docs/architecture.md` from `board/`), never repo-root paths in backticks. The markdown link test under `pnpm test` enforces resolution.
