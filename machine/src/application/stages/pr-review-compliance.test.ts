import { COMPLIANCE_CONTROL_CHARS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { prReviewRunner } from "./pr-review.ts";

const node = {
  number: 12,
  title: "Export CSV",
  body: "Adds the export.",
  url: "https://github.com/o/a/pull/12",
  isDraft: false,
  updatedAt: "t",
  baseRefName: "main",
  headRefName: "feat/export",
  author: { login: "them" },
  headRepository: { nameWithOwner: "o/a" },
  reviewDecision: null,
  mergeable: "MERGEABLE",
  reviewRequests: { nodes: [] },
  reviewThreads: { nodes: [] },
  commits: { nodes: [] },
};

const context = {
  task: { id: "t1", route: "review", branch: "feat/export", worktreePath: "/wt", repoPath: "/r/a", source: { kind: "github_pr", repo: "o/a", number: 12, url: node.url, headRef: "feat/export", baseRef: "main" } } as unknown as TaskRow,
  stage: "reviewing",
  attempt: 1,
  runId: "r1",
  approvals: [],
  signal: new AbortController().signal,
} as StageContext;

const regimeFinding = { path: "a.ts", line: 1, severity: "security", title: "Email in the log", body: "The log line writes the email.", confidence: 0.9, regime: "gdpr", clause: "GDPR Art. 5(1)(c)", control: "Compliance/Controls/PRIV-LOG-01.md" };
const clean = { verdict: "approve", summary: "Fine.", findings: [], comments: [] };

type Seen = { review: { diff: string }; compliance: { repo: string; regimes: string[]; controls: Array<{ path: string; text: string }> } };

function withCompliance(opts: { regimes?: string[]; wiki?: "ok" | "fails"; pages?: Array<{ path: string; text: string }>; run?: () => Promise<StageResult> } = {}) {
  const runs: Seen[] = [];
  const github = fakeGitHub({ prFacts: async () => node as never, prDiff: async () => "diff --git a/a.ts b/a.ts\n+log(email)\n", prFiles: async () => [{ path: "a.ts", additions: 1, deletions: 0 }], prComments: async () => [] });
  const run = prReviewRunner({
    github,
    runPack: async () => ({ outcome: "pass", usage: { turns: 1, costUsd: 0.25, tokens: { input: 40, output: 4 } }, detail: { answer: clean, summary: "Fine." } }),
    compliance: {
      regimes: async () => (opts.regimes ?? []) as never,
      wiki: {
        readPages: async (_slug: string, prefix: string) => {
          if (opts.wiki === "fails") throw new Error("the wiki is disabled");
          const pages = opts.pages ?? [{ path: "Compliance/Controls/PRIV-LOG-01.md", text: "No personal data in logs." }];
          return pages.filter((p) => p.path.startsWith(prefix));
        },
        writePages: async () => ({ sha: "x" }),
      },
      run:
        opts.run ??
        (async (_context, review, compliance) => {
          runs.push({ review, compliance } as unknown as Seen);
          return { outcome: "pass", detail: { answer: { summary: "One GDPR finding.", findings: [regimeFinding], regimesRun: ["gdpr"] } } };
        }),
    },
  });
  return { run, runs };
}

describe("reviewing with the compliance review", () => {
  it("runs when the repo declares regimes, with the wiki's controls and the diff, and a high finding requests changes with the clause and the control in the comment", async () => {
    const { run, runs } = withCompliance({ regimes: ["gdpr"] });
    const result = await run(context);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.compliance).toEqual({ repo: "o/a", regimes: ["gdpr"], controls: [{ path: "Compliance/Controls/PRIV-LOG-01.md", text: "No personal data in logs." }] });
    expect(runs[0]!.review.diff).toContain("+log(email)");
    expect(result.detail).toMatchObject({ verdict: "request_changes", compliance: { regimesRun: ["gdpr"] } });
    const action = result.requested?.[0] as unknown as { payload: { event: string; body: string; comments: Array<{ body: string }> } };
    expect(action.payload.event).toBe("REQUEST_CHANGES");
    expect(action.payload.comments[0]!.body).toContain("[GDPR Art. 5(1)(c) · Compliance/Controls/PRIV-LOG-01.md]");
    expect(action.payload.body).toContain("One GDPR finding.");
    expect(result.findings).toHaveLength(1);
  });

  it("reads only the control and policy pages, not access reviews or answers, and skips an oversized page instead of stopping", async () => {
    const pages = [
      { path: "Compliance/Access-Reviews/2026-Q1.md", text: "alice, bob" },
      { path: "Compliance/Answers/acme.md", text: "answers" },
      { path: "Compliance/Controls/HUGE.md", text: "x".repeat(COMPLIANCE_CONTROL_CHARS + 1) },
      { path: "Compliance/Controls/PRIV-LOG-01.md", text: "No personal data in logs." },
      { path: "Compliance/Policies/Retention.md", text: "Keep a year." },
    ];
    const { run, runs } = withCompliance({ regimes: ["gdpr"], pages });
    const result = await run(context);
    expect(runs[0]!.compliance.controls.map((c) => c.path)).toEqual(["Compliance/Controls/PRIV-LOG-01.md", "Compliance/Policies/Retention.md"]);
    expect(result.detail).toMatchObject({ compliance: { notes: [expect.stringContaining("left out")] } });
  });

  it("adds the compliance sub-run's usage to the review's, even when its answer is not used", async () => {
    const usage = { turns: 2, costUsd: 0.5, tokens: { input: 100, output: 10 } };
    const ran = withCompliance({ regimes: ["gdpr"], run: async () => ({ outcome: "pass", usage, detail: { answer: { summary: "One.", findings: [], regimesRun: ["gdpr"] } } }) });
    const failed = withCompliance({ regimes: ["gdpr"], run: async () => ({ outcome: "fail", usage, detail: { error: "boom" } }) });
    for (const { run } of [ran, failed]) {
      const result = await run(context);
      expect(result.usage).toMatchObject({ turns: 2 + 1, costUsd: 0.5 + 0.25, tokens: { input: 100 + 40, output: 10 + 4 } });
    }
  });

  it("skips when no regime is declared", async () => {
    const { run, runs } = withCompliance({ regimes: [] });
    const result = await run(context);
    expect(runs).toHaveLength(0);
    expect(result.detail).toMatchObject({ verdict: "approve" });
    expect(result.detail).not.toHaveProperty("compliance");
  });

  it("goes on with no controls and a note when the wiki cannot be read", async () => {
    const { run, runs } = withCompliance({ regimes: ["soc2"], wiki: "fails" });
    const result = await run(context);
    expect(runs[0]!.compliance.controls).toEqual([]);
    expect(result.detail).toMatchObject({ compliance: { notes: [expect.stringContaining("the wiki is disabled")] } });
  });

  it("never blocks when the compliance run fails, throws or answers nonsense: the review goes on with a note", async () => {
    const failures = [
      async (): Promise<StageResult> => ({ outcome: "fail", detail: { error: "boom" } }),
      async (): Promise<StageResult> => {
        throw new Error("container died");
      },
      async (): Promise<StageResult> => ({ outcome: "pass", detail: { answer: { nope: 1 } } }),
    ];
    for (const failing of failures) {
      const { run } = withCompliance({ regimes: ["gdpr"], run: failing });
      const result = await run(context);
      expect(result).toMatchObject({ outcome: "pass", detail: { verdict: "approve", compliance: { regimesRun: [], notes: [expect.stringContaining("did not run")] } } });
    }
  });
});
