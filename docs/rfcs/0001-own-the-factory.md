# RFC 0001 — Own the factory: run stages through the Agent SDK with no orc dependency

- **Author:** Higor Alves
- **Status:** In Review (implemented on `feat/own-the-factory`)
- **Created:** 2026-10-27
- **Discussion:** (open a PR with this file)
- **Decision deadline:** 2026-11-03

## Summary

Every agent stage today runs `orc-stage run` inside a container with the orc plugin baked in at `/orc`. The machine can only steer what orc's `stages.json` and prompt templates expose, and in practice most of orc's power never reaches the sandbox: agent bodies are not loaded, model and effort are not applied, skills are names in a prompt, and the step tool has no server. This RFC detaches the harness from orc completely. The packs, prompts, agents, skills, guards and the SDK runner move into this repository as a `@hardness/factory` package that calls `@anthropic-ai/claude-agent-sdk` directly. What is worth keeping from orc (agent bodies, skills, prompt templates) is copied once and becomes this repo's own; nothing orc-named remains at runtime, in the image build, on the host, or in the contract. A fresh clone with no orc installed runs the whole pipeline.

## Goals

- Clone and run: a fresh clone with no orc installed, no Claude Code plugin and no `~/.claude` content runs `pnpm install && pnpm start` and passes the golden matrix.
- The stage image builds from this repository alone: no orc checkout, no `ORC_PATH`, no `vendor-orc`, no orc inputs in the golden CI workflow.
- One process per stage: the container runs a TypeScript entry that calls the SDK. No bash → jq → node chain.
- Each role runs as a real SDK agent definition with its own prompt body, model, effort, tools, turn limit and skills.
- Guardrails (no push, no PR create, no tracker writes, no AI attribution, write jail to `/work` and `/out`) run as in-process `PreToolUse` hooks owned and tested here.
- The step tool and the slice ledger are in-process MCP tools served by the runner, not a bash CLI writing to `.orc/`.
- The stage contract (`StageInput`, `StageOutput`, pack ids, output schemas) has one source of truth in `contracts/` and one conformance test, in one repo.
- Nothing orc-named at runtime: no `ORC_*` env, no `.orc/` path, no `orc.` event prefix, no `orc-*` binary lookup on the host.
- Parity first: the golden matrix (`pnpm golden`, `golden:live`) passes with the new runner before any behavior is changed on purpose.

## Non-goals

- Changing the pipeline's stages, states, gates or the board.
- Running agents on the host instead of in the hardened container. The sandbox stays; only what runs inside it changes.
- Keeping any sync with orc. The copied prompts, agent bodies and skills become this repo's; improvements flow by hand in either direction, never by a vendoring script.
- Renaming `@hardness/*`, `HARDNESS_*` or `~/.config/hardness` (separate change, as the README already says).
- New product behavior (per-repo model policy, session resume, streamed events) lands only after parity, as its own PRs. It is listed in Phase 5 because it is the reason to do this, not as part of the migration.

## Background / Context

### What the seam looks like today

```
machine (TS)  ──docker run──▶  runner.mjs (node)
                                   └─▶ orc-stage run (bash, /orc/bin)
                                        └─▶ lib/stage.sh (bash + jq: validate, render prompt)
                                             └─▶ lib/factory/run.mjs (node: Agent SDK query)
                                                  plugins: [/orc]   settingSources: []
```

- `machine/runner/build.sh` archives an orc checkout (or clones `main`) into `vendor/orc.tar`; the Dockerfile unpacks it at `/orc` and installs the SDK under `/orc/lib/factory`. `.github/workflows/golden.yml` builds the same image from an `orc_ref` input.
- `machine/src/domain/stage-input.ts` hand-mirrors `PACK_LIMITS` from orc's `stages.json` ("change both together").
- `contracts/fixtures/orc/` holds a vendored copy of orc's packs and schemas; `orc-contract.test.ts` checks the machine's zod shapes against it and, when an orc checkout is next to the repo, that the copy is current.
- `pack-runner.ts` mounts `<stateDir>/tasks/<id>/orc` at `/state` and sets `ORC_STATE_DIR` so orc's slice ledger survives an attempt; `memory.ts` and the retro prompt read `.orc/<branch>/files/`.
- `main.ts` looks for `orc-state` on the host PATH; `close-task.ts` calls `orc-state close --merged` when it exists.
- `e2e.ts` treats a `.orc/targets.json` in the worktree as a sign of a web repo; the e2e prompt cites `orc:qa-targets`.

