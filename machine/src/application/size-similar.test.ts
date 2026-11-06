// The closed cards the size prompt's "similar cards" come from: only those the origin's audience may see, with their counted diff, and failing closed.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { freshTestDatabase } from "../test/database.ts";
import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";

let db: DataSource;
let pipeline: Pipeline;
const stubs = new StubStages();
const REPO = "/repos/a";

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true });
});

const gh = (repo: string, number = 1) => ({ kind: "github" as const, repo, number, url: `https://github.com/${repo}/issues/${number}` });
const closed = async (title: string, source: ReturnType<typeof gh> | undefined, diff: [number, number] | null, over: Record<string, unknown> = {}) => {
  const task = await pipeline.createTask({ title, description: `${title} text`, repoPath: REPO, ...(source ? { source } : {}), ...over });
  await db.query("update tasks set state = 'closed', state_since = now(), diff_added = $2, diff_removed = $3 where id = $1", [task.id, diff?.[0] ?? null, diff?.[1] ?? null]);
  return task;
};

describe("closed cards with their counted diff, for the size prompt", () => {
  it("shows a card whose source its origin's audience could already see, and not any other", async () => {
    const mine = await closed("Mine, same repository", gh("o/a", 5), [120, 30]);
    await closed("Elsewhere, another repository", gh("o/b", 6), [900, 100]);
    await closed("Slack thread of strangers", { kind: "slack", channel: "C1", ts: "1.1", url: "https://x/y" } as never, [700, 50]);
    await closed("No source at all", undefined, [400, 40]);
    const origin = await pipeline.createTask({ title: "Origin", description: "t", repoPath: REPO, source: gh("o/a", 9) });
    const found = await pipeline.closedSized(origin);
    expect(found.map((c) => c.id)).toEqual([mine.id]);
    expect(found[0]).toMatchObject({ kind: "closed", title: "Mine, same repository", diffAdded: 120, diffRemoved: 30 });
  });

  it("fails closed for an origin whose own audience is unknown: a card with a source of its own sees nothing it cannot prove", async () => {
    await closed("A card with no source", undefined, [10, 1]);
    const origin = await pipeline.createTask({ title: "Origin", description: "t", repoPath: REPO, source: { kind: "jira", key: "PAY-1", url: "https://x/browse/PAY-1" } as never });
    expect(await pipeline.closedSized(origin)).toEqual([]);
  });

  it("lets the operator's own card (typed in the TUI, no source) see every closed card of its repository", async () => {
    const a = await closed("One", gh("o/a", 5), [10, 1]);
    const b = await closed("Two", undefined, [20, 2]);
    const origin = await pipeline.createTask({ title: "Origin", description: "t", repoPath: REPO });
    expect((await pipeline.closedSized(origin)).map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("leaves out a closed card with no counted diff, an open card, and another repository's card", async () => {
    await closed("Uncounted", gh("o/a", 5), null);
    const open = await pipeline.createTask({ title: "Open one", description: "t", repoPath: REPO, source: gh("o/a", 7) });
    const other = await pipeline.createTask({ title: "Other repository", description: "t", repoPath: "/repos/b", source: gh("o/a", 8) });
    await db.query("update tasks set state = 'closed', diff_added = 5, diff_removed = 5 where id = $1", [other.id]);
    const origin = await pipeline.createTask({ title: "Origin", description: "t", repoPath: REPO, source: gh("o/a", 9) });
    const ids = (await pipeline.closedSized(origin)).map((c) => c.id);
    expect(ids).not.toContain(open.id);
    expect(ids).not.toContain(other.id);
    expect(ids).toHaveLength(0);
  });
});
