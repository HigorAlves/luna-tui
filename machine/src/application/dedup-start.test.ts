// A card that starts is checked for a duplicate: merged, linked or asked about, by the repo's own bars.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../adapters/http/app.ts";
import { Bus } from "../adapters/http/bus.ts";
import { cardOf } from "../domain/card-fields.ts";
import { freshTestDatabase } from "../test/database.ts";
import type { ContextDeps } from "./context-setup.ts";
import type { DedupAnswer } from "./intake-dedup.ts";
import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";

let db: DataSource;
const stubs = new StubStages();
const learned: any[] = [];
const bumped: string[] = [];
let calls: any[] = [];
let answer: DedupAnswer | Error = {} as DedupAnswer;
let backlogItems: Array<{ id: string; title: string; text: string; repo: string | null }> = [];
let pipeline: Pipeline;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});

const context: ContextDeps = { resolveRepo: async () => null, channelRepo: () => null, projectRepo: async () => null, configProject: async () => null, owners: async () => [], history: async () => [] };
/** 25 words that depend on the title's first word: cards about one thing share them, unrelated ones do not. */
const fill = (title: string) => Array.from({ length: 25 }, (_, i) => `${title.split(" ")[0]!.toLowerCase()}${i}`).join(" ");
const REPO = "/repos/a";

beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
  learned.length = 0;
  bumped.length = 0;
  calls = [];
  backlogItems = [];
  answer = { slot1: { choice: "different", confidence: 0.9 } } as DedupAnswer;
  pipeline = new Pipeline(db, stubs.runnerFor, {
    inline: true,
    hasConfig: () => true,
    contextSetup: context,
    boardUrl: "http://127.0.0.1:7777",
    truth: { learned: async (fact: unknown) => (learned.push(fact), true) } as never,
    dedup: {
      decide: async (ctx) => {
        calls.push(ctx);
        if (answer instanceof Error) throw answer;
        return { answer, recordId: "rec-1" };
      },
      backlog: { list: async () => backlogItems, bump: async (id) => void bumped.push(id) },
    },
  });
});

const make = (title: string, over: Record<string, unknown> = {}) => pipeline.createTask({ title, description: fill(title), repoPath: REPO, ...over });
const kept = () => make("Checkout fails when paying with card");
const fresh = () => make("Checkout fails when paying");

describe("the duplicate check at start", () => {
  it("a confident same on an open card merges the new card into it, with no person, before triage", async () => {
    const k = await kept();
    answer = { slot1: { choice: "same", confidence: 0.95 } } as DedupAnswer;
    const n = await fresh();
    const after = await pipeline.start(n.id);
    expect(after.state).toBe("closed");
    expect(cardOf(after).mergedInto).toBe(k.id);
    expect(cardOf(await pipeline.get(k.id))).toMatchObject({ demand: 2, merged: [{ id: n.id }] });
    expect(await pipeline.stageRuns(n.id)).toEqual([]);
    expect(cardOf(after).dedup).toMatchObject({ recordId: "rec-1", outcome: "duplicate", candidates: [{ id: k.id, kind: "open", slot: 1 }] });
    expect(learned).toEqual([]);
  });

  it("offers the decision only the cards of the same repository", async () => {
    await kept();
    await make("Checkout fails when paying with card", { repoPath: "/repos/other" });
    await fresh().then((n) => pipeline.start(n.id));
    expect(calls).toHaveLength(1);
    expect(calls[0].candidates).toHaveLength(1);
  });

  it("makes no call when nothing is similar", async () => {
    await make("Unrelated zebra pattern");
    await fresh().then((n) => pipeline.start(n.id));
    expect(calls).toEqual([]);
  });

  it("a duplicate of a backlog item bumps that item and closes the card", async () => {
    backlogItems = [{ id: "99999999-0000-0000-0000-000000000000", title: "Checkout fails when paying with card", text: fill("Checkout"), repo: REPO }];
    answer = { slot1: { choice: "same", confidence: 0.95 } } as DedupAnswer;
    const n = await fresh();
    const after = await pipeline.start(n.id);
    expect(bumped).toEqual(["99999999-0000-0000-0000-000000000000"]);
    expect(after.state).toBe("closed");
    expect(cardOf(after).mergedInto).toBe("99999999-0000-0000-0000-000000000000");
  });

  it("related links the two cards and the card goes on", async () => {
    const k = await kept();
    answer = { slot1: { choice: "related", confidence: 0.8 } } as DedupAnswer;
    const n = await fresh();
    const after = await pipeline.start(n.id);
    expect(after.state).not.toBe("closed");
    expect(after.state).not.toBe("awaiting_setup");
    expect(cardOf(after).related).toEqual([k.id]);
    expect(cardOf(await pipeline.get(k.id)).related).toEqual([n.id]);
  });

  it("goes on to triage with a note when the decision fails", async () => {
    await kept();
    answer = new Error("down");
    const n = await fresh();
    const after = await pipeline.start(n.id);
    expect(after.state).not.toBe("awaiting_setup");
    expect(cardOf(after).dedup).toMatchObject({ outcome: "skipped" });
    expect((await pipeline.events(n.id)).some((e) => e.kind === "intake.dedup_skipped")).toBe(true);
  });
});

