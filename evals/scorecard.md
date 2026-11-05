# Decision scorecard

Generated 2026-11-04 by `pnpm eval scorecard` from `evals/baselines/<engine>/<pack>.json`. Do not edit by hand: re-run the baselines (docs/runbooks/calibrate-decisions.md).

## The rule

An engine qualifies with coverage >= 0.6 and n >= 4. The default is the qualifying engine with the highest acted-on accuracy; engines within 2 points of it tie and the cheaper one (cost per case) wins; Jev wins only by 5 points or more over claude:haiku (it is the metered path); a pack with fewer than two engines measured keeps its current default and reads `unmeasured`.

## Every baseline

No baselines yet: the first run (`pnpm eval --pack <p> --engine <e> --save-baseline` on two engines per pack) fills this in.

| pack | engine | n | accuracy | acted-on accuracy | coverage | Brier | ECE | cost per case | p50 latency | measured at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## The default per slot

| pack | default | why |
| --- | --- | --- |
