# Decision scorecard

Generated 2026-11-06 by `pnpm eval scorecard` from `evals/baselines/<engine>/<pack>.json`. Do not edit by hand: re-run the baselines (docs/runbooks/calibrate-decisions.md).

## The rule

An engine qualifies with coverage >= 0.6 and n >= 4. The default is the qualifying engine with the highest acted-on accuracy; engines within 2 points of it tie, and a tie goes to Jev when it is among them (by far the cheapest engine), else to the cheaper one (cost per case). A pack with fewer than two engines measured keeps its current default. An engine that acted on every case and was right on every one wins outright; among several such, Jev, else the cheaper. A pack the machine reads answer by answer is read the same way on its pool of answers (at least 20 labelled). A default moves only when the winner has 8 graded cases and 6 labelled; under that it keeps its engine. A pin of the owner is never moved by any of this.

## Every baseline

| pack | engine | n | accuracy | acted-on accuracy | coverage | Brier | ECE | cost per case | p50 latency | measured at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ci_failure_class | claude:haiku | 9 | 100% | 100% (75-100) | 100% | 0.006 | 0.074 | $0.0004 | 1.8s | 2026-11-06 |
| ci_failure_class | codex:luna | 9 | 100% | 100% (75-100) | 100% | 0.000 | 0.011 | n/a | 2.4s | 2026-11-06 |
| ci_failure_class | jev | 9 | 88% | 100% (72-100) | 89% | 0.024 | 0.084 | $0.0000 | 0.5s | 2026-11-06 |
| comment_intent | claude:haiku | 8 | 100% | 100% (69-100) | 88% | 0.046 | 0.181 | $0.0005 | 2.1s | 2026-11-06 |
| comment_intent | codex:luna | 8 | 86% | 86% (55-97) | 100% | 0.137 | 0.127 | n/a | 2.1s | 2026-11-06 |
| comment_intent | jev | 8 | 100% | 100% (65-100) | 75% | 0.052 | 0.150 | $0.0000 | 0.5s | 2026-11-06 |
| conversation_assess | claude:haiku | 8 | 100% | 100% (27-100) | 13% | 0.034 | 0.180 | $0.0010 | 3.1s | 2026-11-06 |
| conversation_assess | codex:luna | 8 | 100% | 100% (69-100) | 75% | 0.004 | 0.057 | n/a | 3.5s | 2026-11-06 |
| conversation_assess | jev | 8 | 29% | 100% (27-100) | 13% | 0.381 | 0.480 | $0.0000 | 0.7s | 2026-11-06 |
| conversation_relation | claude:haiku | 8 | 100% | 100% (72-100) | 100% | 0.008 | 0.082 | $0.0005 | 2.0s | 2026-11-06 |
| conversation_relation | codex:luna | 8 | 86% | 86% (55-97) | 100% | 0.137 | 0.129 | n/a | 2.4s | 2026-11-06 |
| conversation_relation | jev | 8 | 86% | 75% (36-94) | 63% | 0.152 | 0.210 | $0.0000 | 0.4s | 2026-11-06 |
| coverage_check | claude:haiku | 8 | 86% | 86% (55-97) | 100% | 0.117 | 0.023 | $0.0006 | 2.6s | 2026-11-06 |
| coverage_check | codex:luna | 8 | 86% | 86% (55-97) | 100% | 0.128 | 0.118 | n/a | 3.3s | 2026-11-06 |
| coverage_check | jev | 8 | 57% | 100% (53-100) | 50% | 0.231 | 0.320 | $0.0000 | 0.5s | 2026-11-06 |
| e2e_failure_cause | claude:haiku | 8 | 100% | 100% (72-100) | 88% | 0.011 | 0.093 | $0.0005 | 2.2s | 2026-11-06 |
| e2e_failure_cause | codex:luna | 8 | 100% | 100% (72-100) | 88% | 0.000 | 0.014 | n/a | 2.4s | 2026-11-06 |
| e2e_failure_cause | jev | 8 | 86% | 100% (69-100) | 75% | 0.015 | 0.069 | $0.0000 | 0.5s | 2026-11-06 |
| escalation_reason | claude:haiku | 8 | 100% | 100% (65-100) | 75% | 0.178 | 0.317 | $0.0004 | 1.9s | 2026-11-06 |
| escalation_reason | codex:luna | 8 | 100% | 100% (72-100) | 100% | 0.000 | 0.017 | n/a | 2.3s | 2026-11-06 |
| escalation_reason | jev | 8 | 100% | 100% (69-100) | 75% | 0.022 | 0.089 | $0.0000 | 0.5s | 2026-11-06 |
| event_class | claude:haiku | 14 | 100% | 100% (83-100) | 93% | 0.015 | 0.095 | $0.0003 | 1.7s | 2026-11-06 |
| event_class | codex:luna | 14 | 92% | 92% (72-98) | 100% | 0.071 | 0.064 | n/a | 2.3s | 2026-11-06 |
| event_class | jev | 14 | 85% | 85% (63-95) | 93% | 0.103 | 0.075 | $0.0000 | 0.5s | 2026-11-06 |
| evidence_format | claude:haiku | 8 | 100% | 100% (72-100) | 100% | 0.007 | 0.079 | $0.0005 | 1.9s | 2026-11-06 |
| evidence_format | codex:luna | 8 | 100% | 100% (72-100) | 100% | 0.000 | 0.013 | n/a | 2.1s | 2026-11-06 |
| evidence_format | jev | 8 | 100% | 100% (69-100) | 75% | 0.051 | 0.197 | $0.0000 | 0.5s | 2026-11-06 |
| evidence_valid | claude:haiku | 8 | 100% | 100% (72-100) | 88% | 0.029 | 0.157 | $0.0005 | 2.1s | 2026-11-06 |
| evidence_valid | codex:luna | 8 | 100% | 100% (72-100) | 100% | 0.001 | 0.021 | n/a | 2.3s | 2026-11-06 |
| evidence_valid | jev | 8 | 71% | 100% (60-100) | 50% | 0.076 | 0.131 | $0.0000 | 0.4s | 2026-11-06 |
| finding_classify | claude:haiku | 8 | 71% | 83% (50-96) | 75% | 0.179 | 0.180 | $0.0004 | 1.8s | 2026-11-06 |
| finding_classify | codex:luna | 8 | 86% | 86% (55-97) | 100% | 0.143 | 0.106 | n/a | 2.2s | 2026-11-06 |
| finding_classify | jev | 8 | 43% | 75% (36-94) | 50% | 0.276 | 0.377 | $0.0000 | 0.4s | 2026-11-06 |
| fix_scope | claude:haiku | 8 | 100% | 100% (65-100) | 75% | 0.060 | 0.203 | $0.0004 | 2.0s | 2026-11-06 |
| fix_scope | codex:luna | 8 | 100% | 100% (72-100) | 100% | 0.002 | 0.033 | n/a | 2.0s | 2026-11-06 |
| fix_scope | jev | 8 | 86% | 100% (60-100) | 50% | 0.118 | 0.207 | $0.0000 | 0.4s | 2026-11-06 |
| frame_privacy | claude:haiku | 8 | 100% | 100% (72-100) | 88% | 0.002 | 0.044 | $0.0004 | 1.7s | 2026-11-06 |
| frame_privacy | codex:luna | 8 | 100% | 100% (72-100) | 100% | 0.000 | 0.014 | n/a | 2.1s | 2026-11-06 |
| frame_privacy | jev | 8 | 100% | 100% (72-100) | 100% | 0.001 | 0.031 | $0.0000 | 0.5s | 2026-11-06 |
| intake_dedup | claude:haiku | 8 | 86% | 100% (65-100) | 63% | 0.115 | 0.062 | $0.0007 | 2.6s | 2026-11-06 |
| intake_dedup | codex:luna | 8 | 86% | 86% (55-97) | 100% | 0.142 | 0.137 | n/a | 3.3s | 2026-11-06 |
| intake_dedup | jev | 8 | 86% | 100% (65-100) | 63% | 0.082 | 0.130 | $0.0000 | 0.4s | 2026-11-06 |
| plan_check | claude:haiku | 8 | 100% | 100% (69-100) | 75% | 0.047 | 0.206 | $0.0007 | 2.9s | 2026-11-06 |
| plan_check | codex:luna | 8 | 71% | 71% (41-90) | 88% | 0.281 | 0.265 | n/a | 3.0s | 2026-11-06 |
| plan_check | jev | 8 | 86% | 100% (43-100) | 25% | 0.134 | 0.127 | $0.0000 | 0.6s | 2026-11-06 |
| red_check | claude:haiku | 8 | 100% | 100% (53-100) | 50% | 0.041 | 0.190 | $0.0006 | 2.8s | 2026-11-06 |
| red_check | codex:luna | 8 | 100% | 100% (72-100) | 100% | 0.000 | 0.014 | n/a | 3.2s | 2026-11-06 |
| red_check | jev | 8 | 100% | 100% (27-100) | 13% | 0.060 | 0.240 | $0.0000 | 0.5s | 2026-11-06 |
| risk_score | claude:haiku | 8 | 86% | 100% (27-100) | 13% | 0.145 | 0.129 | $0.0007 | 2.7s | 2026-11-06 |
| risk_score | codex:luna | 8 | 86% | 80% (44-95) | 75% | 0.147 | 0.079 | n/a | 3.3s | 2026-11-06 |
| risk_score | jev | 8 | 86% | 50% (12-88) | 25% | 0.299 | 0.487 | $0.0000 | 0.6s | 2026-11-06 |
| scope_check | claude:haiku | 8 | 100% | 100% (72-100) | 100% | 0.013 | 0.111 | $0.0008 | 2.9s | 2026-11-06 |
| scope_check | codex:luna | 8 | 100% | 100% (65-100) | 63% | 0.034 | 0.119 | n/a | 3.1s | 2026-11-06 |
| scope_check | jev | 8 | 86% | 100% (60-100) | 63% | 0.116 | 0.005 | $0.0000 | 0.5s | 2026-11-06 |
| size_estimate | claude:haiku | 8 | 71% | 100% (43-100) | 25% | 0.202 | 0.108 | $0.0007 | 2.9s | 2026-11-06 |
| size_estimate | codex:luna | 8 | 57% | 50% (22-78) | 88% | 0.392 | 0.382 | n/a | 2.9s | 2026-11-06 |
| size_estimate | jev | 8 | 57% | 100% (43-100) | 38% | 0.208 | 0.292 | $0.0000 | 0.5s | 2026-11-06 |
| split_check | claude:haiku | 6 | 80% | 67% (25-92) | 67% | 0.174 | 0.207 | $0.0006 | 7.3s | 2026-11-06 |
| split_check | codex:luna | 8 | 86% | 86% (55-97) | 100% | 0.124 | 0.092 | n/a | 2.6s | 2026-11-06 |
| split_check | jev | 8 | 57% | 100% (53-100) | 50% | 0.198 | 0.306 | $0.0000 | 0.5s | 2026-11-06 |
| ticket_assess | claude:haiku | 8 | 71% | n/a | 0% | 0.171 | 0.144 | $0.0017 | 3.8s | 2026-11-06 |
| ticket_assess | codex:luna | 8 | 86% | 100% (43-100) | 25% | 0.096 | 0.103 | n/a | 5.3s | 2026-11-06 |
| ticket_assess | jev | 8 | 29% | n/a | 0% | 0.344 | 0.370 | $0.0001 | 0.6s | 2026-11-06 |
| ticket_recommend | claude:haiku | 8 | 86% | 100% (60-100) | 50% | 0.113 | 0.304 | $0.0005 | 1.7s | 2026-11-06 |
| ticket_recommend | codex:luna | 8 | 100% | 100% (72-100) | 100% | 0.009 | 0.080 | n/a | 2.3s | 2026-11-06 |
| ticket_recommend | jev | 8 | 100% | 100% (27-100) | 13% | 0.243 | 0.479 | $0.0000 | 0.4s | 2026-11-06 |
| ticket_validity | claude:haiku | 8 | 100% | 100% (43-100) | 25% | 0.030 | 0.165 | $0.0008 | 2.9s | 2026-11-06 |
| ticket_validity | codex:luna | 8 | 100% | 100% (72-100) | 88% | 0.000 | 0.017 | n/a | 2.8s | 2026-11-06 |
| ticket_validity | jev | 8 | 100% | 100% (27-100) | 13% | 0.023 | 0.150 | $0.0000 | 0.5s | 2026-11-06 |
| triage_signals | claude:haiku | 8 | 14% | n/a | 0% | 0.464 | 0.591 | $0.0011 | 3.6s | 2026-11-06 |
| triage_signals | codex:luna | 8 | 14% | 0% (0-73) | 13% | 0.581 | 0.685 | n/a | 4.5s | 2026-11-06 |
| triage_signals | jev | 8 | 14% | n/a | 0% | 0.444 | 0.556 | $0.0001 | 0.5s | 2026-11-06 |
| worth_learning | claude:haiku | 8 | 100% | 100% (69-100) | 100% | 0.038 | 0.168 | $0.0004 | 2.2s | 2026-11-06 |
| worth_learning | codex:luna | 8 | 100% | 100% (69-100) | 88% | 0.001 | 0.023 | n/a | 2.3s | 2026-11-06 |
| worth_learning | jev | 8 | 100% | 100% (65-100) | 75% | 0.037 | 0.163 | $0.0000 | 0.4s | 2026-11-06 |