### What orc actually contributes inside the sandbox

Read from orc at `9ef37bd3b1a8` (the checkout next to this repo) and the vendored `27748f1b6676`:

| orc piece | Reaches the stage? | Why |
|---|---|---|
| Agent bodies (`orc/agents/*.md`, 29 KB across the six roles) | No | `run.mjs` calls `query({ prompt })` with no `agent` or `agents` option. The prompt only says "You are the `orc-implementer` role". |
| Agent model and effort (`model: opus, effort: high` for the analyzer; `sonnet, medium` for the implementer) | No | `stages.json` has no `model`; `run.mjs` sets one only when the pack has it. Every stage runs on the SDK default. |
| Skills (`orc:tdd`, `orc:review-contract`, `orc:ci-routing`, …) | Mostly no | Listed as text in the prompt. The `Skill` tool is in the e2e pack's tool list only; other stages could at best `Read` the skill file by guessing its path. |
| `mcp__orc__step` | No | Served by the orc mod (`hooks/mod/register.ts`), which needs the Claude Code mod runtime. In the headless SDK it is an allowed tool name with no server. |
| PreToolUse git guards (`pre-git-guard.sh`) | Yes | Plugin hooks load through `plugins`. This is the real safety value today. |
| SessionStart banner (iron rules, `mode: factory`) | Yes | Plugin hook. With `systemPrompt` omitted the SDK uses a minimal prompt, so this banner is most of the operating instructions the model gets. |
| `orc-state` slice ledger | Yes | A bash CLI writing JSON under `.orc/`, mounted from the host so it survives an attempt. |
| `orc:gates` §8 (no AskUserQuestion, `needs_input`, `requested[]`) | Partly | Restated in every prompt template; the skill itself is not loaded. |
| orc's two factory evals | No | They run in orc's CI against orc's prompts, not against what this machine ships. |

### Drift that nothing catches

- The vendored copy is at `27748f1b6676`; the checkout is at `9ef37bd3b1a8`. The conformance test only compares when a checkout is present.
- The `verifying` pack names agent `orc-verifier`; no such file exists in `orc/agents/`.
- orc's `stage-input.json` schema says `"schema": { "const": 1 }`; the machine writes `schema: 3`. orc's bash validator does not check the value, so it passes by accident.
- orc's `stages.json` limits and the machine's `PACK_LIMITS` are two hand-kept copies.

### Every orc touchpoint, and what replaces it

