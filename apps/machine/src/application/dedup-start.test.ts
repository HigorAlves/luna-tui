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
let backlogItems: Array<{ id: string; title: string; text: string; repo: string | null; sources: object[] }> = [];
const unbumped: string[] = [];
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
  unbumped.length = 0;
  calls = [];
  backlogItems = [];
  answer = { slot1: { choice: "different", confidence: 0.9 } } as DedupAnswer;
  pipeline = new Pipeline(db, stubs.runnerFor, {
    inline: true,
    hasConfig: () => true,
    contextSetup: context,
    publicBoardUrl: "https://board.example",
    truth: { learned: async (fact: unknown) => (learned.push(fact), true) } as never,
    dedup: {
      decide: async (ctx) => {
        calls.push(ctx);
        if (answer instanceof Error) throw answer;
        return { answer, recordId: "rec-1" };
      },
      backlog: { list: async () => backlogItems, bump: async (id) => void bumped.push(id), unbump: async (id) => void unbumped.push(id) },
    },
  });
});

const make = (title: string, over: Record<string, unknown> = {}) => pipeline.createTask({ title, description: fill(title), repoPath: REPO, ...over });
const kept = () => make("Checkout fails when paying with card");
const fresh = () => make("Checkout fails when paying");

describe("the duplicate check at start", () => {
  it("a confident same on an open card merges the new card into it, with no person, before triage", async () => {
    const k = await make("Checkout fails when paying with card", { reporter: { id: "alice", channel: "slack" } });
    answer = { slot1: { choice: "same", confidence: 0.95 } } as DedupAnswer;
    const n = await make("Checkout fails when paying", { reporter: { id: "bob", channel: "slack" } });
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
    backlogItems = [{ id: "99999999-0000-0000-0000-000000000000", title: "Checkout fails when paying with card", text: fill("Checkout"), repo: REPO, sources: [] }];
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

describe("only a card the new card's reporter could see is a candidate", () => {
  const ghNew = { kind: "github", repo: "o/a", number: 5, url: "https://github.com/o/a/issues/5" } as const;
  const jiraPrivate = { kind: "jira", key: "PAY-1", url: "https://x.atlassian.net/browse/PAY-1", issueType: null } as const;
  const slackPrivate = { kind: "slack", channel: "C9", ts: "1", permalink: "https://x.slack.com/p1" } as const;

  it("never shortlists, shows, merges into or says anything about a private card for a public report", async () => {
    const privateCards = [await make("Checkout fails when paying with card", { source: jiraPrivate }), await make("Checkout fails when paying with card", { source: slackPrivate }), await make("Checkout fails when paying with card")];
    answer = { slot1: { choice: "same", confidence: 0.99 } } as DedupAnswer;
    const n = await make("Checkout fails when paying", { source: ghNew });
    const after = await pipeline.start(n.id);
    expect(calls).toEqual([]);
    expect(after.state).not.toBe("closed");
    expect(cardOf(after).dedup).toMatchObject({ outcome: "none", candidates: [] });
    const events = (await pipeline.events(n.id)).map((e) => e.kind);
    expect(events).not.toContain("card.merged");
    expect(events).not.toContain("task.reply");
    for (const k of privateCards) expect(cardOf(await pipeline.get(k.id)).merged ?? []).toEqual([]);
  });

  it("does offer a card of the same GitHub repository, and a Jira or Slack card of the same project or channel", async () => {
    await make("Checkout fails when paying with card", { source: { ...ghNew, number: 1 } });
    await make("Checkout fails when paying with card", { source: jiraPrivate });
    answer = { slot1: { choice: "different", confidence: 0.9 } } as DedupAnswer;
    await pipeline.start((await make("Checkout fails when paying", { source: ghNew })).id);
    expect(calls[0].candidates).toHaveLength(1);
    await pipeline.start((await make("Checkout fails when paying", { source: { ...jiraPrivate, key: "PAY-7" } })).id);
    expect(calls[1].candidates).toHaveLength(1);
  });

  it("a card typed in the TUI, with no source, sees every card of its repository", async () => {
    await make("Checkout fails when paying with card", { source: jiraPrivate });
    await make("Checkout fails when paying with card", { source: slackPrivate });
    answer = { slot1: { choice: "different", confidence: 0.9 } } as DedupAnswer;
    await pipeline.start((await fresh()).id);
    expect(calls[0].candidates).toHaveLength(2);
  });

  it("a backlog item with no source is the operator's: a public report does not see it", async () => {
    backlogItems = [{ id: "99999999-0000-0000-0000-000000000000", title: "Checkout fails when paying with card", text: fill("Checkout"), repo: REPO, sources: [] }];
    await pipeline.start((await make("Checkout fails when paying", { source: ghNew })).id);
    expect(calls).toEqual([]);
    backlogItems[0]!.sources = [{ ...ghNew, number: 1 }];
    await pipeline.start((await make("Checkout fails when paying", { source: ghNew })).id);
    expect(calls).toHaveLength(1);
  });
});

describe("an unmerge stays unmerged", () => {
  it("the restored card is not checked again at start, so it does not merge again", async () => {
    const k = await kept();
    answer = { slot1: { choice: "same", confidence: 0.95 } } as DedupAnswer;
    const n = await fresh();
    await pipeline.start(n.id);
    const restored = await pipeline.unmerge(n.id);
    const before = calls.length;
    const after = await pipeline.start(restored.id);
    expect(calls.length).toBe(before);
    expect(after.state).not.toBe("closed");
    expect(cardOf(after).related).toEqual([k.id]);
  });

  it("undoing a merge into a backlog item undoes its bump", async () => {
    backlogItems = [{ id: "99999999-0000-0000-0000-000000000000", title: "Checkout fails when paying with card", text: fill("Checkout"), repo: REPO, sources: [] }];
    answer = { slot1: { choice: "same", confidence: 0.95 } } as DedupAnswer;
    const n = await fresh();
    await pipeline.start(n.id);
    expect(bumped).toHaveLength(1);
    await pipeline.unmerge(n.id);
    expect(unbumped).toEqual(["99999999-0000-0000-0000-000000000000"]);
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
