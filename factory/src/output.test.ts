import { PACKS, StageOutput } from "@hardness/contracts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EMPTY_RUN, finish, outcomeOf, scanArtifacts } from "./output.ts";
import type { LunaState } from "./tools/luna.ts";

const state = (over: Partial<LunaState> = {}): LunaState => ({ ledger: { schema: 1, slices: [] }, events: [], ...over });
const outDir = () => mkdtempSync(join(tmpdir(), "factory-out-"));
const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

describe("outcomeOf", () => {
  it("maps the answer's kind to the outcome the machine acts on", () => {
    expect(outcomeOf({ ...EMPTY_RUN, ok: true, structured: { kind: "brief" } })).toBe("pass");
    expect(outcomeOf({ ...EMPTY_RUN, ok: true, structured: { kind: "questions", questions: [{ question: "q", recommended: "a" }] } })).toBe("needs_input");
    expect(outcomeOf({ ...EMPTY_RUN, ok: true, structured: { kind: "done", questions: [{ question: "q", recommended: null }] } })).toBe("needs_input");
    expect(outcomeOf({ ...EMPTY_RUN, ok: true, structured: { kind: "test_change" } })).toBe("test_change");
    expect(outcomeOf({ ...EMPTY_RUN, ok: true, structured: { kind: "escalated" } })).toBe("escalated");
    expect(outcomeOf({ ...EMPTY_RUN, ok: false, structured: null })).toBe("fail");
  });
});

describe("finish", () => {
  it("writes a schema-3 result the machine's contract accepts, with the ledger and the session", () => {
    const dir = outDir();
    const ledger = { schema: 1 as const, slices: [{ id: 1, title: "s", status: "committed" as const, commit: "abc" }, { id: 2, title: "t", status: "red" as const, commit: null }] };
    const result = finish(dir, PACKS.implementing, { ...EMPTY_RUN, ok: true, structured: { kind: "done", summary: "did it", commit: "abc" }, turns: 7, costUsd: 0.5, durationMs: 1234.6, model: "sonnet", sessionId: "sess-1" }, state({ ledger, events: [{ kind: "step", payload: { label: "x" } }] }));
    expect(StageOutput.safeParse(result).error).toBeUndefined();
    expect(read(dir, "result.json")).toMatchObject({ schema: 3, ok: true, outcome: "pass", summary: "did it", commit: "abc", slices: { done: 1, total: 2 }, usage: { turns: 7, costUsd: 0.5, durationMs: 1235, model: "sonnet" }, ledger, sessionId: "sess-1" });
    const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events).toEqual([{ kind: "step", payload: { label: "x" } }, { kind: "note", payload: { phase: "stage_end", outcome: "pass", pack: "implementing" } }]);
  });

  it("carries questions, requested actions and findings out of the answer", () => {
    const dir = outDir();
    const questions = [{ question: "which db?", recommended: "sqlite" }];
    const findings = [{ path: "a.ts", line: 1, severity: "bug", title: "t", body: "b", confidence: 0.9 }];
    const requested = [{ kind: "publish", target: "escalation", payload: { x: 1 } }];
    const result = finish(dir, PACKS.triage, { ...EMPTY_RUN, ok: true, structured: { kind: "questions", summary: "s", questions, findings, requested } }, state());
    expect(result).toMatchObject({ outcome: "needs_input", needsInput: questions, findings, requested });
    expect(StageOutput.safeParse(result).error).toBeUndefined();
  });

  it("writes rules.md from rulesMarkdown and indexes it as a rules artifact", () => {
    const dir = outDir();
    const result = finish(dir, PACKS.reviewing_memory, { ...EMPTY_RUN, ok: true, structured: { summary: "s", rulesMarkdown: "- a rule" } }, state());
    expect(readFileSync(join(dir, "files", "rules.md"), "utf8")).toBe("- a rule\n");
    expect(result.artifacts).toEqual([expect.objectContaining({ kind: "rules", path: "files/rules.md", label: "rules.md" })]);
  });

  it("records a failed run with its error, and a rate limit with its reset", () => {
    const dir = outDir();
    const result = finish(dir, PACKS.triage, { ...EMPTY_RUN, ok: false, error: "boom", rateLimited: true, resetsAt: 1700000000 }, state());
    expect(result).toMatchObject({ ok: false, outcome: "fail", error: "boom", rateLimited: true, resetsAt: 1700000000, summary: "" });
    expect(StageOutput.safeParse(result).error).toBeUndefined();
  });
});

describe("scanArtifacts", () => {
  it("lists every file under files/ with its kind, path relative to /out, and sha256, sorted", () => {
    const dir = outDir();
    mkdirSync(join(dir, "files", "qa"), { recursive: true });
    mkdirSync(join(dir, "files", "tests"), { recursive: true });
    writeFileSync(join(dir, "files", "qa", "qa-manifest.json"), "{}");
    writeFileSync(join(dir, "files", "qa", "shot.png"), "png");
    writeFileSync(join(dir, "files", "qa", "run.webm"), "v");
    writeFileSync(join(dir, "files", "tests", "a.test.ts"), "t");
    writeFileSync(join(dir, "files", "notes.txt"), "n");
    expect(scanArtifacts(dir).map((a) => [a.kind, a.path])).toEqual([
      ["report", "files/notes.txt"],
      ["qa-manifest", "files/qa/qa-manifest.json"],
      ["video", "files/qa/run.webm"],
      ["screenshot", "files/qa/shot.png"],
      ["test", "files/tests/a.test.ts"],
    ]);
    expect(scanArtifacts(dir)[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(scanArtifacts(outDir())).toEqual([]);
  });
});
