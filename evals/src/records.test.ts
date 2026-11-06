import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKS, type DecisionRecord } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { loadCases } from "./cases.ts";
import { decisionPack } from "./labels.ts";
import { folderMegabytes, labelState, priorityHints, recordsReport } from "./records.ts";

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  schema: 1, id: "11111111-aaaa", pack: "worth_learning", engine: "claude:haiku", model: "m", at: "2026-11-04T12:00:00.000Z", client: "ship", taskId: "t1",
  context: { ship: { kind: "retro", retro: { predicted: { size: "small", risk: "low", estLoc: 120 }, actual: { added: 640, removed: 90, retries: { verify: 2, e2e: 1, ci: 1, total: 5 }, escalations: 1, format: "captures", durationMs: 1 }, runs: 14 } } },
  answer: { worth: { value: true, p: 0.9 } }, verdicts: { worth: "proceed" }, overall: "proceed", traceId: null, origin: "machine", ...over,
});
const truth = (kind: "person" | "fact" | "outcome", source = "x") => ({ label: { worth: { value: true } }, source, at: "2026-11-05T00:00:00.000Z", kind });

describe("labelState", () => {
  it("puts a record with no truth in the queue, or local only when the scrub refuses it or it is private", () => {
    expect(labelState(record())).toBe("queue");
    expect(labelState(record({ private: true }))).toBe("local_only");
    expect(labelState(record({ context: { ship: { note: `see ${"gh"}p_${"a".repeat(30)}` } } }))).toBe("local_only");
  });
  it("is labelled for a person or fact truth on every answered question, to confirm for an outcome", () => {
    expect(labelState(record({ truth: truth("person") }))).toBe("labelled");
    expect(labelState(record({ truth: truth("fact") }))).toBe("labelled");
    expect(labelState(record({ truth: { label: { worth: { value: true } }, source: "x", at: "a" } }))).toBe("labelled");
    expect(labelState(record({ truth: truth("outcome") }))).toBe("to_confirm");
  });
  it("reads a question's kind from the history: an outcome then a person is labelled", () => {
    const t = { ...truth("person"), history: [{ label: { worth: { value: false } }, source: "pr_merged", kind: "outcome" as const, at: "a" }, { label: { worth: { value: true } }, source: "person", kind: "person" as const, at: "b" }] };
    expect(labelState(record({ truth: t }))).toBe("labelled");
  });
  it("is to confirm when a person labelled only some of the answered questions", () => {
    const two = record({ pack: "intake_dedup", answer: { a: { choice: "x", confidence: 1 }, b: { choice: "y", confidence: 1 } }, truth: { label: { a: { choice: "x" } }, source: "person", kind: "person", at: "a" } });
    expect(labelState(two)).toBe("to_confirm");
  });
  it("is not labelable when the repository kept no context", () => {
    expect(labelState(record({ context: {} }))).toBe("not_labelable");
    expect(labelState(record({ context: {}, truth: truth("person") }))).toBe("labelled");
  });
  it("puts a record of every decision pack's own case in the queue or local only, never not labelable", () => {
    const evals = fileURLToPath(new URL("..", import.meta.url));
    for (const pack of Object.keys(PACKS).filter((p) => decisionPack(p as never))) {
      for (const c of loadCases(evals, pack as never)) {
        const context = Object.fromEntries(Object.entries(c.input.context).filter(([k, v]) => k !== "projectContext" && v != null));
        expect(["queue", "local_only"], `${pack}/${c.id}`).toContain(labelState(record({ pack: pack as never, context, answer: {} })));
      }
    }
  });
});

describe("recordsReport", () => {
  it("prints one line per record with the pack, time, engine, what was done, the state and the truth's source, then a count line", () => {
    const rows = recordsReport([record({ acted: { overall: "flag", below: ["worth"], overrides: false }, truth: truth("person", "retro_approved") }), record({ id: "22222222-bbbb", pack: "event_class" }), record({ id: "3", truth: truth("outcome", "pr_merged") }), record({ id: "4", private: true })]);
    expect(rows.lines[0]).toContain("worth_learning");
    expect(rows.lines[0]).toContain("claude:haiku");
    expect(rows.lines[0]).toContain("machine");
    expect(rows.lines[0]).toContain("acted flag");
    expect(rows.lines[0]).toContain("labelled");
    expect(rows.lines[0]).toContain("person retro_approved");
    expect(rows.lines.at(-1)).toBe("4 decisions: 1 labelled, 1 to confirm, 1 waiting for a label, 1 local only");
  });
  it("shows no context, no text of a private record and no control characters, and redacts a token shape", () => {
    const secret = `${"gh"}p_${"b".repeat(30)}`;
    const rows = recordsReport([record({ private: true, taskId: `t\u001b[31m${secret}`, context: { ship: { text: "hello private world" } } })]);
    const all = rows.lines.join("\n");
    expect(all).not.toContain("hello private world");
    expect(all).not.toContain(secret);
    expect(all).not.toContain("\u001b");
  });
});

describe("priorityHints", () => {
  it("reads the two levels a priority file kept for each record", () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-"));
    mkdirSync(join(dir, "ground-truth", "priority"), { recursive: true });
    writeFileSync(join(dir, "ground-truth", "priority", "triage-1.json"), JSON.stringify({ schema: 1, machine: "triage", id: "1", recordId: "r1", machineLevel: "P2", personLevel: "P0" }));
    writeFileSync(join(dir, "ground-truth", "priority", "bad.json"), "{");
    expect(priorityHints(dir).get("r1")).toEqual({ machineLevel: "P2", personLevel: "P0" });
    expect(priorityHints(join(dir, "none")).size).toBe(0);
  });
});

describe("folderMegabytes", () => {
  it("adds the size of every file under a folder, and is zero for a folder that is not there", () => {
    const dir = mkdtempSync(join(tmpdir(), "size-"));
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "one"), Buffer.alloc(1024 * 1024));
    writeFileSync(join(dir, "a", "b", "two"), Buffer.alloc(512 * 1024));
    expect(folderMegabytes(dir)).toBeCloseTo(1.5, 2);
    expect(folderMegabytes(join(dir, "none"))).toBe(0);
  });
});
