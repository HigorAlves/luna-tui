import { describe, expect, it } from "vitest";

import { AgentRole, ForemanAction, ForemanAnswer, ForemanContext, NO_ACCESS, PACKS, PackId, StageInput, foremanActionProblem } from "./index.ts";

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Card ${id}`,
  repo: "o/a",
  state: "planning",
  column: "plan",
  gate: null,
  gateSummary: null,
  gateOutcome: null,
  route: "feature",
  approvalId: null,
  escalation: null,
  questions: [],
  engines: {},
  updatedAt: "2026-11-16T10:00:00.000Z",
  ...extra,
});
const board = {
  now: "2026-11-16T12:00:00.000Z",
  cards: [
    card("t1"),
    card("t2", { gate: "plan", gateSummary: "approve the plan" }),
    card("t3", { escalation: "tests stayed red" }),
    card("c1", { gate: "awaiting_approval", gateOutcome: "conversation" }),
    card("c2", { gate: "awaiting_approval", gateOutcome: "archive" }),
    card("c3", { gate: "awaiting_approval", gateOutcome: "split" }),
    card("c4", { gate: "awaiting_approval", gateOutcome: "split_failed" }),
    card("c5", { gate: "awaiting_setup", route: "config" }),
    card("c6", { gate: "awaiting_ship", gateOutcome: "ship_approval" }),
    card("t4", { state: "awaiting_answers", questions: [{ id: "q1", question: "Which db?", recommended: "postgres" }, { id: "q2", question: "Which cache?", recommended: null }] }),
  ],
  packs: [{ id: "chat_triage", allowed: ["claude:haiku", "codex:luna"] }],
};
const context = { question: "what is blocked?", history: [], board };

describe("the foreman pack", () => {
  it("runs as the foreman with no tools and no worktree: haiku (Codex luna allowed), low effort, two turns", () => {
    expect(PACKS.foreman).toMatchObject({
      kind: "agent",
      agent: "foreman",
      helpers: [],
      skills: [],
      access: NO_ACCESS,
      writable: false,
      maxTurns: 2,
      timeoutMs: 2 * 60_000,
      engines: { default: "claude:haiku", allowed: ["claude:haiku", "codex:luna"] },
      effort: "low",
      template: "foreman.md",
    });
    expect(PACKS.foreman.answer).toBe(ForemanAnswer);
    expect(AgentRole.options).toContain("foreman");
    expect(PackId.options).toContain("foreman");
  });

  it("reads a board snapshot under context.foreman", () => {
    expect(ForemanContext.safeParse(context).error).toBeUndefined();
    const input = { schema: 3, stage: "foreman", pack: "foreman", attempt: 1, task: { id: "foreman", title: "Foreman", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], context: { projectContext: null, foreman: context }, limits: { maxTurns: 2, timeoutMs: 120_000 }, env: { LUNA_FACTORY: "1" } };
    expect(StageInput.safeParse(input).error).toBeUndefined();
  });

  it("bounds the question, the history, the cards and the reply", () => {
    expect(ForemanContext.safeParse({ ...context, question: "" }).success).toBe(false);
    expect(ForemanContext.safeParse({ ...context, question: "q".repeat(2001) }).success).toBe(false);
    const turn = { who: "person", text: "hi" };
    expect(ForemanContext.safeParse({ ...context, history: Array.from({ length: 10 }, () => turn) }).success).toBe(true);
    expect(ForemanContext.safeParse({ ...context, history: Array.from({ length: 11 }, () => turn) }).success).toBe(false);
    expect(ForemanContext.safeParse({ ...context, history: [{ who: "robot", text: "x" }] }).success).toBe(false);
    expect(ForemanContext.safeParse({ ...context, board: { ...board, cards: Array.from({ length: 61 }, (_, i) => card(`t${i}`)) } }).success).toBe(false);
    expect(ForemanAnswer.safeParse({ reply: "r".repeat(1201), actions: [] }).success).toBe(false);
    const start = { kind: "start", taskId: "t1", why: "ready" };
    expect(ForemanAnswer.safeParse({ reply: "ok", actions: Array.from({ length: 20 }, () => start) }).success).toBe(true);
    expect(ForemanAnswer.safeParse({ reply: "ok", actions: Array.from({ length: 21 }, () => start) }).success).toBe(false);
    expect(ForemanContext.safeParse({ ...context, board: { ...board, cards: [card("t1", { gateSummary: "g".repeat(201) })] } }).success).toBe(false);
  });

  it("knows ten kinds of action, each with a task and a short reason", () => {
    const ok = [
      { kind: "start", taskId: "t1", why: "w" },
      { kind: "approve", taskId: "t2", why: "w" },
      { kind: "resume", taskId: "t1", why: "w" },
      { kind: "abort", taskId: "t1", why: "w" },
      { kind: "archive", taskId: "t1", why: "w" },
      { kind: "send_back", taskId: "t2", why: "w", reason: "too wide" },
      { kind: "retry", taskId: "t3", why: "w", reason: "try again" },
      { kind: "set_engine", taskId: "t1", why: "w", pack: "chat_triage", engine: "codex:luna" },
      { kind: "answer", taskId: "t4", why: "w", answers: { q1: "postgres" } },
      { kind: "post_questions", taskId: "t4", why: "w" },
    ];
    for (const action of ok) expect(ForemanAction.safeParse(action).error).toBeUndefined();
    expect(ForemanAction.safeParse({ kind: "start", taskId: "t1", why: "w".repeat(201) }).success).toBe(false);
    expect(ForemanAction.safeParse({ kind: "send_back", taskId: "t2", why: "w" }).success).toBe(false);
    expect(ForemanAction.safeParse({ kind: "delete", taskId: "t1", why: "w" }).success).toBe(false);
  });
});

describe("foremanActionProblem", () => {
  const problem = (action: unknown) => foremanActionProblem(ForemanAction.parse(action), ForemanContext.parse(context).board);

  it("accepts an action the board can take", () => {
    expect(problem({ kind: "start", taskId: "t1", why: "w" })).toBeNull();
    expect(problem({ kind: "approve", taskId: "t2", why: "w" })).toBeNull();
    expect(problem({ kind: "retry", taskId: "t3", why: "w", reason: "r" })).toBeNull();
    expect(problem({ kind: "set_engine", taskId: "t1", why: "w", pack: "chat_triage", engine: "codex:luna" })).toBeNull();
    expect(problem({ kind: "answer", taskId: "t4", why: "w", answers: { q1: "postgres", q2: "redis" } })).toBeNull();
    expect(problem({ kind: "post_questions", taskId: "t4", why: "w" })).toBeNull();
  });

  it("refuses answer for a question the card does not have open, or with no answers", () => {
    expect(problem({ kind: "answer", taskId: "t4", why: "w", answers: { q9: "x" } })).toMatch(/q9/);
    expect(problem({ kind: "answer", taskId: "t1", why: "w", answers: { q1: "x" } })).toMatch(/q1/);
    expect(problem({ kind: "answer", taskId: "t4", why: "w", answers: {} })).toMatch(/no answer/);
  });

  it("refuses post_questions for a card with no open questions", () => {
    expect(problem({ kind: "post_questions", taskId: "t1", why: "w" })).toMatch(/question/);
  });

  it("refuses a card that is not on the board", () => {
    expect(problem({ kind: "start", taskId: "nope", why: "w" })).toMatch(/nope/);
  });

  it("refuses approve for a card with no gate", () => {
    expect(problem({ kind: "approve", taskId: "t1", why: "w" })).toMatch(/gate/);
  });

  it("refuses approve at a gate that acts outward or writes files: a reply, an archive, a split, a config card and the release", () => {
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) expect(problem({ kind: "approve", taskId: id, why: "w" }), id).toMatch(/own confirm|board/);
  });

  it("refuses approve for a card with flagged findings or an open council finding", () => {
    const flagged = ForemanContext.parse({ ...context, board: { ...board, cards: [card("f1", { gate: "plan", flagged: ["coverage"] }), card("f2", { gate: "plan", council: { passed: false, open: 2 } }), card("f3", { gate: "plan", council: { passed: true, open: 0 }, flagged: [] })] } }).board;
    const check = (id: string) => foremanActionProblem(ForemanAction.parse({ kind: "approve", taskId: id, why: "w" }), flagged);
    expect(check("f1")).toMatch(/flagged/);
    expect(check("f2")).toMatch(/council/);
    expect(check("f3")).toBeNull();
  });

  it("refuses archive, abort and send_back for a config card: an archive is not a decline and the proposal would come back", () => {
    const config = ForemanContext.parse({ ...context, board: { ...board, cards: [card("k1", { gate: "awaiting_setup", route: "config" })] } }).board;
    for (const action of [{ kind: "archive" }, { kind: "abort" }, { kind: "send_back", reason: "r" }]) {
      expect(foremanActionProblem(ForemanAction.parse({ ...action, taskId: "k1", why: "w" }), config), action.kind).toMatch(/config/);
    }
    expect(foremanActionProblem(ForemanAction.parse({ kind: "archive", taskId: "t1", why: "w" }), ForemanContext.parse(context).board)).toBeNull();
  });

  it("reads the flags, the council, the settled count and the trust of a card, and the repo's pending approvals", () => {
    const parsed = ForemanContext.parse({
      ...context,
      board: { ...board, pending: [{ repo: "luna", kind: "base", ref: "node:24" }, { repo: "luna", kind: "dockerfile", ref: "Dockerfile" }], cards: [card("p1", { flagged: ["coverage"], council: { passed: false, open: 1 }, settledByCouncil: 2, trust: "untrusted" })] },
    });
    expect(parsed.board.cards[0]).toMatchObject({ flagged: ["coverage"], council: { passed: false, open: 1 }, settledByCouncil: 2, trust: "untrusted" });
    expect(parsed.board.pending).toHaveLength(2);
    expect(ForemanContext.safeParse({ ...context, board: { ...board, cards: [card("p2", { trust: "bogus" })] } }).success).toBe(false);
  });

  it("keeps the open approval's id on a card, null when none is open", () => {
    const parsed = ForemanContext.parse({ ...context, board: { ...board, cards: [card("t2", { gate: "plan", approvalId: "ap-1" }), card("t1")] } });
    expect(parsed.board.cards.map((c) => c.approvalId)).toEqual(["ap-1", null]);
  });

  it("refuses retry for a card that is not escalated", () => {
    expect(problem({ kind: "retry", taskId: "t1", why: "w", reason: "r" })).toMatch(/escalat/);
  });

  it("refuses set_engine with an engine the pack does not allow, or a pack the board does not list", () => {
    expect(problem({ kind: "set_engine", taskId: "t1", why: "w", pack: "chat_triage", engine: "claude:opus" })).toMatch(/claude:opus/);
    expect(problem({ kind: "set_engine", taskId: "t1", why: "w", pack: "plan", engine: "claude:haiku" })).toMatch(/plan/);
  });
});
