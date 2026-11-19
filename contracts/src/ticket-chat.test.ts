import { describe, expect, it } from "vitest";

import { AgentRole, PACKS, PackId, StageInput, TicketChatAnswer, TicketChatContext } from "./index.ts";

const draft = { title: "Add a t key that plans a ticket", description: "Context, approach, files, risks.", criteria: ["t opens the chat"] };
const context = { repo: { name: "luna-tui", path: "/repos/luna-tui" }, message: "a ticket for the board", history: [], notes: "", draft: null };
const answer = { reply: "Which view should own the key?", choices: ["board", "backlog"], notes: "board/src/keys.rs binds keys", draft: null, ready: false };

describe("the ticket_chat pack", () => {
  it("plans with the person on a read-only checkout: Opus by default, Codex sol allowed, no fallback", () => {
    const pack = PACKS.ticket_chat;
    expect(pack).toMatchObject({
      kind: "agent",
      agent: "ticket-planner",
      writable: false,
      maxTurns: 25,
      timeoutMs: 8 * 60_000,
      engines: { default: "claude:opus", allowed: ["claude:opus", "codex:sol"] },
      effort: "medium",
      template: "ticket_chat.md",
      network: "engine",
    });
    expect(pack.kind === "agent" && pack.access.read).toBe(true);
    expect(pack.kind === "agent" && pack.access.write).toBeFalsy();
    expect(pack.engines.fallback ?? []).toEqual([]);
    expect(pack.answer).toBe(TicketChatAnswer);
    expect(AgentRole.options).toContain("ticket-planner");
    expect(PackId.options).toContain("ticket_chat");
  });

  it("reads the talk under context.ticketChat", () => {
    expect(TicketChatContext.safeParse(context).error).toBeUndefined();
    const input = { schema: 3, stage: "ticket_chat", pack: "ticket_chat", attempt: 1, task: { id: "ticket-chat", title: "Ticket chat", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], context: { projectContext: null, ticketChat: context }, limits: { maxTurns: 25, timeoutMs: 480_000 }, env: { LUNA_FACTORY: "1" } };
    expect(StageInput.safeParse(input).error).toBeUndefined();
  });

  it("an answer that is ready has a draft, and choices are at most 4", () => {
    expect(TicketChatAnswer.safeParse(answer).error).toBeUndefined();
    expect(TicketChatAnswer.safeParse({ ...answer, ready: true, draft }).success).toBe(true);
    expect(TicketChatAnswer.safeParse({ ...answer, ready: true, draft: null }).success).toBe(false);
    expect(TicketChatAnswer.safeParse({ ...answer, choices: ["a", "b", "c", "d"] }).success).toBe(true);
    expect(TicketChatAnswer.safeParse({ ...answer, choices: ["a", "b", "c", "d", "e"] }).success).toBe(false);
  });

  it("bounds the message, the history, the notes and the draft", () => {
    expect(TicketChatContext.safeParse({ ...context, message: "" }).success).toBe(false);
    expect(TicketChatContext.safeParse({ ...context, message: "m".repeat(4001) }).success).toBe(false);
    const turn = { who: "person", text: "hi" };
    expect(TicketChatContext.safeParse({ ...context, history: Array.from({ length: 30 }, () => turn) }).success).toBe(true);
    expect(TicketChatContext.safeParse({ ...context, history: Array.from({ length: 31 }, () => turn) }).success).toBe(false);
    expect(TicketChatContext.safeParse({ ...context, history: [{ who: "foreman", text: "x" }] }).success).toBe(false);
    expect(TicketChatContext.safeParse({ ...context, notes: "n".repeat(6001) }).success).toBe(false);
    expect(TicketChatContext.safeParse({ ...context, draft }).success).toBe(true);
    expect(TicketChatContext.safeParse({ ...context, draft: { ...draft, title: "" } }).success).toBe(false);
    expect(TicketChatContext.safeParse({ ...context, draft: { ...draft, criteria: Array.from({ length: 13 }, () => "c") } }).success).toBe(false);
    expect(TicketChatAnswer.safeParse({ ...answer, reply: "r".repeat(4001) }).success).toBe(false);
    expect(TicketChatAnswer.safeParse({ ...answer, notes: "n".repeat(6001) }).success).toBe(false);
  });
});
