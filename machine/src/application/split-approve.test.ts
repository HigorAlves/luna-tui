// Approving a split makes its child cards (wave 15, slice 5): once, in dependency order, each with the origin's repository and
// engines and nothing else. The origin ends `split`, and only the approval makes anything.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Pipeline, SplitNotValidError } from "./pipeline.ts";
import type { StageContext, StageResult } from "./ports.ts";
import { StubStages } from "./stages/stubs.ts";
import { previewOn } from "../test/policies.ts";
import { freshTestDatabase } from "../test/database.ts";
import { cardOf } from "../domain/card-fields.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;
const seen: Array<{ id: string; stage: string }> = [];

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
const runner = (stage: Parameters<StubStages["runnerFor"]>[0]) => {
  const inner = stubs.runnerFor(stage);
  return async (context: StageContext) => (seen.push({ id: context.task.id, stage }), inner(context));
};
const make = (options: Record<string, unknown> = {}) => new Pipeline(db, runner, { inline: true, policies: previewOn, hasConfig: () => true, ...options });
beforeEach(async () => {
  await pipeline?.shutdown();
  await db.query("truncate tasks cascade");
  stubs.reset();
  seen.length = 0;
  pipeline = make();
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const part = (n: number, over: Record<string, unknown> = {}) => ({ title: `Part ${n}`, goal: words(25), acceptance_criteria: [`works ${n}`], covers: [`C${n}`], files_hint: [`src/part${n}.ts`], est_loc: 400, depends_on: [] as number[], order: n, ...over });
const gate = (children: unknown[], via: "cards" | "tickets" = "cards", extra: Record<string, unknown> = {}): StageResult => ({
  outcome: "pass",
  detail: { outcome: "split", summary: "over", split: { children, rounds: 1, judged: true, via }, size: { verdict: "over", estLoc: 4000, planned: null, limit: { target: [1000, 2000], hard: 2500 }, by: "decision" }, risk: { level: "high", machine: "high", scores: {} }, flagged: ["over the size limit"], decisions: { split_check: "rec-split" }, ...extra },
});
const origin = async (p: Pipeline = pipeline, order: Record<string, unknown> = {}) => {
  const task = await p.createTask({ title: "Everything", description: "the whole thing", criteria: ["csv", "pdf"], repoPath: "/r/app", stages: { plan: "claude:opus" } as never, ...order });
  await p.start(task.id);
  return task.id;
};
const count = async (): Promise<number> => Number((await db.query("select count(*)::int as n from tasks"))[0].n);
const children = async (id: string) => (await db.query("select id from tasks where id <> $1 order by created_at, id", [id])).map((r: { id: string }) => r.id as string);

describe("approving a split", () => {
  it("makes the child cards once, archives the origin as split, and logs one event per child", async () => {
    stubs.plan("test_design", gate([part(1), part(2, { depends_on: [1] })]));
    const id = await origin();
    expect(await count()).toBe(1);
    const done = await pipeline.decide(id, "approved", "split it");
    expect(done).toMatchObject({ state: "archived", archiveReason: "split" });
    const kids = await children(id);
    expect(kids).toHaveLength(2);
    const events = await pipeline.events(id);
    expect(events.find((e) => e.kind === "card.split")?.payload).toEqual({ children: 2, via: "cards" });
    for (const [i, kid] of kids.entries()) expect((await pipeline.events(kid)).find((e) => e.kind === "card.child")?.payload).toEqual({ of: id, n: i + 1, total: 2 });
    expect(cardOf(await pipeline.get(id)).splitInto).toEqual(kids);
    expect((await pipeline.approvals(id))[0]).toMatchObject({ decision: "approved" });
  });

  it("gives a child the origin's repository and engines, its own criteria and stack, and nothing else of the origin", async () => {
    stubs.plan("test_design", gate([part(1), part(2, { depends_on: [1] })]));
    const p = make({ jiraSite: "https://acme.atlassian.net" });
    pipeline = p;
    const source = { kind: "github", repo: "o/a", number: 7, url: "https://github.com/o/a/issues/7" } as const;
    const jira = { key: "PLAT-9", url: "https://acme.atlassian.net/browse/PLAT-9", issueType: null, status: null, priority: null, dueAt: null, syncedAt: null };
    const id = await origin(p, { source, jira, reporter: { id: "marta" }, followers: ["ana"], links: { doc: "https://example.com/d" }, attachments: [{ name: "a", url: "https://example.com/a" }] });
    await p.decide(id, "approved");
    const [first, second] = await children(id);
    const a = await p.get(first!);
    const b = await p.get(second!);
    expect(a).toMatchObject({ title: "Part 1", repoPath: "/r/app", stages: { plan: "claude:opus" }, criteria: ["works 1"], source: null, jira: null, record: null, evidence: null, classification: null });
    expect(a.description).toContain(`Part 1 of 2 of card ${id.slice(0, 8)}.`);
    expect(a.description).toContain("src/part1.ts");
    const ca = cardOf(a);
    expect(ca).toMatchObject({ sources: [], reporter: null, followers: [], links: {}, attachments: [], originMachine: "automation", splitFrom: id, splitPart: { n: 1, of: 2 }, riskFloor: "high", startWhenReady: true, dedup: { chosen: "neither", outcome: "none" } });
    expect(ca.hints).toMatchObject({ size: expect.any(String) });
    expect(ca.dependsOn).toBeUndefined();
    expect(cardOf(b)).toMatchObject({ dependsOn: [first], splitPart: { n: 2, of: 2 } });
    expect(await p.approvals(first!)).toEqual([expect.objectContaining({ decision: null })]);
  });

  it("never lets a child's own title link a Jira issue", async () => {
    stubs.plan("test_design", gate([part(1, { title: "PLAT-123 do part one" }), part(2, { depends_on: [1] })]));
    const p = make({ jiraSite: "https://acme.atlassian.net" });
    pipeline = p;
    const id = await origin(p);
    await p.decide(id, "approved");
    for (const kid of await children(id)) expect((await p.get(kid)).jira).toBeNull();
  });

  it("starts the children with no dependency and leaves the others as drafts waiting to be ready", async () => {
    stubs.plan("test_design", gate([part(1), part(2, { depends_on: [1] })]));
    const id = await origin();
    seen.length = 0;
    await pipeline.decide(id, "approved");
    const [first, second] = await children(id);
    expect((await pipeline.get(first!)).state).toBe("awaiting_approval");
    expect((await pipeline.get(second!)).state).toBe("draft");
    expect(seen.some((s) => s.id === second)).toBe(false);
  });

  it("builds the branch of a part from ids when its workspace is made", async () => {
    stubs.plan("test_design", gate([part(1), part(2, { depends_on: [1] })]));
    const id = await origin();
    await pipeline.decide(id, "approved");
    const { workspaceFor } = await import("../adapters/git/worktree.ts");
    const [first] = await children(id);
    expect(workspaceFor(await pipeline.get(first!), "/r/app", "/w").branch).toBe(`task/${first!.slice(0, 8)}-part-1-of-${id.slice(0, 8)}`);
  });

  it("makes no second card on a retry: a failure midway leaves the gate open and the next approval goes on from the keys", async () => {
    stubs.plan("test_design", gate([part(1), part(2, { depends_on: [1] })]));
    const id = await origin();
    const real = pipeline.createTaskOnce.bind(pipeline);
    let calls = 0;
    const spy = vi.spyOn(pipeline, "createTaskOnce").mockImplementation(async (order, key) => {
      calls += 1;
      if (calls === 2) throw new Error("the database blinked");
      return real(order, key);
    });
    await expect(pipeline.decide(id, "approved")).rejects.toThrow("blinked");
    expect((await pipeline.get(id)).state).toBe("awaiting_approval");
    expect((await pipeline.approvals(id))[0]!.decision).toBeNull();
    expect(await count()).toBe(2);
    spy.mockRestore();
    await pipeline.decide(id, "approved");
    expect(await count()).toBe(3);
    expect((await pipeline.get(id)).archiveReason).toBe("split");
  });

  it("refuses a split the repository's limits would not pass now", async () => {
    stubs.plan("test_design", gate([part(1, { covers: [] }), part(2)]));
    const id = await origin();
    await expect(pipeline.decide(id, "approved")).rejects.toBeInstanceOf(SplitNotValidError);
    expect(await count()).toBe(1);
  });

  it("is refused with split_changed when the gate's way of splitting is not what the approval would do now", async () => {
    stubs.plan("test_design", gate([part(1), part(2)], "tickets"));
    const id = await origin();
    await expect(pipeline.decide(id, "approved")).rejects.toMatchObject({ name: "SplitChangedError" });
    expect(await count()).toBe(1);
    await pipeline.shutdown();
    await db.query("truncate tasks cascade");
    const create = vi.fn();
    pipeline = make({ splitTickets: { knows: async () => ({ tool: "jira", key: "PLAT-1" }), create } });
    stubs.plan("test_design", gate([part(1), part(2)], "cards"));
    const again = await origin();
    await expect(pipeline.decide(again, "approved")).rejects.toMatchObject({ name: "SplitChangedError" });
    expect(create).not.toHaveBeenCalled();
  });

  it("with the gate opened for tickets, creates the tickets through the port in place of cards and archives the origin", async () => {
    const create = vi.fn(async () => ({ keys: ["PLAT-2", "PLAT-3"] }));
    pipeline = make({ splitTickets: { knows: async () => ({ tool: "jira", key: "PLAT-1" }), create } });
    stubs.plan("test_design", gate([part(1), part(2)], "tickets"));
    const id = await origin();
    const done = await pipeline.decide(id, "approved");
    expect(done).toMatchObject({ state: "archived", archiveReason: "split" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await count()).toBe(1);
    expect((await pipeline.events(id)).find((e) => e.kind === "card.split")?.payload).toEqual({ children: 2, via: "tickets" });
  });

  it("opens the gate with the way it would split now: tickets when the card's source is a ticket the port knows, cards otherwise", async () => {
    pipeline = make({ splitTickets: { knows: async () => ({ tool: "jira", key: "PLAT-1" }), create: async () => ({ keys: [] }) } });
    expect(await pipeline.splitVia(await pipeline.createTask({ title: "t" }))).toBe("tickets");
    expect(await make().splitVia(await pipeline.createTask({ title: "t" }))).toBe("cards");
  });

  it("does not let wave 14's duplicate check merge two parts of one split", async () => {
    const decide = vi.fn(async () => ({ answer: { related: { choice: "slot1", confidence: 0.99 }, same: { value: true, p: 0.99 } } as never }));
    pipeline = make({ dedup: { decide: decide as never } });
    stubs.plan("test_design", gate([part(1), part(2)]));
    const id = await origin();
    decide.mockClear();
    await pipeline.decide(id, "approved");
    expect(decide).not.toHaveBeenCalled();
    for (const kid of await children(id)) expect((await pipeline.get(kid)).state).not.toBe("archived");
  });
});

describe("what an approved split teaches split_check", () => {
  it("confirms the record: every answer stands", async () => {
    const learned: Array<Record<string, unknown>> = [];
    const yes = { covers: { value: true, p: 0.9 }, no_overlap: { value: true, p: 0.9 }, stand_alone: { value: true, p: 0.9 } };
    pipeline = make({ truth: { learned: async (f: Record<string, unknown>) => (learned.push(f), true), answerOf: async () => yes } });
    stubs.plan("test_design", gate([part(1), part(2)]));
    const id = await origin();
    await pipeline.decide(id, "approved");
    expect(learned.filter((l) => l.pack === "split_check")).toEqual([expect.objectContaining({ recordId: "rec-split", source: "split_approved", label: { covers: { value: true }, no_overlap: { value: true }, stand_alone: { value: true } } })]);
  });
});
