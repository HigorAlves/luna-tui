import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { LinkableCard } from "../pr-link.ts";
import type { StageContext } from "../ports.ts";
import type { Decide } from "./check-decide.ts";
import { prReviewRunner } from "./pr-review.ts";

const node = { number: 12, title: "Export CSV", body: "Adds the export.", url: "https://github.com/o/a/pull/12", isDraft: false, updatedAt: "t", baseRefName: "main", headRefName: "feat/export", author: { login: "them" }, headRepository: { nameWithOwner: "o/a" }, reviewDecision: null, mergeable: "MERGEABLE", reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [] } };
const context = { task: { id: "t1", route: "review", branch: "feat/export", worktreePath: "/wt", repoPath: "/r/a", source: { kind: "github_pr", repo: "o/a", number: 12, url: node.url, headRef: "feat/export", baseRef: "main" } } as unknown as TaskRow, stage: "reviewing", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;
const DIFF = "diff --git a/src/export.ts b/src/export.ts\n--- a/src/export.ts\n+++ b/src/export.ts\n@@ -1,1 +1,3 @@\n x\n+const header = 'a';\n+rows.join(',');\n";
const clean = { verdict: "approve", summary: "Fine.", findings: [], comments: [] };
const card = (over: Partial<LinkableCard> & { id: string }): LinkableCard => ({ title: "Export", description: "", criteria: [], state: "implementing", route: "feature", repoPath: "/r/a", branch: "feat/export", source: null, jira: null, stateSince: null, ...over });

function setup(opts: { criteria: string[]; decide: Decide | null }) {
  const run = prReviewRunner({
    github: fakeGitHub({ prFacts: async () => node as never, prDiff: async () => DIFF, prFiles: async () => [], prComments: async () => [] }),
    runPack: async () => ({ outcome: "pass", detail: { answer: clean } }),
    links: { cards: async () => [card({ id: "abcdef123456", criteria: opts.criteria })], prUrls: async () => [] },
    helpers: { run: async () => ({ outcome: "pass", detail: { answer: { summary: "ok", findings: [] } } }), get decide() { return opts.decide; } },
  });
  return run;
}
const byMet = (answers: Array<{ value: boolean; p: number }>): Decide => {
  let i = 0;
  return (async (pack) => (pack === "criteria_met" ? { met: answers[i++] } : { level: { choice: "medium", confidence: 0.9 } })) as Decide;
};

describe("reviewing against the acceptance criteria of the linked cards", () => {
  it("keeps a checklist in the detail, makes an unmet criterion a bug that requests changes, and says the count in the body", async () => {
    const run = setup({ criteria: ["Header first", "Rows exported"], decide: byMet([{ value: true, p: 0.97 }, { value: false, p: 0.03 }]) });
    const result = await run(context);
    expect(result.detail).toMatchObject({
      verdict: "request_changes",
      criteria: [
        { source: "card abcdef12", criterion: "Header first", verdict: "met" },
        { source: "card abcdef12", criterion: "Rows exported", verdict: "unmet" },
      ],
    });
    expect(result.findings).toEqual([expect.objectContaining({ severity: "bug", path: "src/export.ts", line: 2 })]);
    const payload = (result.requested![0] as unknown as { payload: { body: string; comments: Array<{ path: string; line: number }> } }).payload;
    expect(payload.body).toContain("Acceptance criteria: 1 of 2 met, 1 not met.");
    expect(payload.comments).toEqual([expect.objectContaining({ path: "src/export.ts", line: 2 })]);
  });

  it("makes an unsure criterion a question that only comments, and does nothing without a linked criterion", async () => {
    const unsure = await setup({ criteria: ["Header first"], decide: byMet([{ value: true, p: 0.55 }]) })(context);
    expect(unsure.detail).toMatchObject({ verdict: "comment", criteria: [{ verdict: "unsure" }] });
    const none = await setup({ criteria: [], decide: byMet([]) })(context);
    expect(none.detail).not.toHaveProperty("criteria");
    expect(none.detail).toMatchObject({ verdict: "approve" });
  });

  it("is only unchecked, with no finding, when no decision is made", async () => {
    const result = await setup({ criteria: ["Header first"], decide: null })(context);
    expect(result.detail).toMatchObject({ verdict: "approve", criteria: [{ verdict: "unchecked" }] });
  });
});
