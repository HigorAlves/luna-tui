import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ApprovalRow, TaskRow } from "../domain/task.ts";
import { escalationTruthOf, escalationTruthWriter } from "./ground-truth.ts";

const task = { id: "t1", title: "Login", description: "d", criteria: ["c"], branch: "task/t1" } as unknown as TaskRow;
const gate = (requested: Record<string, unknown>, response: Record<string, unknown> | null = null): ApprovalRow =>
  ({ id: "a1", taskId: "t1", kind: "escalated", requested, decision: "approved", reason: "I fixed the env", response, createdAt: new Date("2026-11-05T10:00:00Z"), decidedAt: new Date("2026-11-05T12:00:00Z") }) as ApprovalRow;
const commits = [{ sha: "a".repeat(40), files: [{ path: "src/a.ts", added: 3, removed: 1 }] }];

describe("escalationTruthOf", () => {
  it("keeps the decision beside what the person did: the decided reason, its confidence and source, the agent's word, the reason a person corrected it to, and the commits since with file names and counts", () => {
    const truth = escalationTruthOf(task, gate({ escalation: "flaky_tests", escalationDecision: { reason: "flaky_tests", confidence: 0.8, source: "decision", agentReason: "other", recordId: "rec-1" }, summary: "s", outputTail: "boom" }), commits, "env_broken");
    expect(truth).toMatchObject({
      schema: 1,
      task: { id: "t1", title: "Login" },
      decided: { reason: "flaky_tests", confidence: 0.8, source: "decision", agentReason: "other", recordId: "rec-1" },
      corrected: "env_broken",
      commits,
      resumedAt: "2026-11-05T12:00:00.000Z",
      escalatedAt: "2026-11-05T10:00:00.000Z",
    });
    expect(JSON.stringify(truth)).not.toContain("boom");
  });

  it("has no corrected reason when nobody corrected it", () => {
    expect(escalationTruthOf(task, gate({ escalationDecision: { reason: "other", confidence: null, source: "agent", agentReason: null } }), [], null).corrected).toBeNull();
  });
});

describe("escalationTruthWriter", () => {
  it("writes <stateDir>/ground-truth/escalation/<task>-<approval>.json and answers the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-"));
    const path = await escalationTruthWriter(dir)(task, gate({}), commits, null);
    expect(path).toBe(join(dir, "ground-truth", "escalation", "t1-a1.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ schema: 1, commits });
  });
});
