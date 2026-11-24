import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ApprovalRow, TaskRow } from "../domain/task.ts";
import { evidenceFeedbackOf, evidenceFeedbackWriter, groundTruthOf, groundTruthWriter } from "./ground-truth.ts";

const task = { id: "task-1", title: "Login", description: "Sign in", criteria: ["c1", "c2"], record: { goal: "Sign in works" } } as unknown as TaskRow;
const slices = [{ title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }];
const cases = [{ title: "t", criterion: "c1", approach: "run it" }];
const approval = (requested: Record<string, unknown>, over: Partial<ApprovalRow> = {}): ApprovalRow =>
  ({ id: "ap-1", taskId: "task-1", kind: "awaiting_approval", requested, decision: "approved", reason: null, response: { approvers: ["ana", "bo"], approver: "bo" }, createdAt: new Date(0), decidedAt: new Date("2026-11-04T10:00:00Z"), ...over }) as ApprovalRow;

describe("groundTruthOf", () => {
  const requested = {
    brief: "edited brief", criteria: ["c1", "c2", "c3"], assumptions: ["a1"], slices, rollback: "revert", cases,
    risk: { level: "high", scores: { blast_radius: 2 } }, verdicts: { coverage: "proceed", plan: "flag", risk: "proceed" },
    revisions: [
      { at: "2026-11-04T09:00:00Z", before: { brief: "first brief", criteria: ["c1", "c2"] }, after: { brief: "second brief", criteria: ["c1", "c2", "c3"] } },
      { at: "2026-11-04T09:30:00Z", before: { brief: "second brief" }, after: { brief: "edited brief" } },
      { at: "2026-11-04T09:40:00Z", before: { cases: [{ title: "old", criterion: "c1", approach: "x" }] }, after: { cases } },
    ],
  };

  it("holds the task, the record, what was proposed, what was approved, the edits, the checks, the risk and who approved", () => {
    const truth = groundTruthOf(task, approval(requested));
    expect(truth).toMatchObject({
      schema: 1,
      task: { id: "task-1", title: "Login", description: "Sign in", criteria: ["c1", "c2"] },
      record: { goal: "Sign in works" },
      approved: { brief: "edited brief", criteria: ["c1", "c2", "c3"], assumptions: ["a1"], slices, rollback: "revert", cases },
      revisions: requested.revisions,
      verdicts: requested.verdicts,
      risk: requested.risk,
      approvers: ["ana", "bo"],
      decidedAt: "2026-11-04T10:00:00.000Z",
    });
    // The proposal is the approved plan with every revision undone, latest first.
    expect(truth.proposed).toMatchObject({ brief: "first brief", criteria: ["c1", "c2"], assumptions: ["a1"], slices, rollback: "revert", cases: [{ title: "old" }] });
  });

  it("keeps a person's override of the risk or the code map with its reason, and the machine's own level beside a lowered one", () => {
    const overrides = { risk: { level: "low", reason: "behind a flag", applied: false }, map: { reason: "ownership moved" } };
    const truth = groundTruthOf(task, approval({ brief: "b", risk: { level: "medium", machine: "medium", product: 6 }, map: { components: [], files: [], entry_points: [], owners: ["@bo"], confidence: 0.8 }, overrides }));
    expect(truth.overrides).toEqual(overrides);
    expect(truth.risk).toEqual({ level: "medium", machine: "medium", product: 6 });
    expect(truth.approved).toMatchObject({ risk: { level: "medium" }, map: { owners: ["@bo"] } });
    expect(groundTruthOf(task, approval({ brief: "b" })).overrides).toBeNull();
  });

  it("proposes what it approves when nothing was edited, and names one approver or none", () => {
    const plain = groundTruthOf(task, approval({ brief: "b", criteria: ["c1"], assumptions: [], slices }, { response: { approver: "ana" } }));
    expect(plain.proposed).toEqual(plain.approved);
    expect(plain).toMatchObject({ revisions: [], approvers: ["ana"], verdicts: null, risk: null });
    expect(groundTruthOf(task, approval({ brief: "b" }, { response: null })).approvers).toEqual([]);
  });
});

describe("groundTruthWriter", () => {
  it("writes <stateDir>/ground-truth/plan/<taskId>-<approvalId>.json and answers the path", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gt-"));
    const path = await groundTruthWriter(stateDir)(task, approval({ brief: "b", criteria: ["c1"] }));
    expect(path).toBe(join(stateDir, "ground-truth", "plan", "task-1-ap-1.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ schema: 1, task: { id: "task-1" }, approved: { brief: "b" } });
    expect(existsSync(path)).toBe(true);
  });
});

describe("the Evidence feedback file", () => {
  const pack = { summary: "s", format: "video", scenarios: [], findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: "abc1234def5678", media: [], at: "t", revision: 2, video: { file: "w.mp4", durationS: 60, verdict: "ship", scores: { hook: 9 }, defects: [], rounds: 1, confidence: 0.8 } } as never;
  const at = new Date("2026-11-06T10:00:00.000Z");

  it("holds the task, the pack's format, commit and revision, the film's verdict and scores, the answer and the time", () => {
    expect(evidenceFeedbackOf(task, pack, { useful: false, note: "too long" }, at)).toEqual({
      schema: 1,
      taskId: "task-1",
      format: "video",
      commit: "abc1234def5678",
      revision: 2,
      video: { verdict: "ship", scores: { hook: 9 } },
      useful: false,
      note: "too long",
      at: "2026-11-06T10:00:00.000Z",
    });
    expect(evidenceFeedbackOf(task, { ...(pack as object), video: undefined, revision: undefined } as never, { useful: true }, at)).toMatchObject({ video: null, revision: null, note: null, useful: true });
  });

  it("flattens the note through safe(): no markup, no mention, no reference, no newline", () => {
    const out = evidenceFeedbackOf(task, pack, { useful: true, note: "<b>x</b>\n@bob closes #12 [a](http://x)" }, at);
    expect(out.note).not.toMatch(/[<>\n]/);
    expect(out.note).not.toContain("@bob");
    expect(out.note).not.toContain("#12");
  });

  it("is written to <stateDir>/ground-truth/evidence/<task>-<sha7>.json, and the last answer for a commit wins", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gt-"));
    const write = evidenceFeedbackWriter(stateDir);
    const path = await write(task, pack, { useful: false }, at);
    expect(path).toBe(join(stateDir, "ground-truth", "evidence", "task-1-abc1234.json"));
    await write(task, pack, { useful: true, note: "fine" }, at);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ useful: true, note: "fine" });
  });
});

