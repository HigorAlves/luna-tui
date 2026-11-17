import { describe, expect, it } from "vitest";

import { AgentRole, BrainAskAnswer, BrainAskContext, NO_ACCESS, PACKS, PackId, StageInput, brainAskCites } from "./index.ts";

const rows = [
  { slug: "card:6f1c2a9e", kind: "card" as const, text: "Export CSV · state closed" },
  { slug: "pr:acme/shop#12", kind: "pr" as const, text: "pull request #12 · merged" },
  { slug: "verdict:abc", kind: "verdict" as const, text: "risk_score asked how risky" },
];
const context = BrainAskContext.parse({ question: "how did the export go?", rows });
const answer = (cites: string[], over: Record<string, unknown> = {}) => BrainAskAnswer.parse({ known: true, reply: "It shipped.", cites, ...over });

describe("the brain_ask pack", () => {
  it("runs as the brain-answerer with no tools and no worktree: haiku (Codex luna allowed), low effort, two turns", () => {
    expect(PACKS.brain_ask).toMatchObject({
      kind: "agent",
      agent: "brain-answerer",
      helpers: [],
      skills: [],
      access: NO_ACCESS,
      writable: false,
      maxTurns: 2,
      timeoutMs: 2 * 60_000,
      engines: PACKS.foreman.engines,
      effort: "low",
      template: "brain_ask.md",
    });
    expect(PACKS.brain_ask.answer).toBe(BrainAskAnswer);
    expect(AgentRole.options).toContain("brain-answerer");
    expect(PackId.options).toContain("brain_ask");
  });

  it("reads the question and the rows under context.brainAsk", () => {
    const input = { schema: 3, stage: "brain_ask", pack: "brain_ask", attempt: 1, task: { id: "brain-ask", title: "Brain ask", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], context: { projectContext: null, brainAsk: context }, limits: { maxTurns: 2, timeoutMs: 120_000 }, env: { LUNA_FACTORY: "1" } };
    expect(StageInput.safeParse(input).error).toBeUndefined();
  });

  it("bounds the question, the rows, a row's slug and text, and the answer", () => {
    expect(BrainAskContext.safeParse({ question: "", rows: [] }).success).toBe(false);
    expect(BrainAskContext.safeParse({ question: "q".repeat(2001), rows: [] }).success).toBe(false);
    const row = rows[0]!;
    expect(BrainAskContext.safeParse({ question: "q", rows: Array.from({ length: 60 }, () => row) }).success).toBe(true);
    expect(BrainAskContext.safeParse({ question: "q", rows: Array.from({ length: 61 }, () => row) }).success).toBe(false);
    expect(BrainAskContext.safeParse({ question: "q", rows: [{ ...row, text: "t".repeat(601) }] }).success).toBe(false);
    expect(BrainAskContext.safeParse({ question: "q", rows: [{ ...row, slug: "" }] }).success).toBe(false);
    expect(BrainAskContext.safeParse({ question: "q", rows: [{ ...row, kind: "ticket" }] }).success).toBe(false);
    expect(BrainAskContext.safeParse({ question: "q", rows: [{ ...row, kind: "learning" }] }).success).toBe(true);
    expect(BrainAskAnswer.safeParse({ known: true, reply: "r".repeat(1201), cites: [] }).success).toBe(false);
    expect(BrainAskAnswer.safeParse({ known: true, reply: "ok", cites: Array.from({ length: 10 }, () => "a") }).success).toBe(true);
    expect(BrainAskAnswer.safeParse({ known: true, reply: "ok", cites: Array.from({ length: 11 }, () => "a") }).success).toBe(false);
  });
});

describe("brainAskCites", () => {
  it("keeps a cite of a shown row, in the answer's order and once each", () => {
    const { cites, dropped } = brainAskCites(answer(["pr:acme/shop#12", "card:6f1c2a9e", "pr:acme/shop#12"]), context);
    expect(cites).toEqual([rows[1], rows[0]]);
    expect(dropped).toEqual([]);
  });

  it("reports a cite of a slug the context never showed as dropped, once", () => {
    const { cites, dropped } = brainAskCites(answer(["card:6f1c2a9e", "card:made-up", "card:made-up"]), context);
    expect(cites).toEqual([rows[0]]);
    expect(dropped).toEqual(["card:made-up"]);
  });

  it("gives nothing for an answer that cites nothing", () => {
    expect(brainAskCites(answer([], { known: false }), context)).toEqual({ cites: [], dropped: [] });
  });
});
