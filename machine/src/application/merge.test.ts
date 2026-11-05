// A duplicate report merges into the card that exists; a person can mark two cards as duplicates or undo a merge.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../adapters/http/app.ts";
import { Bus } from "../adapters/http/bus.ts";
import { cardOf } from "../domain/card-fields.ts";
import { freshTestDatabase } from "../test/database.ts";
import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";

let db: DataSource;
const stubs = new StubStages();
const learned: unknown[] = [];
let pipeline: Pipeline;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
  learned.length = 0;
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true, publicBoardUrl: "https://board.example", truth: { learned: async (fact: unknown) => (learned.push(fact), true) } as never });
});

const gh = { kind: "github", repo: "o/a", number: 1, url: "https://github.com/o/a/issues/1" } as const;
const slack = { kind: "slack", channel: "C1", ts: "1.2", permalink: "https://example.slack.com/archives/C1/p12" } as const;
const ghDup = { kind: "github", repo: "o/a", number: 2, url: "https://github.com/o/a/issues/2" } as const;
/** `visible`: the duplicate also has a report from the kept card's GitHub repository, so its reporter could see the kept card. */
const pair = async (visible = true, reporter = "U2") => {
  const kept = await pipeline.createTask({ title: "Secret roadmap item", source: gh, repoPath: "/r/a", reporter: { id: "alice", channel: "github" } });
  const dup = await pipeline.createTask({ title: "Checkout broken", description: "it fails", source: slack, ...(visible ? { sources: [ghDup] } : {}), repoPath: "/r/a", reporter: { id: reporter, channel: "slack" } });
  return { kept, dup };
};

describe("merging a duplicate", () => {
  it("adds its source, follows its reporter, raises the demand, and closes the duplicate as merged into the kept card", async () => {
    const { kept, dup } = await pair();
    await pipeline.merge(dup.id, kept.id);
    const card = cardOf(await pipeline.get(kept.id));
    expect(card.sources).toEqual([gh, slack, ghDup]);
    expect(card.followers).toEqual(["U2"]);
    expect(card.demand).toBe(2);
    expect(card.merged).toEqual([{ id: dup.id, sources: [slack, ghDup], followers: ["U2"] }]);
    const after = await pipeline.get(dup.id);
    expect(after).toMatchObject({ state: "closed", archiveReason: null });
    expect(cardOf(after).mergedInto).toBe(kept.id);
    expect(await pipeline.stageRuns(dup.id)).toEqual([]);
    const events = await pipeline.events(dup.id);
    expect(events.find((e) => e.kind === "card.merged")?.payload).toEqual({ into: kept.id });
    expect((await pipeline.events(kept.id)).some((e) => e.kind === "card.merged")).toBe(true);
  });

  it("tells the duplicate's source which card tracks it, in fixed words with the id and link and no title", async () => {
    const { kept, dup } = await pair();
    await pipeline.merge(dup.id, kept.id);
    const reply = (await pipeline.events(dup.id)).find((e) => e.kind === "task.reply");
    const body = String(reply?.payload.body);
    expect(body).toContain(kept.id.slice(0, 8));
    expect(body).toContain(`https://board.example/tasks/${kept.id}`);
    expect(body).not.toContain("127.0.0.1");
    expect(body).not.toContain("Secret roadmap");
    expect(body).not.toContain("Checkout broken");
  });

  it("says only that the report is tracked when its reporter could not see the kept card: no report from its repository", async () => {
    const { kept, dup } = await pair(false);
    await pipeline.merge(dup.id, kept.id);
    const body = String((await pipeline.events(dup.id)).find((e) => e.kind === "task.reply")?.payload.body);
    expect(body).toContain("tracked");
    expect(body).not.toContain(kept.id.slice(0, 8));
    expect(body).not.toContain("127.0.0.1");
  });

  it("recomputes the priority when the card was triaged", async () => {
    const { kept, dup } = await pair();
    const urgencyDetail = { priority: "P2", subScores: { who: 2, what: 2, impact: 2, time: 2, demand: 1 } };
    await db.query("update tasks set record = $2 where id = $1", [kept.id, JSON.stringify({ urgencyDetail })]);
    await pipeline.merge(dup.id, kept.id);
    // 3*2 + 3*2 + 2*2 + 2*2 + 1*2 = 22: the P1 bar.
    expect((await pipeline.get(kept.id)).record?.urgencyDetail).toEqual({ priority: "P1", subScores: { who: 2, what: 2, impact: 2, time: 2, demand: 2 } });
  });

  it("refuses a card into itself, an ended duplicate and an unknown card", async () => {
    const { kept, dup } = await pair();
    await expect(pipeline.merge(kept.id, kept.id)).rejects.toThrow();
    await expect(pipeline.merge(dup.id, "00000000-0000-0000-0000-000000000000")).rejects.toThrow();
    await pipeline.merge(dup.id, kept.id);
    await expect(pipeline.merge(dup.id, kept.id)).rejects.toThrow();
  });

  it("keeps the decision's ground truth: a merge confirms the same, an undo says different", async () => {
    const { kept, dup } = await pair();
    const dedup = { at: "2026-11-05T00:00:00Z", recordId: "rec-1", candidates: [{ id: kept.id, kind: "open", score: 0.8, slot: 2 }], answer: null, outcome: "ask" };
    await db.query("update tasks set card = $2 where id = $1", [dup.id, JSON.stringify({ ...cardOf(dup), dedup })]);
    await pipeline.merge(dup.id, kept.id);
    await pipeline.unmerge(dup.id);
    expect(learned).toEqual([
      expect.objectContaining({ pack: "intake_dedup", recordId: "rec-1", label: { slot2: { choice: "same" } }, source: "merge_confirmed" }),
      expect.objectContaining({ pack: "intake_dedup", recordId: "rec-1", label: { slot2: { choice: "different" } }, source: "merge_undone" }),
    ]);
  });
});

