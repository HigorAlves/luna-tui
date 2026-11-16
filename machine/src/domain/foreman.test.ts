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

  it("carries the route and the gate's outcome", () => {
    const gates = new Map([
      ["a", { state: "awaiting_approval" as const, requested: { outcome: "archive" } }],
      ["s", { state: "awaiting_ship" as const, requested: { gate: "ship_approval" } }],
    ]);
    const out = board([task("a", { route: "config" } as Partial<TaskRow>), task("s"), task("n")], gates);
    const by = (id: string) => out.cards.find((c) => c.id === id)!;
    expect(by("a")).toMatchObject({ gateOutcome: "archive", route: "config" });
    expect(by("s")).toMatchObject({ gateOutcome: "ship_approval" });
    expect(by("n")).toMatchObject({ gateOutcome: null });
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