## Per answer

| pack | engine | question | n labelled | accuracy | acted-on accuracy | coverage | Brier |
| --- | --- | --- | --- | --- | --- | --- | --- |
| conversation_assess | claude:haiku | kind | 7 | 100% | 100% | 75% | 0.050 |
| conversation_assess | claude:haiku | needs_reply | 2 | 100% | 100% | 63% | 0.006 |
| conversation_assess | claude:haiku | production_down | 7 | 100% | 100% | 100% | 0.001 |
| conversation_assess | claude:haiku | data_loss | 6 | 100% | 100% | 100% | 0.001 |
| conversation_assess | claude:haiku | security | 7 | 100% | 100% | 100% | 0.001 |
| conversation_assess | claude:haiku | who | 1 | 100% | 100% | 38% | 0.010 |
| conversation_assess | claude:haiku | what | 3 | 100% | 100% | 75% | 0.022 |
| conversation_assess | claude:haiku | impact | 4 | 100% | 100% | 75% | 0.067 |
| conversation_assess | claude:haiku | time | 6 | 100% | 100% | 75% | 0.031 |
| conversation_assess | claude:haiku | demand | 6 | 100% | 100% | 63% | 0.074 |
| conversation_assess | codex:luna | kind | 7 | 100% | 100% | 100% | 0.003 |
| conversation_assess | codex:luna | needs_reply | 2 | 100% | 100% | 88% | 0.001 |
| conversation_assess | codex:luna | production_down | 7 | 100% | 100% | 100% | 0.000 |
| conversation_assess | codex:luna | data_loss | 6 | 100% | 100% | 100% | 0.000 |
| conversation_assess | codex:luna | security | 7 | 100% | 100% | 100% | 0.000 |
| conversation_assess | codex:luna | who | 1 | 100% | 100% | 88% | 0.000 |
| conversation_assess | codex:luna | what | 3 | 100% | 100% | 88% | 0.005 |
| conversation_assess | codex:luna | impact | 4 | 100% | 100% | 88% | 0.008 |
| conversation_assess | codex:luna | time | 6 | 100% | 100% | 100% | 0.003 |
| conversation_assess | codex:luna | demand | 6 | 100% | 100% | 100% | 0.001 |
| conversation_assess | jev | kind | 7 | 71% | 67% | 75% | 0.237 |
| conversation_assess | jev | needs_reply | 2 | 100% | 100% | 75% | 0.015 |
| conversation_assess | jev | production_down | 7 | 100% | 100% | 75% | 0.016 |
| conversation_assess | jev | data_loss | 6 | 100% | 100% | 100% | 0.006 |
| conversation_assess | jev | security | 7 | 100% | 100% | 100% | 0.003 |
| conversation_assess | jev | who | 1 | 100% | 100% | 25% | 0.000 |
| conversation_assess | jev | what | 3 | 67% | 100% | 75% | 0.163 |
| conversation_assess | jev | impact | 4 | 50% | 100% | 38% | 0.106 |
| conversation_assess | jev | time | 6 | 67% | 100% | 50% | 0.125 |
| conversation_assess | jev | demand | 6 | 100% | 100% | 88% | 0.004 |
| ticket_assess | claude:haiku | who | 0 | n/a | n/a | 13% | n/a |
| ticket_assess | claude:haiku | what | 5 | 100% | 100% | 88% | 0.024 |
| ticket_assess | claude:haiku | impact | 4 | 100% | 100% | 75% | 0.041 |
| ticket_assess | claude:haiku | time | 5 | 100% | 100% | 63% | 0.055 |
| ticket_assess | claude:haiku | demand | 5 | 100% | n/a | 13% | 0.160 |
| ticket_assess | claude:haiku | files | 2 | 100% | 100% | 38% | 0.056 |
| ticket_assess | claude:haiku | unknowns | 1 | 0% | n/a | 25% | 0.360 |
| ticket_assess | claude:haiku | cross_team | 4 | 100% | 100% | 75% | 0.095 |
| ticket_assess | claude:haiku | new_infra | 6 | 100% | 100% | 100% | 0.024 |
| ticket_assess | claude:haiku | dependents | 2 | 100% | 100% | 63% | 0.065 |
| ticket_assess | claude:haiku | traffic | 2 | 100% | 100% | 13% | 0.100 |
| ticket_assess | claude:haiku | data_sensitivity | 5 | 100% | 100% | 75% | 0.039 |
| ticket_assess | claude:haiku | reversibility | 5 | 80% | 100% | 75% | 0.095 |
| ticket_assess | claude:haiku | regression | 0 | n/a | n/a | 25% | n/a |
| ticket_assess | claude:haiku | compounding | 0 | n/a | n/a | 63% | n/a |
| ticket_assess | claude:haiku | production_down | 6 | 100% | 100% | 100% | 0.009 |
| ticket_assess | claude:haiku | data_loss | 7 | 100% | 100% | 100% | 0.009 |
| ticket_assess | claude:haiku | security | 7 | 100% | 100% | 100% | 0.004 |
| ticket_assess | claude:haiku | incident | 6 | 100% | 100% | 100% | 0.019 |
| ticket_assess | claude:haiku | compliance_deadline | 7 | 100% | 100% | 100% | 0.020 |
| ticket_assess | codex:luna | who | 0 | n/a | n/a | 50% | n/a |
| ticket_assess | codex:luna | what | 5 | 100% | 100% | 88% | 0.004 |
| ticket_assess | codex:luna | impact | 4 | 100% | 100% | 88% | 0.012 |
| ticket_assess | codex:luna | time | 5 | 80% | 80% | 100% | 0.135 |
| ticket_assess | codex:luna | demand | 5 | 100% | 100% | 88% | 0.012 |
| ticket_assess | codex:luna | files | 2 | 100% | 100% | 50% | 0.007 |
| ticket_assess | codex:luna | unknowns | 1 | 100% | 100% | 50% | 0.032 |
| ticket_assess | codex:luna | cross_team | 4 | 100% | 100% | 100% | 0.041 |
| ticket_assess | codex:luna | new_infra | 6 | 100% | 100% | 100% | 0.009 |
| ticket_assess | codex:luna | dependents | 2 | 100% | 100% | 50% | 0.017 |
| ticket_assess | codex:luna | traffic | 2 | 100% | 100% | 38% | 0.007 |
| ticket_assess | codex:luna | data_sensitivity | 5 | 80% | 100% | 75% | 0.073 |
| ticket_assess | codex:luna | reversibility | 5 | 100% | 100% | 88% | 0.012 |
| ticket_assess | codex:luna | regression | 0 | n/a | n/a | 50% | n/a |
| ticket_assess | codex:luna | compounding | 0 | n/a | n/a | 88% | n/a |
| ticket_assess | codex:luna | production_down | 6 | 100% | 100% | 100% | 0.002 |
| ticket_assess | codex:luna | data_loss | 7 | 100% | 100% | 100% | 0.004 |
| ticket_assess | codex:luna | security | 7 | 100% | 100% | 100% | 0.000 |
| ticket_assess | codex:luna | incident | 6 | 100% | 100% | 100% | 0.004 |
| ticket_assess | codex:luna | compliance_deadline | 7 | 100% | 100% | 100% | 0.001 |
| ticket_assess | jev | who | 0 | n/a | n/a | 13% | n/a |
| ticket_assess | jev | what | 5 | 100% | 100% | 63% | 0.052 |
| ticket_assess | jev | impact | 4 | 100% | 100% | 75% | 0.066 |
| ticket_assess | jev | time | 5 | 100% | 100% | 63% | 0.217 |
| ticket_assess | jev | demand | 5 | 100% | 100% | 75% | 0.019 |
| ticket_assess | jev | files | 2 | 100% | 100% | 38% | 0.072 |
| ticket_assess | jev | unknowns | 1 | 0% | n/a | 13% | 0.058 |
| ticket_assess | jev | cross_team | 4 | 100% | 100% | 88% | 0.005 |
| ticket_assess | jev | new_infra | 6 | 100% | 100% | 63% | 0.063 |
| ticket_assess | jev | dependents | 2 | 100% | 100% | 63% | 0.005 |
| ticket_assess | jev | traffic | 2 | 100% | 100% | 13% | 0.176 |
| ticket_assess | jev | data_sensitivity | 5 | 20% | 100% | 13% | 0.176 |
| ticket_assess | jev | reversibility | 5 | 80% | 100% | 25% | 0.076 |
| ticket_assess | jev | regression | 0 | n/a | n/a | 25% | n/a |
| ticket_assess | jev | compounding | 0 | n/a | n/a | 25% | n/a |
| ticket_assess | jev | production_down | 6 | 100% | 100% | 88% | 0.016 |
| ticket_assess | jev | data_loss | 7 | 100% | 100% | 100% | 0.022 |
| ticket_assess | jev | security | 7 | 100% | 100% | 100% | 0.011 |
| ticket_assess | jev | incident | 6 | 100% | 100% | 75% | 0.040 |
| ticket_assess | jev | compliance_deadline | 7 | 100% | 100% | 88% | 0.024 |
| triage_signals | claude:haiku | kind | 6 | 100% | 100% | 50% | 0.034 |
| triage_signals | claude:haiku | type_of_work | 5 | 100% | 100% | 38% | 0.125 |
| triage_signals | claude:haiku | ready | 5 | 80% | 100% | 88% | 0.087 |
| triage_signals | claude:haiku | size | 4 | 100% | 100% | 63% | 0.139 |
| triage_signals | claude:haiku | who | 6 | 33% | 67% | 38% | 0.252 |
| triage_signals | claude:haiku | what | 4 | 100% | 100% | 50% | 0.056 |
| triage_signals | claude:haiku | impact | 2 | 100% | 100% | 25% | 0.130 |
| triage_signals | claude:haiku | time | 4 | 100% | 100% | 38% | 0.056 |
| triage_signals | claude:haiku | demand | 4 | 100% | 100% | 75% | 0.078 |
| triage_signals | claude:haiku | risk_prelim | 7 | 71% | 100% | 38% | 0.166 |
| triage_signals | claude:haiku | archive | 7 | 100% | 100% | 75% | 0.028 |
| triage_signals | claude:haiku | archive_reason | 7 | 100% | 100% | 38% | 0.040 |
| triage_signals | codex:luna | kind | 6 | 100% | 100% | 75% | 0.002 |
| triage_signals | codex:luna | type_of_work | 5 | 100% | 100% | 50% | 0.051 |
| triage_signals | codex:luna | ready | 5 | 80% | 80% | 100% | 0.136 |
| triage_signals | codex:luna | size | 4 | 50% | 50% | 88% | 0.294 |
| triage_signals | codex:luna | who | 6 | 50% | 50% | 50% | 0.225 |
| triage_signals | codex:luna | what | 4 | 100% | 100% | 63% | 0.033 |
| triage_signals | codex:luna | impact | 2 | 100% | 100% | 63% | 0.061 |
| triage_signals | codex:luna | time | 4 | 75% | 75% | 63% | 0.170 |
| triage_signals | codex:luna | demand | 4 | 100% | 100% | 88% | 0.012 |
| triage_signals | codex:luna | risk_prelim | 7 | 86% | 100% | 38% | 0.046 |
| triage_signals | codex:luna | archive | 7 | 86% | 100% | 50% | 0.084 |
| triage_signals | codex:luna | archive_reason | 7 | 86% | 100% | 75% | 0.097 |
| triage_signals | jev | kind | 6 | 100% | 100% | 75% | 0.009 |
| triage_signals | jev | type_of_work | 5 | 80% | 100% | 50% | 0.145 |
| triage_signals | jev | ready | 5 | 80% | 100% | 63% | 0.105 |
| triage_signals | jev | size | 4 | 75% | 100% | 63% | 0.173 |
| triage_signals | jev | who | 6 | 33% | 50% | 25% | 0.194 |
| triage_signals | jev | what | 4 | 100% | 100% | 38% | 0.109 |
| triage_signals | jev | impact | 2 | 50% | 100% | 25% | 0.000 |
| triage_signals | jev | time | 4 | 75% | 100% | 50% | 0.176 |
| triage_signals | jev | demand | 4 | 100% | 100% | 100% | 0.001 |
| triage_signals | jev | risk_prelim | 7 | 57% | 100% | 38% | 0.074 |
| triage_signals | jev | archive | 7 | 100% | 100% | 38% | 0.052 |
| triage_signals | jev | archive_reason | 7 | 100% | 100% | 38% | 0.020 |