describe("what a merge may touch", () => {
  it("counts distinct reporters: a reporter already on the card raises nothing", async () => {
    const { kept, dup } = await pair(true, "alice");
    await pipeline.merge(dup.id, kept.id);
    expect(cardOf(await pipeline.get(kept.id)).demand).toBe(1);
  });

  it("a person's merge is refused for a card that has reached Build: a workspace or a state past the plan", async () => {
    const { kept, dup } = await pair();
    await db.query("update tasks set worktree_path = '/w/x' where id = $1", [dup.id]);
    await expect(pipeline.merge(dup.id, kept.id)).rejects.toThrow(/Build/);
    await db.query("update tasks set worktree_path = null, state = 'implementing' where id = $1", [dup.id]);
    await expect(pipeline.merge(dup.id, kept.id)).rejects.toThrow(/Build/);
    const route = await createApp({ db, pipeline, bus: new Bus() }).request(`/tasks/${dup.id}/merge`, { method: "POST", body: JSON.stringify({ into: kept.id }), headers: { "content-type": "application/json" } });
    expect(route.status).toBe(409);
  });
});

describe("a merge the machine made alone", () => {
  it("is no person's word, so it teaches the decision nothing", async () => {
    const { kept, dup } = await pair();
    const dedup = { at: "2026-11-05T00:00:00Z", recordId: "rec-1", candidates: [{ id: kept.id, kind: "open", score: 0.8, slot: 1 }], answer: null, outcome: "duplicate" };
    await db.query("update tasks set card = $2 where id = $1", [dup.id, JSON.stringify({ ...cardOf(dup), dedup })]);
    await pipeline.merge(dup.id, kept.id, "machine");
    expect(learned).toEqual([]);
  });
});

describe("undoing a merge", () => {
  it("takes the source, follower and demand back and makes a new card of the duplicate", async () => {
    const { kept, dup } = await pair();
    await pipeline.merge(dup.id, kept.id);
    const restored = await pipeline.unmerge(dup.id);
    const card = cardOf(await pipeline.get(kept.id));
    expect(card).toMatchObject({ sources: [gh], followers: [], demand: 1, merged: [] });
    expect(card.related).toEqual([restored.id]);
    expect(restored).toMatchObject({ id: expect.not.stringMatching(dup.id), title: "Checkout broken", state: "draft" });
    expect(cardOf(restored).sources).toEqual([slack, ghDup]);
    expect(cardOf(restored).dedup).toMatchObject({ chosen: "neither" });
    expect(cardOf(restored).related).toEqual([kept.id]);
    expect((await pipeline.events(kept.id)).some((e) => e.kind === "card.unmerged")).toBe(true);
    await expect(pipeline.unmerge(kept.id)).rejects.toThrow();
  });
});

describe("the board's merge routes", () => {
  const app = () => createApp({ db, pipeline, bus: new Bus() });
  const post = (path: string, body: unknown) => app().request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  it("POST /tasks/:id/merge and /unmerge", async () => {
    const { kept, dup } = await pair();
    expect((await post(`/tasks/${dup.id}/merge`, { into: kept.id })).status).toBe(200);
    expect((await post(`/tasks/${dup.id}/merge`, { into: kept.id })).status).toBe(409);
    expect((await post(`/tasks/${dup.id}/merge`, {})).status).toBe(400);
    const undone = await post(`/tasks/${dup.id}/unmerge`, {});
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as { title: string }).title).toBe("Checkout broken");
  });
});
