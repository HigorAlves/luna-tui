import { REVIEW_HELPER_PACKS, type Finding } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext, StageResult } from "../ports.ts";
import type { Decide } from "./check-decide.ts";
import { tagged } from "../decision-truth.ts";
import { prReviewRunner } from "./pr-review.ts";

const node = { number: 12, title: "Export CSV", body: "Adds the export.", url: "https://github.com/o/a/pull/12", isDraft: false, updatedAt: "t", baseRefName: "main", headRefName: "feat/export", author: { login: "them" }, headRepository: { nameWithOwner: "o/a" }, reviewDecision: null, mergeable: "MERGEABLE", reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [] } };
const context = { task: { id: "t1", route: "review", branch: "feat/export", worktreePath: "/wt", repoPath: "/r/a", source: { kind: "github_pr", repo: "o/a", number: 12, url: node.url, headRef: "feat/export", baseRef: "main" } } as unknown as TaskRow, stage: "reviewing", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;

const clean = { verdict: "approve", summary: "Fine.", findings: [], comments: [] };
const idor: Finding = { path: "a.ts", line: 1, severity: "security", title: "IDOR on export", body: "No owner check on the export route.", confidence: 0.9 };
const usage = { turns: 1, costUsd: 0.25, tokens: null };

function setup(opts: { answer?: unknown; helperFindings?: Partial<Record<string, Finding[]>>; helperRun?: (pack: string) => Promise<StageResult>; decide?: Decide | null; mainAnswer?: unknown; classify?: Record<string, unknown>; existing?: Array<{ path: string | null; line: number | null; author: string; body: string }> } = {}) {
  const github = fakeGitHub({ prFacts: async () => node as never, prDiff: async () => "diff --git a/a.ts b/a.ts\n+route(export)\n", prFiles: async () => [{ path: "a.ts", additions: 1, deletions: 0 }], prComments: async () => opts.existing ?? [], viewer: async () => ({ login: "luna" }) as never });
  const ran: string[] = [];
  const checks: Array<{ pack: string; check: { finding: Finding; excerpt: string } }> = [];
  const run = prReviewRunner({
    github,
    runPack: async () => ({ outcome: "pass", usage, detail: { answer: opts.mainAnswer ?? clean, summary: "Fine." } }),
    helpers: {
      run: async (_c, pack) => {
        ran.push(pack);
        if (opts.helperRun) return opts.helperRun(pack);
        return { outcome: "pass", usage, detail: { answer: { summary: `${pack} looked`, findings: opts.helperFindings?.[pack] ?? [] } } };
      },
      get decide() {
        const confirming: Decide = async (pack, check) => pack === "already_raised" ? ({ same: { value: true, p: 0.95 } }) : pack === "finding_classify" ? (opts.classify ?? { severity: { choice: "should_fix", confidence: 0.9 } }) : (pack === "finding_confirm" && checks.push({ pack, check: check as never }), { real: { value: true, p: 0.95 } });
        return opts.decide === undefined ? confirming : opts.decide;
      },
    },
  });
  return { run, ran, checks };
}

const posted = (result: Awaited<ReturnType<ReturnType<typeof setup>["run"]>>) => (result.requested?.[0] as unknown as { payload: { event: string; body: string; comments: Array<{ path: string; line: number; side: string; body: string }> } }).payload;

describe("what the gate keeps of the finding_confirm records", () => {
  const recording: Decide = async (pack) => (pack === "finding_confirm" ? tagged({ answer: { real: { value: true, p: 0.95 } }, recordId: "rec-sec" }) : { severity: { choice: "should_fix", confidence: 0.9 } });

  it("names the record of each finding that goes to the gate as a comment, by its file and line", async () => {
    const { run } = setup({ helperFindings: { review_security: [idor] }, decide: recording });
    const result = await run(context);
    expect(result.detail).toMatchObject({ decisions: { finding_confirm: { "a.ts:1": "rec-sec" } } });
  });

  it("keeps no record id of a finding the check dropped: it has no comment for a person to keep or delete", async () => {
    const { run } = setup({ helperFindings: { review_security: [idor] }, decide: async (pack) => (pack === "finding_confirm" ? tagged({ answer: { real: { value: false, p: 0.03 } }, recordId: "rec-gone" }) : { severity: { choice: "should_fix", confidence: 0.9 } }) });
    const result = await run(context);
    expect(result.detail?.decisions).toBeUndefined();
  });
});

describe("reviewing with the review passes", () => {
  it("runs all four passes on every PR, and a clean review stays an approve", async () => {
    const { run, ran } = setup();
    const result = await run(context);
    expect(ran).toEqual([...REVIEW_HELPER_PACKS]);
    expect(result.detail).toMatchObject({ verdict: "approve", helpers: REVIEW_HELPER_PACKS.map((pack) => ({ pack, outcome: "ok", findings: 0 })) });
    expect(result.usage).toMatchObject({ turns: 5, costUsd: 1.25 });
  });

  it("confirms a pass's own finding against the code, keeps it, and it blocks like the reviewer's: request changes with an inline comment", async () => {
    const { run, checks } = setup({ helperFindings: { review_security: [idor] } });
    const result = await run(context);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.pack).toBe("finding_confirm");
    expect(checks[0]!.check.finding).toEqual(idor);
    expect(result.detail).toMatchObject({ verdict: "request_changes", helpers: expect.arrayContaining([{ pack: "review_security", outcome: "ok", findings: 1, confirm: { proceed: 1 } }]) });
    const action = posted(result);
    expect(action.event).toBe("REQUEST_CHANGES");
    expect(action.comments).toEqual([{ path: "a.ts", line: 1, side: "RIGHT", body: "IDOR on export: No owner check on the export route." }]);
    expect(result.findings).toEqual([idor]);
  });

  it("drops a finding the judge says is not real, so it neither blocks nor comments", async () => {
    const { run } = setup({ helperFindings: { review_security: [idor] }, decide: async () => ({ real: { value: false, p: 0.03 } }) });
    const result = await run(context);
    expect(result.findings).toEqual([]);
    expect(result.detail).toMatchObject({ verdict: "approve", helpers: expect.arrayContaining([{ pack: "review_security", outcome: "ok", findings: 1, confirm: { proceed: 1 }, dropped: 1 }]) });
    expect(posted(result).comments).toEqual([]);
  });

  it("marks a flagged finding unsure at the gate only: the title and the comment body stay clean, and keeps a finding when no decision can be asked", async () => {
    const flagged = setup({ helperFindings: { review_iac: [idor] }, decide: async () => ({ real: { value: true, p: 0.6 } }) });
    const a = await flagged.run(context);
    expect(a.findings![0]).toEqual({ ...idor, unsure: true });
    expect(posted(a).comments).toEqual([{ path: "a.ts", line: 1, side: "RIGHT", body: "IDOR on export: No owner check on the export route.", unsure: true }]);
    const none = setup({ helperFindings: { review_iac: [idor] }, decide: null });
    const b = await none.run(context);
    expect(b.findings).toEqual([idor]);
    expect(b.detail).toMatchObject({ helpers: expect.arrayContaining([{ pack: "review_iac", outcome: "ok", findings: 1, confirm: { skipped: 1 } }]) });
  });

  it("checks the main reviewer's findings too: a confident no never drops one, it marks it and its line comment unsure", async () => {
    const main = { verdict: "request_changes", summary: "One bug.", findings: [{ ...idor, severity: "bug", title: "Wrong total" }], comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "Wrong total: sums twice." }] };
    const { run } = setup({ mainAnswer: main, decide: async () => ({ real: { value: false, p: 0.03 } }) });
    const result = await run(context);
    expect(result.findings).toMatchObject([{ title: "Wrong total", unsure: true }]);
    expect(result.detail).toMatchObject({ verdict: "request_changes", mainConfirm: { proceed: 1 } });
    expect(posted(result).comments).toEqual([{ path: "a.ts", line: 1, side: "RIGHT", body: "Wrong total: sums twice.", unsure: true }]);
    const sure = setup({ mainAnswer: main });
    const kept = await sure.run(context);
    expect(sure.checks).toHaveLength(1);
    expect(kept.findings).toEqual(main.findings);
    expect(posted(kept).comments[0]).not.toHaveProperty("unsure");
  });

  it("merges a pass's finding the reviewer also made, asking about it once (as the reviewer's own)", async () => {
    const main = { verdict: "request_changes", summary: "One.", findings: [{ ...idor, title: "idor on export", severity: "bug" }], comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "idor on export" }] };
    const { run, checks } = setup({ mainAnswer: main, helperFindings: { review_security: [idor] } });
    const result = await run(context);
    expect(checks).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings![0]!.severity).toBe("bug");
    expect(posted(result).comments).toHaveLength(1);
  });

  it("never fails the review for a pass that fails, and says so in the detail", async () => {
    const { run } = setup({ helperRun: async (pack) => (pack === "review_migration" ? { outcome: "fail", detail: { error: "boom" } } : { outcome: "pass", detail: { answer: { summary: "ok", findings: [] } } }) });
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ verdict: "approve", helpers: expect.arrayContaining([{ pack: "review_migration", outcome: "failed", findings: 0 }]), helperNotes: [expect.stringContaining("review_migration")] });
  });

  it("caps the inline comments across the reviewer's and the passes' findings together", async () => {
    const many = Array.from({ length: 20 }, (_, i): Finding => ({ ...idor, line: 10 + i * 10, title: `Issue ${i}`, severity: "nit" }));
    const { run } = setup({ helperFindings: { review_second: many } });
    const result = await run(context);
    expect(result.findings).toHaveLength(20);
    expect(posted(result).comments).toHaveLength(15);
  });

  it("starts the passes with the main review, not after it, and waits for them even when the main review does not pass", async () => {
    const github = fakeGitHub({ prFacts: async () => node as never, prDiff: async () => "diff --git a/a.ts b/a.ts\n+x\n", prFiles: async () => [], prComments: async () => [] });
    const events: string[] = [];
    let finishMain!: () => void;
    const mainGate = new Promise<void>((r) => (finishMain = r));
    const run = prReviewRunner({
      github,
      runPack: async () => (events.push("main started"), await mainGate, events.push("main done"), { outcome: "fail", detail: { error: "main failed" } }),
      helpers: {
        decide: null,
        run: async (_c, pack) => (events.push(`${pack} started`), await new Promise((r) => setTimeout(r, 10)), events.push(`${pack} done`), { outcome: "pass", detail: { answer: { summary: "s", findings: [] } } }),
      },
    });
    const result = run(context);
    await new Promise((r) => setTimeout(r, 30));
    expect(events.filter((e) => e.endsWith("started")).length).toBe(5);
    expect(events).not.toContain("main done");
    finishMain();
    const out = await result;
    expect(out.outcome).toBe("fail");
    expect(events.filter((e) => e.endsWith("done")).length).toBe(5);
  });
});

