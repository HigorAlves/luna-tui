# RFC 0002 — Native agent runtimes: Claude through its SDK, Codex through eve, Jev through TypeSafe's SDK

- **Author:** Higor Alves
- **Status:** Draft
- **Created:** 2026-11-02
- **Discussion:** (open a PR with this file)
- **Related:** [RFC 0001](./0001-own-the-factory.md) (the factory this extends), [RFC 0003](./0003-upgradable-harness.md) (how it stays maintainable)

## Summary

Every pack runs on the Claude Agent SDK today, and the pack names a Claude model directly. This RFC lets a pack run on more than one harness. The factory gets three native runtimes, each built on its vendor's SDK: `claude` (the Claude Agent SDK, for Claude models only), `eve` (Vercel's eve framework, for Codex and every other agent model, on the local ChatGPT login) and `jev` (TypeSafe's SDK, for the Jev decision model). A pack stops naming a model and names a role plus the engines allowed to play it. Everything a runtime does not own (prompt rendering, the result file, the slice ledger, the guards) moves to a shared core that all three call.

## Goals

- A role is written once and can run on Claude or Codex: "triage by Claude or by Codex" is one role with two engines, not two copies.
- A pack can be locked to one engine (the implementer stays on Claude), or allow several and pick per repo in `luna.yaml`.
- An agent on one engine can call an agent on another (a Claude verifier asking Codex for a second opinion).
- Jev classifies issues at intake, as a first pass in front of the LLM packs.
- No runtime imports another runtime's SDK; each can be upgraded or removed alone.
- The machine's side of the stage contract (`/in/stage.json`, `/out/result.json`) does not change shape.

## Non-goals

- Running Claude models through anything but the Claude Agent SDK. eve never gets an Anthropic model, not even through `eve/models/anthropic`.
- API-key paths for agent models. Claude stays on the subscription token, Codex on the ChatGPT login.
- Deploying agents to Vercel. eve runs inside the stage container, locally.
- Moving any pack's default off Claude. That is decided per pack from eval results ([RFC 0003](./0003-upgradable-harness.md)), not here.

## Background / Context

### Four terms

| Term | What it is | Lives in | Example |
|---|---|---|---|
| Role | Who the agent is: body, description, skills. Runtime-neutral. | `factory/roles/<role>/` | `triage-planner` |
| Pack | A job: role (or questions) + template + answer schema + access + limits + allowed engines. | `contracts/src/packs.ts` | `triage`, `issue_classify` |
| Runtime | The harness that executes a run, on one vendor SDK. Exactly three. | `factory/src/runtimes/<runtime>/` | `claude`, `eve`, `jev` |
| Engine | A named alias: runtime + a pinned model + effort. What packs, `luna.yaml` and the board refer to. | `contracts/src/engines.ts` | `claude:opus`, `codex:sol`, `jev` |

### Where Claude is welded in today

| File | Coupling | Becomes |
|---|---|---|
| `contracts/src/packs.ts` | `model: "opus" \| "sonnet" \| "haiku"`; `tools` are Claude tool names (`Bash(git add:*)`, `mcp__luna__step`) | `engines` + a neutral `access` block |
| `factory/src/main.ts` | Builds SDK options and loops over `query()` inline | A dispatcher; the loop moves to `runtimes/claude/run.ts` |
| `factory/src/agents.ts` | `AgentDefinition`, `ROLE_DESCRIPTION`, the `HELPER` table with Claude aliases | Description in role frontmatter; helpers carry an engine |
| `factory/src/hooks/guards.ts` | Guard policy as a `PreToolUse` hook | A pure `checkCall()` in core, wrapped per runtime |
| `factory/src/tools/luna.ts` | Ledger and step tools as an SDK MCP server | Plain handlers + zod in core, one wrapper per runtime |
| `factory/src/render.ts` | `FACTORY_RULES` names Claude tools | Rules with the runtime's tool names filled in |
| `factory/plugin/` | Skills packaged as a Claude plugin | `factory/skills/`; Claude and eve both read Agent Skills `SKILL.md` |
| `machine/src/adapters/docker/credentials.ts` | One Claude credential | One loader per runtime |

### What the other SDKs offer (as read on 2026-11-02)

- **eve** (`eve@1.0.0-rc.1`): an agent is a directory (`agent/agent.ts`, `instructions.md`, `skills/`, `tools/`, `subagents/`, `hooks/`, `sandbox/`). `chatgpt()` from `eve/models/openai` bills the ChatGPT subscription; with `codex` on the PATH it gets tokens from `codex app-server`, otherwise it needs an OS keychain. Subagents each set their own model. A client turn takes an `outputSchema` and the server validates the result. eve is server-shaped: a run is a session against `eve start` through `eve/client`.
- **Jev** (`@typesafe-ai/sdk`): a decision model, not a chat model. `TypeSafeClient.systemOne({ state, questions })` answers typed choice, score and yes/no questions (yes/no is `noul` on the wire). It reads `TYPESAFE_API_KEY` and honours `TYPESAFE_BASE_URL`. These names come from secondary sources; the spike confirms them.

## Proposed design

### Folder structure

```
contracts/src/
  packs.ts            # `model` replaced by `engines`, `tools` by `access`
  engines.ts          # engine aliases (see RFC 0003 for the model catalog behind them)
  access.ts           # runtime-neutral capabilities: read, write, commands, web, luna tools
  stage.ts            # StageInput gains `engine`

factory/
  roles/<role>/
    role.md           # frontmatter: description, skills; body shared by every runtime
    claude.md         # optional addendum, appended on Claude runs only
    eve.md            # optional addendum, appended on eve runs only
  questions/<pack>.ts # Jev packs: typed questions and criteria, no role
  prompts/<pack>.md   # unchanged
  skills/<skill>/     # was plugin/skills; read by Claude and eve
  .claude-plugin/     # manifest moves up so the plugin root is factory/
  src/
    main.ts           # dispatcher: RUNTIMES[input.engine.runtime].run(ctx)
    core/             # runtime-neutral: runtime.ts, stage-io.ts, render.ts, output.ts,
                      #   guards.ts, luna-tools.ts, delegate.ts
    runtimes/
      index.ts        # the only file that imports the runtimes
      claude/         # run.ts, options.ts, agents.ts, hooks.ts, mcp.ts
      eve/            # run.ts, compile.ts, tools/, sandbox.ts
      jev/            # run.ts, questions.ts
  .eve-agents/        # generated by eve/compile.ts at image build, gitignored

machine/src/
  adapters/credentials/   # claude.ts, codex.ts, typesafe.ts, index.ts
  domain/engine-choice.ts # pure: pack default → luna.yaml → task override
```

A role is a folder because its body is about the job and reads the same for any model; what differs is small (tool names, progress reporting, a model habit to correct) and goes in an addendum. An addendum longer than the shared body means the two are different roles. Jev packs get `factory/questions/` instead of a role: a decision model has no persona and reads no prompt. eve agents are generated from the same role, skills and pack at image build time, since roles and packs are static; a run only sends a message.

### Key interfaces / data shapes

```ts
// contracts/src/engines.ts
export const ENGINES = {
  "claude:opus":   { runtime: "claude", model: "anthropic/opus-5.5",   effort: "high" },
  "claude:sonnet": { runtime: "claude", model: "anthropic/sonnet-5.5", effort: "medium" },
  "claude:haiku":  { runtime: "claude", model: "anthropic/haiku-5.5",  effort: "low" },
  "codex:sol":     { runtime: "eve",    model: "openai/gpt-6-sol",     effort: "high" },
  "codex:luna":    { runtime: "eve",    model: "openai/gpt-6-luna",    effort: "low" },
  "jev":           { runtime: "jev",    model: "typesafe/jev" },
} as const satisfies Record<string, Engine>;

// contracts/src/packs.ts
triage: {
  id: "triage",
  kind: "agent",                                // "agent" | "decision" | "script"
  agent: "triage-planner",
  engines: { default: "claude:opus", allowed: ["claude:opus", "codex:sol"] },
  helpers: [],
  access: { read: true, write: false, web: false, commands: READ_ONLY_COMMANDS, luna: ["step"] },
  maxTurns: 40, timeoutMs: 15 * MINUTE,
  answer: TriageAnswer,
  template: "triage.md",
}

// factory/src/core/runtime.ts
export interface Runtime {
  id: "claude" | "eve" | "jev";
  run(ctx: RunContext, emit: (e: RunEvent) => void): Promise<RunOutcome>;
}
```

The Claude runtime maps `access` back to exactly today's `tools`/`allowedTools`; a golden test pins that mapping for every pack. The eve runtime maps it to eve's tools plus the guard.

```yaml
# luna.yaml
engines:
  triage: codex:sol        # must be in the pack's `allowed`; the setup gate flags it otherwise
```

Precedence: task override (a board key, later) → `luna.yaml` → pack default.

### The four cases

- **Same role, two engines.** `triage` allows `claude:opus` and `codex:sol`; one role, one template, one answer.
- **Engine-locked.** `implementing` allows only `claude:sonnet` while its guards depend on `PreToolUse`. A Codex-only `second_opinion` pack allows only eve engines.
- **Cross-engine call.** A helper with an engine on the pack's own runtime is a native subagent (the SDK's Agent tool, an eve `subagents/` entry). A helper on another runtime is a call to the `delegate` tool in `core/delegate.ts`: a child run of that helper's pack in the same container, whose validated answer is the tool result.

  ```ts
  verifying.helpers: [
    { role: "security-reviewer", engine: "claude:opus" },  // SDK subagent
    { role: "second-opinion",    engine: "codex:sol" },    // delegate
  ]
  ```

