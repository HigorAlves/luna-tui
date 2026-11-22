# Replay evals

This tool runs a pack's eval cases on an engine and grades the answers. So the question "did triage get worse on this engine?" has an answer from data ([RFC 0003](../docs/rfcs/0003-upgradable-harness.md) §3). Each case runs in the stage image exactly as the machine runs a pack (`runPackOnce` in `machine/src/application/stages/run-once.ts`). It uses the docker sandbox and only that engine's credential. Then three steps grade it:

1. **Schema**: the run left a `StageOutput` that answered. The answer matches the pack's schema.
2. **Checks**: the case's deterministic checks in `expect.json`.
3. **Judge**: the `eval_judge` pack on `claude:opus` (always that engine) reads the case, its rubric and the answer. It gives a score from 0 to 1, a pass and its reasons.

A case passes when all three pass. Evals need a model credential, so they run locally and never in CI. CI runs only the grading's unit tests.

## Run

Build the stage image from your checkout first. It carries the `eval_judge` pack:

```sh
pnpm --filter @hardness/machine runner:build
pnpm eval --pack slack_triage --engine claude:haiku
pnpm eval --pack triage --engine codex:sol --against claude:opus
pnpm eval --pack triage --engine claude:opus --case task-price-decimals --no-judge
```

| Flag | |
|---|---|
| `--pack <id>` | the pack whose cases run |
| `--engine <id>` | the engine under test; one outside the pack's `allowed` runs as a candidate |
| `--against <id>` | runs the cases on a second engine too and prints the diff |
| `--case <id>` | only this case; repeat it for several |
| `--effort <low\|medium\|high>` | runs an agent pack at that effort. Without it, the pack's own effort applies. A bad `--effort` is refused before any case runs: a decision pack takes none, and an engine may not support it. An image that ignores it fails each case and refuses `--save-baseline`: rebuild it (`pnpm images`) |
| `--no-judge` | schema and checks only |
| `--judge` | adds the judge to a decision pack, which runs without one by default |
| `--trials <n>` | runs every case n times (1 to 20), each in its own container |
| `--dataset <name>` | takes the cases from the Laminar dataset of that name instead of the folder |
| `--save-baseline` | writes each scorecard to `baselines/<engine>/<pack>.json` (`claude:opus` is `claude-opus`). With `--effort`, the folder is `<engine>@<effort>` |
| `--image <tag>` | the stage image (`RUNNER_IMAGE`, else `hardness-runner:dev`) |
| `RUNNER_QA_IMAGE` | not a flag: the QA image a browser pack (`a11y_audit`, `e2e`) runs in, else `hardness-runner-qa:dev`. Build it with `pnpm --filter @hardness/machine runner-qa:build`; the runner refuses to start without it |

On a laptop, keep it awake for the run (`caffeinate -s pnpm eval …` on macOS). A sleep freezes the container, and the grader counts the run as timed out.

The credentials are the machine's. They are the Claude subscription token, the Codex login, an OpenAI key and the Jev credential. The Jev credential is a Vercel AI Gateway or TypeSafe key. The tool finds them the same way (see [configuration](../docs/configuration.md)). The judge needs the Claude one.

The scorecard gives the pass rate, the mean judge score, the mean turns and duration, and the summed cost per pack and engine. The cost is `n/a` when the runtime reports none. Without `--save-baseline` the tool compares the scorecard with the engine's saved baseline, over the cases both ran. Every run folder (the input, the output, the transcript) stays under `evals/.runs/`, which git ignores. Delete it whenever.


## Decision packs

A decision pack (`risk_score`, `worth_learning`, ...) answers typed questions with a confidence. So its grade is not a judge's opinion. The grade asks two things: **was the label right** and **was the confidence honest**. For a decision pack the runner uses no judge (`--judge` opts in). It grades each answer with `schema`, the case's checks, and:

- `correct`: every labelled question's choice, value or score equals the case's label. It is null when the case has no label: a borderline case, or one awaiting review. A label value that is an array is the set of labels it may be. A score matches within half a level.
- `confidence`: the answer's confidence, the mean over its questions (a yes/no's is its distance from a coin toss).
- `verdict`: the pack's own bars applied to the answer (`proceed`, `flag`, `ask`).

The scorecard adds the calibration over the labelled cases:

- `accuracy`
- `actedOnAccuracy` (among `proceed`: the answers the machine would act on)
- `coverage` (the share that was `proceed`)
- `brier` (mean of (confidence - correct)^2)
- `ece` (expected calibration error, five equal-width bins)
- `meanConfidence`
- `overconfident` (wrong at or above the proceed bar)
- `n` and `labelled`

