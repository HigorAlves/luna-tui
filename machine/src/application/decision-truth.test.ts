import { PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { DecisionTruth, commentIntentTruth, e2eCauseTruth, eventClassTruth, evidenceFormatTruth, findingTruth, planTruth, recordIdOf, redCheckTruth, tagged, triageConfirmTruth, triageEditTruth, triageOutcomeTruth, worthLearningTruth, ciClassTruth, e2eCompareTruth, escalationResumedTruth, fixScopeTruth, frameCredentialTruth, scopeFactsTruth, sizeTruth } from "./decision-truth.ts";

describe("what each fact says about the answer", () => {
  it("e2e_failure_cause: a re-run that passed makes env_flake right; one that failed the same way rules it out", () => {
    expect(e2eCauseTruth(true)).toEqual({ cause: { choice: "env_flake" } });
    expect(e2eCauseTruth(false)).toEqual({ cause: { choice: ["product_bug", "test_bug"] } });
  });

  it("evidence_format: the format the pack shipped with", () => {
    // The decision's own labels, from the stored format.
    expect(evidenceFormatTruth("captures")).toEqual({ format: { choice: "screenshots_or_terminal" } });
    expect(evidenceFormatTruth("video")).toEqual({ format: { choice: "video" } });
    expect(evidenceFormatTruth("text")).toEqual({ format: { choice: "text_only" } });
  });

  it("red_check: a slice that went green with the test unchanged was a right-reason red; a rewritten test was not", () => {
    expect(redCheckTruth(false)).toEqual({ right_reason: { value: true } });
    expect(redCheckTruth(true)).toEqual({ right_reason: { value: false } });
  });

  it("worth_learning: approved rules mean yes, a closed retro means no", () => {
    expect(worthLearningTruth(true)).toEqual({ worth: { value: true } });
    expect(worthLearningTruth(false)).toEqual({ worth: { value: false } });
  });

  it("event_class: no further activity confirms noise, further activity makes it a comment", () => {
    expect(eventClassTruth(false)).toEqual({ event: { choice: "noise" } });
    expect(eventClassTruth(true)).toEqual({ event: { choice: "review_comment" } });
  });

  it("comment_intent: a question the reviewer resolved, a change request fixed and resolved", () => {
    expect(commentIntentTruth("question")).toEqual({ intent: { choice: "question" } });
    expect(commentIntentTruth("change_request")).toEqual({ intent: { choice: "change_request" } });
  });

  it("finding_classify: a finding a person shipped with is not a blocker", () => {
    expect(findingTruth()).toEqual({ severity: { choice: ["should_fix", "nit"] } });
  });

  it("plan packs: an approval with no edits confirms the answer (scores rounded), an edit or a send-back flips each yes/no and leaves a score unlabelled", () => {
    const coverage = { pins: { value: true, p: 0.9 }, redundancy: { score: 0.8, confidence: 0.7 }, untestable: { value: false, p: 0.1 } };
    expect(planTruth(PACKS.coverage_check, coverage, "confirmed")).toEqual({ pins: { value: true }, redundancy: { score: 1 }, untestable: { value: false } });
    expect(planTruth(PACKS.coverage_check, coverage, "contradicted")).toEqual({ pins: { value: false }, untestable: { value: true } });
    const risk = { blast_radius: { score: 1.2, confidence: 0.8 }, reversibility: { score: 0, confidence: 0.8 }, data_sensitivity: { score: 2, confidence: 0.8 } };
    expect(planTruth(PACKS.risk_score, risk, "confirmed")).toEqual({ blast_radius: { score: 1 }, reversibility: { score: 0 }, data_sensitivity: { score: 2 } });
    expect(planTruth(PACKS.risk_score, risk, "contradicted")).toBeNull();
  });
});

describe("tagging an answer with its record", () => {
  it("survives a spread, and stays out of the answer's JSON", () => {
    const answer = tagged({ answer: { worth: { value: true, p: 0.9 } }, recordId: "r1" });
    expect(recordIdOf({ ...answer })).toBe("r1");
    expect(JSON.stringify(answer)).toBe('{"worth":{"value":true,"p":0.9}}');
    expect(recordIdOf({ worth: 1 })).toBeUndefined();
    expect(recordIdOf(tagged({ answer: { a: 1 } }))).toBeUndefined();
  });
});

describe("what the wave 18 facts say about the answer", () => {
  it("ci_failure_class: a re-run that passed is a flake, one still red rules the flake out, a fix says real, a rebase says drift", () => {
    expect(ciClassTruth("rerun_passed")).toEqual({ label: { class: { choice: "flake" } }, source: "ci_rerun", kind: "fact" });
    expect(ciClassTruth("rerun_red")).toEqual({ label: { class: { choice: ["real", "infra", "drift"] } }, source: "ci_rerun", kind: "fact" });
    expect(ciClassTruth("fixed")).toEqual({ label: { class: { choice: "real" } }, source: "ci_fixed", kind: "fact" });
    expect(ciClassTruth("rebased")).toEqual({ label: { class: { choice: "drift" } }, source: "ci_rebased", kind: "fact" });
  });

  it("scope_check: only the questions the diff answered with a no are labelled, from the script", () => {
    expect(scopeFactsTruth({})).toBeNull();
    expect(scopeFactsTruth({ no_todo: false, no_test_removed: false })).toEqual({ label: { no_todo: { value: false }, no_test_removed: { value: false } }, source: "scope_facts", kind: "fact" });
  });

  it("frame_privacy: a redactor match is a credential; no match labels nothing", () => {
    expect(frameCredentialTruth(true)).toEqual({ label: { exposure: { choice: "credential" } }, source: "frame_redactor", kind: "fact" });
    expect(frameCredentialTruth(false)).toBeNull();
  });

  it("fix_scope: an in-place fix that failed or was sent up is one of the wider scopes; a merged round with no reopened thread confirms the answer", () => {
    expect(fixScopeTruth("in_place", { checksFailed: true })).toEqual({ label: { scope: { choice: ["re_verify_partial", "re_plan"] } }, source: "fix_round", kind: "fact" });
    expect(fixScopeTruth("in_place", { sentTo: "verify" })).toMatchObject({ label: { scope: { choice: ["re_verify_partial", "re_plan"] } }, kind: "fact" });
    expect(fixScopeTruth("in_place", { merged: true, reopened: false })).toEqual({ label: { scope: { choice: "in_place" } }, source: "fix_round", kind: "outcome" });
    expect(fixScopeTruth("re_plan", { merged: true, reopened: false })).toEqual({ label: { scope: { choice: "re_plan" } }, source: "fix_round", kind: "outcome" });
    expect(fixScopeTruth("re_plan", { checksFailed: true })).toBeNull();
    expect(fixScopeTruth("in_place", { merged: true, reopened: true })).toBeNull();
    expect(fixScopeTruth("in_place", {})).toBeNull();
  });

  it("evidence_valid: any scenario result that changed says refresh_media; none changed leaves valid or refresh_text; nothing to compare labels nothing", () => {
    expect(e2eCompareTruth({ a: "pass", b: "pass" }, { a: "pass", b: "fail" })).toEqual({ label: { validity: { choice: "refresh_media" } }, source: "e2e_compare", kind: "fact" });
    expect(e2eCompareTruth({ a: "pass" }, { a: "pass" })).toEqual({ label: { validity: { choice: ["valid", "refresh_text"] } }, source: "e2e_compare", kind: "fact" });
    expect(e2eCompareTruth({}, { a: "pass" })).toBeNull();
    expect(e2eCompareTruth({ a: "pass" }, {})).toBeNull();
  });

  it("escalation_reason: a card resumed with no correction confirms the reason as an outcome", () => {
    expect(escalationResumedTruth("plan_wrong")).toEqual({ label: { reason: { choice: "plan_wrong" } }, source: "escalation_resumed", kind: "outcome" });
  });

  it("size_estimate: the counted lines and files fall on the nearest level of each rubric, reviewable gets none", () => {
    expect(sizeTruth({ lines: 40, files: 1 })).toEqual({ label: { est_loc: { score: 0 }, est_files: { score: 0 } }, source: "merged_size", kind: "fact" });
    expect(sizeTruth({ lines: 640, files: 6 })).toEqual({ label: { est_loc: { score: 2 }, est_files: { score: 1 } }, source: "merged_size", kind: "fact" });
    expect(sizeTruth({ lines: 20_000, files: 400 })).toEqual({ label: { est_loc: { score: 6 }, est_files: { score: 4 } }, source: "merged_size", kind: "fact" });
    expect(Object.keys(sizeTruth({ lines: 1, files: 1 }).label)).not.toContain("reviewable");
    expect(sizeTruth({ lines: 640 }).label).toEqual({ est_loc: { score: 2 } });
  });
});

describe("DecisionTruth when a repository keeps no truth", () => {
  const fact = { pack: "risk_score" as const, recordId: "r1", label: { blast_radius: { score: 1 } }, kind: "person" as const, source: "plan_approved", taskId: "task-1" };
  it("is a no-op for a card whose repository says truth: false, and never throws when the question fails", async () => {
    const written: unknown[] = [];
    const told: unknown[] = [];
    const sink = { setTruth: async (...args: unknown[]) => (written.push(args), true) };
    const off = new DecisionTruth(sink, { allowed: async () => false, told: async (e) => void told.push(e) });
    expect(await off.learned(fact)).toBe(false);
    expect([written, told]).toEqual([[], []]);
    const on = new DecisionTruth(sink, { allowed: async (f) => f.taskId === "task-1" });
    expect(await on.learned(fact)).toBe(true);
    const broken = new DecisionTruth(sink, { allowed: async () => Promise.reject(new Error("no policy")) });
    expect(await broken.learned(fact)).toBe(true);
    expect(written).toHaveLength(2);
  });
});

describe("DecisionTruth", () => {
  it("writes the label with its source and the clock's time, then reports it", async () => {
    const written: unknown[] = [];
    const told: unknown[] = [];
    const truth = new DecisionTruth({ setTruth: async (pack, id, t) => (written.push([pack, id, t]), true) }, { now: () => new Date("2026-11-05T09:00:00Z"), told: async (e) => void told.push(e) });
    expect(await truth.learned({ pack: "worth_learning", recordId: "r1", label: { worth: { value: true } }, source: "retro_approved", kind: "person", taskId: "t1" })).toBe(true);
    expect(written).toEqual([["worth_learning", "r1", { label: { worth: { value: true } }, source: "retro_approved", kind: "person", at: "2026-11-05T09:00:00.000Z" }]]);
    expect(told).toEqual([{ taskId: "t1", pack: "worth_learning", recordId: "r1", source: "retro_approved" }]);
  });

  it("says nothing when no record is there, and never throws", async () => {
    const told: unknown[] = [];
    const none = new DecisionTruth({ setTruth: async () => false }, { told: async (e) => void told.push(e) });
    expect(await none.learned({ pack: "worth_learning", recordId: "gone", label: {}, source: "x", kind: "fact" })).toBe(false);
    const broken = new DecisionTruth({ setTruth: async () => Promise.reject(new Error("disk")) }, { told: async (e) => void told.push(e) });
    expect(await broken.learned({ pack: "worth_learning", recordId: "r", label: {}, source: "x", kind: "fact" })).toBe(false);
    expect(told).toEqual([]);
  });
});

describe("the triage_signals truths", () => {
  const classification = { signals: { kind: { answer: "bug", confidence: 0.9 }, size: { answer: "S", confidence: 0.5 }, who: { answer: 1.4, confidence: 0.9 }, time: { answer: 0, confidence: 0.9 }, risk_prelim: { answer: "low", confidence: 0.9 }, archive: { answer: false, confidence: 0.95 } } };
  const verdicts = { kind: { verdict: "proceed" }, size: { verdict: "flag" }, urgency: { verdict: "proceed" }, risk: { verdict: "proceed" }, archive: { verdict: "proceed" } } as const;

  it("labels what a person corrected, by the question it corrects, and nothing for a priority edit", () => {
    expect(triageEditTruth({ editedFields: ["kind", "size", "riskPrelim", "typeOfWork"], kind: "feature", size: "M", riskPrelim: "high", typeOfWork: "infra" })).toEqual({
      kind: { choice: "feature" }, size: { choice: "M" }, risk_prelim: { choice: "high" }, type_of_work: { choice: "infra" },
    });
    expect(triageEditTruth({ editedFields: ["priority"], kind: "bug" })).toEqual({});
    expect(triageEditTruth({ kind: "bug" })).toEqual({});
  });

  it("confirms the signals the machine acted on: each as it answered, scores rounded, the flagged ones left out", () => {
    expect(triageConfirmTruth(classification, verdicts)).toEqual({
      kind: { choice: "bug" }, who: { score: 1 }, time: { score: 0 }, risk_prelim: { choice: "low" }, archive: { value: false },
    });
  });

  it("leaves a corrected question to the correction", () => {
    expect(triageConfirmTruth(classification, verdicts, new Set(["kind"]))).not.toHaveProperty("kind");
  });

  it("reads a reply or an archive gate: approved confirms it, sent back contradicts it", () => {
    expect(triageOutcomeTruth("conversation", "approved")).toEqual({ kind: { choice: "question" } });
    expect(triageOutcomeTruth("conversation", "sent_back")).toEqual({ kind: { choice: ["bug", "feature", "task", "chore", "incident"] } });
    expect(triageOutcomeTruth("archive", "approved")).toEqual({ archive: { value: true } });
    expect(triageOutcomeTruth("archive", "sent_back")).toEqual({ archive: { value: false } });
  });
});

describe("a fact that names a repository rather than a card", () => {
  it("is asked of the same switch, so a repository that keeps no truth learns nothing from its tickets or conversations", async () => {
    const calls: unknown[] = [];
    const sink = { setTruth: async (...a: unknown[]) => (calls.push(a), true) } as never;
    const asked: Array<string | null | undefined> = [];
    const log = new DecisionTruth(sink, { allowed: async (f) => (asked.push(f.repoPath), f.repoPath !== "/r/off") });
    expect(await log.learned({ pack: "ticket_recommend", recordId: "r1", label: { action: { choice: "decline" } }, kind: "person", source: "ticket_override", repoPath: "/r/off" })).toBe(false);
    expect(asked).toEqual(["/r/off"]);
    expect(calls).toEqual([]);
  });
});