- **A decision.** `issue_classify` is `kind: "decision"` on `jev`: no tools, no worktree, no turns.

### Jev at intake

```ts
// factory/questions/issue_classify.ts
export default {
  kind:  { type: "choice", criteria: { bug: "...", feature: "...", chore: "...", question: "..." } },
  area:  { type: "choice", criteria: { board: "...", machine: "...", factory: "...", contracts: "...", site: "..." } },
  ready: { type: "yesno",  instructions: "Has testable acceptance criteria an agent could verify" },
  size:  { type: "score",  instructions: "How much code the change touches, 0 tiny to 1 large" },
} satisfies QuestionSet;
```

`runtimes/jev/questions.ts` turns this spec into the SDK's helpers, so a wire-format change moves one file. Before `jira_intake` runs on a new Jira or GitHub issue, `issue_classify` labels it; above the pack's `minConfidence` the labels apply and the ticket routes, below it `jira_intake` runs as it does now. Later uses: a yes/no "expects a reply" filter in front of `slack_triage`, and an `engine_route` pack that picks among a pack's allowed engines once evals give the criteria.

### Credentials and image

| Runtime | Credential | Reaches the container as | When missing |
|---|---|---|---|
| `claude` | `CLAUDE_CODE_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY` | env, as today | stage stays a stub, as today |
| `eve` | the ChatGPT login owned by the Codex CLI | `codex` in the image; a per-run copy of `~/.codex/auth.json` mounted writable | the pack's Claude default runs, or a stub for an eve-only pack |
| `jev` | `TYPESAFE_API_KEY` (env, then `~/.config/hardness/typesafe-api-key`) | env | classification is skipped; intake behaves as now |

