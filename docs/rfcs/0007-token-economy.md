# RFC 0007 — Token economy: a loop guard, learned repo facts and tool pruning, ported from TokenEconomizer

- **Author:** Higor Alves
- **Status:** Accepted (2026-11-10)
- **Created:** 2026-11-10
- **Discussion:** the PR that carries this file and its implementation
- **Related:** [RFC 0002](./0002-native-agent-runtimes.md) (runtimes, decision packs), [RFC 0003](./0003-upgradable-harness.md) (catalog, evals), [RFC 0005](./0005-software-factory-v1-5.md) (budget, escalation, retro)
- **Source:** [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer) at `81e32e5` (Apache-2.0), [arXiv 2610.22732](https://arxiv.org/abs/2610.22732)

## Summary

TokenEconomizer cuts the cost of a coding agent in a repository it works in often. It learns from past sessions and removes three kinds of waste: facts that every session finds again, tools that no session uses, and turns that loop on one failure. Its paper measures 18 to 31% lower cost on SWE-Bench with no loss of pass rate. It ships as a Python plugin for interactive CLIs. Luna's packs run headless on the Agent SDK and on eve, with no settings files and no plugin hooks. So this RFC ports the three mechanisms and the cost ledger to TypeScript, inside the factory and the machine. Every model call of the port is a pack. One PR carries this RFC and the code.

## Goals

- A stage run that loops on one failure gets one redirect inside the run. A run that stays stuck ends itself with a result and its events, and escalates.
- The machine learns facts about a repository from its own runs, and each later run starts with them.
- A pack stops loading a tool that the repository's runs never use, after a person's tap.
- Cost is counted as it is billed: cache reads and writes have their own weights, and the mechanisms' own calls count as overhead.
- Each mechanism has a switch per repository and one machine-wide kill switch. A failure of any mechanism never fails a run.

## Non-goals

- Installing or vendoring the upstream plugin, or running Python in a stage.
- Upstream's host adapters (Codex capability packages, Copilot, Pi and the others) and its repomap. Graphify already serves the code map.
- Replacing the machine's stuck detector, the Build budget or the retro. The port sits beside them.
- A mask on eve runs. An eve app gets its tools at image build (see Limits).

## Background

| Upstream | Luna today | Gap |
|---|---|---|
| Micro-skills: facts from repeated failures, stated at session start | `docs/agents/project-context.md`, changed only by a retro PR | Nothing learns command spellings or environment facts from runs |
| Loop guard: per-call state, an envelope of usual turn length, a judge, one redirect | `StuckDetector` kills the container on repeated transcript lines; three identical failures escalate; the Build budget | No redirect. A killed run writes no `result.json` and no `events.jsonl`, so it teaches nothing |
| Tool pruning: a deny list in the agent's settings | Each pack names its `access`; `settingSources: []` | Access is per pack, never per repository |
| Cost with cache pricing, overhead included | `Tokens { input, output, cached }`; cache writes are inside `input` | No weight for cache traffic, no overhead line |

Two facts of the harness shape the design:

1. **No runtime reads a tool's output.** The Claude runtime drops `tool_result` content. eve sends it straight to the model. The guard and the fact observer both need it, so both runtimes get a new read point.
2. **`RunEvent` carries no command output, by design.** The port keeps that rule. The runtime classifies each result inside the container and emits only the class.

## Proposed design

### Layout

| Part | Where |
|---|---|
| Observation of one tool call (intent, form, error class, failure fingerprint, edited files, tests ran) | `factory/src/core/economy/observe.ts`, `shell-edits.ts` |
| Loop guard state, rules and the redirect template | `factory/src/core/economy/guard.ts`, `rules.ts` |
| Runtime wiring | Claude: a `PostToolUse` hook in `runtimes/claude/guards.ts`. eve: the tool wrappers in `runtimes/eve/agent/tools.ts` |
| Effective tokens | `factory/src/core/usage.ts`, `contracts/src/economy.ts` |
| Contract shapes (`EconomyInput`, `Observation`, facts, mask, config) | `contracts/src/economy.ts` |
| Fold after each run, lifecycle, envelope, evidence, ledger | `machine/src/domain/economy/*.ts` (pure) |
| The `Economy` port, with `noEconomy()` | `machine/src/application/economy.ts` |
| Its store, files under `<state>/economy/<repo slug>/` | `machine/src/adapters/economy/` |
| Routes | `machine/src/adapters/http/app.ts` |
| The Economy view | `board/src/economy.rs` |

Learning data stays in owner-only files under the state dir, as ground truth and graph misses do. `factory/NOTICE` names the upstream project and its licence.

### 1. Observation

After each tool call the runtime builds an `Observation` and attaches it to the `tool_result` event:

```ts
{ intent?: "test" | "interpreter" | "build" | "package" | "fetch" | "vcs",
  form?: string,          // how the command was spelled, flattened, 120 characters at most
  errorClass?: string,    // upstream's environmental error classes
  failure?: string,       // fingerprint of the first error line: hex, digits and paths removed, then a 10-character hash
  testsRan?: boolean,
  edits?: string[] }      // repo-relative paths, also from shell edits (sed -i, redirects)
```

The output text itself never leaves the container. The regex tables come from upstream's `observe.py`, `state.py` and `shell_edits.py`, with its generic vocabulary.

### 2. Loop guard

**State.** The guard folds each observation into upstream's `SpiralState`: calls, edits per file, files edited, error outputs, verification runs and repeated failures.

**Envelope.** The machine keeps, per repository and pack, the call counts of the last 500 runs that ended `pass`. The envelope is their 90th percentile times 1.25. It is null under 5 samples. It reaches the run in `StageInput.context.economy.guard`. With no envelope the guard only records.

**Decision, per call.** The numbers are upstream's defaults.

1. Free gate: at least 20 calls in the segment, and a repeated failure or 8 error outputs.
2. Backstop: `is_stuck` and more than 2.5 times the envelope. This needs no judge.
3. Otherwise the judge, for a pack with shell access. The guard asks at most every 5 calls. The gap grows by 5, up to 20, after each `productive` verdict.

`is_stuck` is: 20 calls, and (4 edits of one file or 3 files edited), and 6 error outputs, and 20% of calls repeating a failure.

**The judge is a decision pack, `loop_judge`.** Its questions are `stuck` (yes/no) and `cause` (a choice: `repeating_failure`, `wrong_approach`, `environment`, `productive`). It runs through the `/out/checks` mailbox, as `red_check` and `scope_check` do. The host's build watch answers it. The run does not wait: the verdict lands on a later call, as upstream's detached job does. Its input is the digest of the last 24 actions (tool, command cut to 90 characters, file base names, error class). It acts at a confidence of 0.7.

**The redirect.** The first stuck verdict injects one note. On Claude it is the hook's `additionalContext`. On eve it is appended to the tool's result. The text is upstream's template (`Process check (automated): …`) with the repeated failure class and the churned files. A writable pack may instead get a text written by the `loop_redirect` agent pack (`claude:haiku`, low effort, no tools, one turn), flattened and capped at 1,200 characters. A failed or late writer falls back to the template. The segment then starts fresh.

**Still stuck.** Upstream only tells the person, because a person watches the session. Luna's runs have no watcher. So on the second stuck verdict the runtime ends the run itself. The error starts with `LOOP_STUCK`. `finish()` writes `result.json` and `events.jsonl`. The machine escalates the stage with a typed fact for `escalation_reason` (the guard's cause, the failure class, calls spent). `StuckDetector` stays as the outer backstop.

