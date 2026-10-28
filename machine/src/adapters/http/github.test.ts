import type { PrSnapshot, PullRequest } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { CloneError, NotReadyError, type PullsPort } from "../../application/pulls.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
let pipeline: Pipeline;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true });
});

const pr = (number: number, split: PullRequest["split"]): PullRequest => ({
  repo: "o/a",
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/a/pull/${number}`,
  author: "me",
  mine: true,
  reviewRequested: false,
  isDraft: false,
  headRef: `feat/${number}`,
  baseRef: "main",
  fromFork: false,
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  checks: { state: "success", passed: 1, total: 1, failed: [] },
  unresolvedThreads: 0,
  split,
  localPath: "/r/a",
  task: null,
  updatedAt: "2026-10-27T10:00:00Z",
});

/** A fake poller: a fixed snapshot, and a log of what the routes asked it to do. */
function fakePulls(prs: PullRequest[]): PullsPort & { did: string[] } {
  const snapshot: PrSnapshot = { prs, polledAt: "2026-10-27T10:00:00Z", error: null };
  const did: string[] = [];
  return {
    did,
    get snapshot() {
      return snapshot;
    },
    async pollOnce() {
      did.push("poll");
      return snapshot;
    },
    async merge(repo, number) {
      const found = prs.find((p) => p.repo === repo && p.number === number);
      if (!found || found.split !== "ready_to_merge") throw new NotReadyError(repo, number);
      did.push(`merge ${repo}#${number}`);
    },
    async clone(repo, dest) {
      if (!dest.startsWith("/")) throw new CloneError("dest must be an absolute path");
      did.push(`clone ${repo} ${dest}`);
    },
  };
}

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("the PR inbox over HTTP", () => {
  it("serves the snapshot and polls on demand", async () => {
    const pulls = fakePulls([pr(1, "ready_to_merge")]);
    const app = createApp({ db, pipeline, bus: new Bus(), pulls });
    const got = await app.request("/github/prs");
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ prs: [{ number: 1, split: "ready_to_merge" }], error: null });
    const refreshed = await app.request("/github/prs/refresh", { method: "POST" });
    expect(refreshed.status).toBe(200);
    expect(pulls.did).toEqual(["poll"]);
  });

  it("merges only a ready PR", async () => {
    const pulls = fakePulls([pr(1, "ready_to_merge"), pr(2, "ci_running")]);
    const app = createApp({ db, pipeline, bus: new Bus(), pulls });
    const merged = await app.request("/github/prs/o/a/1/merge", post({}));
    expect(merged.status).toBe(200);
    expect(await merged.json()).toEqual({ merged: true });
    const refused = await app.request("/github/prs/o/a/2/merge", post({}));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "not_ready" });
    expect(pulls.did).toEqual(["merge o/a#1"]);
  });

  it("starts a clone and rejects a bad destination or repo", async () => {
    const pulls = fakePulls([]);
    const app = createApp({ db, pipeline, bus: new Bus(), pulls });
    const started = await app.request("/github/clone", post({ repo: "o/b", dest: "/r/b" }));
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ repo: "o/b", dest: "/r/b", cloning: true });
    expect((await app.request("/github/clone", post({ repo: "o/b", dest: "r/b" }))).status).toBe(400);
    expect((await app.request("/github/clone", post({ repo: "nope", dest: "/r/b" }))).status).toBe(400);
  });

  it("answers 404 for the inbox when the poller is off", async () => {
    const app = createApp({ db, pipeline, bus: new Bus() });
    expect((await app.request("/github/prs")).status).toBe(404);
  });
});