One runner image carries all three SDKs and the Codex CLI, because a delegated child runs in its parent's container.

### Failure modes & invariants

- A run's answer is validated against its pack's schema whatever runtime produced it; ingest never learns the runtime.
- Delegation has depth 1, writes to `/out/children/<n>/`, and counts against the parent's turn and time budget.
- An engine outside a pack's `allowed` list is rejected by `engine-choice.ts` before a container starts.
- Without `TYPESAFE_API_KEY`, nothing about intake changes.

### Migration / rollout

Each phase is a PR (or short stack) under the size budget; phases 1–3 change no behaviour.

0. **Spike** (throwaway branch): in the runner image, an eve agent on `chatgpt()` via `codex app-server` answering with an `outputSchema`; a tool call blocked by a guard; commands in `/work` without nested docker; one `systemOne()` call. Exit: a yes/no for each, versions pinned.
1. **Move only:** `factory/agents/*.md` → `factory/roles/<role>/role.md`, `plugin/skills` → `skills/`, `src/*` → `src/core/` + `src/runtimes/claude/`. Exit: `LUNA_STAGE_DRY_RUN=1` output byte-identical for every pack.
2. **Contracts:** `engines.ts`, `access.ts`, `StageInput.engine`; every pack's default equals today's model. Exit: the golden `access` → Claude tools test.
3. **Core:** `checkCall()`, `luna-tools.ts`, per-runtime credentials. Exit: guard and luna tool tests pass against core.
4. **Evals** ([RFC 0003](./0003-upgradable-harness.md)) before any pack moves.
5. **eve runtime** on `slack_triage` (`codex:luna`), then `codex:sol` as a triage candidate. Exit: a live run of each, ingested by the unchanged machine.
6. **Jev runtime** and `issue_classify` in Jira and GitHub intake. Exit: recorded tickets classified with a measured agreement rate.
7. **Helpers with engines** and `delegate`; first user, a Codex second opinion on the verifier.