**Events.** `economy.guard` rows (`gate`, `judge`, `redirect`, `stop`) go on the task log.

### 3. Learned facts

**Sources.** Two, as upstream:

- *Free facts*, from scripts only. The six families are form repair (a failing spelling then a working one), boundary (every fetch to a host refused), empty probe, arg repair, env value and absent tool.
- *Proposed facts*, from the `fact_propose` agent pack (`claude:haiku`, low effort, no tools, one turn). It runs after every third closed card of a repository, over the digests of the last 8 runs. It answers at most 4 facts, each with two cited runs and a detector.

**Detectors differ from upstream.** Upstream lets the model write Python regexes that run with no time limit. Here a detector is structured data: a scope, a confirm and a contradict clause, each built from named predicates and literal substrings. The machine checks it against the cited digests before it admits the fact.

**Lifecycle.** A candidate is active after 3 confirming runs. A proposed fact needs runs that edited different files. A fact is stated only while at least 4 runs exercised it, it fired in 40% of them and 2 distinct cards confirmed it. It retires when its score goes below zero, with a contradiction weighted five times and a decay of 0.8. `retired` is final.

**Injection.** `StageInput.context.economy.facts` holds the rendered lines. `core/render.ts` appends them to the stage prompt as a data block under upstream's header, `# environment facts learned from earlier sessions in this repository`. The block has at most 4 free facts and 150 tokens. Proposed facts get the second header and the same lint, which upstream leaves out: a line that reads as completion or verification advice is refused. Fact text is built from templates. The only foreign text in it is a command spelling, limited to a plain character set.

