import { describe, expect, it } from "vitest";

import { DIGEST_LINES, DIGESTS_KEPT, digestOf, keepDigests, observedCalls } from "./observe-run.ts";

const result = (observation: unknown, ok = true, tool = "Bash") => ({ kind: "tool_result", payload: { id: "1", tool, ok, observation } });

describe("observedCalls", () => {
  it("lists the observed calls in the order their results came, with whether each was ok", () => {
    const calls = observedCalls([
      { kind: "tool_call", payload: { tool: "Bash", target: "pytest", allowed: true } },
      result({ intent: "test", form: "pytest", errorClass: "command_missing", failure: "abcdef0123" }, false),
      result({ intent: "test", form: "python -m pytest", testsRan: true }),
      result({ intent: "fetch", host: "a.example", errorClass: "name_resolution" }, false, "WebFetch"),
    ]);
    expect(calls).toEqual([
      { intent: "test", form: "pytest", errorClass: "command_missing", failure: "abcdef0123", ok: false },
      { intent: "test", form: "python -m pytest", testsRan: true, ok: true },
      { intent: "fetch", host: "a.example", errorClass: "name_resolution", ok: false },
    ]);
  });

  it("skips a result with no observation, an empty one, one that is not the shape and a garbled line", () => {
    const calls = observedCalls([null, 4, { kind: "tool_result" }, { kind: "tool_result", payload: { ok: true } }, result({}), result({ form: "ls", output: "text" }), result("x"), result({ form: "ls" }, true)]);
    expect(calls).toEqual([{ form: "ls", ok: true }]);
  });

  it("keeps a result whose ok is missing as not ok", () => {
    expect(observedCalls([{ kind: "tool_result", payload: { observation: { form: "ls" } } }])).toEqual([{ form: "ls", ok: false }]);
  });
});

describe("digestOf", () => {
  const meta = { at: "2026-11-10T00:00:00.000Z", runId: "r1", pack: "implementing", cardId: "c1", outcome: "pass" } as const;

  it("is one line per call with its intent, its form and how it ended", () => {
    const digest = digestOf(meta, [
      { intent: "test", form: "pytest", errorClass: "command_missing", ok: false },
      { intent: "test", form: "python -m pytest", ok: true },
      { form: "ls", ok: false },
    ]);
    expect(digest).toEqual({ ...meta, calls: 3, lines: ["test | pytest | command_missing", "test | python -m pytest | ok", "- | ls | failed"] });
  });

  it("leaves out a call that has neither intent, form nor error class", () => {
    expect(digestOf(meta, [{ edits: ["a.ts"], ok: true }, { host: "a.example", intent: "fetch", ok: true }]).lines).toEqual(["fetch | - | ok"]);
  });

  it("keeps at most 40 lines, the first ones", () => {
    const calls = Array.from({ length: 60 }, (_, i) => ({ intent: "build" as const, form: `make t${i}`, ok: true }));
    const digest = digestOf(meta, calls);
    expect(DIGEST_LINES).toBe(40);
    expect(digest.lines).toHaveLength(40);
    expect(digest.lines[0]).toBe("build | make t0 | ok");
    expect(digest.calls).toBe(60);
  });
});

describe("keepDigests", () => {
  it("keeps the last eight runs of a repository", () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ at: "t", runId: `r${i}`, pack: "p", cardId: "c", outcome: "pass", calls: 0, lines: [] }));
    expect(DIGESTS_KEPT).toBe(8);
    expect(keepDigests(rows).map((d) => d.runId)).toEqual(["r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10"]);
  });
});
