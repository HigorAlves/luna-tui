import type { IssueHit, OpenPrInput, PrDetail, PrLink } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GitHubError } from "../../application/github.ts";
import { Pipeline } from "../../application/pipeline.ts";
import { OutsideReposError, type PrDeskPort, PushFailedError } from "../../application/pr-desk.ts";
import { NoPullError } from "../../application/pulls.ts";
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

const detail: PrDetail = {
  repo: "o/a",
  number: 7,
  state: "open",
  facts: {
    repo: "o/a",
    number: 7,
    title: "PR 7",
    url: "https://github.com/o/a/pull/7",
    author: "me",
    mine: true,
    reviewRequested: false,
    isDraft: true,
    headRef: "feat/7",
    baseRef: "main",
    fromFork: false,
    reviewDecision: null,
    mergeable: "MERGEABLE",
    mergeState: "DRAFT",
    checks: { state: "none", passed: 0, total: 0, failed: [], all: [] },
    unresolvedThreads: 0,
    updatedAt: "2026-11-27T10:00:00Z",
    createdAt: "2026-11-26T10:00:00Z",
    reviewRequestedAt: null,
    threadsComplete: true,
    headSha: null,
    headCommittedAt: null,
    nodeId: null,
    body: null,
  },
  threads: [{ id: "T1", path: "a.ts", line: 3, resolved: false, outdated: false, comments: [{ author: "r", body: "why?", at: "2026-11-27T09:00:00Z" }] }],
  reviews: [{ author: "r", state: "COMMENTED", at: "2026-11-27T09:00:00Z" }],
  files: [{ path: "a.ts", additions: 3, deletions: 1 }],
};

/** A fake desk: fixed answers, and a log of what the routes asked. */
function fakeDesk(): PrDeskPort & { did: string[] } {
  const did: string[] = [];
  return {
    did,
    async detail(repo, number) {
      if (number !== 7) throw new NoPullError(repo, number);
      return detail;
    },
    async ready(repo, number) {
      if (number === 8) throw new GitHubError("marking o/a#8 ready failed (422): not a draft", 422);
      did.push(`ready ${repo}#${number}`);
    },
    async lookup(_repo, branch): Promise<PrLink | null> {
      return branch === "feat/7" ? { url: "https://github.com/o/a/pull/7", number: 7, isDraft: true } : null;
    },
    async search(repo, kind, query): Promise<IssueHit[]> {
      did.push(`search ${repo} ${kind} ${query}`);
      return [{ number: 4, title: "Crash on open", url: "https://github.com/o/a/issues/4", state: "open", author: "r" }];
    },
    async openPr(input: OpenPrInput): Promise<PrLink> {
      if (!input.path.startsWith("/repos/")) throw new OutsideReposError(input.path, "/repos");
      if (input.branch === "rejected") throw new PushFailedError("git push failed: rejected");
      did.push(`open ${input.path} ${input.branch} draft=${input.draft}`);
      return { url: "https://github.com/o/a/pull/9", number: 9, isDraft: input.draft };
    },
    async inside(path) {
      if (!path.startsWith("/repos/")) throw new OutsideReposError(path, "/repos");
      return path;
    },
  };
}

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("one PR on demand over HTTP", () => {
  it("serves a PR's detail, and 404s one GitHub no longer shows", async () => {
    const app = createApp({ db, pipeline, bus: new Bus(), prDesk: fakeDesk() });
    const got = await app.request("/github/prs/o/a/7");
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ number: 7, state: "open", threads: [{ id: "T1" }], files: [{ path: "a.ts" }] });
    const missing = await app.request("/github/prs/o/a/9");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "no_pull" });
  });

  it("marks a draft ready, and answers GitHub's refusal in its words", async () => {
    const desk = fakeDesk();
    const app = createApp({ db, pipeline, bus: new Bus(), prDesk: desk });
    const ready = await app.request("/github/prs/o/a/7/ready", post({}));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true });
    expect(desk.did).toEqual(["ready o/a#7"]);
    const refused = await app.request("/github/prs/o/a/8/ready", post({}));
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ error: "github_failed" });
  });

  it("finds a branch's PR, or answers null", async () => {
    const app = createApp({ db, pipeline, bus: new Bus(), prDesk: fakeDesk() });
    expect(await (await app.request("/github/prs/lookup?repo=o/a&branch=feat/7")).json()).toEqual({ pr: { url: "https://github.com/o/a/pull/7", number: 7, isDraft: true } });
    expect(await (await app.request("/github/prs/lookup?repo=o/a&branch=feat/none")).json()).toEqual({ pr: null });
    expect((await app.request("/github/prs/lookup?repo=nope&branch=x")).status).toBe(400);
  });

  it("searches a repository's PRs or issues", async () => {
    const desk = fakeDesk();
    const app = createApp({ db, pipeline, bus: new Bus(), prDesk: desk });
    const got = await app.request("/github/search?repo=o/a&kind=issue&q=crash");
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ items: [{ number: 4, title: "Crash on open", url: "https://github.com/o/a/issues/4", state: "open", author: "r" }] });
    expect(desk.did).toEqual(["search o/a issue crash"]);
    expect((await app.request("/github/search?repo=o/a&kind=wiki&q=x")).status).toBe(400);
  });

  it("pushes a branch and opens its PR; refuses a folder the machine can't see, and says why a push failed", async () => {
    const desk = fakeDesk();
    const app = createApp({ db, pipeline, bus: new Bus(), prDesk: desk });
    const opened = await app.request("/github/pr", post({ path: "/repos/a", branch: "feat/x", title: "Feat" }));
    expect(opened.status).toBe(201);
    expect(await opened.json()).toEqual({ url: "https://github.com/o/a/pull/9", number: 9, isDraft: false });
    expect(desk.did).toEqual(["open /repos/a feat/x draft=false"]);
    const outside = await app.request("/github/pr", post({ path: "/elsewhere/a", branch: "feat/x", title: "Feat" }));
    expect(outside.status).toBe(400);
    expect(await outside.json()).toMatchObject({ error: "outside_repos" });
    const rejected = await app.request("/github/pr", post({ path: "/repos/a", branch: "rejected", title: "Feat" }));
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ error: "push_failed", message: "git push failed: rejected" });
    expect((await app.request("/github/pr", post({ path: "/repos/a", branch: "has space", title: "Feat" }))).status).toBe(400);
  });

  it("answers 404 for every desk route when the machine has none", async () => {
    const app = createApp({ db, pipeline, bus: new Bus() });
    expect((await app.request("/github/prs/o/a/7")).status).toBe(404);
    expect((await app.request("/github/search?repo=o/a&kind=pr&q=x")).status).toBe(404);
  });

  it("says on /health which folder the machine sees, for a client's clone and push", async () => {
    const app = createApp({ db, pipeline, bus: new Bus(), reposDir: "/Users/me/Developer" });
    expect(await (await app.request("/health")).json()).toMatchObject({ ok: true, reposDir: "/Users/me/Developer" });
  });
});
