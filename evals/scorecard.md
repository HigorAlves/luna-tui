# Decision scorecard

Generated 2026-11-05 by `pnpm eval scorecard` from `evals/baselines/<engine>/<pack>.json`. Do not edit by hand: re-run the baselines (docs/runbooks/calibrate-decisions.md).

## The rule

An engine qualifies with coverage >= 0.6 and n >= 4. The default is the qualifying engine with the highest acted-on accuracy; engines within 2 points of it tie and the cheaper one (cost per case) wins; Jev wins only by 5 points or more over claude:haiku (it is the metered path); a pack with fewer than two engines measured keeps its current default and reads `unmeasured`.

## Every baseline

| pack | engine | n | accuracy | acted-on accuracy | coverage | Brier | ECE | cost per case | p50 latency | measured at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| comment_intent | claude:haiku | 4 | 67% | 67% | 100% | 0.222 | 0.193 | $0.0004 | 2.1s | 2026-11-05 |
| comment_intent | codex:luna | 4 | 67% | 67% | 100% | 0.321 | 0.310 | n/a | 2.5s | 2026-11-05 |
| comment_intent | jev | 4 | 100% | 100% | 100% | 0.006 | 0.063 | $0.0000 | 0.4s | 2026-11-05 |
| coverage_check | claude:haiku | 4 | 67% | 100% | 75% | 0.193 | 0.347 | $0.0006 | 2.8s | 2026-11-05 |
| coverage_check | codex:luna | 4 | 67% | 67% | 100% | 0.307 | 0.311 | n/a | 2.7s | 2026-11-05 |
| coverage_check | jev | 4 | 67% | 100% | 50% | 0.181 | 0.092 | $0.0000 | 0.4s | 2026-11-05 |
| e2e_failure_cause | claude:haiku | 4 | 100% | 100% | 75% | 0.020 | 0.130 | $0.0005 | 3.3s | 2026-11-05 |
| e2e_failure_cause | codex:luna | 4 | 100% | 100% | 75% | 0.000 | 0.010 | n/a | 2.6s | 2026-11-05 |
| e2e_failure_cause | jev | 4 | 100% | 100% | 50% | 0.161 | 0.257 | $0.0000 | 0.5s | 2026-11-05 |
| event_class | claude:haiku | 4 | 100% | 100% | 50% | 0.057 | 0.180 | $0.0003 | 2.0s | 2026-11-05 |
| event_class | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.010 | n/a | 2.1s | 2026-11-05 |
| event_class | jev | 4 | 67% | 100% | 75% | 0.045 | 0.147 | $0.0000 | 0.5s | 2026-11-05 |
| evidence_format | claude:haiku | 4 | 100% | 100% | 75% | 0.010 | 0.090 | $0.0004 | 2.2s | 2026-11-05 |
| evidence_format | codex:luna | 4 | 67% | 67% | 100% | 0.333 | 0.327 | n/a | 2.4s | 2026-11-05 |
| evidence_format | jev | 4 | 100% | 100% | 100% | 0.016 | 0.090 | $0.0000 | 0.5s | 2026-11-05 |
| evidence_valid | claude:haiku | 4 | 100% | 100% | 100% | 0.037 | 0.177 | $0.0005 | 4.2s | 2026-11-05 |
| evidence_valid | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.017 | n/a | 2.4s | 2026-11-05 |
| evidence_valid | jev | 4 | 33% | 100% | 25% | 0.036 | 0.180 | $0.0000 | 0.4s | 2026-11-05 |
| finding_classify | claude:haiku | 4 | 100% | 100% | 75% | 0.006 | 0.073 | $0.0004 | 2.0s | 2026-11-05 |
| finding_classify | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.010 | n/a | 2.4s | 2026-11-05 |
| finding_classify | jev | 4 | 67% | 100% | 50% | 0.128 | 0.217 | $0.0000 | 0.4s | 2026-11-05 |
| fix_scope | claude:haiku | 4 | 100% | 100% | 75% | 0.062 | 0.207 | $0.0005 | 2.0s | 2026-11-05 |
| fix_scope | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.010 | n/a | 2.4s | 2026-11-05 |
| fix_scope | jev | 4 | 67% | 100% | 50% | 0.013 | 0.083 | $0.0000 | 0.4s | 2026-11-05 |
| plan_check | claude:haiku | 4 | 100% | 100% | 100% | 0.015 | 0.119 | $0.0007 | 2.8s | 2026-11-05 |
| plan_check | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.013 | n/a | 3.0s | 2026-11-05 |
| plan_check | jev | 4 | 100% | 100% | 50% | 0.064 | 0.248 | $0.0000 | 0.4s | 2026-11-05 |
| red_check | claude:haiku | 4 | 100% | 100% | 50% | 0.023 | 0.142 | $0.0005 | 4.3s | 2026-11-05 |
| red_check | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.010 | n/a | 2.5s | 2026-11-05 |
| red_check | jev | 4 | 67% | 50% | 50% | 0.244 | 0.298 | $0.0000 | 0.5s | 2026-11-05 |
| risk_score | claude:haiku | 4 | 67% | 67% | 75% | 0.255 | 0.336 | $0.0007 | 3.8s | 2026-11-05 |
| risk_score | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.018 | n/a | 3.0s | 2026-11-05 |
| risk_score | jev | 4 | 67% | 100% | 25% | 0.169 | 0.043 | $0.0000 | 0.4s | 2026-11-05 |
| scope_check | claude:haiku | 4 | 100% | 100% | 75% | 0.008 | 0.091 | $0.0007 | 3.0s | 2026-11-05 |
| scope_check | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.008 | n/a | 3.3s | 2026-11-05 |
| scope_check | jev | 4 | 100% | 100% | 100% | 0.015 | 0.123 | $0.0000 | 0.5s | 2026-11-05 |
| triage_signals | claude:haiku | 5 | 100% | n/a | 20% | 0.110 | 0.331 | $0.0009 | 3.1s | 2026-11-05 |
| triage_signals | codex:luna | 5 | 100% | n/a | 40% | 0.019 | 0.139 | n/a | 6.0s | 2026-11-05 |
| triage_signals | jev | 5 | 100% | n/a | 0% | 0.088 | 0.296 | $0.0000 | 0.4s | 2026-11-05 |
| worth_learning | claude:haiku | 4 | 100% | 100% | 100% | 0.035 | 0.167 | $0.0004 | 4.2s | 2026-11-05 |
| worth_learning | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.017 | n/a | 2.7s | 2026-11-05 |
| worth_learning | jev | 4 | 100% | 100% | 100% | 0.026 | 0.147 | $0.0000 | 0.4s | 2026-11-05 |

