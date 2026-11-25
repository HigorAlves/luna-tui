import type { EngineId } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { tagged } from "../decision-truth.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext } from "../ports.ts";
import type { Decide } from "./check-decide.ts";
import { prReviewRunner } from "./pr-review.ts";

const node = { number: 12, title: "Export CSV", body: "Adds the export.", url: "https://github.com/o/a/pull/12", isDraft: false, updatedAt: "t", baseRefName: "main", headRefName: "feat/export", author: { login: "them" }, headRepository: { nameWithOwner: "o/a" }, reviewDecision: null, mergeable: "MERGEABLE", reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [] } };
const context = { task: { id: "t1", route: "review", branch: "feat/export", worktreePath: "/wt", repoPath: "/r/a", source: { kind: "github_pr", repo: "o/a", number: 12, url: node.url, headRef: "feat/export", baseRef: "main" } } as unknown as TaskRow, stage: "reviewing", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n+one\n+two\ndiff --git a/docs/b.md b/docs/b.md\n+doc\n-old\n";
const clean = { verdict: "approve", summary: "Fine.", findings: [], comments: [] };
const level = (choice: string, confidence = 0.95) => ({ level: { choice, confidence } });

function setup(opts: { decide?: Decide | null; policy?: { engines?: Record<string, string>; effort?: Record<string, string> }; ready?: EngineId[] } = {}) {
  const seen: { main?: StageContext["suggested"]; passes: Record<string, StageContext["suggested"]>; asked: Array<{ pack: string; check: Record<string, unknown> }> } = { passes: {}, asked: [] };
  const run = prReviewRunner({
    github: fakeGitHub({ prFacts: async () => node as never, prDiff: async () => DIFF, prFiles: async () => [], prComments: async () => [] }),
    runPack: async (c) => ((seen.main = c.suggested), { outcome: "pass", detail: { answer: clean } }),
    helpers: {
      run: async (c, pack) => ((seen.passes[pack] = c.suggested), { outcome: "pass", detail: { answer: { summary: "ok", findings: [] } } }),
      get decide() {
        const d: Decide = async (pack, check) => (seen.asked.push({ pack, check: check as never }), level("medium"));
        return opts.decide === undefined ? d : opts.decide;
      },
      policy: async () => (opts.policy ?? {}) as never,
      engineReady: async (engine) => (opts.ready ?? []).includes(engine),
    },
  });
  return { run, seen };
}

describe("the depth of a review follows the PR's risk", () => {
  it("asks pr_risk with the title as data, and the files with their line counts", async () => {
    const { run, seen } = setup();
    await run(context);
    const asked = seen.asked.find((a) => a.pack === "pr_risk")!;
    expect(asked.check).toMatchObject({ kind: "pr_risk", risk: { title: "Export CSV", scope: "the whole PR", filesTotal: 2, additions: 3, deletions: 1, files: expect.arrayContaining([{ path: "src/a.ts", additions: 2, deletions: 0 }]) } });
  });

  it("reviews a low-risk PR lighter: Opus at medium for the main reviewer, haiku at low for the four passes", async () => {
    const { run, seen } = setup({ decide: async () => level("low") });
    const result = await run(context);
    expect(seen.main).toEqual({ effort: "medium" });
    expect(Object.values(seen.passes)).toHaveLength(4);
    for (const s of Object.values(seen.passes)) expect(s).toEqual({ engine: "claude:haiku", effort: "low" });
    expect(result.detail).toMatchObject({ risk: { level: "low", by: "jev", applied: { main: { effort: "medium" }, passes: { engine: "claude:haiku", effort: "low" } } } });
  });

  it("keeps today's defaults for medium, and for no decision at all, a decision that throws, or a low that is not confident", async () => {
    const cases: Array<[Decide | null, string]> = [[async () => level("medium"), "jev"], [null, "skipped"], [async () => { throw new Error("down"); }, "skipped"], [async () => level("low", 0.6), "jev"]];
    for (const [decide, by] of cases) {
      const { run, seen } = setup({ decide });
      const result = await run(context);
      expect(seen.main).toBeUndefined();
      for (const s of Object.values(seen.passes)) expect(s).toBeUndefined();
      expect(result.detail).toMatchObject({ risk: { level: "medium", by } });
    }
  });

  it("deepens a high-risk PR: Sonnet at high for the passes, and the second opinion on the Codex login when there is one", async () => {
    const { run, seen } = setup({ decide: async () => level("high"), ready: ["codex:sol", "codex:luna"] });
    const result = await run(context);
    expect(seen.main).toBeUndefined();
    expect(seen.passes.review_security).toEqual({ engine: "claude:sonnet", effort: "high" });
    expect(seen.passes.review_second).toEqual({ engine: "codex:sol", effort: "high" });
    expect(result.detail).toMatchObject({ risk: { level: "high", applied: { second: "codex:sol" } } });
  });

  it("uses codex:luna for the second opinion when only it is ready, and leaves the second pass alone with no Codex login", async () => {
    const luna = setup({ decide: async () => level("high"), ready: ["codex:luna"] });
    await luna.run(context);
    expect(luna.seen.passes.review_second).toEqual({ engine: "codex:luna", effort: "high" });
    const none = setup({ decide: async () => level("high"), ready: [] });
    const result = await none.run(context);
    expect(none.seen.passes.review_second).toEqual({ engine: "claude:sonnet", effort: "high" });
    expect((result.detail as { risk: { applied: { second?: string } } }).risk.applied.second).toBeUndefined();
  });

  it("takes a high that is only flagged, for a mistake that way costs a look", async () => {
    const { run, seen } = setup({ decide: async () => level("high", 0.6) });
    await run(context);
    expect(seen.passes.review_security).toEqual({ engine: "claude:sonnet", effort: "high" });
  });

  it("never overrides luna.yaml: an engine or an effort the repo names is left out of what is suggested", async () => {
    const { run, seen } = setup({ decide: async () => level("low"), policy: { engines: { review_security: "claude:opus" }, effort: { reviewing: "high", review_iac: "high" } } });
    const result = await run(context);
    expect(seen.main).toBeUndefined();
    expect(seen.passes.review_security).toEqual({ effort: "low" });
    expect(seen.passes.review_iac).toEqual({ engine: "claude:haiku" });
    expect(seen.passes.review_migration).toEqual({ engine: "claude:haiku", effort: "low" });
    expect(result.detail).toMatchObject({ risk: { level: "low" } });
  });

  it("says when the fallback engine, not Jev, gave the answer", async () => {
    const { run } = setup({ decide: async () => tagged({ answer: level("low"), usage: { engine: "claude:haiku" } }) });
    const result = await run(context);
    expect(result.detail).toMatchObject({ risk: { level: "low", by: "fallback" } });
  });
});