## The default per slot

| pack | default | why |
| --- | --- | --- |
| ci_failure_class | jev | jev: pinned by the owner on 2026-11-06, to try Jev on real cards first (measured: acted-on accuracy 1.00 at coverage 0.89, n 9) |
| comment_intent | jev | jev: acted-on accuracy 1.00 at coverage 0.75 (n 8), a tie within 2 points that goes to Jev, the cheapest |
| conversation_assess | claude:haiku | claude:haiku: per answer, acted-on accuracy 1.00 at coverage 0.76 (n 80), a tie within 2 points settled by cost |
| conversation_relation | jev | jev: pinned by the owner on 2026-11-06, to try Jev on real cards first (measured: acted-on accuracy 0.75 at coverage 0.63, n 8) |
| coverage_check | claude:haiku | claude:haiku: acted-on accuracy 0.86 at coverage 1.00 (n 8), a tie within 2 points settled by cost |
| e2e_failure_cause | jev | jev: acted-on accuracy 1.00 at coverage 0.75 (n 8), a tie within 2 points that goes to Jev, the cheapest |
| escalation_reason | jev | jev: pinned by the owner on 2026-11-06, to try Jev on real cards first (measured: acted-on accuracy 1.00 at coverage 0.75, n 8) |
| event_class | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 0.93 (n 14) |
| evidence_format | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 1.00 (n 8), it acted on every case and was right on every one; so did others, and it is the cheaper |
| evidence_valid | codex:luna | codex:luna: acted-on accuracy 1.00 at coverage 1.00 (n 8), it acted on every case and was right on every one |
| finding_classify | codex:luna | codex:luna: acted-on accuracy 0.86 at coverage 1.00 (n 8) |
| fix_scope | jev | jev: pinned by the owner on 2026-11-06, to try Jev on real cards first (measured: acted-on accuracy 1.00 at coverage 0.50, n 8) |
| frame_privacy | jev | jev: acted-on accuracy 1.00 at coverage 1.00 (n 8), it acted on every case and was right on every one; so did others, and Jev is the cheapest |
| intake_dedup | jev | jev: acted-on accuracy 1.00 at coverage 0.63 (n 8), a tie within 2 points that goes to Jev, the cheapest |
| plan_check | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 0.75 (n 8) |
| red_check | codex:luna | codex:luna: acted-on accuracy 1.00 at coverage 1.00 (n 8), it acted on every case and was right on every one |
| risk_score | codex:luna | codex:luna: acted-on accuracy 0.80 at coverage 0.75 (n 8) |
| scope_check | claude:haiku | claude:haiku: acted-on accuracy 1.00 at coverage 1.00 (n 8), it acted on every case and was right on every one |
| size_estimate | codex:luna | codex:luna: acted-on accuracy 0.50 at coverage 0.88 (n 8) |
| split_check | codex:luna | codex:luna: acted-on accuracy 0.86 at coverage 1.00 (n 8) |
| ticket_assess | claude:haiku | claude:haiku: per answer, acted-on accuracy 1.00 at coverage 0.65 (n 160), a tie within 2 points settled by cost |
| ticket_recommend | codex:luna | codex:luna: acted-on accuracy 1.00 at coverage 1.00 (n 8), it acted on every case and was right on every one |
| ticket_validity | codex:luna | codex:luna: acted-on accuracy 1.00 at coverage 0.88 (n 8) |
| triage_signals | codex:luna | codex:luna: per answer, acted-on accuracy 0.88 at coverage 0.67 (n 96) |
| worth_learning | jev | jev: pinned by the owner on 2026-11-06, to try Jev on real cards first (measured: acted-on accuracy 1.00 at coverage 0.75, n 8) |
