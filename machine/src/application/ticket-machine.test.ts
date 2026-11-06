import { tagged } from "./decision-truth.ts";
import { createHash } from "node:crypto";
import { type CanonicalTicket, SCORING_DEFAULTS, FACTORY_DEFAULTS } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PgTicketStore } from "../adapters/persistence/ticket-store.ts";
import { freshTestDatabase } from "../test/database.ts";
import type { AssessAnswer } from "../domain/ticket-score.ts";
import { TicketMachine, TicketNotFound, TicketRefusal, parseTicketKey, splitTargetOf } from "./ticket-machine.ts";
import { draftHash } from "./ticket-drafts.ts";
import type { Tickets } from "./tickets.ts";
import type { ValidityAnswer } from "./ticket-validity.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
let intakeLabel: string | undefined;
beforeEach(async () => {
  intakeLabel = undefined;
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

function setup(over: { validity?: ValidityAnswer; validityRecord?: string; recommend?: string; silent?: boolean; noRecord?: boolean; reply?: string; hold?: Promise<void>; split?: { children?: Array<Record<string, unknown>> | "none"; failAt?: number; failTimes?: number }; size?: { answer?: Record<string, unknown>; fail?: boolean; candidates?: Array<{ id: string; kind: "open" | "closed" | "backlog"; title: string; text: string; repo: string | null; closedAt: Date | null }>; counted?: Record<string, { added: number; removed: number }> } } = {}) {
  const learned: Array<Record<string, any>> = [];
  const kept: Array<Record<string, any>> = [];
  const half = { score: 0.5, confidence: 1 };
  const silentAnswer = { ...assessAnswer, who: half, what: half, impact: half, time: half, demand: half, files: half, unknowns: half, cross_team: half, new_infra: half, dependents: half, traffic: half, data_sensitivity: half, reversibility: half, regression: { score: 1, confidence: 1 }, compounding: { score: 0, confidence: 1 } } as AssessAnswer;
  const writes: unknown[][] = [];
  const creates: Array<{ origin: string; title: string; body: string }> = [];
  let failures = 0;
  const port: Tickets = {
    listInScope: async () => [], create: async (origin, child) => {
      if (over.split?.failAt !== undefined && creates.length + 1 === over.split.failAt && failures < (over.split.failTimes ?? 1)) { failures++; throw new Error("the tracker said no"); }
      await over.hold;
      creates.push({ origin: origin.key, ...child });
      return { key: `PAY-${100 + creates.length}`, permalink: `https://x/browse/PAY-${100 + creates.length}` };
    }, read: async (k) => (k === "PAY-12" ? ticket() : ticket({ id: k, key: k, title: `child ${k}` })),
    comment: async (k, t) => { await over.hold; writes.push(["comment", k, t]); }, transition: async (k, to) => void writes.push(["transition", k, to]), link: async (k, u) => void writes.push(["link", k, u]),
  };
  const cards: unknown[] = [];
  const items: Array<Record<string, any>> = [];
  const decide = { validity: vi.fn(async () => (over.validityRecord ? tagged({ answer: (over.validity ?? goodValidity) as never, recordId: over.validityRecord }) as unknown as ValidityAnswer : over.validity ?? goodValidity)), assess: vi.fn(async () => (over.silent ? silentAnswer : assessAnswer)), recommend: vi.fn(async () => ({ action: { choice: over.recommend ?? "schedule", confidence: 0.9 }, ...(over.noRecord ? {} : { recordId: "rec-1" }) })), write: vi.fn(async () => ({ reply: over.reply ?? "Not planned now.", confidence: 0.9 })) };
  const sizeDecide = vi.fn(async (_context: unknown, _repoPath: string | null) => {
    if (over.size?.fail) throw new Error("no model");
    return over.size?.answer ?? sizeAnswer(2);
  });
  const store = new PgTicketStore(db);
  const machine = new TicketMachine({
    store,
    port: () => port,
    candidates: async () => over.size?.candidates ?? [],
    config: async () => FACTORY_DEFAULTS,
    ...(over.size ? { size: { decide: sizeDecide, counted: async (ids: string[]) => ids.flatMap((id) => (over.size!.counted?.[id] ? [{ id, ...over.size!.counted[id]! }] : [])) } } : {}),
    ...(over.split ? { split: { decompose: async () => ({ children: over.split!.children === "none" ? [] : over.split!.children ?? SPLIT_KIDS }), check: null } } : {}),
    createCard: async (input) => (cards.push(input), { id: "card-1" }),
    validity: { decide: decide.validity }, assess: { decide: decide.assess }, recommend: { decide: decide.recommend }, reply: { write: decide.write },
    truth: { learned: async (f) => (learned.push(f), true), draft: async (e) => void kept.push(e) },
    backlog: { upsertFromSource: async (input, o) => { const i = items.findIndex((x) => JSON.stringify(x.sources) === JSON.stringify(input.sources)); if (i >= 0) { items[i] = { ...input, id: "b1" }; return { id: "b1", created: false }; } if (!o.createIfMissing) return null; items.push({ ...input, id: "b1" }); return { id: "b1", created: true }; } },
    now: () => new Date("2026-11-05T12:00:00Z"),
    ...(intakeLabel ? { intakeLabel } : {}),
  });
  return { machine, store, writes, cards, decide, items, learned, kept, port, sizeDecide, creates };
}
const ctx = { repoPath: "/r/a", question: false };
const kid = (title: string, over: Record<string, unknown> = {}) => ({ title, goal: `do ${title} in the refund service and keep the existing behaviour for every other payment path`, acceptance_criteria: [`${title} works`], covers: [], files_hint: ["src/a.ts"], est_loc: 800, depends_on: [], order: 1, ...over });
const SPLIT_KIDS = [kid("Part A"), kid("Part B", { depends_on: [1], order: 2 })];
const sizeAnswer = (loc: number, confidence = 0.95, reviewable = true) => ({ est_loc: { score: loc, confidence }, est_files: { score: 1, confidence }, reviewable: { value: reviewable, p: reviewable ? 0.95 : 0.05 } });

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

  it("teaches ticket_validity's reporter question from the tool's own fact (a reporter is on the ticket, or is not), on the validity record, naming the repository", async () => {
    const present = setup({ validityRecord: "rec-v" });
    await present.machine.ingest(ticket(), ctx);
    expect(present.learned).toEqual([{ pack: "ticket_validity", recordId: "rec-v", label: { reporter: { value: true } }, kind: "fact", source: "ticket_fact", repoPath: "/r/a" }]);
    const absent = setup({ validityRecord: "rec-v" });
    await absent.machine.ingest(ticket({ id: "PAY-40", key: "PAY-40", reporter: null }), ctx);
    expect(absent.learned).toEqual([expect.objectContaining({ label: { reporter: { value: false } } })]);
    const none = setup();
    await none.machine.ingest(ticket({ id: "PAY-41", key: "PAY-41" }), ctx);
    expect(none.learned).toEqual([]);
  });

  it("names the ticket's repository on what it keeps and on what it teaches, so the repository's learning.truth can apply", async () => {
    const x = await held({ recommend: "decline" });
    await x.machine.schedule("PAY-12");
    expect(x.learned).toEqual([expect.objectContaining({ recordId: "rec-1", repoPath: "/r/a" })]);
    const [d] = (await x.machine.view("PAY-12")).drafts;
    await x.machine.edit("PAY-12", { draft: d!.id, hash: d!.hash, text: "Later, please." }).catch(() => {});
    expect(x.kept.every((k) => k.repoPath === "/r/a")).toBe(true);
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

describe("the size estimate of a ticket (wave 15)", () => {
  const last = async (x: ReturnType<typeof setup>) => (await x.store.get("PAY-12"))!.assessments.at(-1)!;
  it("is asked after the assessment, kept on it, and its numbers end the assessment comment", async () => {
    const x = setup({ size: { answer: sizeAnswer(2) } });
    await x.machine.ingest(ticket(), ctx);
    expect(await last(x)).toMatchObject({ outcome: "workable", sizeEstimate: { estLoc: expect.any(Number), estFiles: expect.any(Number), reviewable: true, confidence: 0.95 } });
    const draft = (await x.store.get("PAY-12"))!.drafts.find((d) => d.kind === "assessment")!;
    expect(draft.text).toMatch(/Estimated size: about \d+ lines in \d+ files\.$/);
    expect(x.writes).toEqual([]);
  });

  it("makes the recommendation split, in fixed words and without asking ticket_recommend, when the estimate is sure and over the hard limit", async () => {
    const x = setup({ size: { answer: sizeAnswer(6) } });
    await x.machine.ingest(ticket(), ctx);
    expect(await last(x)).toMatchObject({ recommendation: { action: "split", reason: expect.stringMatching(/about \d+ lines.*2500/) } });
    expect(x.decide.recommend).not.toHaveBeenCalled();
    expect(x.writes).toEqual([]);
  });

  it("makes it split when a sure answer says one reviewer cannot read it as one change", async () => {
    const x = setup({ size: { answer: sizeAnswer(2, 0.95, false) } });
    await x.machine.ingest(ticket(), ctx);
    expect(await last(x)).toMatchObject({ recommendation: { action: "split", reason: expect.stringContaining("one change") } });
  });

  it("changes nothing when the estimate is unsure or fails: the recommendation is asked as before", async () => {
    const unsure = setup({ size: { answer: sizeAnswer(6, 0.1) } });
    await unsure.machine.ingest(ticket(), ctx);
    expect((await last(unsure)).recommendation).not.toMatchObject({ action: "split" });
    const failed = setup({ size: { fail: true } });
    await failed.machine.ingest(ticket({ id: "PAY-13", key: "PAY-13" }), ctx);
    const failedRow = (await failed.store.get("PAY-13"))!;
    expect(failedRow.assessments.at(-1)).toMatchObject({ outcome: "workable" });
    expect(failedRow.assessments.at(-1)).not.toHaveProperty("sizeEstimate");
    expect(failedRow.drafts.find((d) => d.kind === "assessment")!.text).not.toContain("Estimated size");
  });

  it("gives the prompt only closed cards among the ticket's own candidates, with their counted lines", async () => {
    const now = new Date("2026-11-04T00:00:00Z");
    const x = setup({
      size: {
        candidates: [
          { id: "c-closed", kind: "closed", title: "Refund fails for partial payments", text: "refund fails", repo: "/r/a", closedAt: now },
          { id: "c-open", kind: "open", title: "Refund fails again", text: "refund fails", repo: "/r/a", closedAt: null },
          { id: "c-uncounted", kind: "closed", title: "Refund fails with no diff", text: "refund fails", repo: "/r/a", closedAt: now },
        ],
        counted: { "c-closed": { added: 120, removed: 30 }, "c-open": { added: 5, removed: 5 } },
      },
    });
    await x.machine.ingest(ticket({ title: "Refund fails", description: "refund fails" }), { repoPath: "/r/a", question: false });
    const context = x.sizeDecide.mock.calls[0]![0] as { similar: Array<{ title: string; added: number; removed: number }> };
    expect(context.similar).toEqual([{ title: "Refund fails for partial payments", added: 120, removed: 30 }]);
  });

  it("with no size decision wired, an assessment is exactly as before", async () => {
    const x = setup();
    await x.machine.ingest(ticket(), ctx);
    expect(await last(x)).not.toHaveProperty("sizeEstimate");
  });
});

describe("a ticket's split (wave 15)", () => {
  const proposed = async (over: Parameters<typeof setup>[0] = {}) => {
    const x = setup({ size: { answer: sizeAnswer(6) }, split: {}, ...over });
    await x.machine.ingest(ticket(), ctx);
    const row = (await x.store.get("PAY-12"))!;
    return { x, row, draft: (row.drafts as any[]).find((d) => d.kind === "split") };
  };
  const tap = (draft: any) => ({ draft: draft.id, hash: draftHash(draft) });
  const seen = async (x: { machine: TicketMachine }) => ((await x.machine.view("PAY-12")).drafts as any[]).find((d) => d.kind === "split" && d.status !== "posted");

  it("the row a client reads carries each child's goal and criteria and the project the tap creates them in", async () => {
    const { x } = await proposed();
    const view = await x.machine.view("PAY-12");
    expect((view.drafts as any[]).find((d) => d.kind === "split").children[0]).toMatchObject({ title: "Part A", goal: expect.stringContaining("do Part A"), acceptance_criteria: ["Part A works"] });
    expect(view.splitTarget).toBe("PAY");
    expect(splitTargetOf("acme/widgets#7")).toBe("acme/widgets");
    expect(splitTargetOf("PAY-12")).toBe("PAY");
    expect((await x.machine.view("PAY-12")).splitTarget).toBe("PAY");
  });

  it("a split proposal for a ticket writes nothing before the tap: a draft with the children, the status split_proposed, no create, no comment", async () => {
    const { x, row, draft } = await proposed();
    expect(row.machineStatus).toBe("split_proposed");
    expect(draft).toMatchObject({ kind: "split", status: "waiting", children: [{ title: "Part A" }, { title: "Part B" }] });
    expect(draft.text).toMatch(/^1\. Part A/);
    expect(draft.text).toContain("after 1");
    expect(x.creates).toEqual([]);
    expect(x.writes).toEqual([]);
  });

  it("with no valid split there is no draft: the assessment says why and a person decides", async () => {
    const { x, row, draft } = await proposed({ split: { children: [kid("Only one")] } });
    expect(draft).toBeUndefined();
    expect(row.machineStatus).toBe("needs_decision");
    expect(row.assessments.at(-1)).toMatchObject({ split: { failed: expect.any(String) } });
    expect(x.creates).toEqual([]);
  });

  it("the tap creates the children in dependency order, once each, in the origin's own project, then marks the origin epic and says so once", async () => {
    const { x, draft } = await proposed();
    await x.machine.approve("PAY-12", tap(draft));
    expect(x.creates.map((c) => c.title)).toEqual(["Part A", "Part B"]);
    expect(x.creates.every((c) => c.origin === "PAY-12")).toBe(true);
    expect(x.creates[0]!.body).toContain("Part 1 of 2 of PAY-12");
    expect(x.creates[1]!.body).toContain("After: PAY-101");
    const row = (await x.store.get("PAY-12"))!;
    expect(row.machineStatus).toBe("epic");
    expect(row.machineLinks.filter((l) => l.kind === "child").map((l) => l.target)).toEqual(["PAY-101", "PAY-102"]);
    expect(x.writes.filter((w) => w[0] === "comment")).toEqual([["comment", "PAY-12", "Split into: PAY-101, PAY-102."]]);
    expect((row.drafts as any[]).find((d) => d.kind === "split")).toMatchObject({ status: "posted", created: [{ n: 1, key: "PAY-101" }, { n: 2, key: "PAY-102" }] });
    // Each child is read back, linked to its origin and the sibling it waits for, and assessed as any ticket.
    const b = (await x.store.get("PAY-102"))!;
    expect(b.machineLinks).toEqual(expect.arrayContaining([{ kind: "origin", target: "PAY-12" }, { kind: "depends_on", target: "PAY-101" }]));
    expect(b.machineStatus).toBe("needs_decision");
  });

  it("refuses a tap on a draft the person did not see (another hash), and creates nothing", async () => {
    const { x, draft } = await proposed();
    await expect(x.machine.approve("PAY-12", { draft: draft.id, hash: "0000000000000000" })).rejects.toBeInstanceOf(TicketRefusal);
    expect(x.creates).toEqual([]);
  });

  it("a failure partway leaves the draft waiting with what was made, and the retry makes only the rest", async () => {
    const { x, draft } = await proposed({ split: { failAt: 2 } });
    await expect(x.machine.approve("PAY-12", tap(draft))).rejects.toBeInstanceOf(TicketRefusal);
    const mid = (await x.store.get("PAY-12"))!;
    expect((mid.drafts as any[]).find((d) => d.kind === "split")).toMatchObject({ status: "waiting", created: [{ n: 1, key: "PAY-101" }] });
    expect(mid.machineStatus).not.toBe("epic");
    await x.machine.approve("PAY-12", tap(draft));
    expect(x.creates.map((c) => c.title)).toEqual(["Part A", "Part B"]);
    expect((await x.store.get("PAY-12"))!.machineStatus).toBe("epic");
  });

  it("two taps at once create the set once", async () => {
    const { x, draft } = await proposed();
    const both = await Promise.allSettled([x.machine.approve("PAY-12", tap(draft)), x.machine.approve("PAY-12", tap(draft))]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(x.creates).toHaveLength(2);
  });

  it("refuses the whole split before any call when a child's text carries a token", async () => {
    const { x, draft } = await proposed();
    // The loop already redacts what it reads; this is a draft that was written some other way.
    await x.store.updateDrafts("PAY-12", (current) => (current as any[]).map((d) => (d.id === draft.id ? { ...d, children: [d.children[0], { ...d.children[1], goal: `use ${secret()}` }] } : d)));
    await expect(x.machine.approve("PAY-12", tap(draft))).rejects.toBeInstanceOf(TicketRefusal);
    expect(x.creates).toEqual([]);
  });

  it("flattens and caps a child's title and keeps an address out of it", async () => {
    const { x, draft } = await proposed({ split: { children: [kid("Part A @everyone see https://evil.example/x #9"), kid("Part B", { depends_on: [1], order: 2 })] } });
    await x.machine.approve("PAY-12", tap(draft));
    expect(x.creates[0]!.title).not.toMatch(/@everyone|https:\/\/|#9/);
  });

  it("refuses an edit of a split draft; an ignore keeps it and creates nothing", async () => {
    const { x, draft } = await proposed();
    await expect(x.machine.edit("PAY-12", { ...tap(draft), text: "other" })).rejects.toBeInstanceOf(TicketRefusal);
    await x.machine.ignore("PAY-12", { draft: draft.id });
    expect(x.creates).toEqual([]);
    expect(((await x.store.get("PAY-12"))!.drafts as any[]).find((d) => d.kind === "split")).toMatchObject({ status: "ignored" });
  });

  it("the card gate's way: the same creation under the gate's id, once, keeping the floor on each child", async () => {
    const { x } = await proposed();
    const made = await x.machine.splitChildren("PAY-12", SPLIT_KIDS as never, { id: "gate-1", floor: "high" });
    expect(made.keys).toEqual(["PAY-101", "PAY-102"]);
    const again = await x.machine.splitChildren("PAY-12", SPLIT_KIDS as never, { id: "gate-1", floor: "high" });
    expect(again.keys).toEqual(["PAY-101", "PAY-102"]);
    expect(x.creates).toHaveLength(2);
    expect((await x.store.get("PAY-101"))!.machineLinks).toEqual(expect.arrayContaining([{ kind: "risk_floor", target: "high" }]));
  });

  it("links every child from what create returned, without reading it back (a GitHub port cannot), with the origin's repo, dependency and a floor of at least medium", async () => {
    intakeLabel = "ready-for-agent";
    const { x, draft } = await proposed();
    x.port.read = async (k) => { if (k === "PAY-12") return ticket(); throw new Error("the port cannot read a child by key"); };
    await x.store.setMachine("PAY-12", { links: [{ kind: "repo", target: "/r/a" }] });
    await x.machine.approve("PAY-12", tap(draft));
    const b = (await x.store.get("PAY-102"))!;
    expect(b.machineLinks).toEqual(expect.arrayContaining([{ kind: "origin", target: "PAY-12" }, { kind: "depends_on", target: "PAY-101" }, { kind: "risk_floor", target: "medium" }, { kind: "repo", target: "/r/a" }]));
    expect((await x.store.get("PAY-101"))!.machineLinks).toEqual(expect.arrayContaining([{ kind: "origin", target: "PAY-12" }, { kind: "risk_floor", target: "medium" }]));
    expect((await x.store.get("PAY-12"))!.machineLinks).toEqual(expect.arrayContaining([{ kind: "split_done", target: draft.id }]));
  });

  it("a split of a ticket with no card gives every child the floor of its origin's assessed blast radius: high stays high", async () => {
    const { x, draft } = await proposed();
    const last = (await x.store.get("PAY-12"))!.assessments.at(-1)!;
    await x.store.appendAssessment("PAY-12", { ...last, blastRadius: "high" });
    await x.machine.approve("PAY-12", tap(draft));
    for (const k of ["PAY-101", "PAY-102"]) expect((await x.store.get(k))!.machineLinks).toEqual(expect.arrayContaining([{ kind: "risk_floor", target: "high" }]));
  });

  it("a GitHub child is created with the intake's label so it is seen; a Jira child with none", async () => {
    intakeLabel = "ready-for-agent";
    const seen: unknown[] = [];
    const gh = setup({ size: { answer: sizeAnswer(6) }, split: {} });
    const make = gh.port.create;
    gh.port.create = async (origin, child, options) => (seen.push(options), make(origin, child, options));
    await gh.machine.ingest(ticket({ tool: "github", id: "o/r#12", key: "o/r#12", permalink: "https://github.com/o/r/issues/12" }), ctx);
    const row = (await gh.store.get("o/r#12"))!;
    await gh.machine.approve("o/r#12", tap((row.drafts as any[]).find((d) => d.kind === "split")));
    expect(seen).toEqual([{ labels: ["ready-for-agent"] }, { labels: ["ready-for-agent"] }]);
    const jira = await proposed();
    const jiraSeen: unknown[] = [];
    const makeJ = jira.x.port.create;
    jira.x.port.create = async (origin, child, options) => (jiraSeen.push(options), makeJ(origin, child, options));
    await jira.x.machine.approve("PAY-12", tap(jira.draft));
    expect(jiraSeen).toEqual([{}, {}]);
  });

  it("a re-drafted split gets its own id and hash: a first tap that failed after one child leaves nothing the second proposal reuses", async () => {
    const kids = [kid("Part A"), kid("Part B", { depends_on: [1], order: 2 })];
    const { x } = await proposed({ split: { children: kids, failAt: 2 } });
    const first = await seen(x);
    await expect(x.machine.approve("PAY-12", tap(first))).rejects.toBeInstanceOf(TicketRefusal);
    expect(x.creates.map((c) => c.title)).toEqual(["Part A"]);
    // The ticket is read again and the decomposer now gives other children.
    kids.splice(0, 2, kid("Other X"), kid("Other Y", { depends_on: [1], order: 2 }));
    await x.machine.ingest(ticket(), { ...ctx, force: true });
    const second = await seen(x);
    expect(second.id).not.toBe(first.id);
    expect(second.hash).not.toBe(first.hash);
    await expect(x.machine.approve("PAY-12", tap(first))).rejects.toBeInstanceOf(TicketRefusal);
    await x.machine.approve("PAY-12", tap(second));
    expect(x.creates.map((c) => c.title)).toEqual(["Part A", "Other X", "Other Y"]);
    const row = (await x.store.get("PAY-12"))!;
    expect(row.machineLinks.filter((l) => l.kind === "child").map((l) => l.target).sort()).toEqual(["PAY-101", "PAY-102", "PAY-103"].sort());
    expect(row.machineLinks.some((l) => l.kind === "split_part" && l.target.startsWith(`${second.id}:1:PAY-102`))).toBe(true);
  });

  it("the hash covers the children, not only the shown text: the old text-only hash is refused, and a draft stored before this fix is never approved", async () => {
    const { x, draft } = await proposed();
    const textOnly = createHash("sha256").update(draft.text).digest("hex").slice(0, 16);
    await expect(x.machine.approve("PAY-12", { draft: draft.id, hash: textOnly })).rejects.toBeInstanceOf(TicketRefusal);
    const row = (await x.store.get("PAY-12"))!;
    const old = { ...draft, id: "PAY-12:split", status: "waiting" };
    delete (old as any).rev;
    await x.store.setDrafts("PAY-12", [old, ...(row.drafts as any[]).filter((d) => d.kind !== "split")]);
    await expect(x.machine.approve("PAY-12", { draft: old.id, hash: textOnly })).rejects.toBeInstanceOf(TicketRefusal);
    expect(x.creates).toEqual([]);
  });

  it("a ticket that depends on another needs that ticket's card first; then its card waits on it with the floor kept", async () => {
    const { x } = await proposed();
    await x.machine.splitChildren("PAY-12", SPLIT_KIDS as never, { id: "gate-1", floor: "high" });
    await expect(x.machine.card("PAY-102")).rejects.toThrow(/PAY-101/);
    await x.store.setMachine("PAY-101", { cardId: "card-a" });
    await x.machine.card("PAY-102");
    expect(x.cards.at(-1)).toMatchObject({ stack: { dependsOn: ["card-a"], riskFloor: "high" } });
  });
});
