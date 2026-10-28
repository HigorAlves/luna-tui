import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  type Gh,
  cloneRepo,
  mergePr,
  postReview,
  prComments,
  prDiff,
  prFacts,
  prFiles,
  prThreads,
  replyToThread,
  resolveThread,
  searchMyPrs,
  threadResolved,
  viewerLogin,
  viewerTeams,
} from "./gh.ts";

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const bad = (stderr: string) => ({ code: 1, stdout: "", stderr });

/** A fake gh that records argv and answers from a queue (the last answer repeats). */
function fake(...answers: Array<{ code: number; stdout: string; stderr: string }>): { gh: Gh; calls: string[][] } {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    return answers.length > 1 ? answers.shift()! : answers[0]!;
  };
  return { gh, calls };
}

describe("searchMyPrs", () => {
  it("runs the two searches and dedupes a PR that is both mine and requested of me", async () => {
    const { gh, calls } = fake(
      ok(JSON.stringify([{ number: 1, repository: { nameWithOwner: "o/a" }, updatedAt: "t1" }, { number: 2, repository: { nameWithOwner: "o/b" }, updatedAt: "t2" }])),
      ok(JSON.stringify([{ number: 2, repository: { nameWithOwner: "o/b" }, updatedAt: "t2" }, { number: 3, repository: { nameWithOwner: "o/a" }, updatedAt: "t3" }])),
    );
    const hits = await searchMyPrs(gh);
    expect(calls).toEqual([
      ["search", "prs", "--review-requested=@me", "--state=open", "--json", "number,repository,updatedAt", "--limit", "100"],
      ["search", "prs", "--author=@me", "--state=open", "--json", "number,repository,updatedAt", "--limit", "100"],
    ]);
    expect(hits).toEqual([
      { repo: "o/a", number: 1, updatedAt: "t1" },
      { repo: "o/b", number: 2, updatedAt: "t2" },
      { repo: "o/a", number: 3, updatedAt: "t3" },
    ]);
  });

  it("throws with gh's own words when a search fails", async () => {
    const { gh } = fake(bad("gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN"));
    await expect(searchMyPrs(gh)).rejects.toThrow(/gh search prs failed: gh: To use/);
  });
});

describe("prFacts and the viewer", () => {
  it("asks GraphQL for one PR and unwraps the node", async () => {
    const node = { number: 7, title: "t" };
    const { gh, calls } = fake(ok(JSON.stringify({ data: { repository: { pullRequest: node } } })));
    expect(await prFacts(gh, "o/a", 7)).toEqual(node);
    expect(calls[0]!.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(calls[0]).toEqual(expect.arrayContaining(["-F", "owner=o", "-F", "name=a", "-F", "number=7"]));
    expect(calls[0]!.find((a) => a.startsWith("query="))).toMatch(/pullRequest\(number:\$number\)/);
  });

  it("answers null for a PR GitHub no longer shows, and the login and teams come from the API", async () => {
    const { gh } = fake(ok(JSON.stringify({ data: { repository: { pullRequest: null } } })));
    expect(await prFacts(gh, "o/a", 7)).toBeNull();
    const who = fake(ok(JSON.stringify({ data: { viewer: { login: "me" } } })));
    expect(await viewerLogin(who.gh)).toBe("me");
    const teams = fake(ok(JSON.stringify([{ slug: "core" }, { slug: "web" }])));
    expect(await viewerTeams(teams.gh)).toEqual(["core", "web"]);
    expect(teams.calls[0]).toEqual(["api", "user/teams", "--paginate"]);
    expect(await viewerTeams(fake(bad("nope")).gh)).toEqual([]);
  });
});

describe("what the review and address stages read", () => {
  it("prDiff keeps the tail of a long diff; prFiles and prComments map the API's fields", async () => {
    const long = "x".repeat(250_000);
    const diff = fake(ok(long));
    const text = await prDiff(diff.gh, "o/a", 7);
    expect(diff.calls[0]).toEqual(["pr", "diff", "7", "--repo", "o/a"]);
    expect(text).toHaveLength(200_000);

    const files = fake(ok(JSON.stringify({ files: [{ path: "a.ts", additions: 3, deletions: 1 }] })));
    expect(await prFiles(files.gh, "o/a", 7)).toEqual([{ path: "a.ts", additions: 3, deletions: 1 }]);
    expect(files.calls[0]).toEqual(["pr", "view", "7", "--repo", "o/a", "--json", "files"]);

    const comments = fake(ok(JSON.stringify([{ path: "a.ts", line: 4, user: { login: "them" }, body: "why?" }, { path: "b.ts", line: null, user: null, body: "x" }])));
    expect(await prComments(comments.gh, "o/a", 7)).toEqual([
      { path: "a.ts", line: 4, author: "them", body: "why?" },
      { path: "b.ts", line: null, author: "ghost", body: "x" },
    ]);
    expect(comments.calls[0]).toEqual(["api", "repos/o/a/pulls/7/comments", "--paginate"]);
  });

  it("prThreads returns only unresolved threads with their ids and comments", async () => {
    const reply = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: "T1", isResolved: false, path: "a.ts", line: 4, comments: { nodes: [{ author: { login: "them" }, body: "why?", createdAt: "t" }] } },
                { id: "T2", isResolved: true, path: "b.ts", line: 1, comments: { nodes: [] } },
              ],
            },
          },
        },
      },
    };
    const { gh } = fake(ok(JSON.stringify(reply)));
    expect(await prThreads(gh, "o/a", 7)).toEqual([{ id: "T1", path: "a.ts", line: 4, comments: [{ author: "them", body: "why?", at: "t" }] }]);
  });
});

