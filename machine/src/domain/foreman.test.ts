import { ForemanContext, PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { buildForemanBoard } from "./foreman.ts";
import type { TaskRow } from "./task.ts";

const NOW = new Date("2026-11-16T12:00:00Z");
const task = (id: string, over: Partial<TaskRow> = {}): TaskRow =>
  ({ id, title: `Card ${id}`, repoPath: "/work/luna", state: "triage", route: "feature", resumeTo: null, reason: null, stages: {}, updatedAt: new Date("2026-11-10T00:00:00Z"), ...over }) as TaskRow;
const packs = [{ id: "foreman" as const, engines: PACKS.foreman.engines }];
const board = (tasks: TaskRow[], gates: Parameters<typeof buildForemanBoard>[1] = new Map()) => buildForemanBoard(tasks, gates, packs, NOW);

describe("buildForemanBoard", () => {
  it("keeps open cards only, newest first, and the result is a valid board", () => {
    const out = board([
      task("old", { updatedAt: new Date("2026-11-01T00:00:00Z") }),
      task("done", { state: "closed" }),
      task("gone", { state: "archived" }),
      task("new", { updatedAt: new Date("2026-11-15T00:00:00Z") }),
    ]);
    expect(out.cards.map((c) => c.id)).toEqual(["new", "old"]);
    expect(out.now).toBe("2026-11-16T12:00:00.000Z");
    expect(ForemanContext.shape.board.safeParse(out).success).toBe(true);
  });

  it("caps the board at 60 cards", () => {
    const many = Array.from({ length: 75 }, (_, i) => task(`t${i}`, { updatedAt: new Date(2026, 10, 1, 0, i) }));
    const out = board(many);
    expect(out.cards).toHaveLength(60);
    expect(out.cards[0]!.id).toBe("t74");
  });

  it("keeps a card that waits on a person when the board is cut, and counts the cards left out", () => {
    const many = Array.from({ length: 60 }, (_, i) => task(`t${i}`, { updatedAt: new Date(2026, 10, 2, 0, i) }));
    const stuck = task("stuck", { state: "escalated", resumeTo: "implementing", reason: "tests stay red", updatedAt: new Date("2026-10-01T00:00:00Z") });
    const out = board([...many, stuck]);
    expect(out.cards).toHaveLength(60);
    expect(out.cards[0]!.id).toBe("stuck");
    expect(out.truncated).toBe(1);
    expect(out.cards.map((c) => c.id)).not.toContain("t0");
    expect(board([task("a")]).truncated).toBe(0);
  });

  it("puts cards that wait on a person first, oldest wait first, then the rest newest first", () => {
    const gates = new Map([
      ["gate", { id: "g", state: "awaiting_approval" as const, requested: {} }],
      ["ask", { id: "q", state: "awaiting_answers" as const, requested: { questions: [{ question: "Which?" }] } }],
    ]);
    const out = board(
      [
        task("new", { updatedAt: new Date("2026-11-15T00:00:00Z") }),
        task("gate", { state: "awaiting_approval", updatedAt: new Date("2026-11-05T00:00:00Z") }),
        task("ask", { state: "awaiting_answers", updatedAt: new Date("2026-11-02T00:00:00Z") }),
        task("esc", { state: "escalated", resumeTo: "implementing", updatedAt: new Date("2026-11-08T00:00:00Z") }),
        task("mid", { updatedAt: new Date("2026-11-12T00:00:00Z") }),
      ],
      gates,
    );
    expect(out.cards.map((c) => c.id)).toEqual(["ask", "gate", "esc", "new", "mid"]);
  });

  it("flattens a title to one line and caps it at 120 characters", () => {
    const out = board([task("a", { title: `Fix\n\n  the   bug\t${"x".repeat(200)}` })]);
    expect(out.cards[0]!.title).not.toMatch(/\s{2}|\n|\t/);
    expect(out.cards[0]!.title.length).toBe(120);
    expect(out.cards[0]!.title.startsWith("Fix the bug xxx")).toBe(true);
  });

  it("names the open gate, what it asks, the escalation reason and the repo", () => {
    const gates = new Map([["a", { state: "awaiting_approval" as const, requested: { summary: "Approve the plan: 3 slices" } }]]);
    const out = board([task("a", { state: "awaiting_approval" }), task("b", { state: "escalated", resumeTo: "implementing", reason: "tests stay red" })], gates);
    const a = out.cards.find((c) => c.id === "a")!;
    expect(a).toMatchObject({ gate: "awaiting_approval", gateSummary: "Approve the plan: 3 slices", escalation: null, repo: "luna", column: "Plan" });
    const b = out.cards.find((c) => c.id === "b")!;
    expect(b).toMatchObject({ gate: null, gateSummary: null, escalation: "tests stay red", column: "Build" });
  });

  it("carries the open approval id, the route and the gate's outcome", () => {
    const gates = new Map([
      ["a", { id: "ap1", state: "awaiting_approval" as const, requested: { outcome: "archive" } }],
      ["s", { id: "ap2", state: "awaiting_ship" as const, requested: { gate: "ship_approval" } }],
    ]);
    const out = board([task("a", { route: "config" } as Partial<TaskRow>), task("s"), task("n")], gates);
    const by = (id: string) => out.cards.find((c) => c.id === id)!;
    expect(by("a")).toMatchObject({ approvalId: "ap1", gateOutcome: "archive", route: "config" });
    expect(by("s")).toMatchObject({ approvalId: "ap2", gateOutcome: "ship_approval" });
    expect(by("n")).toMatchObject({ approvalId: null, gateOutcome: null });
  });

  it("names the flags, the council, what the council settled and the trust of a card", () => {
    const gates = new Map([
      ["a", { id: "g", state: "awaiting_approval" as const, requested: { flagged: ["coverage", "council.security"], council: { passed: false, transcript: [{ member: "security", round: 1, findings: [{ title: "x" }, { title: "y" }] }, { member: "security", round: 2, findings: [{ title: "y" }] }, { member: "second", round: 2, findings: [] }] } } }],
      ["b", { id: "h", state: "awaiting_approval" as const, requested: { council: { passed: true, transcript: [] } } }],
    ]);
    const qa = [{ question: "a", answer: "x", by: "council" as const }, { question: "b", answer: "y" }, { question: "c", answer: "z", by: "council" as const }];
    const out = board(
      [
        task("a", { state: "awaiting_approval", source: { kind: "github", authorAssociation: "NONE" } } as Partial<TaskRow>),
        task("b", { state: "awaiting_approval", record: { qa } } as Partial<TaskRow>),
        task("c"),
      ],
      gates,
    );
    const by = (id: string) => out.cards.find((c) => c.id === id)!;
    expect(by("a")).toMatchObject({ flagged: ["coverage", "council.security"], council: { passed: false, open: 1 }, trust: "untrusted", settledByCouncil: 0 });
    expect(by("b")).toMatchObject({ flagged: [], council: { passed: true, open: 0 }, trust: "trusted", settledByCouncil: 2 });
    expect(by("c")).toMatchObject({ flagged: [], council: null, settledByCouncil: 0, trust: "trusted" });
    expect(ForemanContext.shape.board.safeParse(out).success).toBe(true);
  });

  it("caps the flags at 10 and each flag at 120 characters", () => {
    const gates = new Map([["a", { state: "awaiting_approval" as const, requested: { flagged: Array.from({ length: 15 }, () => "f".repeat(300)) } }]]);
    const flagged = board([task("a")], gates).cards[0]!.flagged!;
    expect(flagged).toHaveLength(10);
    expect(flagged[0]).toHaveLength(120);
  });

  it("lists the repos' pending base and Dockerfile approvals on the board", () => {
    const pending = [{ repo: "luna", kind: "base" as const, ref: "node:24" }];
    expect(buildForemanBoard([], new Map(), packs, NOW, pending).pending).toEqual(pending);
    expect(board([]).pending).toEqual([]);
  });

  it("caps the gate summary at 200 characters", () => {
    const gates = new Map([["a", { state: "awaiting_approval" as const, requested: { summary: "s".repeat(500) } }]]);
    expect(board([task("a")], gates).cards[0]!.gateSummary).toHaveLength(200);
  });

  it("lists the open questions of an awaiting_answers card with their recommended answers, numbered", () => {
    const gates = new Map([["a", { state: "awaiting_answers" as const, requested: { questions: [{ question: "Which format?", recommended: "csv" }, { question: "Include totals?", recommended: null }, { nope: 1 }] } }]]);
    const out = board([task("a", { state: "awaiting_answers" })], gates);
    expect(out.cards[0]!.questions).toEqual([
      { id: "q1", question: "Which format?", recommended: "csv" },
      { id: "q2", question: "Include totals?", recommended: null },
    ]);
    expect(out.cards[0]!.gateSummary).toBe("2 open questions");
  });

  it("reads a card's own engines and lists each pack with the engines it allows", () => {
    const out = board([task("a", { stages: { foreman: "codex:luna" } })]);
    expect(out.cards[0]!.engines).toEqual({ foreman: "codex:luna" });
    expect(out.packs).toEqual([{ id: "foreman", allowed: [...PACKS.foreman.engines.allowed] }]);
  });
});