These values are in the baseline file, in the printed scorecard and in the diff against a baseline. In Laminar each case's scores gain `correct`, `confidence` and `proceed` (1/0). The evaluation's metadata carries `trials`.

`--trials N` runs every case N times, each in its own container with the same `taskId`. So a model's variance shows. `--dataset <name>` takes the cases from the Laminar dataset of that name instead of the folder. It uses the datapoints with a target, parses each with the pack's context schema and uses the `taskId` as the case id. This grades what a person labelled before anyone commits it.

### The loop: record, harvest, push, label, pull, commit

1. The machine keeps one **decision record** per decision pack call under its state dir (`<MACHINE_STATE_DIR>/decisions/<pack>/<day>/<id>.json`). Only the owner can read it. `MACHINE_DECISIONS=off` stops it. `MACHINE_DECISIONS_RETENTION_DAYS` bounds it. The record holds the context, the answer, the verdicts and the trace id. Sometimes a later fact settles a decision: a re-run passed, or someone approved a plan untouched or a retro. Then the machine writes that **truth** onto the record.
2. `pnpm eval harvest --pack <decision> [--since <date>] [--with-truth] [--all]` takes only the pipeline's own records. Those are the records that name a stage. `--all` adds an HTTP client's records. It scrubs each record: logins become `user-N.example`, and it removes emails, internal hosts and home paths. A token-shaped string **refuses** the record. The command names that record and leaves it out. It writes `evals/<pack>/cases/rec-<id>/`. A record with a truth becomes a case with `equals` checks. A record without a truth gets `"review": true` and no checks. It never overwrites a case.
   `pnpm eval harvest --pack design_parity [--since <date>] [--include-images]` is the other kind: it reads the machine's `ground-truth/design_parity/<task>-<finding>.json` waivers (not records), and each becomes `evals/design_parity/cases/waiver-<sha8>/`, with the waived frame's capture under `mounts/` and the sub-run's frame render as the replayed `mcp/figma/get_screenshot` answer (nothing is connected). The case holds the waived frame alone. A `not_a_difference` waiver expects no finding on its node; an `accepted` one expects no blocker, with the reason in the rubric. Scrubbed as above; a token-shaped string, or a render or capture that is not a plain file in the run's own folders, refuses the waiver and names it. It never overwrites a case. A case copies a screenshot of the user's app and a render of their Figma frame, byte for byte, into a folder meant to be committed, so without `--include-images` every waiver is refused with that reason and nothing is written. With it, the command prints each image path it wrote (the capture PNG and the replayed `get_screenshot` file that holds the render) and says each must be looked at before committing; harvest cannot scrub pixels. The card's real Figma file key is not kept: `stage.json` and the replay's recorded arguments carry the stand-in `EvalFigmaFileKey` (a second file of the same card, `EvalFigmaFileKey1`, and so on), so the replay still matches.
3. `pnpm eval dataset push --pack <decision> [--queue <name> [--records]]` mirrors the pack's cases to the Laminar dataset with the pack's name (`taskId` = the case id). `--queue` takes the queue's id (the UUID in its page address in Laminar). You make a queue in the UI. Where the instance can list queues, the queue's name also works. A self-hosted Laminar cannot list queues, and it says to pass the id. With `--queue`, the cases marked for review go to that labeling queue. With `--records`, the unlabelled records go there too. Each goes there with the model's own answer as the prefilled target. Nothing goes to Laminar without this command.
4. A person corrects the targets in Laminar's labeling queue and pushes them to the dataset.
5. `pnpm eval dataset pull --pack <decision>` turns the dataset's labelled datapoints into cases. It reports and skips a datapoint whose data is off the pack's context schema. Review the diff. Commit the cases.

### The measure per answer, and when a default moves

`triage_signals`, `ticket_assess` and `conversation_assess` ask 12, 20 and 10 independent questions. The machine acts on each by its own bar. So the scorecard measures them **per answer** (`measure: "answer"` in `contracts/src/packs.ts`). Every labelled question of every case is one answer. The summary carries a pool (`summary.answers`) and a table per question. The scorecard reads the pool. The scorecard reads every other pack whole. A case is right when every labelled question is right.