describe("under the asking bar", () => {
  const ask = async () => {
    const k = await kept();
    answer = { slot1: { choice: "same", confidence: 0.5 } } as DedupAnswer;
    const n = await fresh();
    const held = await pipeline.start(n.id);
    return { k, n, held };
  };

  it("holds the card at a gate that lists the candidates", async () => {
    const { k, n, held } = await ask();
    expect(held.state).toBe("awaiting_setup");
    const gate = (await pipeline.approvals(n.id)).find((a) => a.decision === null);
    expect(gate?.requested).toMatchObject({ kind: "dedup", candidates: [{ id: k.id, kind: "open", title: "Checkout fails when paying with card", slot: 1 }] });
  });

  it("'duplicate of one' merges it and is ground truth on the record", async () => {
    const { k, n } = await ask();
    const after = await pipeline.answerDedup(n.id, { choice: "duplicate", of: [k.id] });
    expect(after.state).toBe("closed");
    expect(cardOf(after).mergedInto).toBe(k.id);
    expect(learned).toEqual([expect.objectContaining({ pack: "intake_dedup", recordId: "rec-1", label: { slot1: { choice: "same" } }, source: "dedup_answer" })]);
  });

  it("'related to some' links them, 'neither' lets it go on, each the truth", async () => {
    const { k, n } = await ask();
    expect((await pipeline.answerDedup(n.id, { choice: "related", of: [k.id] })).state).not.toBe("awaiting_setup");
    expect(cardOf(await pipeline.get(n.id)).related).toEqual([k.id]);
    expect(learned[0]).toMatchObject({ label: { slot1: { choice: "related" } } });
        const again = await ask();
    expect((await pipeline.answerDedup(again.n.id, { choice: "neither" })).state).not.toBe("awaiting_setup");
    expect(learned.at(-1)).toMatchObject({ label: { slot1: { choice: "different" } } });
  });

  it("takes ids from the listed candidates only", async () => {
    const { n } = await ask();
    const stranger = await make("Something else entirely");
    await expect(pipeline.answerDedup(n.id, { choice: "duplicate", of: [stranger.id] })).rejects.toThrow();
    await expect(pipeline.answerDedup(n.id, { choice: "duplicate", of: [] })).rejects.toThrow();
    expect((await pipeline.get(n.id)).state).toBe("awaiting_setup");
  });

  it("approving the gate is 'neither', and a card not waiting for it is refused", async () => {
    const { n } = await ask();
    expect((await pipeline.decide(n.id, "approved")).state).not.toBe("awaiting_setup");
    await expect(pipeline.answerDedup(n.id, { choice: "neither" })).rejects.toThrow();
  });

  it("POST /tasks/:id/dedup answers it; a body outside the listed ids is 400", async () => {
    const { k, n } = await ask();
    const app = createApp({ db, pipeline, bus: new Bus() });
    const post = (body: unknown) => app.request(`/tasks/${n.id}/dedup`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect((await post({ choice: "bogus" })).status).toBe(400);
    expect((await post({ choice: "duplicate", of: ["00000000-0000-0000-0000-000000000000"] })).status).toBe(400);
    expect((await post({ choice: "duplicate", of: [k.id] })).status).toBe(200);
    expect((await post({ choice: "neither" })).status).toBe(409);
  });
});
