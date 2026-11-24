# Handoff

Disclosed from `writing-plans`. Read after the brief is drafted: who consumes which field, so the brief is written for its readers.

In factory mode (LUNA_FACTORY=1) there is no execution choice to offer and no subagent to dispatch: the triage stage answers with the JSON brief and the stages after it do the work themselves.

- **Implementing stage** — reads `slices[]` in order and runs each as a TDD loop (`tdd`): failing test per acceptance line, minimal code, suite green, one commit per slice. `touchpoints` is its file-ownership boundary; `est_loc` is the budget it escalates on at 1.5×.
- **Verifying stage** — scores every entry of `criteria[]` and every slice's `acceptance[]` with evidence (`verification-before-completion`).
- **E2E stage** — proves the browser-observable subset of `criteria[]` against the running app (`browser-qa`).
- **Controller** — reads `confidence` and `risk` to decide whether the plan waits for a person; `assumptions[]` is what that person sees first.

Nothing reads `summary` to act — it is the one place for prose, and prose there never substitutes for a missing slice, criterion or assumption.
