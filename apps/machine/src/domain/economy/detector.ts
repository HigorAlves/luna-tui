// How a proposed fact is checked on a run without a model (te-spec 2.4.5, with the Python regexes replaced by structured data). A detector
// has three clauses over a run's observed calls: the scope says the fact is about this run, the confirm clause that it held, the contradict
// clause that it did not. The order is upstream's: no scope, no verdict; then the contradiction; then the confirmation. Pure.
//
// Upstream's built-ins that read a digest's `check_commands`, `failed_commands` and the three boolean flags are kept as predicates over the
// observed calls (`ran_checks`, `command_failed`, `missing_command`, `missing_dependency`, `bad_usage`, `edited`, `ran_tests`). Dropped:
// `repro_written` (the experiments' digest; the observer sees no file contents to tell a repro script) and the model-authored extractors,
// regex names and `fired` (all regexes over raw command and output text, which the machine never keeps).
import type { Detector, DetectorAtom, DetectorClause } from "@hardness/contracts";

import type { ObservedCall } from "./observe-run.ts";

type Predicate = Extract<DetectorAtom, { predicate: string }>["predicate"];

const PREDICATE: Record<Predicate, (calls: readonly ObservedCall[]) => boolean> = {
  ran_tests: (calls) => calls.some((c) => c.intent === "test" || c.testsRan !== undefined),
  tests_passed: (calls) => calls.some((c) => c.testsRan === true && c.ok),
  tests_failed: (calls) => calls.some((c) => c.testsRan === true && !c.ok),
  ran_checks: (calls) => calls.some((c) => c.intent === "test" || c.intent === "build"),
  ran_build: (calls) => calls.some((c) => c.intent === "build"),
  edited: (calls) => calls.some((c) => (c.edits?.length ?? 0) > 0),
  command_failed: (calls) => calls.some((c) => !c.ok && (c.intent !== undefined || c.form !== undefined)),
  missing_command: (calls) => calls.some((c) => c.errorClass === "command_missing" || c.errorClass === "script_missing"),
  missing_dependency: (calls) => calls.some((c) => c.errorClass === "module_missing"),
  bad_usage: (calls) => calls.some((c) => c.errorClass === "usage_error"),
};

function holds(atom: DetectorAtom, calls: readonly ObservedCall[]): boolean {
  if ("predicate" in atom) return PREDICATE[atom.predicate](calls);
  if ("commandIncludes" in atom) return calls.some((c) => c.form?.includes(atom.commandIncludes) === true);
  if ("errorClass" in atom) return calls.some((c) => c.errorClass === atom.errorClass);
  return calls.some((c) => c.intent === atom.intent);
}

const clauseHolds = (clause: DetectorClause, calls: readonly ObservedCall[]): boolean => clause.all.every((atom) => holds(atom, calls));

export interface Verdict {
  exercised: boolean;
  confirms: boolean;
  contradicts: boolean;
}

/** What a detector says of one run. A contradiction wins over a confirmation. */
export function evaluate(detector: Detector, calls: readonly ObservedCall[]): Verdict {
  if (!clauseHolds(detector.scope, calls)) return { exercised: false, confirms: false, contradicts: false };
  if (clauseHolds(detector.contradict, calls)) return { exercised: true, confirms: false, contradicts: true };
  return { exercised: true, confirms: clauseHolds(detector.confirm, calls), contradicts: false };
}

/** The files a run edited, once each, in the order the calls came. */
export const filesOf = (calls: readonly ObservedCall[]): string[] => [...new Set(calls.flatMap((c) => c.edits ?? []))];