| Where | Today | After |
|---|---|---|
| Image build (`build.sh`, Dockerfile, `golden.yml`) | Archives or clones orc into `vendor/orc.tar`; `ORC_SOURCE`, `ORC_PATH`, `ORC_REF`, `orc_ref` workflow input | `COPY factory/`; no orc inputs; the golden workflow builds from the checkout under test |
| Stage entry (`runner.mjs`) | Spawns `orc-stage run` | `node /factory/dist/main.js` |
| Prompts, agents, skills | orc's, loaded from `/orc` at run time | Copied once into `factory/`, owned and edited here; a NOTICE records the source commit; no sync script |
| Guards | orc's bash hooks through the plugin | In-process hooks in `factory/src/hooks` with table tests |
| Step tool, slice ledger | `mcp__orc__step` (no server), `orc-state` plus `.orc/` in the worktree, `/state` host mount | `mcp__luna__*` served in-process; ledger in `/out/ledger.json`; no `.orc/` written anywhere |
| Env | `ORC_FACTORY`, `ORC_STATE_DIR` | `LUNA_FACTORY` only |
| Contract | orc's JSON schemas vendored under `contracts/fixtures/orc/`, `pnpm vendor:orc` | zod in `contracts/src/packs.ts`, one conformance test |
| Machine host | `which orc-state` in `main.ts`; `orc-state close --merged` in `close-task.ts` | Removed |
| QA target detection (`e2e.ts`) | `.orc/targets.json` marks a web repo; the prompt cites `orc:qa-targets` | `qa_targets` in `PIPELINE.md` front matter; our own `qa-targets` skill in `factory/plugin` |
| Events | Stored as `orc.<kind>` | `stage.<kind>` |
| Memory stage | Reads `.orc/<branch>/files/` in the worktree | Reads the ingested ledger and events under the run folder |
| Project rules file | `docs/agents/project-context.md`, orc's convention | Kept: it is only a file path, now this repo's convention, documented in `configuration.md` |
| Docs and site | README ("runs orc as a software factory"), `docs/*`, the landing page's orc scene | Rewritten; the site scene becomes the factory scene |
| Contributor tooling | `.orc/pr-budget.json`; `.gitignore` and `.dockerignore` entries for `.orc/` | Removed in the docs phase; the PR budget moves to `contributing.md` prose; contributors may use any plugin, nothing in the repo assumes one |
| Intake | GitHub poll loop, the board, `POST /tasks` | Unchanged. `/orc:triage` can still post, as any HTTP client can, but nothing documents or depends on it |

### Constraints

- The sandbox hardening stays: read-only root, tmpfs `/tmp`, `no-new-privileges`, memory/cpu/pids caps, worktree read-only unless the pack is writable, git `hooks` and `config` read-only, credential by name only.
- The `StageOutput` the machine ingests (`contracts/src/stage.ts`) is the only thing `pipeline.ts`, `ingest.ts`, the board and `/metrics` depend on. Keeping it means the machine side of this change is small.
- PR size budget is 300 LOC. The work below is sliced to respect it.

### SDK surface this relies on

Verified against the TypeScript reference and the `0.3.309` type declarations (current release `0.3.311`):

- `agents: Record<string, AgentDefinition>` with `description`, `prompt`, `tools`, `disallowedTools`, `model`, `effort`, `maxTurns`, `skills`, `mcpServers`, `permissionMode`; and a top-level `agent: string` that runs the query as that definition.
- `systemPrompt: { type: 'preset', preset: 'claude_code', append }`. Omitting it means a minimal prompt.
- `hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>`, in-process callbacks returning `permissionDecision: 'deny'` to block. They run even with `settingSources: []`.
- `mcpServers` with `createSdkMcpServer({ name, tools: [tool(name, description, zodShape, handler)] })`; tool names become `mcp__<key>__<name>`; `alwaysLoad: true` keeps a tool's schema out of deferred tool search.
- `plugins: [{ type: 'local', path }]` for skills (and any file hooks) without `settingSources`. `skills: string[]` selects which discovered skills an agent may invoke.
- `outputFormat: { type: 'json_schema', schema }`, `structured_output` on the result; `error_max_turns` and `error_max_structured_output_retries` are distinct result subtypes.
- `effort`, `thinking`, `includePartialMessages`, `resume` / `forkSession`.

## Proposed design

### High-level shape

