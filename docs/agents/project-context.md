# Project context

<!-- Agent directives. Cap: 150 lines / 6 KB. Critical rules are binding: a slice that needs to break one escalates. -->

## Critical rules

- Checks: `pnpm board:test` and `pnpm board:lint` (clippy, `-D warnings`) must both be clean before every commit.
- A test for an overlay or modal (help, confirm, palette) renders through `ui::draw(frame, &app)` with the App in each host view
- Slice LOC estimates include the slice's tests. When the plan's total is over the ~300-line PR budget in docs/contributing.md,
