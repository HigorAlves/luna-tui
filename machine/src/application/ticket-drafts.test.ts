import { describe, expect, it, vi } from "vitest";

import type { AssessmentRecord } from "./ticket-assess.ts";
import { assessmentDraft, declineDraft, editDraft, ignoreDraft, needsInfoDraft, notOursDraft, recommendWithDecision } from "./ticket-drafts.ts";

const secret = () => ["gh", "p_"].join("") + "a".repeat(36);
const record = { priority: "P1", size: "M", blastRadius: "low", score: 0.8, costOfDelay: 4, costOfDoing: 5, urgencyTotal: 22, knockOut: null, parked: false, at: "2026-11-05T12:00:00.000Z", subScores: {} } as unknown as AssessmentRecord;

describe("drafts that wait", () => {
  it("builds the assessment comment by script, in fixed words and numbers", () => {
    const d = assessmentDraft("PAY-12", record, "schedule");
    expect(d).toMatchObject({ kind: "assessment", status: "waiting", ticket: "PAY-12" });
    expect(d.text).toBe("Assessed: priority P1, size M, blast radius low, score 0.80 (cost of delay 4.0 over cost of doing 5.0). Recommended: schedule.");
  });

  it("builds the needs-info comment from exactly what is missing", () => {
    const d = needsInfoDraft("PAY-12", ["what outcome is wanted", "which project or repository this is for"]);
    expect(d.text).toBe("Before this can be worked on, it needs: what outcome is wanted; which project or repository this is for.");
  });

  it("says where a ticket that is not ours should go", () => {
    expect(notOursDraft("PAY-12", "the platform team").text).toContain("the platform team");
    expect(notOursDraft("PAY-12", null).text).toContain("another team");
  });

  it("has the decline reply written by the ticket_reply pack, flattened by postable()", async () => {
    const write = vi.fn(async () => ({ reply: "Thanks <b>for this</b> @ana, see #12.", confidence: 0.9 }));
    const d = await declineDraft({ write }, "PAY-12", { key: "PAY-12" } as never);
    expect(d).toMatchObject({ kind: "decline", status: "waiting" });
    expect(d!.text).not.toMatch(/[<>]/);
    expect(d!.text).not.toContain("@ana");
  });

  it("refuses a draft that carries a token, from the pack or from an edit", async () => {
    expect(await declineDraft({ write: async () => ({ reply: `use ${secret()}`, confidence: 1 }) }, "PAY-12", {} as never)).toBeNull();
    const d = needsInfoDraft("PAY-12", ["x"]);
    expect(editDraft(d, `try ${secret()}`, new Date())).toBeNull();
  });

  it("keeps what was done to a draft: the original beside an edit, and an ignored draft with its time", () => {
    const d = assessmentDraft("PAY-12", record, "schedule");
    const edited = editDraft(d, "Assessed by hand: later.", new Date("2026-11-05T13:00:00Z"))!;
    expect(edited).toMatchObject({ status: "edited", text: "Assessed by hand: later.", original: d.text });
    expect(edited.history).toEqual([{ at: "2026-11-05T13:00:00.000Z", did: "edited", from: d.text }]);
    const ignored = ignoreDraft(edited, new Date("2026-11-05T14:00:00Z"));
    expect(ignored.status).toBe("ignored");
    expect(ignored.history).toHaveLength(2);
  });
});

describe("the recommendation, with the decision for what the rule cannot tell", () => {
  const score = { knockOut: null, parked: false, priority: "P2", size: "M", blastRadius: "low", costOfDelay: 4, costOfDoing: 8, score: 0.5, urgencyTotal: 18, subScores: {} } as never;
  it("asks the typed decision only when the rule is silent", async () => {
    const decide = vi.fn(async () => ({ action: { choice: "schedule", confidence: 0.9 } }));
    expect((await recommendWithDecision({ decide }, score, {} as never))).toMatchObject({ action: "schedule" });
    expect(decide).toHaveBeenCalledTimes(1);
    const clear = { ...(score as object), priority: "P0", score: 2 } as never;
    await recommendWithDecision({ decide }, clear, {} as never);
    expect(decide).toHaveBeenCalledTimes(1);
  });
  it("hands a failed or unsure decision to a person", async () => {
    expect(await recommendWithDecision({ decide: async () => { throw new Error("x"); } }, score, {} as never)).toMatchObject({ action: "needs_decision" });
    expect(await recommendWithDecision({ decide: async () => ({ action: { choice: "decline", confidence: 0.3 } }) }, score, {} as never)).toMatchObject({ action: "needs_decision" });
  });
});