The scorecard prints the defaults rule at the head of `scorecard.md`. An engine qualifies with coverage 0.6 and four graded cases. Per answer, it needs 20 labelled answers. The default is the qualifying engine with the highest acted-on accuracy. Engines within 2 points (`TIE_POINTS`) tie. A tie goes to Jev, else the cheaper engine. **An engine that acted on every case and was right on every one wins outright.** Among several such engines, Jev wins, else the cheaper. A pack with fewer than two engines measured keeps its default. **A default moves only when the winner has eight graded cases and six labelled** (`kept: <engine> won on n 6, 8 are needed to move a default`). The acted-on cell carries a 90% interval (`100% (69-100)`). Six of six is not as sure as sixty of sixty. The owner **pinned** five decisions on Jev (`PINNED` in `scorecard.ts`). No case count or rule un-pins one. The calibrate tool and the reports show the pin beside the numbers.

### Admitting an engine to a pack that reads images

A pack with `vision: true` (`design_spec`, `design_parity`) allows only engines whose model reads images (`caps.vision`), and a non-Claude engine joins it only after its eval matches Claude's. Save both baselines (`--save-baseline`), then run `pnpm eval admit --pack <p> --engine <e> --against <claude:*> [--write]`. It passes when the engine's pass rate is at least Claude's minus 2 points (`TIE_POINTS`) on at least eight cases and, where both baselines carry them, recall and the false-blocker rate hold to the same margin. It exits 0 on a pass, 1 on a fail and 2 on a missing baseline. `--write` records the verdict in `evals/baselines/<engine>/<pack>.admission.json`; `src/admission.test.ts` fails when such a pack allows a non-Claude engine with no passing record. The whole step, in order, is the runbook [admit an engine to a vision pack](../docs/runbooks/admit-an-engine-to-a-vision-pack.md).

### The case format: `kind`, `twin`, `reading`

Every hand-written decision case (an id that does not start with `rec-`) says why its label is right. `expect.json` gains three fields beside `label`. `kind` is `labelled`, `adversarial` or `borderline`. `twin` is the labelled case with the same input but without the steering text. An adversarial case names it. `reading` holds the next four fields. `criteria` gives, per labelled question, **the pack's own criterion text, character for character**. That is the label's criterion for a choice, the question's instructions for a yes/no, or the rubric text of the level for a score. `why` gives the reason for the label. `ruledOut` lists every other label of a choice of six or fewer, each with a reason of at least 20 characters. `second` is a second reading of the input. A person makes it later. Its label equals `label`. A borderline case has no `label`. It has at least two `readings` with different labels, each tied to its criterion. It also has a check that bounds the confidence: a `between` on `.p` or `.confidence` with a max of 0.85 or less. A case that needs a secret-looking text uses a shape that the redactors do not match, and says so in `reading.note`. A criterion that changes in `contracts/src/packs.ts` breaks the cases that quote it until someone reads them again. `src/cases.test.ts` runs `checkReading` (`src/reading.ts`) over every decision pack.

Follow this order of work for a label:

1. Write `stage.json` only.
2. Open the pack's criteria in `contracts/src/packs.ts`. Write the label from the input and the criteria alone. Paste `reading.criteria`. Write `ruledOut`.
3. Finish the pack's cases. Then read each `stage.json` again without its `expect.json`. Write the label that the input gives into `reading.second.label`. Compare the two labels.
4. Where the two labels differ, choose one of three fixes. Rewrite the case until one reading is plainly right. Or make it a borderline with both readings. Or drop it.

An adversarial case must be unambiguous apart from its steering text. A borderline case must truly have two readings. It checks the confidence, not a label. Keep case files small and realistic, with names under `.example`.

### Commands

