# Luna TUI: rules for agents working in this repo

## Every model call goes through a pack, an engine and a native runtime

The point of this project is that everything runs locally, on the user's own subscriptions (the Claude token, the Codex login) unless they opt into a metered key. So:

- **Claude models run only through the Claude Agent SDK** (`factory/src/runtimes/claude/`), on the subscription token first (`ANTHROPIC_API_KEY` is the fallback `loadCredential()` has). Never add `@anthropic-ai/sdk`, a `fetch` to `api.anthropic.com`, or `eve/models/anthropic`.
- **Every other agent model runs through eve** (`factory/src/runtimes/eve/`): `codex:*` engines on `chatgpt()`, the local Codex login; `openai:*` engines on `OPENAI_API_KEY`, opt-in.
- **Jev runs only in `factory/src/runtimes/jev/`**, and only for decision packs: through TypeSafe's SDK (`@typesafe-ai/sdk`, `TYPESAFE_API_KEY`) or the AI SDK's decision API on the Vercel AI Gateway (`experimental_decide` from `ai`, `AI_GATEWAY_API_KEY`, preferred when set). It is the metered path: opt-in through either key, priced in the model catalog, and Luna works the same without it.
- **Cognee, the memory service, calls OpenAI itself** with its own opt-in key (`~/.config/hardness/cognee-openai-key`), its model named in the catalog (`SERVICE_MODELS.cognee` in `contracts/src/models.ts`). This is the one model path outside packs, and memory is local-only (Cognee's local extractor) without the key.
- **A local embedding model serving Cognee is not a pack:** it writes no text, runs offline and holds no credential.
- **An SDK is imported only inside its own runtime folder**, and no source file outside `contracts/src/models.ts` names a model ID (`contracts/src/engines.test.ts` checks): a pack names engines (`contracts/src/engines.ts`, such as `claude:haiku`), an engine names a catalog model. Effort stays on the pack.
- **Every integration that needs a model is a pack.** An agent pack is a role in `factory/roles/<role>/role.md` (a `description:` frontmatter, then the body; an optional `eve.md` beside it is appended on eve runs), a prompt template in `factory/prompts/<pack>.md`, and an entry in `contracts/src/packs.ts` (engines, effort, turns, access, answer schema). A decision pack is an entry with typed questions (`contracts/src/questions.ts`) and no role or prompt. Either runs in the stage container through `factory/src/main.ts`, which hands it to its engine's runtime; the machine passes only that engine's credential. The Slack triage pack (`slack_triage`) is the reference for a pack that is not a pipeline stage.
- **Cheap work still goes through a pack**, on `claude:haiku` with `effort: "low"` and a small `maxTurns`; do not reach for an API because a pack feels heavy.
- **External services** (GitHub, Slack, Jira, …) are talked to from the machine through a port in `machine/src/application/<service>.ts` and an adapter in `machine/src/adapters/<service>/`, with a `noToken…()` fallback. Their data reaches a model only as a pack's `StageInput`.

## Keep the TUI's integrations

The TUI keeps Jira, Slack and the PR inbox, and the machine's loops behind them, until the user has tested Luna Notch with the machine and says otherwise ([RFC 0004](docs/rfcs/0004-harness-for-luna-notch.md), step 7).

## Where things are

`docs/architecture.md` explains the pipeline, the hexagonal layout and how packs run on each runtime; `docs/configuration.md` lists every variable and credential; `docs/contributing.md` has the checks to run before a PR; `docs/runbooks/` the procedures (upgrading a model); `docs/rfcs/` the designs, each with notes on what was built.
