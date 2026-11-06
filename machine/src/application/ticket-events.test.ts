import { type CanonicalTicket, FACTORY_DEFAULTS } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PgTicketStore } from "../adapters/persistence/ticket-store.ts";
import { freshTestDatabase } from "../test/database.ts";
import { TicketEvents, ticketChanges } from "./ticket-events.ts";

const t = (over: Partial<CanonicalTicket> = {}): CanonicalTicket => ({
  tool: "jira", id: "PAY-12", key: "PAY-12", title: "Refund fails", description: "It fails.", type: "Task", status: "To Do", priority: "High",
  reporter: { id: "u1", name: "Ana" }, assignee: "ana", labels: [], components: [], links: { blocks: [], duplicates: [], epic: null },
  comments: [], attachments: [], sprint: null, dueAt: null, createdAt: null, updatedAt: "2026-11-05T10:00:00Z", permalink: "https://x", ...over,
});
const c = (text: string) => ({ author: "Bo", text, at: null });

describe("what changed on a ticket", () => {
  it("names the scope edited, the priority changed, a reassignment and a new comment", () => {
    expect(ticketChanges(t(), t({ title: "Refund fails twice" }), [])).toEqual(["scope_edited"]);
    expect(ticketChanges(t(), t({ description: "other" }), [])).toEqual(["scope_edited"]);
    expect(ticketChanges(t(), t({ priority: "Low" }), [])).toEqual(["priority_changed"]);
    expect(ticketChanges(t(), t({ assignee: "carla" }), [])).toEqual(["reassigned"]);
    expect(ticketChanges(t(), t({ comments: [c("hi")] }), [])).toEqual(["new_comment"]);
    expect(ticketChanges(t(), t({ status: "In Progress", updatedAt: "later" }), [])).toEqual([]);
  });

  it("does not count a comment that is a draft the machine's person posted", () => {
    expect(ticketChanges(t(), t({ comments: [c("Assessed: priority P1.")] }), ["Assessed: priority P1."])).toEqual([]);
  });
});

describe("TicketEvents", () => {
  let db: DataSource;
  beforeAll(async () => {
    db = await freshTestDatabase();
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await db.query("truncate tickets");
  });
  const mk = (scope = { assignees: ["ana"], teams: [] as string[] }) => {
    const store = new PgTicketStore(db);
    const records: Array<[string, string, Record<string, unknown>]> = [];
    const ingest = vi.fn(async () => {});
    const events = new TicketEvents({ store, machine: { ingest }, pipeline: { record: async (id, kind, payload) => void records.push([id, kind, payload]) }, config: async () => ({ ...FACTORY_DEFAULTS, tickets: { ...FACTORY_DEFAULTS.tickets, ...scope } }) });
    return { store, records, ingest, events };
  };
  const card = (state: string, over = {}) => ({ id: "card-1", state, repoPath: "/r/a", worktreePath: null, branch: null, ...over }) as never;

  it("reads a ticket it has not seen as the baseline: no event", async () => {
    const { events, records, store } = mk();
    expect(await events.handle(t(), card("triage"))).toEqual([]);
    expect(records).toEqual([]);
    expect(await store.get("PAY-12")).not.toBeNull();
  });

  it("before Build: a row per change, a re-assessment, and the card's gate marked for another look", async () => {
    const { events, records, ingest, store } = mk();
    await store.read(t());
    const changes = await events.handle(t({ title: "Refund fails twice", priority: "Low" }), card("awaiting_approval"));
    expect(changes).toEqual(["scope_edited", "priority_changed"]);
    expect(records.map((r) => r[1])).toEqual(["ticket.scope_edited", "ticket.priority_changed", "ticket.gate_recheck"]);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ title: "Refund fails twice" }), expect.objectContaining({ force: true, repoPath: "/r/a" }));
  });

  it("during or after Build: the card gets a flag and a person decides", async () => {
    const { events, records, store } = mk();
    await store.read(t());
    await events.handle(t({ description: "new scope" }), card("implementing", { worktreePath: "/w" }));
    expect(records.map((r) => r[1])).toEqual(["ticket.scope_edited", "ticket.flag"]);
  });

  it("a comment while triage waits for answers restarts that clock", async () => {
    const { events, records, store } = mk();
    await store.read(t());
    await events.handle(t({ comments: [c("the answer")] }), card("awaiting_answers"));
    expect(records.map((r) => r[1])).toContain("ticket.answered");
  });

  it("a reassignment out of scope drafts a hand-over note, stops assessing, and posts nothing", async () => {
    const { events, ingest, store } = mk();
    await store.read(t());
    await events.handle(t({ assignee: "carla" }), card("triage"));
    const row = (await store.get("PAY-12"))!;
    expect(row.machineStatus).toBe("handed_over");
    expect(row.drafts[0]).toMatchObject({ kind: "handover", status: "waiting" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("puts no free text from the ticket in an event row", async () => {
    const { events, records, store } = mk();
    await store.read(t());
    await events.handle(t({ title: "SECRET TITLE", comments: [c("SECRET COMMENT")] }), card("triage"));
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });
});