| Command | What it does |
|---|---|
| `pnpm eval records [--task <id>] [--pack <p>] [--since <date>] [--sizes]` | one line per decision record (pack, time, engine, what the machine did, its state, where its truth came from) and a count line. It prints no context |
| `pnpm eval label --pack <p> --record <id> --set <question>=<value>... [--note <text>]` | a person's truth, source `person_cli`, on this computer; the value must be one of the question's labels |
| `pnpm eval label --pack <p> --next` | the oldest record with no person's label: stored context (capped, control characters removed), the model's answer, the allowed labels, the command to type |
| `pnpm eval label push --queue <queue id> [--pack <p>] [--since <date>]` | sends the records that wait for a label to the local labelling queue, scrubbed. It names private and scrub-refused ones and never sends them. The queue id names the queue |
| `pnpm eval cases [--pack <p>]` | a table of the cases for a person to read: kind, label, the criterion quoted, the twin, the second reading. For an agent pack (`plan`, `decompose`) it gives each case's id, outcome and rubric |
| `pnpm eval preflight` | no model call. It checks eight cases per decision pack: six labelled, an adversarial with its twin, a borderline. It also checks every reading, the runner image (reported, never built), each engine's credential and the collector (a warning). It exits 1 on a failure |
| `pnpm eval calibrate --pack <p> [--since <date>] [--target 0.9] [--with-outcome] [--out <file>]` | proposes confidence bars from labelled answers: per question the count, the acted-on accuracy at each bar from 0.50 to 0.95, and a proposal needing 20 answers. It prints the `luna.yaml` lines, marked proposed, not applied |
| `pnpm eval calibrate --weights [--machine <m>] [--out <file>]` | proposes the priority weights and bands from the priority files (30 files, 10 that a person changed, a knock-out card left out) |
| `pnpm eval baseline-plan [--engines a,b,c] [--efforts a,b]` | prints the baseline commands in order and runs none; `evals/baseline-run.sh` is that output. With `--efforts`, it adds one run for each agent pack that has cases, each engine and each effort that engine supports |
| `pnpm eval propose --repo <abs path> [--machine <url>] [--dry-run]` | turns the agent baselines and the decision scorecards into candidates and posts them to the machine's `POST /repos/proposals`. The machine adds the repo's own signals and, when the rule finds a change, opens a `luna.yaml` card on the board. It prints the changes and the card id. `--dry-run` prints the request and makes no call. It reads `MACHINE_API_TOKEN` or `~/.config/hardness/machine-api-token` |
| `pnpm eval build-helper --engine <e> [--case <id>]... [--no-baseline] [--dry]` | `implementing` on three logic-plus-UI cards, with the ui-designer helper and with delegation off; per card both slices committed, scope, picks, conflicts and wall clock. Local only, never in CI; see [the ui-designer's cases](#the-ui-designers-cases-and-the-build-helper-eval-rfc-0013-phase-5) |
| `pnpm eval prune-runs [--older-than 30]` | removes stamped run folders under `evals/.runs/` older than that |

Neither calibrate mode writes a config, a default, a pack or a record. Only `--out` writes, and it writes the report. Nothing turns these by itself. `propose` is the one command that ends in a config change, and a person approves it on the board. See [architecture](../docs/architecture.md#config-proposals).

**Harvest now takes every decision the machine asked**, not only those that name a stage. A record's `origin` says whose it is: `machine` for the machine's own callers. A record from before that field is the pipeline's own when it names a stage. Harvest skips a record from `POST /runs` without `--all`.

**The collector line.** With a trace key, the runner first tries the local collector. If the collector does not answer, the runner prints one line (`traces: the collector at <host>:<port> does not answer; this run leaves no traces (docker compose --profile observe up -d starts it)`) and runs without traces. `--dataset`, `dataset push` and `dataset pull` stop with that line and exit 2.

## In Laminar

You can set a Laminar key in `LMNR_PROJECT_API_KEY` or in `~/.config/hardness/lmnr-project-api-key` (see [configuration](../docs/configuration.md#observability-laminar)). With a key, each `pnpm eval` run on an engine is an evaluation in the group with the pack's name. So two engines' runs compare side by side in the UI. Each case is a trace (`eval:<pack>`) in the session `eval-<pack>-<time>`. In `MACHINE_TRACES=full`, the trace also holds the case's model turns and tool calls. The container continues the trace, as it does for a stage. A datapoint carries the case's input as data, the expectation as target, and the answer and its three grades as output. It also carries the scores `pass`, `schema`, `checks` (the share that passed), `judge`, `turns` and `costUsd`. `MACHINE_TRACES=full` attaches each case's transcript. Without a key nothing changes: the scorecards and baselines here stay the record.

## Add a case

`<pack>/cases/<id>/` holds two files:

- `stage.json`: a `StageInput` as the machine writes it (`contracts/src/stage.ts`). The runner sets `engine` and the pack's current `limits`. A case that needs a repo names a fixture as its `task.repoPath` (`fixtures/golden-task`). For every run, the runner copies the fixture into a fresh git repo on `task.branch`. The copy leaves out `.golden/` (the reference patches and hidden tests). The runner mounts the repo read-only. Any other `repoPath` gets an empty `/work`.
- `expect.json`: `{ "schema": 1, "outcome"?, "checks": [...], "rubric": "..." }`. `outcome` is the `StageOutput` outcome that a good answer settles to. `rubric` tells the judge, in words, what a good answer does and what would be a real error. Each check has a `kind` and a `path` into the answer. Examples of a path are `kind`, `slices[].touchpoints[]`, `items[id=C0EVAL01:1].priority` and `slices[0]`. An empty path is the whole answer:

| Kind | Passes when |
|---|---|
| `equals` `value` | every value at the path equals it, and there is one |
| `oneOf` `values` | every value at the path is one of them |
| `count` `min` `max` | the array at the path, or the matches of a `[key=value]` selector, has that many |
| `between` `min` `max` | every value at the path is a number in range |
| `mentions` `words` `any`? | the text at the path names every word (or, with `any`, one), case-insensitively |
| `avoids` `words` | the text at the path names none of them |

A selector value cannot hold a `.`. Keep checks to what any good answer must contain. Put judgement calls in the rubric.

An agent pack's case has no label and no reading. Its `expect.json` has an `outcome`, a few loose `checks` and a `rubric` for the judge. The `plan` and `decompose` cases are the first of this kind. Their inputs come from the `fixtures/` repos. A person reviews each rubric before any baseline of the pack counts.

A design pack's case may carry an `mcp/` folder: the recorded answers of the design servers, in the layout the machine's record mode writes (`<server>/tools.json` and `<server>/<tool>/<sha256 of the args>.json`; see `machine/src/adapters/mcp/replay.ts`). The runner replays it as a trusted run and never connects, whatever `MCP_BRIDGE_MODE` says. A case with `mcp/` for a pack with no design tools is refused.

The `design_parity` cases are planted differences and clean pairs (RFC 0013): `token-swap`, `spacing-drift`, `radius`, `type-size`, `layout-wrap`, `missing-hover` (no hover capture) and `clean-desktop`/`clean-mobile`. Each has `mounts/evidence/parity/` (the build's captures and their computed styles, mounted read-only at `/evidence`), an `mcp/figma/` replay (the frame's render as a `get_screenshot` answer, the variables and context as text; hand-written, never recorded) and a `good-answer.json` the offline test grades against the checks. Regenerate them all, byte for byte, with `node evals/design_parity/make-fixtures.mjs`: it draws the card with pngjs (read through machine's package), so it needs no browser, image or network. A case's replay answers only the exact arguments it was written with (`{fileKey, nodeId}`). Running one on a model by hand needs the stage image and a login: `pnpm eval --pack design_parity --engine claude:opus --no-judge`.

### The ui-designer's cases and the build-helper eval (RFC 0013, phase 5)

Neither runs in CI. Both need a model login and the stage image, and both are **hand-written fixtures until a Figma account exists**: no run of either has been made, no baseline is saved, and the live Figma test is deferred.

- **`ui_design` cases.** `card-hover-focus` (a hover and a focus state), `panel-empty-error` (the empty and error states the spec names) and `field-a11y` (a form field with an accessibility note). Each is one pure UI slice of `fixtures/golden-ui`, with the approved design spec in `context.plan.designSpec`, its scenario test already in the repo (red until the slice is built) and a hand-written `mcp/figma/` replay (not recorded; keyed by the sha256 of the arguments, like the other cases). `expect.json` checks the answer: a commit, no escalation, only the slice's own file in `files`, none of the implementer's files, `package.json` or the test, and the spec's states and token names in the summary. The judge's rubric covers the states and any invented value. The checks read the answer, not the commits: whether the scenario tests are green and the spec's token names are in the code is the judge's reading of what the helper says, until a run keeps the worktree. Regenerate the folders with `node evals/ui_design/make-fixtures.mjs`. Run one with `pnpm eval --pack ui_design --engine claude:sonnet`.
- **`pnpm eval build-helper --engine claude:sonnet [--case <id>]... [--no-baseline] [--dry]`.** Runs `implementing` through `runAgent` (the machine's own pack runner, on the real docker sandbox, credentials and egress, with the real helper coordinator) on three cards in `evals/build_helper/*.json`. Each card has a logic slice (`src/cart/total.ts`) and the UI slice of one `ui_design` case, whose spec and replayed design servers it reuses. Each card runs twice, with the helper and with the card's design off (delegation off), and the report gives per card: both slices committed, scope clean, picks and conflicts (the machine's `build.helper_*` rows), and the wall clock of the two runs. It exits 1 when a card has a problem. `--dry` lists the cards and runs nothing; the report's shaping is covered by `src/build-helper.test.ts`, with no model.

## What is scrubbed

Cases live in this repository. Scrub a case that comes from a real run before you commit it. Replace people, channels and companies with `.example` names. Replace ids with fake ones (`U0EVAL0001`, `C0EVAL01:1`). Remove tokens, URLs to private systems and any message text the graders do not need. The unit tests refuse a case that carries something shaped like a token or a non-`.example` address. A fixture's `.golden/` never reaches a container.
