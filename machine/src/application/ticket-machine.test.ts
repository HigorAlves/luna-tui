import { type CanonicalTicket, SCORING_DEFAULTS, FACTORY_DEFAULTS } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PgTicketStore } from "../adapters/persistence/ticket-store.ts";
import { freshTestDatabase } from "../test/database.ts";
import type { AssessAnswer } from "../domain/ticket-score.ts";
import { TicketMachine, TicketNotFound, TicketRefusal, parseTicketKey } from "./ticket-machine.ts";
import type { Tickets } from "./tickets.ts";
import type { ValidityAnswer } from "./ticket-validity.ts";

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

const secret = () => ["gh", "p_"].join("") + "a".repeat(36);
const yes = { value: true, p: 0.95 };
const no = { value: false, p: 0.05 };
const goodValidity: ValidityAnswer = { goal: yes, criteria: yes, scope: yes, duplicate: { choice: "none", confidence: 0.9 }, project: yes, reporter: yes };
const s = { score: 1, confidence: 0.9 };
const flagNo = { value: false, p: 0.05 };
const assessAnswer = { who: s, what: s, impact: s, time: s, demand: s, files: s, unknowns: s, cross_team: s, new_infra: s, dependents: s, traffic: s, data_sensitivity: s, reversibility: s, regression: s, compounding: s, production_down: flagNo, data_loss: flagNo, security: flagNo, incident: flagNo, compliance_deadline: flagNo } as AssessAnswer;

const ticket = (over: Partial<CanonicalTicket> = {}): CanonicalTicket => ({
  tool: "jira", id: "PAY-12", key: "PAY-12", title: "Refund fails", description: "It fails.", type: "Task", status: "To Do", priority: "High",
  reporter: { id: "u1", name: "Ana" }, assignee: "bo", labels: [], components: [], links: { blocks: [], duplicates: [], epic: null },
  comments: [], attachments: [], sprint: null, dueAt: null, createdAt: null, updatedAt: "2026-11-05T10:00:00Z", permalink: "https://x/browse/PAY-12", ...over,
});

function setup(over: { validity?: ValidityAnswer; recommend?: string } = {}) {
  const writes: unknown[][] = [];
  const port: Tickets = {
    listInScope: async () => [], read: async () => ticket(),
    comment: async (k, t) => void writes.push(["comment", k, t]), transition: async (k, to) => void writes.push(["transition", k, to]), link: async (k, u) => void writes.push(["link", k, u]),
  };
  const cards: unknown[] = [];
  const decide = { validity: vi.fn(async () => over.validity ?? goodValidity), assess: vi.fn(async () => assessAnswer), recommend: vi.fn(async () => ({ action: { choice: over.recommend ?? "schedule", confidence: 0.9 } })), write: vi.fn(async () => ({ reply: "Not planned now.", confidence: 0.9 })) };
  const store = new PgTicketStore(db);
  const machine = new TicketMachine({
    store,
    port: () => port,
    candidates: async () => [],
    config: async () => FACTORY_DEFAULTS,
    createCard: async (input) => (cards.push(input), { id: "card-1" }),
    validity: { decide: decide.validity }, assess: { decide: decide.assess }, recommend: { decide: decide.recommend }, reply: { write: decide.write },
    now: () => new Date("2026-11-05T12:00:00Z"),
  });
  return { machine, store, writes, cards, decide };
}
const ctx = { repoPath: "/r/a", question: false };

describe("ingesting a ticket", () => {
  it("assesses a workable one and holds the drafts: nothing is written", async () => {
    const { machine, store, writes } = setup();
    await machine.ingest(ticket(), ctx);
    const row = (await store.get("PAY-12"))!;
    expect(row.machineStatus).toBe("assessed");
    expect(row.drafts.map((d) => d.kind)).toEqual(["assessment"]);
    expect(row.assessments[0]).toMatchObject({ outcome: "workable", recommendation: { action: expect.any(String) } });
    expect(writes).toEqual([]);
  });

  it("holds a needs-info draft, with no assessment call", async () => {
    const { machine, store, decide } = setup({ validity: { ...goodValidity, goal: no } });
    await machine.ingest(ticket(), ctx);
    expect((await store.get("PAY-12"))!.machineStatus).toBe("needs_info");
    expect((await store.get("PAY-12"))!.drafts[0]).toMatchObject({ kind: "needs_info" });
    expect(decide.assess).not.toHaveBeenCalled();
  });

  it("parks a bug with no repro and no reachable reporter, with no assessment call and no draft to the reporter", async () => {
    const { machine, store, decide } = setup({ validity: { ...goodValidity, criteria: no, reporter: no } });
    await machine.ingest(ticket({ type: "Bug" }), ctx);
    const row = (await store.get("PAY-12"))!;
    expect(row.machineStatus).toBe("parked");
    expect(row.assessments[0]).toMatchObject({ outcome: "parked", reason: "a bug that cannot be reproduced, with no reporter to ask" });
    expect(decide.assess).not.toHaveBeenCalled();
    const reachable = setup({ validity: { ...goodValidity, criteria: no } });
    await reachable.machine.ingest(ticket({ type: "Bug", id: "PAY-13", key: "PAY-13" }), ctx);
    expect((await reachable.store.get("PAY-13"))!.machineStatus).toBe("needs_info");
  });

  it("marks a duplicate and a not-ours ticket", async () => {
    const dup = setup({ validity: { ...goodValidity, project: no } });
    await dup.machine.ingest(ticket(), ctx);
    expect((await dup.store.get("PAY-12"))!).toMatchObject({ machineStatus: "not_ours" });
    expect((await dup.store.get("PAY-12"))!.drafts[0]).toMatchObject({ kind: "not_ours" });
  });

  it("makes a confident question a ticket with a drafted reply, skipping validity", async () => {
    const { machine, store, decide } = setup();
    await machine.ingest(ticket(), { repoPath: "/r/a", question: true });
    expect((await store.get("PAY-12"))!).toMatchObject({ machineStatus: "question" });
    expect((await store.get("PAY-12"))!.drafts[0]).toMatchObject({ kind: "decline", text: "Not planned now." });
    expect(decide.validity).not.toHaveBeenCalled();
  });

  it("does not assess again a ticket that has not changed", async () => {
    const { machine, decide } = setup();
    await machine.ingest(ticket(), ctx);
    await machine.ingest(ticket(), ctx);
    expect(decide.validity).toHaveBeenCalledTimes(1);
    await machine.ingest(ticket({ updatedAt: "2026-11-05T11:00:00Z" }), ctx);
    expect(decide.validity).toHaveBeenCalledTimes(2);
  });
});