describe("reviewing against the comments already on the PR", () => {
  const theirs = { path: "a.ts", line: 2, author: "coderabbit", body: "Anyone can export another user's data: add an owner check." };

  it("drops a finding another reviewer already raised, with its comment, and says who raised it first", async () => {
    const { run } = setup({ helperFindings: { review_security: [idor] }, existing: [theirs] });
    const result = await run(context);
    expect(result.findings).toEqual([]);
    expect(result.detail).toMatchObject({ verdict: "approve", alreadyRaised: [{ title: "IDOR on export", path: "a.ts", line: 1, by: "coderabbit" }] });
    expect(posted(result).comments).toEqual([]);
  });

  it("keeps the finding when the comment is ours or the decision says it is another point", async () => {
    const ours = setup({ helperFindings: { review_security: [idor] }, existing: [{ ...theirs, author: "luna" }] });
    expect((await ours.run(context)).findings).toEqual([idor]);
    const other = setup({ helperFindings: { review_security: [idor] }, existing: [theirs], decide: async (pack) => (pack === "already_raised" ? { same: { value: false, p: 0.02 } } : { real: { value: true, p: 0.95 } }) });
    const result = await other.run(context);
    expect(result.findings).toEqual([idor]);
    expect(result.detail).not.toHaveProperty("alreadyRaised");
  });
});

