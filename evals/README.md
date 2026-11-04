# Replay evals

Runs a pack's eval cases on an engine and grades the answers, so "did triage get worse on this engine?" has an answer from data ([RFC 0003](../docs/rfcs/0003-upgradable-harness.md) §3). Each case runs in the stage image exactly like the machine runs a pack (`runPackOnce` in `machine/src/application/stages/run-once.ts`: the docker sandbox, only that engine's credential). Then it is graded in three steps:

1. **Schema**: the run left a `StageOutput` that answered, and the answer is on the pack's schema.
2. **Checks**: the case's deterministic checks in `expect.json`.
3. **Judge**: the `eval_judge` pack on `claude:opus`, always that engine, reads the case, its rubric and the answer and gives a score from 0 to 1, a pass and its reasons.

A case passes when all three pass. Evals need a model credential, so they run locally and never in CI; CI runs only the grading's unit tests.

## Run

Build the stage image from your checkout first; it carries the `eval_judge` pack:

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
| `--no-judge` | schema and checks only |
| `--save-baseline` | writes each scorecard to `baselines/<engine>/<pack>.json` (`claude:opus` is `claude-opus`) |
| `--image <tag>` | the stage image (`RUNNER_IMAGE`, else `hardness-runner:dev`) |

On a laptop, keep it awake for the run (`caffeinate -s pnpm eval …` on macOS): a container frozen through a sleep is graded as timed out.

The credentials are the machine's: the Claude subscription token, the Codex login, an OpenAI key, the Jev credential (a Vercel AI Gateway or TypeSafe key), found the same way (see [configuration](../docs/configuration.md)). The judge needs the Claude one.

The scorecard gives, per pack and engine, the pass rate, the mean judge score, the mean turns and duration, and the summed cost (`n/a` when the runtime reports none). Without `--save-baseline` it is compared with the engine's saved baseline, over the cases both ran. Every run folder (the input, the output, the transcript) stays under `evals/.runs/`, which git ignores; delete it whenever.


## In Laminar

With a Laminar key set (`LMNR_PROJECT_API_KEY`, or `~/.config/hardness/lmnr-project-api-key`; see [configuration](../docs/configuration.md#observability-laminar)), each `pnpm eval` run on an engine is an evaluation in the group named after the pack, so two engines' runs compare side by side in the UI, and each case is a trace (`eval:<pack>`) in the session `eval-<pack>-<time>`, and in `MACHINE_TRACES=full` with the case's model turns and tool calls under it (the container continues the trace, as it does for a stage). A datapoint carries the case's input as data, the expectation as target, the answer and its three grades as output, and the scores `pass`, `schema`, `checks` (the share passed), `judge`, `turns` and `costUsd`. `MACHINE_TRACES=full` attaches each case's transcript. Without a key nothing changes: the scorecards and baselines here stay the record.

## Add a case

`<pack>/cases/<id>/` holds two files:

- `stage.json`: a `StageInput` as the machine writes it (`contracts/src/stage.ts`). The runner sets `engine` and the pack's current `limits`. A case that needs a repo names a fixture as its `task.repoPath` (`fixtures/golden-task`); the fixture is copied into a fresh git repo on `task.branch` for every run, without `.golden/` (the reference patches and hidden tests) and mounted read-only. Any other `repoPath` gets an empty `/work`.
- `expect.json`: `{ "schema": 1, "outcome"?, "checks": [...], "rubric": "..." }`. `outcome` is the `StageOutput` outcome a good answer settles to. `rubric` tells the judge, in words, what a good answer does and what would be a real error. Each check has a `kind` and a `path` into the answer (`kind`, `slices[].touchpoints[]`, `items[id=C0EVAL01:1].priority`, `slices[0]`; empty is the whole answer):

| Kind | Passes when |
|---|---|
| `equals` `value` | every value at the path equals it, and there is one |
| `oneOf` `values` | every value at the path is one of them |
| `count` `min` `max` | the array at the path, or the matches of a `[key=value]` selector, has that many |
| `between` `min` `max` | every value at the path is a number in range |
| `mentions` `words` `any`? | the text at the path names every word (or, with `any`, one), case-insensitively |
| `avoids` `words` | the text at the path names none of them |

A selector value cannot hold a `.`. Keep checks to what any good answer must contain; judgement calls go in the rubric.

## What is scrubbed

Cases live in this repository, so a case recorded from a real run is scrubbed before it is committed: people, channels and companies become `.example` names, ids become fake ones (`U0EVAL0001`, `C0EVAL01:1`), tokens, URLs to private systems and any message text the graders do not need are removed. The unit tests refuse a case carrying something shaped like a token or a non-`.example` address. A fixture's `.golden/` never reaches a container.
