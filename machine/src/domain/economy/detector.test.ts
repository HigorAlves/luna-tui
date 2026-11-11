import type { Detector, DetectorAtom } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { evaluate, filesOf } from "./detector.ts";
import type { ObservedCall } from "./observe-run.ts";

const clause = (...all: DetectorAtom[]) => ({ all });
const detector = (over: Partial<Detector> = {}): Detector => ({ scope: clause({ intent: "test" }), confirm: clause({ predicate: "tests_passed" }), contradict: clause({ errorClass: "command_missing" }), ...over });
const passed: ObservedCall = { intent: "test", form: "python -m pytest -q", testsRan: true, ok: true };
const failed: ObservedCall = { intent: "test", form: "pytest -q", testsRan: true, ok: false, failure: "a1b2c3d4e5" };
const missing: ObservedCall = { intent: "test", form: "pytest", errorClass: "command_missing", ok: false };

describe("evaluate", () => {
  it("is not exercised when the scope does not hold, and then neither confirms nor contradicts", () => {
    expect(evaluate(detector(), [{ intent: "build", form: "make", ok: true }])).toEqual({ exercised: false, confirms: false, contradicts: false });
    expect(evaluate(detector(), [])).toEqual({ exercised: false, confirms: false, contradicts: false });
  });

  it("confirms when the scope and the confirm clause hold", () => {
    expect(evaluate(detector(), [passed])).toEqual({ exercised: true, confirms: true, contradicts: false });
  });

  it("is exercised with no verdict when the scope holds and neither clause does", () => {
    expect(evaluate(detector(), [failed])).toEqual({ exercised: true, confirms: false, contradicts: false });
  });

  it("lets the contradiction win over the confirmation, as upstream orders scope, contradict, confirm", () => {
    expect(evaluate(detector(), [missing, passed])).toEqual({ exercised: true, confirms: false, contradicts: true });
  });

  it("holds a clause only when every atom does, each over the whole run", () => {
    const d = detector({ confirm: clause({ predicate: "tests_passed" }, { commandIncludes: "python -m pytest" }) });
    expect(evaluate(d, [passed]).confirms).toBe(true);
    expect(evaluate(d, [{ ...passed, form: "npx vitest run" }]).confirms).toBe(false);
    // The atoms need not be satisfied by one call.
    expect(evaluate(d, [{ intent: "build", form: "python -m pytest --co", ok: true }, { intent: "test", form: "x", testsRan: true, ok: true }]).confirms).toBe(true);
  });

  it("matches a command literal as text, never as a pattern", () => {
    const d = (commandIncludes: string) => detector({ confirm: clause({ commandIncludes }) });
    expect(evaluate(d("pytest -q"), [passed]).confirms).toBe(true);
    expect(evaluate(d("pytest.q"), [passed]).confirms).toBe(false);
    expect(evaluate(d("pytest"), [{ intent: "test", ok: true }]).confirms).toBe(false);
  });

  it("reads each predicate from the run's calls", () => {
    const holds = (predicate: DetectorAtom extends infer A ? (A extends { predicate: infer P } ? P : never) : never, calls: ObservedCall[]) => evaluate({ scope: clause({ predicate }), confirm: clause({ predicate }), contradict: clause({ errorClass: "unreachable" }) }, calls).exercised;
    expect(holds("ran_tests", [passed])).toBe(true);
    expect(holds("ran_tests", [{ intent: "test", form: "pytest", ok: false }])).toBe(true);
    expect(holds("ran_tests", [{ intent: "build", ok: true }])).toBe(false);
    expect(holds("tests_passed", [passed])).toBe(true);
    expect(holds("tests_passed", [failed])).toBe(false);
    expect(holds("tests_failed", [failed])).toBe(true);
    expect(holds("tests_failed", [passed])).toBe(false);
    expect(holds("ran_checks", [{ intent: "build", ok: true }])).toBe(true);
    expect(holds("ran_checks", [{ intent: "vcs", ok: true }])).toBe(false);
    expect(holds("ran_build", [{ intent: "build", ok: true }])).toBe(true);
    expect(holds("ran_build", [passed])).toBe(false);
    expect(holds("edited", [{ intent: "vcs", edits: ["src/a.ts"], ok: true }])).toBe(true);
    expect(holds("edited", [passed])).toBe(false);
    expect(holds("command_failed", [failed])).toBe(true);
    expect(holds("command_failed", [passed])).toBe(false);
    expect(holds("missing_command", [missing])).toBe(true);
    expect(holds("missing_command", [{ errorClass: "script_missing", ok: false }])).toBe(true);
    expect(holds("missing_dependency", [{ errorClass: "module_missing", ok: false }])).toBe(true);
    expect(holds("bad_usage", [{ errorClass: "usage_error", ok: false }])).toBe(true);
    expect(holds("bad_usage", [passed])).toBe(false);
  });
});

describe("filesOf", () => {
  it("lists the files a run edited, once each, in order", () => {
    expect(filesOf([{ edits: ["a.ts", "b.ts"], ok: true }, passed, { edits: ["b.ts", "c.ts"], ok: true }])).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