```
factory/                            new workspace package @hardness/factory (TypeScript, Node 24)
  package.json                      @anthropic-ai/claude-agent-sdk pinned; zod from contracts
  NOTICE                            the orc commit the prompts, agent bodies and skills were copied from (MIT)
  src/
    main.ts                         entry inside the container: /in/stage.json → run → /out
    packs.ts                        the pack registry: id → { agent, writable, maxTurns, timeoutMs, output schema, template }
    render.ts                       {{placeholders}} → prompt (port of stage.sh render, typed, tested)
    agents/<role>.ts                one AgentDefinition per role: prompt body, model, effort, tools, skills
    hooks/guards.ts                 PreToolUse: git guard, no-attribution, write jail, outward-action refusal
    tools/step.ts                   createSdkMcpServer "luna": step, slice (init/set/list), decision (get)
    output.ts                       result.json envelope, events.jsonl, artifact scan (port of run.mjs finish())
    dry-run.ts                      LUNA_STAGE_DRY_RUN=1 for the sandbox smoke
  plugin/                           a local Claude Code plugin, loaded via `plugins`, holding only skills/
    .claude-plugin/plugin.json
    skills/{tdd,review-contract,verification-before-completion,code-discovery,
            browser-qa,playwright-qa,ci-routing,caveman-review,qa-targets}/
  prompts/<pack>.md                 the eight templates (copied from orc, then edited here)

contracts/src/packs.ts              pack metadata + zod output schemas; JSON schema for the SDK derived from zod
contracts/src/factory-contract.test.ts   replaces orc-contract.test.ts: every pack's zod output schema, filled minimally, ingests

machine/runner/Dockerfile           COPY factory/ instead of ADD vendor/orc.tar; npm install the SDK in /factory
machine/runner/build.sh             drops ORC_SOURCE/ORC_PATH/ORC_REF; the image key covers factory/**
machine/runner/runner.mjs           deleted; ENTRYPOINT node /factory/dist/main.js
.github/workflows/golden.yml        no orc_ref input; builds the image from the checkout
machine/src/domain/stage-input.ts   PACK_LIMITS imported from contracts, not mirrored
machine/src/application/stages/pack-runner.ts   stateMount/ORC_STATE_DIR removed; ledger comes back in /out
machine/src/application/stages/memory.ts        reads the ledger from the run's ingested files, not .orc/
machine/src/application/stages/e2e.ts           web detection reads PIPELINE.md qa_targets, not .orc/targets.json
machine/src/application/close-task.ts, main.ts  orc-state step removed
scripts/vendor-orc.mjs, contracts/fixtures/orc/ deleted
```

Removed from the image: `/orc` (plugin, 14 agents, ~90 skills, bash libs, mod), `jq` as a hard requirement. Added: `/factory` (one package, its `dist/`, `node_modules` with the SDK).

### The runner, in one call

```ts
const pack = PACKS[input.pack];
const result = query({
  prompt: render(pack.template, input),
  options: {
    cwd: "/work",
    agent: pack.agent,                       // run *as* the role
    agents: AGENTS,                          // the role definitions, in code
    systemPrompt: { type: "preset", preset: "claude_code", append: FACTORY_RULES },
    plugins: [{ type: "local", path: "/factory/plugin" }],   // skills only
    settingSources: [],                      // nothing from /work or HOME leaks in
    tools: pack.tools, allowedTools: pack.tools,
    permissionMode: "dontAsk",
    maxTurns: input.limits.maxTurns,
    outputFormat: { type: "json_schema", schema: pack.outputJsonSchema },
    mcpServers: { luna: lunaTools({ ledgerPath: "/out/ledger.json", decisions: input.decisions }) },
    hooks: { PreToolUse: guards(pack) },
    model: pack.model, effort: pack.effort,
    env: { ...process.env, LUNA_FACTORY: "1" },
  },
});
```

`FACTORY_RULES` is the §8 text that today lives in the orc SessionStart banner and in every prompt: no AskUserQuestion, questions end the stage as `needs_input`, outward actions go to `requested[]`, never write outside `/work` and `/out`.

### Key interfaces / data shapes

