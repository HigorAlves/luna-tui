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

function setup(over: { validity?: ValidityAnswer; recommend?: string; silent?: boolean; noRecord?: boolean; reply?: string; hold?: Promise<void> } = {}) {
  const learned: Array<Record<string, any>> = [];
  const kept: Array<Record<string, any>> = [];
  const half = { score: 0.5, confidence: 1 };
  const silentAnswer = { ...assessAnswer, who: half, what: half, impact: half, time: half, demand: half, files: half, unknowns: half, cross_team: half, new_infra: half, dependents: half, traffic: half, data_sensitivity: half, reversibility: half, regression: { score: 1, confidence: 1 }, compounding: { score: 0, confidence: 1 } } as AssessAnswer;
  const writes: unknown[][] = [];
  const port: Tickets = {
    listInScope: async () => [], read: async () => ticket(),
    comment: async (k, t) => { await over.hold; writes.push(["comment", k, t]); }, transition: async (k, to) => void writes.push(["transition", k, to]), link: async (k, u) => void writes.push(["link", k, u]),
  };
  const cards: unknown[] = [];
  const items: Array<Record<string, any>> = [];
  const decide = { validity: vi.fn(async () => over.validity ?? goodValidity), assess: vi.fn(async () => (over.silent ? silentAnswer : assessAnswer)), recommend: vi.fn(async () => ({ action: { choice: over.recommend ?? "schedule", confidence: 0.9 }, ...(over.noRecord ? {} : { recordId: "rec-1" }) })), write: vi.fn(async () => ({ reply: over.reply ?? "Not planned now.", confidence: 0.9 })) };
  const store = new PgTicketStore(db);
  const machine = new TicketMachine({
    store,
    port: () => port,
    candidates: async () => [],
    config: async () => FACTORY_DEFAULTS,
    createCard: async (input) => (cards.push(input), { id: "card-1" }),
    validity: { decide: decide.validity }, assess: { decide: decide.assess }, recommend: { decide: decide.recommend }, reply: { write: decide.write },
    truth: { learned: async (f) => (learned.push(f), true), draft: async (e) => void kept.push(e) },
    backlog: { upsertFromSource: async (input, o) => { const i = items.findIndex((x) => JSON.stringify(x.sources) === JSON.stringify(input.sources)); if (i >= 0) { items[i] = { ...input, id: "b1" }; return { id: "b1", created: false }; } if (!o.createIfMissing) return null; items.push({ ...input, id: "b1" }); return { id: "b1", created: true }; } },
    now: () => new Date("2026-11-05T12:00:00Z"),
  });
  return { machine, store, writes, cards, decide, items, learned, kept, port };
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

describe("scheduling into the shared backlog", () => {
  it("places a ticket in the backlog on a tap, with its sub-scores as scores, its size and its ticket as the source, and writes nothing to the ticket", async () => {
    const { machine, items, writes, store } = setup();
    await machine.ingest(ticket(), ctx);
    await machine.schedule("PAY-12");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Refund fails", size: "M", scores: { who: 2, what: 2, impact: 2, time: 2, demand: 2 }, sources: [{ kind: "jira", key: "PAY-12" }] });
    expect((await store.get("PAY-12"))!.machineStatus).toBe("scheduled");
    expect(writes).toEqual([]);
  });

  it("updates the item, not adds one, when the ticket is scheduled again or assessed again", async () => {
    const { machine, items, decide } = setup();
    await machine.ingest(ticket(), ctx);
    await machine.schedule("PAY-12");
    await machine.schedule("PAY-12");
    expect(items).toHaveLength(1);
    decide.assess.mockResolvedValueOnce({ ...assessAnswer, who: { score: 2, confidence: 1 } } as never);
    await machine.ingest(ticket({ updatedAt: "2026-11-06T10:00:00Z" }), ctx);
    expect(items).toHaveLength(1);
    expect(items[0]!.scores.who).toBe(3);
    expect((await machine.view("PAY-12")).status).toBe("scheduled");
  });

  it("refuses to schedule a ticket that was not assessed as workable", async () => {
    const { machine } = setup({ validity: { ...goodValidity, goal: no } });
    await machine.ingest(ticket(), ctx);
    await expect(machine.schedule("PAY-12")).rejects.toBeInstanceOf(TicketRefusal);
  });

  it("drafts the decline reply when its backlog item is declined, posting nothing", async () => {
    const { machine, writes } = setup();
    await machine.ingest(ticket(), ctx);
    await machine.declineFromBacklog([{ kind: "jira", key: "PAY-12", url: "u", issueType: null }]);
    const drafts = (await machine.view("PAY-12")).drafts;
    expect(drafts.map((d) => d.kind)).toContain("decline");
    expect(writes).toEqual([]);
  });
});

describe("clocks", () => {
  const DAY = 86_400_000;
  const at = (days: number) => new Date(Date.parse("2026-11-05T12:00:00Z") + days * DAY);
  it("an overdue clock is a row on the ticket, and a reminder or a park is a draft: a clock writes nothing", async () => {
    const { machine, writes, store } = setup({ validity: { ...goodValidity, goal: no } });
    await machine.ingest(ticket(), ctx);
    const first = await machine.sweepClocks(at(4));
    expect(first).toEqual([{ key: "PAY-12", overdue: expect.arrayContaining(["acknowledge", "needs_info_reminder"]) }]);
    expect((await machine.view("PAY-12")).drafts.map((d) => d.kind)).toEqual(["needs_info", "reminder"]);
    await machine.sweepClocks(at(4));
    expect((await machine.view("PAY-12")).drafts.filter((d) => d.kind === "reminder")).toHaveLength(1);
    await machine.sweepClocks(at(11));
    expect((await machine.view("PAY-12")).drafts.map((d) => d.kind)).toEqual(["needs_info", "reminder", "park"]);
    expect((await store.get("PAY-12"))!.machineStatus).toBe("needs_info");
    expect(writes).toEqual([]);
  });

  it("a person's tap acknowledges the ticket, and approving a park draft is what parks it", async () => {
    const { machine, writes, store } = setup({ validity: { ...goodValidity, goal: no } });
    await machine.ingest(ticket(), ctx);
    await machine.sweepClocks(at(11));
    const park = (await machine.view("PAY-12")).drafts.find((d) => d.kind === "park")!;
    await machine.approve("PAY-12", { draft: park.id, hash: park.hash });
    expect((await store.get("PAY-12"))!.machineStatus).toBe("parked");
    expect(writes).toHaveLength(1);
    expect(((await store.get("PAY-12"))!.clocks as Record<string, unknown>).acknowledgedAt).toBeTruthy();
  });
});

describe("what a tap says about the decisions behind it", () => {
  const held = async (over = {}) => {
    const x = setup({ silent: true, ...over });
    await x.machine.ingest(ticket(), ctx);
    return x;
  };

  it("a card tap, when ticket_recommend said do now, confirms its label", async () => {
    const x = await held({ recommend: "do_now" });
    await x.machine.card("PAY-12");
    expect(x.learned).toEqual([expect.objectContaining({ pack: "ticket_recommend", recordId: "rec-1", label: { action: { choice: "do_now" } }, source: "ticket_confirmed" })]);
  });

  it("a backlog tap against what it recommended is the label of what the person chose: an override", async () => {
    const x = await held({ recommend: "decline" });
    await x.machine.schedule("PAY-12");
    expect(x.learned).toEqual([expect.objectContaining({ recordId: "rec-1", label: { action: { choice: "schedule" } }, source: "ticket_override" })]);
  });

  it("a tap with no decision record behind it (the rule decided, no engine ran) labels nothing", async () => {
    const x = await held({ noRecord: true });
    await x.machine.card("PAY-12");
    expect(x.learned).toEqual([]);
    const rule = setup();
    await rule.machine.ingest(ticket({ id: "PAY-20", key: "PAY-20" }), ctx);
    await rule.machine.card("PAY-20");
    expect(rule.learned).toEqual([]);
  });

  it("keeps an approved draft as sent, an edited one with its difference, and an ignored one, with the draft", async () => {
    const x = await held();
    const [d] = (await x.machine.view("PAY-12")).drafts;
    await x.machine.edit("PAY-12", { draft: d!.id, hash: d!.hash, text: "Later, please." });
    expect(x.kept).toEqual([expect.objectContaining({ key: "PAY-12", kind: "assessment", did: "edited", original: d!.text, final: "Later, please." })]);
    const y = setup({ silent: true });
    await y.machine.ingest(ticket({ id: "PAY-30", key: "PAY-30" }), ctx);
    const [e] = (await y.machine.view("PAY-30")).drafts;
    await y.machine.approve("PAY-30", { draft: e!.id, hash: e!.hash });
    await y.machine.ingest(ticket({ id: "PAY-21", key: "PAY-21" }), ctx);
    const [g] = (await y.machine.view("PAY-21")).drafts;
    await y.machine.ignore("PAY-21", { draft: g!.id });
    expect(y.kept.map((k) => k.did)).toEqual(["sent", "ignored"]);
  });

  it("an approved decline draft, when it recommended declining, confirms decline; an approved park confirms needs decision", async () => {
    const x = await held({ recommend: "decline" });
    const decline = (await x.machine.view("PAY-12")).drafts.find((d) => d.kind === "decline")!;
    await x.machine.approve("PAY-12", { draft: decline.id, hash: decline.hash });
    expect(x.learned).toEqual([expect.objectContaining({ label: { action: { choice: "decline" } }, source: "ticket_confirmed" })]);
  });

  it("card and backlog taps also acknowledge the ticket", async () => {
    const x = await held();
    await x.machine.card("PAY-12");
    expect((await x.store.get("PAY-12"))!.clocks.acknowledgedAt).toBeTruthy();
    await x.machine.ingest(ticket({ id: "PAY-22", key: "PAY-22" }), ctx);
    await x.machine.schedule("PAY-22");
    expect((await x.store.get("PAY-22"))!.clocks.acknowledgedAt).toBeTruthy();
  });
});

describe("a reply that asks for a link", () => {
  it("is not kept: the ticket gets no decline draft, and the row says why in fixed words", async () => {
    const x = setup({ silent: true, recommend: "decline", reply: "Sure, see https://evil.example/login" });
    await x.machine.ingest(ticket(), ctx);
    const v = await x.machine.view("PAY-12");
    expect(v.drafts.map((d) => d.kind)).not.toContain("decline");
    expect(v.assessments.at(-1)).toMatchObject({ draftRefused: "the reply held an address, so it was not kept" });
  });
});

describe("posting once", () => {
  it("two taps in flight post once: the second is refused", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const x = setup({ hold });
    await x.machine.ingest(ticket(), ctx);
    const [d] = (await x.machine.view("PAY-12")).drafts;
    const first = x.machine.approve("PAY-12", { draft: d!.id, hash: d!.hash });
    const second = x.machine.approve("PAY-12", { draft: d!.id, hash: d!.hash });
    const refused = await second.then(() => null, (e) => e);
    release();
    await first;
    expect(refused).toBeInstanceOf(TicketRefusal);
    expect(x.writes).toHaveLength(1);
    expect((await x.machine.view("PAY-12")).drafts[0]!.status).toBe("posted");
  });

  it("a comment that went out stays posted when the transition after it fails: a second tap cannot post it again", async () => {
    const x = setup();
    await x.machine.ingest(ticket(), ctx);
    const [d] = (await x.machine.view("PAY-12")).drafts;
    x.port.transition = async () => {
      throw new Error("no such transition");
    };
    await expect(x.machine.approve("PAY-12", { draft: d!.id, hash: d!.hash, transition: "Done" })).rejects.toThrow(/posted.*transition|transition.*posted/i);
    expect((await x.machine.view("PAY-12")).drafts[0]!.status).toBe("posted");
    await expect(x.machine.approve("PAY-12", { draft: d!.id, hash: d!.hash })).rejects.toBeInstanceOf(TicketRefusal);
    expect(x.writes.filter((w) => w[0] === "comment")).toHaveLength(1);
  });

  it("an ingest between the read and the write keeps the posting mark, and then the posted one", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const x = setup({ hold });
    await x.machine.ingest(ticket(), ctx);
    const [d] = (await x.machine.view("PAY-12")).drafts;
    const tap = x.machine.approve("PAY-12", { draft: d!.id, hash: d!.hash });
    await new Promise((r) => setTimeout(r, 50));
    expect((await x.machine.view("PAY-12")).drafts[0]!.status).toBe("posting");
    await x.machine.ingest(ticket({ updatedAt: "2026-11-06T10:00:00Z" }), ctx);
    expect((await x.machine.view("PAY-12")).drafts[0]!.status).toBe("posting");
    release();
    await tap;
    const after = await x.machine.view("PAY-12");
    expect(after.drafts.filter((k) => k.id === d!.id)).toHaveLength(1);
    expect(after.drafts.find((k) => k.id === d!.id)!.status).toBe("posted");
  });

  it("a failed post goes back to waiting, and can be tapped again", async () => {
    const x = setup();
    await x.machine.ingest(ticket(), ctx);
    const [d] = (await x.machine.view("PAY-12")).drafts;
    const real = x.port.comment;
    x.port.comment = async () => { throw new Error("jira down"); };
    await expect(x.machine.approve("PAY-12", { draft: d!.id, hash: d!.hash })).rejects.toThrow("jira down");
    expect((await x.machine.view("PAY-12")).drafts[0]!.status).toBe("waiting");
    x.port.comment = real;
    await x.machine.approve("PAY-12", { draft: d!.id, hash: d!.hash });
    expect((await x.machine.view("PAY-12")).drafts[0]!.status).toBe("posted");
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
