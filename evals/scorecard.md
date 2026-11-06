# Decision scorecard

Generated 2026-11-06 by `pnpm eval scorecard` from `evals/baselines/<engine>/<pack>.json`. Do not edit by hand: re-run the baselines (docs/runbooks/calibrate-decisions.md).

## The rule

An engine qualifies with coverage >= 0.6 and n >= 4. The default is the qualifying engine with the highest acted-on accuracy; engines within 2 points of it tie, and a tie goes to Jev when it is among them (by far the cheapest engine), else to the cheaper one (cost per case). A pack with fewer than two engines measured keeps its current default.

## Every baseline

| pack | engine | n | accuracy | acted-on accuracy | coverage | Brier | ECE | cost per case | p50 latency | measured at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ci_failure_class | claude:haiku | 6 | 100% | 100% | 100% | 0.007 | 0.078 | $0.0002 | 1.8s | 2026-11-06 |
| ci_failure_class | codex:luna | 6 | 100% | 100% | 100% | 0.000 | 0.012 | n/a | 2.7s | 2026-11-06 |
| ci_failure_class | jev | 6 | 80% | 100% | 83% | 0.040 | 0.110 | $0.0000 | 0.4s | 2026-11-06 |
| comment_intent | claude:haiku | 4 | 100% | 100% | 100% | 0.024 | 0.150 | $0.0004 | 1.9s | 2026-11-05 |
| comment_intent | codex:luna | 4 | 100% | 100% | 100% | 0.001 | 0.030 | n/a | 2.0s | 2026-11-05 |
| comment_intent | jev | 4 | 100% | 100% | 100% | 0.007 | 0.067 | $0.0000 | 0.4s | 2026-11-05 |
| coverage_check | claude:haiku | 4 | 67% | 67% | 100% | 0.249 | 0.211 | $0.0006 | 3.1s | 2026-11-05 |
| coverage_check | codex:luna | 4 | 67% | 67% | 100% | 0.316 | 0.317 | n/a | 2.6s | 2026-11-05 |
| coverage_check | jev | 4 | 33% | 100% | 50% | 0.329 | 0.510 | $0.0000 | 0.5s | 2026-11-05 |
| e2e_failure_cause | claude:haiku | 4 | 100% | 100% | 75% | 0.007 | 0.080 | $0.0005 | 3.2s | 2026-11-06 |
| e2e_failure_cause | codex:luna | 4 | 100% | 100% | 75% | 0.000 | 0.013 | n/a | 2.5s | 2026-11-06 |
| e2e_failure_cause | jev | 4 | 100% | 100% | 50% | 0.189 | 0.270 | $0.0000 | 0.4s | 2026-11-06 |
| escalation_reason | claude:haiku | 4 | 100% | 100% | 100% | 0.026 | 0.160 | $0.0005 | 2.0s | 2026-11-05 |
| escalation_reason | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.020 | n/a | 2.1s | 2026-11-05 |
| escalation_reason | jev | 4 | 100% | 100% | 75% | 0.009 | 0.060 | $0.0000 | 0.4s | 2026-11-05 |
| event_class | claude:haiku | 4 | 100% | 100% | 75% | 0.015 | 0.097 | $0.0005 | 2.0s | 2026-11-05 |
| event_class | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.013 | n/a | 2.1s | 2026-11-05 |
| event_class | jev | 4 | 67% | 100% | 75% | 0.035 | 0.133 | $0.0000 | 0.4s | 2026-11-05 |
| evidence_format | claude:haiku | 7 | 100% | 100% | 86% | 0.015 | 0.110 | $0.0005 | 1.9s | 2026-11-06 |
| evidence_format | codex:luna | 7 | 100% | 100% | 86% | 0.000 | 0.013 | n/a | 2.7s | 2026-11-06 |
| evidence_format | jev | 7 | 100% | 100% | 71% | 0.060 | 0.210 | $0.0000 | 0.5s | 2026-11-06 |
| evidence_valid | claude:haiku | 4 | 100% | 100% | 100% | 0.039 | 0.177 | $0.0005 | 1.9s | 2026-11-05 |
| evidence_valid | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.013 | n/a | 2.1s | 2026-11-05 |
| evidence_valid | jev | 4 | 33% | 100% | 25% | 0.030 | 0.170 | $0.0000 | 0.4s | 2026-11-05 |
| finding_classify | claude:haiku | 4 | 100% | 100% | 75% | 0.004 | 0.063 | $0.0005 | 1.9s | 2026-11-06 |
| finding_classify | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.010 | n/a | 3.4s | 2026-11-06 |
| finding_classify | jev | 4 | 67% | 100% | 50% | 0.137 | 0.223 | $0.0000 | 0.4s | 2026-11-06 |
| fix_scope | claude:haiku | 4 | 100% | 100% | 100% | 0.027 | 0.150 | $0.0005 | 2.3s | 2026-11-05 |
| fix_scope | codex:luna | 4 | 100% | 100% | 100% | 0.000 | 0.020 | n/a | 2.5s | 2026-11-05 |
| fix_scope | jev | 4 | 67% | 100% | 50% | 0.005 | 0.057 | $0.0000 | 0.4s | 2026-11-05 |
| frame_privacy | claude:haiku | 5 | 100% | 100% | 80% | 0.002 | 0.045 | $0.0005 | 2.4s | 2026-11-06 |
| frame_privacy | codex:luna | 5 | 100% | 100% | 100% | 0.000 | 0.010 | n/a | 2.3s | 2026-11-06 |
| frame_privacy | jev | 5 | 100% | 100% | 100% | 0.001 | 0.028 | $0.0000 | 0.5s | 2026-11-06 |
| plan_check | claude:haiku | 4 | 100% | 100% | 75% | 0.023 | 0.150 | $0.0007 | 3.5s | 2026-11-05 |
| plan_check | codex:luna | 4 | 67% | 67% | 100% | 0.328 | 0.303 | n/a | 2.5s | 2026-11-05 |
| plan_check | jev | 4 | 100% | 100% | 50% | 0.097 | 0.292 | $0.0000 | 0.5s | 2026-11-05 |
| red_check | claude:haiku | 6 | 100% | 100% | 83% | 0.029 | 0.157 | $0.0006 | 2.6s | 2026-11-05 |
| red_check | codex:luna | 6 | 100% | 100% | 100% | 0.005 | 0.040 | n/a | 2.5s | 2026-11-05 |
| red_check | jev | 6 | 100% | 100% | 17% | 0.058 | 0.235 | $0.0000 | 0.5s | 2026-11-05 |
| risk_score | claude:haiku | 4 | 67% | 100% | 25% | 0.206 | 0.159 | $0.0007 | 3.0s | 2026-11-05 |
| risk_score | codex:luna | 4 | 67% | 67% | 100% | 0.291 | 0.289 | n/a | 2.9s | 2026-11-05 |
| risk_score | jev | 4 | 67% | 50% | 50% | 0.299 | 0.418 | $0.0000 | 0.5s | 2026-11-05 |
| scope_check | claude:haiku | 5 | 100% | 100% | 80% | 0.013 | 0.112 | $0.0007 | 2.9s | 2026-11-05 |
| scope_check | codex:luna | 5 | 100% | 100% | 40% | 0.039 | 0.127 | n/a | 3.3s | 2026-11-05 |
| scope_check | jev | 5 | 100% | 100% | 80% | 0.018 | 0.132 | $0.0000 | 0.4s | 2026-11-05 |
| triage_signals | claude:haiku | 6 | 100% | n/a | 0% | 0.083 | 0.283 | $0.0012 | 4.3s | 2026-11-05 |
| triage_signals | codex:luna | 6 | 50% | 0% | 33% | 0.417 | 0.366 | n/a | 5.0s | 2026-11-05 |
| triage_signals | jev | 6 | 50% | n/a | 0% | 0.329 | 0.405 | $0.0001 | 0.5s | 2026-11-05 |
| worth_learning | claude:haiku | 4 | 100% | 100% | 100% | 0.051 | 0.193 | $0.0004 | 1.8s | 2026-11-05 |
| worth_learning | codex:luna | 4 | 100% | 100% | 100% | 0.001 | 0.020 | n/a | 2.0s | 2026-11-05 |
| worth_learning | jev | 4 | 100% | 100% | 100% | 0.029 | 0.157 | $0.0000 | 0.4s | 2026-11-05 |

