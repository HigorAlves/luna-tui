import { describe, expect, it } from "vitest";

import { MemoryAskInput, MemoryForgetInput, MemoryRecallInput } from "./api.ts";
import { NO_ACCESS } from "./access.ts";
import { AgentRole, MemoryAnswerAnswer, PACKS } from "./packs.ts";
import { MemoryAnswerContext } from "./stage.ts";

const recalled = { id: "mem_1", kind: "outcome", text: "the uploader retries three times", source: "github", anchors: { files: ["a.ts"], commit: "abc" }, stale: false, score: 1 };

describe("memory_answer", () => {
  it("is a context-only agent pack: haiku or luna, low effort, a few turns, no tools and no worktree", () => {
    expect(PACKS.memory_answer).toMatchObject({
      agent: "memory-answerer",
      helpers: [],
      skills: [],
      access: NO_ACCESS,
      writable: false,
      maxTurns: 2,
      engines: { default: "codex:luna", allowed: ["codex:luna", "claude:haiku"], fallback: ["claude:haiku", "codex:luna"] },
      effort: "low",
      template: "memory_answer.md",
    });
    expect(AgentRole.options).toContain("memory-answerer");
    expect(PACKS.memory_answer.answer).toBe(MemoryAnswerAnswer);
  });

  it("answers with text, the ids it cites and whether the items settled the question", () => {
    expect(MemoryAnswerAnswer.safeParse({ answer: "Three.", citations: ["mem_1"], grounded: true }).success).toBe(true);
    expect(MemoryAnswerAnswer.safeParse({ answer: "x".repeat(1501), citations: [], grounded: false }).success).toBe(false);
    expect(MemoryAnswerAnswer.safeParse({ answer: "x", citations: ["a"] }).success).toBe(false);
  });

  it("reads a question and at most twelve recalled items", () => {
    expect(MemoryAnswerContext.safeParse({ question: "how often?", items: [recalled], note: null }).success).toBe(true);
    expect(MemoryAnswerContext.safeParse({ question: "", items: [], note: null }).success).toBe(false);
    expect(MemoryAnswerContext.safeParse({ question: "q", items: Array.from({ length: 13 }, () => recalled), note: null }).success).toBe(false);
  });
});

describe("the memory API's request shapes", () => {
  it("trim and bound what a client sends", () => {
    expect(MemoryAskInput.parse({ question: "  why?  " })).toEqual({ question: "why?" });
    expect(MemoryAskInput.safeParse({ question: "  " }).success).toBe(false);
    expect(MemoryRecallInput.parse({ query: "retries", scope: "docs", repo: "api-1" })).toEqual({ query: "retries", scope: "docs", repo: "api-1" });
    expect(MemoryRecallInput.safeParse({ query: "x", scope: "everything" }).success).toBe(false);
    expect(MemoryForgetInput.parse({})).toEqual({});
    expect(MemoryForgetInput.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
  });
});
