#!/usr/bin/env bash
# The baseline run, as `pnpm eval baseline-plan` prints it. It calls models: run it only after the image is rebuilt from this branch and the suite is green.
# Jev is metered and needs AI_GATEWAY_API_KEY or TYPESAFE_API_KEY. triage_signals is written to the defaults only after the owner has seen its per-answer numbers.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm eval preflight
pnpm eval --pack triage_signals --engine claude:haiku --save-baseline
pnpm eval --pack triage_signals --engine codex:luna --save-baseline
pnpm eval --pack triage_signals --engine jev --save-baseline
pnpm eval --pack risk_score --engine claude:haiku --save-baseline
pnpm eval --pack risk_score --engine codex:luna --save-baseline
pnpm eval --pack risk_score --engine jev --save-baseline
pnpm eval --pack coverage_check --engine claude:haiku --save-baseline
pnpm eval --pack coverage_check --engine codex:luna --save-baseline
pnpm eval --pack coverage_check --engine jev --save-baseline
pnpm eval --pack plan_check --engine claude:haiku --save-baseline
pnpm eval --pack plan_check --engine codex:luna --save-baseline
pnpm eval --pack plan_check --engine jev --save-baseline
pnpm eval --pack red_check --engine claude:haiku --save-baseline
pnpm eval --pack red_check --engine codex:luna --save-baseline
pnpm eval --pack red_check --engine jev --save-baseline
pnpm eval --pack scope_check --engine claude:haiku --save-baseline
pnpm eval --pack scope_check --engine codex:luna --save-baseline
pnpm eval --pack scope_check --engine jev --save-baseline
pnpm eval --pack escalation_reason --engine claude:haiku --save-baseline
pnpm eval --pack escalation_reason --engine codex:luna --save-baseline
pnpm eval --pack escalation_reason --engine jev --save-baseline
pnpm eval --pack finding_classify --engine claude:haiku --save-baseline
pnpm eval --pack finding_classify --engine codex:luna --save-baseline
pnpm eval --pack finding_classify --engine jev --save-baseline
pnpm eval --pack e2e_failure_cause --engine claude:haiku --save-baseline
pnpm eval --pack e2e_failure_cause --engine codex:luna --save-baseline
pnpm eval --pack e2e_failure_cause --engine jev --save-baseline
pnpm eval --pack ci_failure_class --engine claude:haiku --save-baseline
pnpm eval --pack ci_failure_class --engine codex:luna --save-baseline
pnpm eval --pack ci_failure_class --engine jev --save-baseline
pnpm eval --pack frame_privacy --engine claude:haiku --save-baseline
pnpm eval --pack frame_privacy --engine codex:luna --save-baseline
pnpm eval --pack frame_privacy --engine jev --save-baseline
pnpm eval --pack evidence_format --engine claude:haiku --save-baseline
pnpm eval --pack evidence_format --engine codex:luna --save-baseline
pnpm eval --pack evidence_format --engine jev --save-baseline
pnpm eval --pack size_estimate --engine claude:haiku --save-baseline
pnpm eval --pack size_estimate --engine codex:luna --save-baseline
pnpm eval --pack size_estimate --engine jev --save-baseline
pnpm eval --pack split_check --engine claude:haiku --save-baseline
pnpm eval --pack split_check --engine codex:luna --save-baseline
pnpm eval --pack split_check --engine jev --save-baseline
pnpm eval --pack event_class --engine claude:haiku --save-baseline
pnpm eval --pack event_class --engine codex:luna --save-baseline
pnpm eval --pack event_class --engine jev --save-baseline
pnpm eval --pack comment_intent --engine claude:haiku --save-baseline
pnpm eval --pack comment_intent --engine codex:luna --save-baseline
pnpm eval --pack comment_intent --engine jev --save-baseline
pnpm eval --pack fix_scope --engine claude:haiku --save-baseline
pnpm eval --pack fix_scope --engine codex:luna --save-baseline
pnpm eval --pack fix_scope --engine jev --save-baseline
pnpm eval --pack evidence_valid --engine claude:haiku --save-baseline
pnpm eval --pack evidence_valid --engine codex:luna --save-baseline
pnpm eval --pack evidence_valid --engine jev --save-baseline
pnpm eval --pack worth_learning --engine claude:haiku --save-baseline
pnpm eval --pack worth_learning --engine codex:luna --save-baseline
pnpm eval --pack worth_learning --engine jev --save-baseline
pnpm eval --pack intake_dedup --engine claude:haiku --save-baseline
pnpm eval --pack intake_dedup --engine codex:luna --save-baseline
pnpm eval --pack intake_dedup --engine jev --save-baseline
pnpm eval --pack ticket_validity --engine claude:haiku --save-baseline
pnpm eval --pack ticket_validity --engine codex:luna --save-baseline
pnpm eval --pack ticket_validity --engine jev --save-baseline
pnpm eval --pack ticket_assess --engine claude:haiku --save-baseline
pnpm eval --pack ticket_assess --engine codex:luna --save-baseline
pnpm eval --pack ticket_assess --engine jev --save-baseline
pnpm eval --pack conversation_assess --engine claude:haiku --save-baseline
pnpm eval --pack conversation_assess --engine codex:luna --save-baseline
pnpm eval --pack conversation_assess --engine jev --save-baseline
pnpm eval --pack conversation_relation --engine claude:haiku --save-baseline
pnpm eval --pack conversation_relation --engine codex:luna --save-baseline
pnpm eval --pack conversation_relation --engine jev --save-baseline
pnpm eval --pack ticket_recommend --engine claude:haiku --save-baseline
pnpm eval --pack ticket_recommend --engine codex:luna --save-baseline
pnpm eval --pack ticket_recommend --engine jev --save-baseline
pnpm eval scorecard
pnpm eval defaults   # prints every proposal and writes nothing
# pnpm eval defaults --write --except triage_signals   # then take the packs that now have an entry out of UNMEASURED
# The line above writes the defaults: run it by hand after reading the dry run.