## The default per slot

| pack | default | why |
| --- | --- | --- |
| ci_failure_class | jev | jev: acted-on accuracy 1.00 at coverage 0.83 (n 6), a tie within 2 points that goes to Jev, the cheapest |
| comment_intent | jev | jev: acted-on accuracy 1.00 at coverage 1.00 (n 4), a tie within 2 points that goes to Jev, the cheapest |
| coverage_check | claude:haiku | claude:haiku: acted-on accuracy 0.67 at coverage 1.00 (n 4), a tie within 2 points settled by cost |
| e2e_failure_cause | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 0.75 (n 4), a tie within 2 points settled by cost |
| escalation_reason | jev | jev: acted-on accuracy 1.00 at coverage 0.75 (n 4), a tie within 2 points that goes to Jev, the cheapest |
| event_class | jev | jev: acted-on accuracy 1.00 at coverage 0.75 (n 4), a tie within 2 points that goes to Jev, the cheapest |
| evidence_format | jev | jev: acted-on accuracy 1.00 at coverage 0.71 (n 7), a tie within 2 points that goes to Jev, the cheapest |
| evidence_valid | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 1.00 (n 4), a tie within 2 points settled by cost |
| finding_classify | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 0.75 (n 4), a tie within 2 points settled by cost |
| fix_scope | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 1.00 (n 4), a tie within 2 points settled by cost |
| frame_privacy | jev | jev: acted-on accuracy 1.00 at coverage 1.00 (n 5), a tie within 2 points that goes to Jev, the cheapest |
| plan_check | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 0.75 (n 4) |
| red_check | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 0.83 (n 6), a tie within 2 points settled by cost |
| risk_score | codex:luna | codex:luna: acted-on accuracy 0.67 at coverage 1.00 (n 4) |
| scope_check | jev | jev: acted-on accuracy 1.00 at coverage 0.80 (n 5), a tie within 2 points that goes to Jev, the cheapest |
| triage_signals | jev | unmeasured: no engine reached coverage 0.6 on 4 cases |
| worth_learning | jev | jev: acted-on accuracy 1.00 at coverage 1.00 (n 4), a tie within 2 points that goes to Jev, the cheapest |
