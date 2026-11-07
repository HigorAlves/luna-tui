# Project context

<!-- Agent directives. Cap: 150 lines / 6 KB. Critical rules are binding: a slice that needs to break one escalates. -->

## Critical rules

- A change to `board/` (Rust): `pnpm board:test` and the board lint CI runs, `cargo clippy --manifest-path board/Cargo.toml --all-targets -- -D warnings -A clippy::large_enum_variant`, must both be clean before every commit. There is no `pnpm board:lint` script.
- A change that only touches documentation (`*.md`, `docs/`) gets no new test and no board check: it is checked by reading it, plus the repo's existing tests (`contracts/src/readme.test.ts` pins strings in `.github/README.md`).
- A test for an overlay or modal (help, confirm, palette) renders through `ui::draw(frame, &app)` with the App in each host view
- Slice LOC estimates include the slice's tests. When the plan's total is over the ~300-line PR budget in docs/contributing.md,