describe("what the host writes back", () => {
  it("mergePr squashes and deletes the branch; cloneRepo clones into dest", async () => {
    const merge = fake(ok(""));
    expect(await mergePr(merge.gh, "o/a", 7)).toBeNull();
    expect(merge.calls[0]).toEqual(["pr", "merge", "7", "--repo", "o/a", "--squash", "--delete-branch"]);
    expect(await mergePr(fake(bad("Pull request is not mergeable")).gh, "o/a", 7)).toMatch(/not mergeable/);

    const clone = fake(ok(""));
    expect(await cloneRepo(clone.gh, "o/a", "/r/a")).toBeNull();
    expect(clone.calls[0]).toEqual(["repo", "clone", "o/a", "/r/a"]);
  });

  it("postReview sends one review with its event and inline comments through --input", async () => {
    const { gh, calls } = fake(ok("{}"));
    const error = await postReview(gh, "o/a", 7, {
      event: "COMMENT",
      body: "Two nits.",
      comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: "nit" }],
    });
    expect(error).toBeNull();
    expect(calls[0]!.slice(0, 4)).toEqual(["api", "--method", "POST", "repos/o/a/pulls/7/reviews"]);
    const file = calls[0]![calls[0]!.indexOf("--input") + 1]!;
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      event: "COMMENT",
      body: "Two nits.",
      comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: "nit" }],
    });
  });

  it("replies to and resolves a thread by its GraphQL id, and can ask whether it is resolved", async () => {
    const reply = fake(ok("{}"));
    expect(await replyToThread(reply.gh, "T1", "Fixed in abc.")).toBeNull();
    expect(reply.calls[0]!.find((a) => a.startsWith("query="))).toMatch(/addPullRequestReviewThreadReply/);
    expect(reply.calls[0]).toEqual(expect.arrayContaining(["-f", "threadId=T1", "-f", "body=Fixed in abc."]));

    const resolve = fake(ok("{}"));
    expect(await resolveThread(resolve.gh, "T1")).toBeNull();
    expect(resolve.calls[0]!.find((a) => a.startsWith("query="))).toMatch(/resolveReviewThread/);

    const check = fake(ok(JSON.stringify({ data: { node: { isResolved: true } } })));
    expect(await threadResolved(check.gh, "T1")).toBe(true);
    expect(await threadResolved(fake(bad("x")).gh, "T1")).toBe(false);
  });
});
