# Admit an engine to a vision pack

A vision pack reads images. Today these are `design_spec` and `design_parity` (`vision: true` in `contracts/src/packs.ts`). An engine joins one only when its model reads images and its eval matches Claude's ([RFC 0013](../rfcs/0013-designer-agents.md), phase 4). This runbook is that path, in order.

Everything here runs on your machine. The probe and the evals need a model credential, so none of it runs in CI. You need the rebuilt stage image, the login or key of the candidate, and the Claude token for the baseline.

The `contracts` tests refuse every shortcut. A blind engine in a vision pack's `allowed` fails `engines.test.ts`. A non-Claude engine in `allowed` with no passing admission record fails `evals/src/admission.test.ts`.

## 1. Probe

Does the model read an image that eve's `read_file` returns, on the route the engine uses?

```sh
LUNA_LIVE_VISION=1 pnpm --filter @hardness/factory exec vitest run src/runtimes/eve/vision.live.test.ts
```

The probe saves a red and a green square under a neutral name and asks for the color. It passes when the engine names the color with the image shown, and answers "unknown" with the image withheld. Edit the `ENGINES` list in the test to probe another engine.

If the backend rejects the image (an HTTP 400 naming `input_image`) or the engine cannot name the color, stop. The engine stays blind. [RFC 0013](../rfcs/0013-designer-agents.md), decision D4, names the fallback: a wrapper in `agent/model.ts`. It is a design change, not a flag.

## 2. Flip the catalog flag

- Set `vision: true` on the model's entry in `contracts/src/models.ts` (`SEES` instead of `BLIND`).
- Run the contract test:

```sh
pnpm --filter @hardness/contracts test
```

The flag alone changes nothing for a pack. It only stops the machine from refusing the engine for being blind. The pack's `allowed` list is step 5.

## 3. Save the baselines

Run the pack's cases on the Claude default and on the candidate. Both baselines must come from the same cases and the same stage image.

```sh
pnpm --filter @hardness/machine runner:build
pnpm eval --pack design_parity --engine claude:opus --save-baseline
pnpm eval --pack design_parity --engine codex:sol --save-baseline
```

An engine outside `allowed` runs as a candidate, so the pack needs no change for this. Keep a laptop awake for the run (`caffeinate -s` on macOS). Do the same for `design_spec` with its own cases.

## 4. Admit

```sh
pnpm eval admit --pack design_parity --engine codex:sol --against claude:opus --write
```

The command reads both baselines. It passes when all of these hold:

- the candidate graded at least eight cases (`MIN_CASES_TO_MOVE`);
- its pass rate is at least Claude's minus 2 points (`TIE_POINTS = 0.02`, `evals/src/scorecard.ts`);
- where both baselines carry them, its recall is at least Claude's minus 2 points, and its false-blocker rate at most Claude's plus 2 points.

It exits 0 on a pass, 1 on a fail and 2 when a baseline is missing (or `--against` is not a Claude engine). `--write` records the verdict in `evals/baselines/<engine>/<pack>.admission.json`, a pass or a fail.

The parity grader does not record `recall` or `falseBlockerRate` yet, so today the gate rests on the pass rate. Confirm what the baselines carry before you read a pass as more than that.

On a fail, the pack stays Claude-only. Keep the record. It says why.

## 5. Add the engine to the pack

Only after a pass:

- Add the engine to the pack's `engines.allowed` in `contracts/src/packs.ts`.
- Add it to `engines.fallback` only if you want the pack to move to it on a usage limit. Leave `default` as it is.
- Update the pack's comment, which says "Claude only".

```sh
pnpm test
```

`pnpm test` includes the admission check and the vision invariant. The machine tests need Postgres first (`pnpm db:up`; see [contributing](../contributing.md)).

## 6. Commit the admission record

Commit the two baselines and the `*.admission.json` file with the `allowed` change, as one PR. The PR description carries the scorecard lines: n, pass rate and the margin for each engine.

## Pull an engine back

To remove an engine, delete it from `allowed` and `fallback`. Keep the admission record as history, or replace it with a failing one from a later run. If a probe later shows a model has lost image input, set `vision: false` first. The machine then refuses it for every vision pack at once.

When a model is upgraded, its vision packs are measured again from step 1 ([upgrade-a-model](upgrade-a-model.md)).
