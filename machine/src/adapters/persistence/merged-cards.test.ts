import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { previewOn } from "../../test/policies.ts";
import { cardMergedAs } from "./merged-cards.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
});

const shipped = (number: number, sha: string | null, repo = "Acme/App") => ({ title: "t", prUrl: `https://github.com/${repo}/pull/${number}`, number, mergedSha: sha, by: "person", format: null, howToVerify: null, media: [] });

describe("cardMergedAs", () => {
  it("finds the card that merged a PR or a commit, the latest first, and nothing else", async () => {
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    const a = await pipeline.createTask({ title: "a", repoPath: "/r/a" });
    const b = await pipeline.createTask({ title: "b", repoPath: "/r/a" });
    const other = await pipeline.createTask({ title: "other repo", repoPath: "/r/o" });
    await pipeline.record(a.id, "ship.merged", shipped(10, "0123456789abcdef0123456789abcdef01234567"));
    await pipeline.record(b.id, "task.shipped", shipped(11, "feedfacefeedfacefeedfacefeedfacefeedface"));
    await pipeline.record(other.id, "ship.merged", shipped(10, "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee", "Acme/Other"));

    expect(await cardMergedAs(db, { repo: "acme/app", number: 10 })).toBe(a.id);
    expect(await cardMergedAs(db, { repo: "acme/app", number: 11 })).toBe(b.id);
    expect(await cardMergedAs(db, { repo: "acme/other", number: 10 })).toBe(other.id);
    expect(await cardMergedAs(db, { repo: "acme/app", number: 12 })).toBeNull();
    expect(await cardMergedAs(db, { repo: "acme/%", number: 10 })).toBeNull();
    expect(await cardMergedAs(db, { sha: "0123456" })).toBe(a.id);
    expect(await cardMergedAs(db, { sha: "feedfacefeedfacefeedfacefeedfacefeedface" })).toBe(b.id);
    expect(await cardMergedAs(db, { sha: "1234567" })).toBeNull();
    expect(await cardMergedAs(db, { sha: "%" })).toBeNull();
  });
});