## The default per slot

| pack | default | why |
| --- | --- | --- |
| comment_intent | jev | jev: acted-on accuracy 1.00 at coverage 1.00 (n 4) |
| coverage_check | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 0.75 (n 4) |
| e2e_failure_cause | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 0.75 (n 4), a tie within 2 points settled by cost |
| event_class | jev | jev: acted-on accuracy 1.00 at coverage 0.75 (n 4), a tie within 2 points settled by cost |
| evidence_format | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 0.75 (n 4), Jev ahead by 0 points, short of the 5 it needs over claude:haiku |
| evidence_valid | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 1.00 (n 4), a tie within 2 points settled by cost |
| finding_classify | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 0.75 (n 4), a tie within 2 points settled by cost |
| fix_scope | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 0.75 (n 4), a tie within 2 points settled by cost |
| plan_check | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 1.00 (n 4), a tie within 2 points settled by cost |
| red_check | codex:luna | codex:luna: acted-on accuracy 1.00 at coverage 1.00 (n 4) |
| risk_score | codex:luna | codex:luna: acted-on accuracy 1.00 at coverage 1.00 (n 4) |
| scope_check | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 0.75 (n 4), Jev ahead by 0 points, short of the 5 it needs over claude:haiku |
| triage_signals | jev | unmeasured: no engine reached coverage 0.6 on 4 cases |
| worth_learning | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 1.00 (n 4), Jev ahead by 0 points, short of the 5 it needs over claude:haiku |