**Promotion.** A fact active over 5 distinct cards with no contradiction goes to the retro as a candidate, by id. `ReviewingMemoryAnswer` gains `factPromotions: [{ id, section }]`. The machine writes the fact's own text into `project-context.md` in the retro's draft PR. A promoted fact leaves the injected block, because the file now states it.

### 4. Tool pruning

**Evidence.** Per repository and pack, the machine counts runs in which each unit loaded and went unused. The units are `web`, `agent`, each skill and each optional luna tool. One use ever protects a unit for good. These are never proposed: reading, writing, the shell commands, the ledger tools, `step`, `decision_get`, `scope_check`, `scenario_red` and `delegate`.

**Rule.** A card stands for upstream's session and a run for its prompt. A unit is proposed when it went unused over 10 runs across at least 2 cards, or over 5 cards.

**Propose, then apply.** The proposal waits on the board. A person's tap stores the mask. It reaches the next run as `context.economy.mask`. The Claude runtime narrows the pack's access with it before it builds the tool lists. The run's fingerprint covers the mask. Restoring a unit marks it `kept`, and the machine never proposes it again.

### 5. Cost

`Tokens` gains `cacheWrite5m` and `cacheWrite1h`. (As built, `input` still holds the cache writes: see [What was built](#what-was-built).) Effective tokens are upstream's formula: input + 0.10 × cache reads + 1.25 × 5-minute writes + 2.0 × 1-hour writes + 5 × output. The weights are ratios, so no file outside the catalog names a model. The Build budget keeps its own count. Each run appends a record to `<state>/economy/<slug>/ledger.jsonl`. A `loop_judge`, `loop_redirect` or `fact_propose` run is an `overhead` record. `GET /metrics` reports effective tokens and overhead over the total.

### 6. Configuration

```yaml
economy:
  loop_guard: on          # on | off
  facts: on               # on | free (no model call) | off
  tool_prune: propose     # propose | off
  propose_every: 3        # closed cards between proposer runs
  guard: { judge_confidence: 0.7, redirects: 1, backstop_mult: 2.5, envelope_min_samples: 5 }
  prune: { runs: 10, min_cards: 2, cards: 5 }
```

Everything is on by default. `MACHINE_ECONOMY=off` turns the whole port off. A repository can only turn a mechanism off or tune it.

### 7. Routes and the board

| Route | What |
|---|---|
| `GET /economy?repo=` | facts by state, the mask and its proposal with evidence, the envelope per pack, guard events, cost |
| `POST /economy/facts/:id/drop` | retire a fact |
| `POST /economy/mask/approve`, `/restore` | apply the proposal; give a unit back |
| `POST /economy/import` | fold the runs already under `<state>/runs/` (tool evidence and envelopes only; old events carry no observation) |

The board gets an Economy view on the Backlog view's pattern, with keys to drop a fact and to approve or restore the mask.

## Trust

- Facts and redirects derive from what a container did. They enter a prompt only as declared data, with caps, from templates.
- A fact never names a path outside the repository, a host credential or a token shape. The frame check's list (`findings.ts`) filters fact text.
- The judge and the writer see commands and file base names, never output.
- The guard can end a run. It cannot change a verdict, an approval or the risk.
- A mask only removes access. It never adds any.

## Limits

- A mask does not apply on eve runs. Evidence still accrues for them.
- The guard stays inert in a repository until 5 runs of a pack ended `pass`.
- The envelope counts tool calls, not time or tokens.
- A fact learned on one engine is stated to every engine.
- The paper's numbers are for interactive agents with full tool sets. Luna's packs already load few tools, so pruning will save less here.

## Alternatives

- **Install the plugin.** It serves only a person's own CLI sessions, and its model calls bypass packs.
- **Vendor the Python package.** It keeps upstream's code verbatim. It adds a second language to every stage and still needs every model call rerouted.
- **Judge inside the container, through `runtime.run()`.** It answers sooner. It needs the judge's credential in every stage and hides the call from the decision log.

## Rollout

One PR, in this order of commits: contracts and cost, observation, the guard, facts, the proposer and promotion, pruning, routes and the board, docs. The PR is over the 300-line budget by the owner's choice. `loop_judge` gets eval cases. (As built, it has no entry in `decision-defaults.json` and no scorecard yet: see [What was built](#what-was-built).)

## Decided

- `loop_judge` runs only for packs with shell access. Other agent packs keep the free backstop.
- Promotion counts distinct cards (5), so the retries of one card cannot promote a fact.

## What was built

The port landed on `feat/token-economizer` as the commits that the Rollout lists. This section says what landed as designed, and where the build differs from the design above. The code and its tests are the source of truth. The team made no model call while it built the port, so every test runs on a fake.

### As designed

- The three mechanisms and the cost ledger are in the factory and the machine, as the Layout table says. The observer, the loop guard and the mask are in `factory/src/core/economy/`. The folds, the lifecycle and the pruning evidence are in `machine/src/domain/economy/`. The port is `machine/src/application/economy.ts`, with `noEconomy()`, and its store is `machine/src/adapters/economy/store.ts`.
- Each tool result becomes an `Observation` inside the container. The output text never leaves it.
- The loop guard has the envelope, the free gate, the backstop and the judge. The judge is `loop_judge`, a decision pack that runs through the `/out/checks` mailbox. The first stuck verdict gives one redirect. The next one ends the run with `LOOP_STUCK`, and the machine escalates the card.
- There are six free fact families. A proposer pack and checked detectors add more. The retro promotes lasting facts into `project-context.md`.
- A person's tap makes a tool mask. Claude narrows the pack by it. eve ignores it.
- `MACHINE_ECONOMY=off` and the `economy` section of `luna.yaml` are the switches. The routes are as the Routes table says, and they are in [api.md](../api.md).

### Where the build differs

- **`Tokens.input` still holds the cache writes.** The design said it would stop. The build keeps the shape, because Build's budget and every reader of `Tokens` count `input` as new work. `cacheWrite5m` and `cacheWrite1h` are optional parts of `input`. `effectiveTokens` takes them off `input` before it weights them. Claude gives the writes, split by lifetime when the SDK says. A write with no split counts as a 5-minute write. eve gives cache reads only, so its writes count as fresh input.
- **`Observation` has more fields than the design lists.** It gained `host`, `envVar`, `labels`, `labelErr`, `needs`, `sets` and `probe`. The six fact families need them (a refused host, a test label, a variable, a VCS probe). Each new field has a strict pattern, and `sets` never holds a variable named like a credential. The schema is strict, so a field that carries text is refused.
- **The stuck test counts failures, not calls.** The design said "20% of calls repeating a failure". The code, as upstream does, takes the share of failures that repeat an earlier one.
- **The judge has two bars.** The machine applies the pack's own bar for `stuck` (0.7, or the repository's `policy.decisions.loop_judge`). The guard in the container also applies `economy.guard.judge_confidence`. A verdict must pass both.
- **The build watch answers the judge.** The design said the host's build watch answers it. The watch now also runs for a pack that has no checks to answer, when the pack has shell commands. A pack with no shell commands has no judge and only the backstop.
- **The redirect writer is for writable packs only.** It has a 30-second budget. After that, the guard sends its own template.
- **A redirect on eve rides on the result of the call that triggered it.** The design said it is appended to the tool's result. A result with no text of its own (a file write) cannot carry the note. The tool then holds the note for the next result that has text. The tool waits at most 2 seconds for the runner's answer.
- **The eve wiring is a bridge.** The design named the tool wrappers in `agent/tools.ts`. The wrappers (`withEconomy`, `agent/economy.ts`) report each finished call to the runner over the loopback bridge (`POST /economy`). The session lives in the runner (`runtimes/eve/economy.ts`).
- **A stop escalates through a typed fact in Build only.** In Build on the feature route, the guard's cause is one fact for the `escalation_reason` decision, which still picks the reason. In any other stage, the error is the reason.
- **Free facts of three families retire on one contradiction.** The absent tool, empty probe and boundary families are costly when wrong. One contradiction retires an active fact of those families, and a candidate of them dies at once. A form repair counts a contradiction only after two runs in a row. The score rule of the design applies to the rest.
- **A proposed fact can be born active.** The machine folds the whole window of digests through a new fact. A fact whose detector confirms on three runs that edited different files is active at birth. A proposed fact retires on its score alone.
- **The detector has four atom kinds.** The design said named predicates and literal substrings. The build adds `errorClass` and `intent` atoms. There are ten predicates. The machine evaluates a detector over the observed calls that it keeps for each of the last 8 runs (`calls.json`, 300 calls a run).
- **The proposed facts have their own block.** They go under a manual header (`# repo operating manual (<folder name>) — ...`). Each block has at most 4 lines and about 150 tokens, with its header counted. The block for the free facts and the block for the proposed facts each have their own cap.
- **The proposer runs only with `facts: on` and 2 digests or more.** `facts: free` makes no model call at all.
- **The config has one more key and bounds.** `promote_cards` (5) is a key. The design fixed the number. The bounds are in `contracts/src/config-v22.ts` and in [configuration](../configuration.md#the-economy-section-the-token-economy): for example `redirects` is 0 to 3 and `backstop_mult` is 1 to 10. `tool_prune: off` also stops the evidence and the mask, not only the proposals.
- **Promotion is complete on close.** The retro names ids and sections. The machine writes the fact's own stored text into the draft PR. The fact becomes `promoted` when the file holds the text, at the close step. The machine offers at most 10 facts.
- **The status shape has `tools` per pack.** `GET /economy` answers `envelopes`, `guard` (the last 50 rows), `cost`, `facts` and `tools`. The `facts` list holds every state. For each pack, `tools` holds the mask and the proposal, with `unusedRuns` and `cards` for each unit. `cost` has an extra `overheadUnpriced`, the overhead runs that reported no tokens. The routes answer 400 for a repository that the machine does not know. With `MACHINE_ECONOMY=off` they are absent.
- **Import scope is narrower than "tool evidence and envelopes".** It gives envelopes from passing runs and tool evidence from Claude runs only. It teaches no fact and writes no cost record. A run is never folded twice.
- **The ledger prices overhead that the runtime did not count.** A `loop_judge`, `loop_redirect` or `fact_propose` run with no token count keeps its cost in dollars. It counts in `overheadUnpriced`, so `overhead` is a floor.
- **`GET /metrics` has an `economy` section.** It holds effective tokens for work and overhead and the overhead share. It also holds the redirects and stops, the active and promoted facts and the masked units. It is absent for `repo=` with no repository and for a repository the machine does not know.
- **`loop_judge` has no measured default.** The design promised an entry in `decision-defaults.json` and a scorecard. The pack has nine eval cases and is in the `UNMEASURED` list of `contracts/src/decision-defaults.test.ts`. So it runs on Jev by default, with Claude as the fallback. Nobody has run a baseline for it.
- **A fact's command is checked on the host, and two cards must confirm a fact.** The container is untrusted, so the character set was not enough: it spells `npx --yes evil-pkg@1 test`. The observer's word lists now live in `contracts/src/economy-vocabulary.ts`. `knownForm` accepts only a spelling the observer could write. The machine applies it when it forms a fact and again when it renders one. A fact is stated only after 2 distinct cards confirmed it (`FIRE_MIN_CARDS`), so one hostile card's retries cannot state a fact.

### Not verified live

The team made no model call on this branch. The conformance table plays the looping run on the fake of each runtime. The behaviour of the Agent SDK when a run is aborted after a `PostToolUse` hook is proven on the fake only. No saving is measured on Luna's runs. [Architecture](../architecture.md#limits-and-not-built) lists the limits as they stand.