describe("recalibrating severity before the verdict", () => {
  const main = (severity: string) => ({ verdict: "comment", summary: "One.", findings: [{ ...idor, severity, title: "Wrong total" }], comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "Wrong total: sums twice." }] });
  const classify = (choice: string, confidence = 0.95) => ({ severity: { choice, confidence } });

  it("lowers a bug the classifier calls a nit, so the verdict follows: a comment, not request changes, and the change is recorded", async () => {
    const { run } = setup({ mainAnswer: main("bug"), classify: classify("nit") });
    const result = await run(context);
    expect(result.findings).toMatchObject([{ severity: "suggestion", title: "Wrong total" }]);
    expect(result.detail).toMatchObject({ verdict: "comment", recalibrated: [{ from: "bug", to: "suggestion" }] });
    expect(posted(result).event).toBe("COMMENT");
  });

  it("raises a suggestion the classifier calls a blocker to a bug, and requests changes", async () => {
    const { run } = setup({ mainAnswer: main("suggestion"), classify: classify("blocker") });
    const result = await run(context);
    expect(result.detail).toMatchObject({ verdict: "request_changes", recalibrated: [{ from: "suggestion", to: "bug" }] });
    expect(posted(result).event).toBe("REQUEST_CHANGES");
  });

  it("changes nothing without a confident answer, and records nothing", async () => {
    const { run } = setup({ mainAnswer: main("bug"), classify: classify("nit", 0.6) });
    const result = await run(context);
    expect(result.detail).toMatchObject({ verdict: "request_changes" });
    expect(result.detail).not.toHaveProperty("recalibrated");
  });
});