### Proposed rule for `CLAUDE.md`

Lands with phase 5, when the folders it names exist:

```md
## Every model call goes through a pack, an engine and a native runtime

- Claude models run only through the Claude Agent SDK (runtimes/claude). Never add
  @anthropic-ai/sdk, a fetch to api.anthropic.com, or eve/models/anthropic.
- Every other agent model runs through eve (runtimes/eve) on chatgpt(), the local
  Codex login. No OPENAI_API_KEY path.
- Jev runs only through @typesafe-ai/sdk (runtimes/jev). It is the only metered path:
  opt-in through TYPESAFE_API_KEY, and Luna works the same without it.
- An SDK is imported only inside its own runtime folder.
```

## Alternatives considered

### Everything on eve, Claude through `eve/models/anthropic`

One harness instead of three. Rejected: it needs `ANTHROPIC_API_KEY`, which leaves the Claude subscription, and it drops what the Claude Agent SDK gives the stages today (skills plugin, `PreToolUse`, structured output, session resume).

### Jev through eve's `decide()`

eve ships `decide()` defaulting to Jev. Rejected: it routes through AI Gateway, ties a tool-less classifier to an agent framework it does not need, and gives up control of retries, credentials and the wire format.

### A second factory package per runtime

`@hardness/factory-eve` beside today's package. Rejected: guards, ledger tools, rendering and output would be duplicated, and delegation across packages would need a second container.

## Open questions

- Engine switchable per task from the board, or only per repo in `luna.yaml` for now?
- Which pack does Codex take first after `slack_triage`: `triage`, or `reviewing` (read-only, easy to shadow)?
- `codex:*` or `openai:*` as the engine prefix?

## Risks & unknowns

- **TypeSafe access.** A third-party guide reports new signups paused in late September 2026, and the SDK names above are from secondary sources.
- **eve is a release candidate** (`1.0.0-rc.1`). Pin it and keep it behind `Runtime`.
- **No verified pre-tool hook in eve.** If the spike cannot block a call before it runs, eve's built-in `bash` and `write_file` are replaced with guarded tools; until then writable packs stay Claude-only.
- **Codex auth in a container.** Refresh rewrites the auth file; concurrent stages must not share one copy.
- **eve start-up per stage** needs measuring.
- **Provider terms** for a ChatGPT subscription driven from containers need reading before it carries real work.

## Success criteria

- A fresh clone with only a Claude token runs exactly as today.
- With a Codex login, `luna.yaml` moves `triage` to `codex:sol` and a task passes triage with no change to the machine.
- `issue_classify` labels a recorded ticket set, and tickets below threshold reach `jira_intake` unchanged.
- No file outside `factory/src/runtimes/<runtime>/` imports that runtime's SDK.