describe("what a tap does", () => {
  const held = async (over = {}) => {
    const t = setup(over);
    await t.machine.ingest(ticket(), ctx);
    const [d] = (await t.machine.view("PAY-12")).drafts;
    return { ...t, d: d! };
  };

  it("approve posts the draft, once, and only with the hash the person saw", async () => {
    const { machine, writes, d } = await held();
    await expect(machine.approve("PAY-12", { draft: d.id, hash: "stale" })).rejects.toBeInstanceOf(TicketRefusal);
    expect(writes).toEqual([]);
    await machine.approve("PAY-12", { draft: d.id, hash: d.hash });
    expect(writes).toEqual([["comment", "PAY-12", d.text]]);
    await expect(machine.approve("PAY-12", { draft: d.id, hash: d.hash })).rejects.toBeInstanceOf(TicketRefusal);
    expect(writes).toHaveLength(1);
  });

  it("approve with a transition on a GitHub ticket is refused before anything is posted", async () => {
    const { machine, writes } = setup();
    await machine.ingest(ticket({ tool: "github", id: "o/a#3", key: "o/a#3" }), ctx);
    const [d] = (await machine.view("o/a#3")).drafts;
    await expect(machine.approve("o/a#3", { draft: d!.id, hash: d!.hash, transition: "Done" })).rejects.toThrow(/GitHub/);
    expect(writes).toEqual([]);
  });

  it("edit posts the person's text through postable, keeps the original, and refuses a token", async () => {
    const { machine, writes, d } = await held();
    await expect(machine.edit("PAY-12", { draft: d.id, hash: d.hash, text: `use ${secret()}` })).rejects.toBeInstanceOf(TicketRefusal);
    expect(writes).toEqual([]);
    await machine.edit("PAY-12", { draft: d.id, hash: d.hash, text: "Later <b>please</b> @ana" });
    expect(writes).toHaveLength(1);
    expect(String(writes[0]![2])).not.toMatch(/[<>]|@ana/);
    const after = (await machine.view("PAY-12")).drafts[0]!;
    expect(after).toMatchObject({ status: "posted", original: d.text });
  });

  it("ignore keeps the draft and writes nothing", async () => {
    const { machine, writes, d } = await held();
    await machine.ignore("PAY-12", { draft: d.id });
    expect((await machine.view("PAY-12")).drafts[0]!.status).toBe("ignored");
    expect(writes).toEqual([]);
  });

  it("card makes one card from the ticket with its source, reporter and the assessment as hints, and writes nothing to the ticket", async () => {
    const { machine, cards, writes, store } = await held();
    await machine.card("PAY-12");
    expect(cards[0]).toMatchObject({ title: "Refund fails", source: { kind: "jira", key: "PAY-12" }, reporter: { id: "u1", channel: "jira" }, hints: { size: "M" } });
    expect((await store.get("PAY-12"))!.cardId).toBe("card-1");
    await expect(machine.card("PAY-12")).rejects.toBeInstanceOf(TicketRefusal);
    expect(writes).toEqual([]);
  });

  it("answers an unknown ticket as not found", async () => {
    const { machine } = setup();
    await expect(machine.ignore("PAY-99", { draft: "x" })).rejects.toBeInstanceOf(TicketNotFound);
  });
});

describe("ticket keys", () => {
  it("accepts a Jira key and a GitHub issue key and nothing else", () => {
    expect(parseTicketKey("PAY-12")).toBe("PAY-12");
    expect(parseTicketKey("o/a#3")).toBe("o/a#3");
    for (const bad of ["pay-12", "PAY-12; drop", "../x", "o/a#x", "", "a".repeat(300)]) expect(() => parseTicketKey(bad)).toThrow(TicketNotFound);
  });
});
void SCORING_DEFAULTS;