- **StageInput / StageOutput**: unchanged in shape. The output `schema` bumps to 3 and gains `ledger: { slices: [...] }` so the machine no longer needs a host mount to read the slice ledger. `env.LUNA_FACTORY` replaces `env.ORC_FACTORY` in the same PR that switches the image; the old image is never run against the new machine.
- **Pack registry** (`contracts/src/packs.ts`): `{ id, agent, writable, maxTurns, timeoutMs, model, effort, tools, skills, output: ZodType }`. `PACK_LIMITS` in the machine becomes a projection of it. `z.toJSONSchema(output)` feeds `outputFormat`.
- **Agent definitions**: one per role, `description` + `prompt` (the trimmed body of today's orc agent, factory-only: no `/orc:flow` phase talk, no `progress.md`, no parallel mode), `model`, `effort`, `maxTurns`, `tools`, `skills`. Roles: `triage-planner`, `test-designer`, `implementer`, `verifier`, `qa-validator`, `ci-investigator`, `retro-reviewer`.
- **Tools** (`mcp__luna__*`): `step {label, n, of}` (appended to `events.jsonl` and echoed on stdout for the watch pane); `slice_init {slices[]}`, `slice_set {id, status, commit?, actualLoc?}`, `slice_list` (the ledger, JSON in `/out/ledger.json`); `decision_get {key}` (reads `input.decisions`). This replaces `Bash(orc-state:*)` in the implementer's tool list.
- **Guards** (`PreToolUse`, matcher `Bash`): deny `git push`, `gh pr create|ready|review|merge`, `gh issue`, `git commit` on a non-`task/` branch, `git reset --hard|clean|branch -D`, any commit message with AI attribution; matcher `Write|Edit`: deny paths outside `/work` and `/out`, and for read-only packs deny `/work`. Each guard is a pure function with a table test.
- **Events**: `events.jsonl` keeps its `{kind, payload}` lines; the machine stores them as `stage.<kind>` instead of `orc.<kind>`, in the same PR that bumps the output schema.
- **QA targets**: `PIPELINE.md` front matter gains `qa_targets` (name, base URL, credential reference), read by the machine's policy store and passed to the e2e pack in `StageInput.context`. The e2e stage's web detection drops the `.orc/targets.json` check.

### Failure modes & invariants

- `result.json` is always written, even when the SDK throws: the `finish()` path runs in a `finally` with `ok: false` and the error, as today.
- `error_max_turns` and `error_max_structured_output_retries` become `outcome: fail` with a named reason instead of the generic "no structured output".
- Rate limits: the `rate_limit_event` handling and the `/usage limit|rate limit/` fallback carry over unchanged; `pack-runner.ts`'s pause logic is untouched.
- Invariant: a writable pack can only commit to `task/*` (host check in `pack-runner.ts` stays; the in-process guard adds the same check inside).
- Invariant: locked tests. Host-side replay in `pack-runner.ts` is untouched.
- A guard bug fails closed: the hook returns `deny` on any exception, and the host-side tool allow-list (`tools`) still excludes everything not listed.
- Without `/factory/plugin` (image built wrong) the runner refuses to start with a clear error rather than running skill-less.

### Durable agents

The goal: you sit near the agent loop, not inside it. A stage that dies mid-run picks up where it stopped, a human can steer a running stage from the board without being the loop, and everything an agent did is committed before anyone sees it. The reference for the concept is `@earendil-works/pi-durable` (commit-before-show, tasks as checkpointed state machines, resume from the last checkpoint, steer while busy, watch from another process, crash-loop parking). We do not adopt the library; we implement the concept on the Agent SDK and the machine we have.

| Concept (pi-durable) | What we have today | What we build |
|---|---|---|
| Commit before show: every entry stored before a UI sees it | The transcript is `docker logs`; the only durable record is `result.json` at the end | `CLAUDE_CONFIG_DIR` points at a per-task host mount, so the SDK's own session JSONL (every user, assistant and tool-result entry, plus subagent transcripts) is on the host as it is written. The session id lands on the `stage_runs` row. Later, the SDK's `sessionStore` mirror (alpha) can dual-write entries to Postgres. |
| Task as a checkpointed state machine; a phase reruns from its top after a restart | The machine is already this at stage level: Postgres rows, attempts, durable queue, re-attach to a running container after a restart | Inside a stage the checkpoints are the session transcript, the slice ledger (`/out/ledger.json`) and the slice commits. A `PreCompact` hook writes a resume digest into the ledger. |
| Resume after a crash | A dead container fails the attempt; the next attempt is a cold start that carries only findings | A container that dies, times out mid-run, or is lost in a machine restart is resumed in a fresh container with `resume: <sessionId>` and `resumeSessionAt` the last tool-result boundary. Tool calls are not replay-safe (bash has side effects), so the resume preface says what happened and asks the model to verify state with `git status` before continuing, the equivalent of pi-durable's `interrupted` tool result. |
| Idempotent submission (`requestId`) | `runId` names the run folder and the container | Unchanged. A resumed run keeps its `runId` and gets `resumed: true` on the row. |
| Crash-loop parking (`restartLimit`) | Attempt cap, then `escalated` | Same, with a `resume` count separate from `attempt`; past the limit the run is parked as `escalated` with a "retry" action on the board. |
| Steer while busy; abort | None: a running stage cannot be spoken to; abort kills the container | The runner opens the query with `streamInput` and reads a control file on the run mount (`/in/control.jsonl`, appended by the machine): `steer` becomes a user message after the current tool round, `interrupt` calls `query.interrupt()`, `model` calls `setModel`. The board gets "send a note to this stage" and "stop after this slice". Answers to a `needs_input` question can be delivered this way to a still-running stage instead of ending it. |
| Watch from another process, read-only | `docker logs -f` into a herdr tab | The board tails typed entries: the session JSONL plus `events.jsonl` (step, slice, usage). `includePartialMessages` gives tool-use events as they happen; `StuckDetector` reads those instead of regex over text. |
| Hooks (before tool, after tool, on yield) | orc's bash hooks | In-process hooks: guards, journaling, and an `onYield`-style `Stop` hook that can refuse an early stop ("you have slices left"). |
| Owned subagents, aborted with their owner | None in factory mode | SDK subagents under the same session dir; the container is the ownership boundary, so abort stays one `docker kill`. |
| Reset and handoff | None | Compaction with the ledger digest; a new stage forks the previous stage's session (`forkSession`) so triage's reasoning is available to the implementer without re-reading the repo. |
| Usage document | `usage` in `result.json` | Per-turn usage from the result and partial messages, appended to `events.jsonl`, summed on the row. |

What we give up by not journaling the model loop ourselves: exactly-once replay of tool calls. Our recovery is "resume at the last persisted message, with the worktree and git log as the ground truth of what already happened". For a coding agent whose effects are files and commits on a host-mounted worktree, that ground truth is better than a journal.

This section is the content of Phase 5. Its first two rows (host-mounted session dir, resume on death) are small and go first; the control channel is the piece that changes how the board feels.

### Migration / rollout

Phases are ordered so every PR leaves `main` runnable and the golden matrix green. Each phase is one or two PRs inside the 300 LOC budget (tests count; copied prompts and skills are excluded from the count).

**Phase 0 — Spike (go / no-go, half a day).** `factory/src/main.ts` with only the `triage` pack: `agent` + `agents`, one in-process `PreToolUse` deny on `git push`, one skill from a local plugin, `outputFormat`. Run it on `fixtures/golden-task` through the existing sandbox with the SDK's dry-run and one real call. Record: the hook fired, the skill was listed, `structured_output` arrived, `usage.model` matches the agent's `model`. If any of these fails on `0.3.311`, stop and revisit.

**Phase 1 — Own the contract.** Move the pack output schemas to `contracts/src/packs.ts` as zod; derive JSON schema; `PACK_LIMITS` reads from it; `factory-contract.test.ts` replaces `orc-contract.test.ts`; delete `contracts/fixtures/orc/` and `scripts/vendor-orc.mjs`. No runtime change yet (the image still runs orc). This PR fixes the `schema: 3` vs `const 1` mismatch on our side.

**Phase 2 — The runner, 1:1.** `factory/` package with `main.ts`, `render.ts`, `output.ts`, `dry-run.ts`, the eight prompts copied from orc (MIT, source commit in `NOTICE`), packs still naming today's tool lists. `agents` defined with the orc bodies trimmed to factory use; `plugin/skills` copied for the nine skills the packs name. Dockerfile, `build.sh` and `golden.yml` switch to `/factory` and lose every `ORC_*` input; `runner.mjs` deleted; `smoke-sandbox.mjs` uses the new dry run; `ORC_FACTORY` becomes `LUNA_FACTORY`. Parity bar: `pnpm golden` and `golden:live` green; `usage.model` per stage now equals the role's model.

**Phase 3 — Guards, tools and host clean-up.** `hooks/guards.ts` with table tests; `tools/step.ts` with the ledger; implementer prompt and tool list switch from `orc-state` and `mcp__orc__step` to `mcp__luna__*`; output `schema: 3` with `ledger`; events stored as `stage.<kind>`; the machine drops `stateMount`, `ORC_STATE_DIR`, the `orc-state` host lookup and the close-task step; `memory.ts` reads the ingested ledger; `e2e.ts` reads `qa_targets` from `PIPELINE.md` instead of `.orc/targets.json`. `docker.test.ts` and `pack-runner.test.ts` updated.

**Phase 4 — Evals.** Port orc's two factory evals (`factory-gate-needs-input`, `factory-refuses-outward`) as runner tests that use the dry run plus a recorded SDK transcript, and add one per guard. CI job `factory` runs them with the contracts job. Add a "fresh clone" CI job: no orc, no plugin, build the image and run the sandbox smoke.

**Phase 5 — Leverage (post-parity, one PR each).**
- Per-repo model and effort in `PIPELINE.md` (`model.implementing: sonnet`, `effort.triage: high`), read by the machine, passed in `StageInput.limits`.
- Retry on findings resumes the previous session (`resume` + `forkSession`) instead of a cold start, when the input commit is unchanged.
- `includePartialMessages` → typed `tool_use` events on stdout, so `StuckDetector` reads events instead of regex over text, and the board's watch pane shows steps.
- Implementing as a two-agent query: the implementer may call the `Agent` tool for a `test-author` subagent on a slice, with both definitions in `agents`.
- A `verifier` definition of our own (today's pack names an agent orc does not ship).

**Phase 6 — Docs and the last traces.** README, `docs/architecture.md` (Factory mode section, repository layout), `docs/install.md` (no orc prerequisite), `docs/configuration.md` (no `ORC_*`; `qa_targets` and `docs/agents/project-context.md` documented as this repo's conventions), `contributing.md` (the PR budget as prose), the site's orc scene becomes the factory scene, `.orc/pr-budget.json` and the `.orc/` ignore entries removed.

Rollback: Phases 1 and 2 are independent of each other at runtime; until Phase 2 merges the image still runs orc. After Phase 2, the old image stays reproducible from git history if a stage regresses and needs a side-by-side run.

## Alternatives considered

### Keep the orc seam (status quo)
Shape: bump orc, re-vendor, keep two repos in step. Rejected: the table above shows that most of what the seam was meant to carry (agent bodies, model, skills, step tool) does not arrive; what does arrive (bash hooks, a banner) is small and easy to own. The cost is a second repo in every change, drift the tests only catch on one machine, and an install story that needs orc.

### Fix it inside orc (teach `run.mjs` the `agent` option, add `model` to packs)
Shape: a few PRs upstream; orc's factory runner becomes complete. Rejected for this harness: it still leaves the runner in bash plus jq plus node, pins this product's roadmap (resume, streamed events, two-agent stages, per-repo policy) to a generic plugin's release cadence, and keeps the image build and the install dependent on an orc checkout. Not rejected for orc itself: the spike's findings are worth filing there.

### Fork orc into a luna-only plugin, keep `orc-stage`
Shape: copy `orc/` into this repo, prune. Rejected: inherits the three-language chain and ~90 skills to maintain for eight packs. The useful subset is nine skills, six agent bodies and one guard script, which is what Phase 2 copies.

### Call `claude -p` instead of the SDK
Shape: shell out to the CLI with `--agent`, `--output-format json`. Rejected: no in-process hooks or MCP tools, and partial messages would be parsed from text again. The SDK is the CLI with those seams exposed.

### Run the SDK on the host, drop the container
Rejected: the sandbox (read-only root, caps, write jail, credential isolation, locked tests) is the product's safety story. Out of scope here.

## Open questions

- Q1: Keep the plugin folder for skills, or inline each skill's text into the agent prompt that needs it? Preferred: plugin folder, so skills stay addressable with the `Skill` tool and can be shared across roles. Uncertain whether the SDK's deferred tool search hides `Skill` in some packs; the spike checks.
- Q2: QA targets in `PIPELINE.md` front matter, or a `.luna/targets.json` next to it? Preferred: `PIPELINE.md`, already the one per-repo file the machine reads at every stage.
- Q3: Should the machine pass `thinking: { type: 'adaptive' }` by default, or leave the SDK default? Preferred: leave default until the golden matrix is the bar, then measure.
- Q4: `maxTurns` exhaustion today reads as a generic failure. Should `error_max_turns` on `implementing` map to `escalated` (the agent ran out, a human picks) rather than `fail` (retry blind)? Preferred: `escalated`, decided in Phase 3.
- Q5: Drop `.orc/pr-budget.json` and the `.orc/` ignore entries, or keep them as contributor convenience? Preferred: drop; the PR budget becomes a sentence in `contributing.md`, and the repo stops assuming any plugin.

## Risks & unknowns

- **Behavior change from the system prompt.** Today the model runs with the SDK's minimal prompt plus orc's banner; the preset is a different prompt. The golden matrix is the bar; if pass rates drop, compare `append` text before touching anything else.
- **In-process guards are only as good as their tests.** The host-side tool allow-list and the branch prefix check remain the floor; the guards are the second layer, not the first.
- **SDK pin.** `agent` as a top-level option is confirmed from the type declarations, not the docs page. The spike proves it on `0.3.311`.
- **Licensing.** orc is MIT; the copied prompts, agent bodies and skills keep a NOTICE with the source commit.
- **Scope creep from Phase 5.** It is the payoff, so it will pull. Parity merges first.

## Success criteria

Three months after Phase 3 merges:

- `grep -ri orc` over the repository finds only `factory/NOTICE` and this RFC.
- A fresh clone on a machine with no orc and no Claude Code plugin builds the image, starts the machine and passes the golden matrix; a CI job proves it on every PR.
- `pnpm images` builds with no checkout or clone outside this repository, and the image key changes only when `factory/**` or the Dockerfiles change.
- Every stage run row reports `usage.model` equal to the pack's configured model.
- The golden matrix pass rate is at or above the rate recorded on the last orc-backed image, measured on the same four fixtures.
- At least one Phase 5 item (per-repo model policy or resume on retry) has shipped on top of the new runner.

## Spike findings (2026-10-27)

Phase 0 ran on the host against `fixtures/golden-task` with the real SDK (`0.3.311`), then three Haiku probes isolated one surprise:

- The top-level `agent` option runs the query as the role: the init message reports the role's model (`claude-opus-5-5` for the triage planner), the plugin folder loads (`luna-factory`), and the in-process `PreToolUse` hooks and `luna` MCP server are live.
- An `AgentDefinition` with its own `tools` list replaces the toolset and silently drops the SDK's internal `StructuredOutput` tool, so the answer arrives as text and `structured_output` is empty. Leaving `tools` off the definition (it inherits the query's list, which is the pack's) keeps structured output. The runner also parses a text answer the pack's schema accepts, so a stage is never lost to the channel.
- One triage of the golden fixture: ten turns, about 28 seconds, 17 cents on Opus, a `brief` with seven criteria and three assumptions.
- Session transcripts land under `CLAUDE_CONFIG_DIR`; with the per-task mount they survive the container.

## Appendix

- orc ADR 0009 (factory mode and the stage contract): `docs/adr/0009-factory-mode-and-stage-contract.md` in the orc repository. This RFC takes its "Option B — prompts inlined into Hardness" alternative, with the difference that the discipline is copied once, versioned here, and run through SDK features that did not exist when the ADR was written.
- Measured sizes: six agent bodies 28.7 KB; eight prompt templates 14.2 KB; nine skills about 120 KB on disk; `run.mjs` 224 lines; `stage.sh` about 200 lines; the machine's orc-aware files 338 (pack-runner) + 114 (stage-input) + 120 (ingest) + 150 (memory) lines.
- SDK reference pages: `code.claude.com/docs/en/agent-sdk/typescript.md`, `subagents.md`, `hooks.md`, `custom-tools.md`, `skills.md`, `permissions.md`, `modifying-system-prompts.md`.
