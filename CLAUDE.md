# Luna TUI: rules for agents working in this repo

## Every model call goes through the harness

The point of this project is that everything runs locally on the user's Claude subscription. So:

- **No direct calls to the Anthropic API.** Never add `@anthropic-ai/sdk`, a `fetch` to `api.anthropic.com`, or anything that needs an `ANTHROPIC_API_KEY` to work.
- **Every integration that needs a model is a pack.** Add a role in `factory/agents/<role>.md`, a prompt template in `factory/prompts/<pack>.md`, and a pack entry in `contracts/src/packs.ts` (model, effort, turns, tools, answer schema). It runs through the Claude Agent SDK inside the stage container via `factory/src/main.ts`, with whatever credential `loadCredential()` finds (the subscription token first). The Slack triage pack (`slack_triage`) is the reference for a pack that is not a pipeline stage.
- **Cheap work still goes through a pack**, on `haiku` with `effort: "low"` and a small `maxTurns`; do not reach for the API because a pack feels heavy.
- **External services** (GitHub, Slack, …) are talked to from the machine through a port in `machine/src/application/<service>.ts` and an adapter in `machine/src/adapters/<service>/`, with a `noToken…()` fallback. Their data reaches a model only as a pack's `StageInput`.

## Where things are

`docs/architecture.md` explains the pipeline, the hexagonal layout and how packs run; `docs/configuration.md` lists every variable; `docs/contributing.md` has the checks to run before a PR.
