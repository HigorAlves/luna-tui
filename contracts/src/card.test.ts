import { describe, expect, it } from "vitest";

import { CreateCardInput, NewTaskInput } from "./api.ts";
import { CardHints, HINT_WEIGHT } from "./card.ts";
import { TriageRecord } from "./stage.ts";

const v1Record = {
  source: "jira",
  kind: "bug",
  goal: "Fix the coupon cap",
  size: "S",
  urgency: "medium",
  risk: "low",
  signals: { kind: { answer: "bug", confidence: 0.9 } },
  qa: [{ question: "which cart?", answer: "the guest cart" }],
  decision: "plan",
  reason: "small and clear",
  at: "2026-11-01T00:00:00.000Z",
  model: "claude:haiku",
};

describe("triage record v2", () => {
  it("parses a record written before v2.2 unchanged", () => {
    expect(TriageRecord.parse(v1Record)).toEqual(v1Record);
  });

  it("accepts the v2 fields", () => {
    const v2 = {
      ...v1Record,
      summary: "s",
      typeOfWork: "backend",
      goalRef: "none",
      urgencyDetail: { priority: "P2", subScores: { who: 2, what: 2, impact: 1, time: 1, demand: 1 } },
      riskPrelim: "low",
      hintsUsed: ["kind"],
      decisionBy: "machine",
      version: 2,
    };
    expect(TriageRecord.parse(v2)).toEqual(v2);
    expect(TriageRecord.safeParse({ ...v1Record, typeOfWork: "wizardry" }).success).toBe(false);
    expect(TriageRecord.safeParse({ ...v1Record, urgencyDetail: { priority: "P9", subScores: { who: 1, what: 1, impact: 1, time: 1, demand: 1 } } }).success).toBe(false);
  });
});

describe("the create_card entry contract", () => {
  it("still takes a task as filed today", () => {
    const today = { title: "Fix it", description: "d", criteria: ["c"] };
    expect(NewTaskInput.parse(today)).toEqual(today);
    expect(CreateCardInput.parse(today)).toEqual(today);
  });

  it("takes sources, a reporter, hints, an origin machine and attachments", () => {
    const card = {
      title: "Fix it",
      sources: [{ type: "slack", permalink: "https://x.slack.com/archives/C1/p1", threadId: "1.2" }, { type: "ticket", ticketId: "ABC-1" }],
      reporter: { id: "U1", channel: "C1", name: "Ana" },
      hints: { kind: "bug", size: "S", urgency: "high", risk: "low", confidence: 0.8 },
      originMachine: "conversation",
      attachments: [{ name: "shot.png", url: "https://x/shot.png" }],
    };
    expect(CreateCardInput.parse(card)).toEqual(card);
    expect(NewTaskInput.safeParse({ title: "t", originMachine: "carrier pigeon" }).success).toBe(false);
    expect(CardHints.safeParse({ confidence: 1.5 }).success).toBe(false);
  });

  it("caps every string and list, and takes only http or https attachment urls", () => {
    const long = (n: number) => "x".repeat(n);
    expect(NewTaskInput.safeParse({ title: "t", reporter: { id: long(201) } }).success).toBe(false);
    expect(NewTaskInput.safeParse({ title: "t", reporter: { id: long(200) } }).success).toBe(true);
    expect(NewTaskInput.safeParse({ title: "t", hints: { kind: long(201) } }).success).toBe(false);
    expect(NewTaskInput.safeParse({ title: "t", sources: [{ type: "slack", permalink: long(2001) }] }).success).toBe(false);
    expect(NewTaskInput.safeParse({ title: "t", sources: Array.from({ length: 21 }, () => ({ type: "slack" })) }).success).toBe(false);
    expect(NewTaskInput.safeParse({ title: "t", sources: Array.from({ length: 20 }, () => ({ type: "slack" })) }).success).toBe(true);
    expect(NewTaskInput.safeParse({ title: "t", attachments: Array.from({ length: 21 }, () => ({ name: "a", url: "https://x/a" })) }).success).toBe(false);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "/etc/passwd"]) expect(NewTaskInput.safeParse({ title: "t", attachments: [{ name: "a", url }] }).success).toBe(false);
    expect(NewTaskInput.safeParse({ title: "t", attachments: [{ name: "a", url: "http://x/a" }] }).success).toBe(true);
  });

  it("weighs a hint at half", () => {
    expect(HINT_WEIGHT).toBe(0.5);
  });
});
