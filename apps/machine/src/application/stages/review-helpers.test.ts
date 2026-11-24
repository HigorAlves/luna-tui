import { type Finding, type ReviewContext, REVIEW_HELPER_PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { StageContext, StageResult } from "../ports.ts";
import type { Decide } from "./check-decide.ts";
import { confirmHelperFindings, runHelpers } from "./review-helpers.ts";

const context = { task: { id: "t1", repoPath: "/r/a" } as unknown as TaskRow, stage: "reviewing", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal, started: async () => {}, resume: { container: "c", inputCommit: null }, engine: "claude:opus" } as unknown as StageContext;
const review = { pr: { repo: "o/a", number: 1, url: "u", title: "t", body: null, author: "a", baseRef: "main", headRef: "h" }, diff: "diff --git a/a.ts b/a.ts\n+x\n", files: [], existingComments: [] } as unknown as ReviewContext;

const finding = (over: Partial<Finding> = {}): Finding => ({ path: "a.ts", line: 3, severity: "security", title: "IDOR", body: "no owner check", confidence: 0.9, ...over });
const pass = (findings: Finding[], extra: Partial<StageResult> = {}): StageResult => ({ outcome: "pass", detail: { answer: { summary: "done", findings } }, ...extra });

describe("runHelpers", () => {
  it("runs the four passes as sub-runs of their own, with nothing of the main run's resume, engine or start hook", async () => {
    const seen: Array<{ pack: string; context: StageContext }> = [];
    const out = await runHelpers({ run: async (ctx, pack) => (seen.push({ pack, context: ctx }), pass([])) }, context, review);
    expect(seen.map((s) => s.pack)).toEqual([...REVIEW_HELPER_PACKS]);
    for (const s of seen) {
      expect(s.context.runId).toBe(`r1-${s.pack}`);
      expect(s.context.started).toBeUndefined();
      expect(s.context.resume).toBeUndefined();
      expect(s.context.engine).toBeUndefined();
    }
    expect(out.helpers.map((h) => [h.pack, h.outcome, h.findings.length])).toEqual(REVIEW_HELPER_PACKS.map((p) => [p, "ok", 0]));
    expect(out.notes).toEqual([]);
  });

  it("keeps each helper's findings and the engine it ran on, and adds up what the runs cost", async () => {
    const out = await runHelpers(
      {
        run: async (_c, pack) => pass(pack === "review_security" ? [finding()] : [], { usage: { turns: 2, costUsd: 0.5, tokens: null }, run: { info: { runtime: "claude", engine: "claude:sonnet", modelId: "m", sdk: { name: "s", version: "1" }, fingerprint: "0".repeat(64) } } }),
      },
      context,
      review,
    );
    const security = out.helpers.find((h) => h.pack === "review_security")!;
    expect(security).toMatchObject({ outcome: "ok", engine: "claude:sonnet", summary: "done" });
    expect(security.findings).toEqual([finding()]);
    expect(out.usage).toMatchObject({ turns: 8, costUsd: 2 });
  });

  it("turns a failed, escalated, throwing or unparseable helper into a note and keeps the others", async () => {
    const out = await runHelpers(
      {
        run: async (_c, pack) => {
          if (pack === "review_security") return { outcome: "fail", detail: { error: "boom" } };
          if (pack === "review_migration") throw new Error("container did not start");
          if (pack === "review_iac") return { outcome: "pass", detail: { answer: { findings: "nope" } } };
          return pass([finding({ path: "b.ts" })]);
        },
      },
      context,
      review,
    );
    expect(out.helpers.map((h) => [h.pack, h.outcome])).toEqual([["review_security", "failed"], ["review_migration", "failed"], ["review_iac", "unparseable"], ["review_second", "ok"]]);
    expect(out.notes).toHaveLength(3);
    expect(out.notes.join("\n")).toContain("review_migration");
    expect(out.notes.join("\n")).toContain("container did not start");
    expect(out.helpers[3]!.findings).toHaveLength(1);
  });

  it("starts every pass before any finishes by default, and runs at most `concurrency` at once when told", async () => {
    for (const [concurrency, expected] of [[undefined, 4], [1, 1], [2, 2]] as const) {
      let live = 0;
      let peak = 0;
      await runHelpers(
        {
          ...(concurrency ? { concurrency } : {}),
          run: async () => {
            live++;
            peak = Math.max(peak, live);
            await new Promise((r) => setTimeout(r, 5));
            live--;
            return pass([]);
          },
        },
        context,
        review,
      );
      expect(peak).toBe(expected);
    }
  });

  it("proves the passes overlap with a deferred fake: all four have started while none has finished", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const running = runHelpers({ run: async (_c, pack) => (started.push(pack), await gate, pass([])) }, context, review);
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual([...REVIEW_HELPER_PACKS]);
    release();
    expect((await running).helpers.every((h) => h.outcome === "ok")).toBe(true);
  });

  it("gives each pass a workspace of its own, hands it to the run, and removes every one, after a success and after a failure", async () => {
    const made: string[] = [];
    const removed: string[] = [];
    const given: Array<[string, string | undefined]> = [];
    const out = await runHelpers(
      {
        workspace: { make: async (ctx, pack) => (made.push(ctx.runId), { path: `/w/${ctx.runId}.review`, branch: `luna-review/${pack}` }), remove: (w) => void removed.push(w.path) },
        run: async (_c, pack, _r, workspace) => {
          given.push([pack, workspace?.path]);
          if (pack === "review_iac") throw new Error("container did not start");
          return pass([]);
        },
      },
      context,
      review,
    );
    expect(new Set(made).size).toBe(4);
    expect(given).toEqual(REVIEW_HELPER_PACKS.map((p) => [p, `/w/r1-${p}.review`]));
    expect([...removed].sort()).toEqual(REVIEW_HELPER_PACKS.map((p) => `/w/r1-${p}.review`).sort());
    expect(out.helpers.find((h) => h.pack === "review_iac")!.outcome).toBe("failed");
  });

  it("turns a workspace that cannot be made into a note for that pass alone, and never runs it", async () => {
    const ran: string[] = [];
    const out = await runHelpers(
      {
        workspace: { make: async (_c, pack) => { if (pack === "review_migration") throw new Error("clone failed"); return { path: `/w/${pack}`, branch: "b" }; }, remove: () => {} },
        run: async (_c, pack) => (ran.push(pack), pass([])),
      },
      context,
      review,
    );
    expect(ran).toEqual(["review_security", "review_iac", "review_second"]);
    expect(out.notes).toEqual([expect.stringContaining("review_migration did not run: clone failed")]);
    expect(out.helpers.filter((h) => h.outcome === "ok")).toHaveLength(3);
  });
});

describe("confirmHelperFindings", () => {
  const helper = (pack: (typeof REVIEW_HELPER_PACKS)[number], findings: Finding[]) => ({ pack, outcome: "ok" as const, findings, summary: "" });
  const answerOf = (value: boolean, p: number) => ({ real: { value, p } });
  const deps = (decide: Decide | null) => ({ decide, repoPath: "/r/a", decisions: {}, excerpt: async (f: Finding) => `excerpt of ${f.path}:${f.line}` });

  it("asks finding_confirm with the finding and its excerpt, and keeps what is a real defect", async () => {
    const asked: Array<{ pack: string; check: unknown; repoPath: string | null }> = [];
    const decide: Decide = async (pack, check, repoPath) => (asked.push({ pack, check, repoPath }), answerOf(true, 0.95));
    const f = finding();
    const out = await confirmHelperFindings(deps(decide), [helper("review_security", [f])], []);
    expect(asked).toEqual([{ pack: "finding_confirm", check: { kind: "finding", finding: f, excerpt: "excerpt of a.ts:3" }, repoPath: "/r/a" }]);
    expect(out.kept).toEqual([{ finding: f, unsure: false, pack: "review_security" }]);
    expect(out.verdicts).toEqual({ review_security: { proceed: 1 } });
  });

  it("drops a confident no and an ask, keeps a flag marked unsure, and keeps a finding when there is no decision to ask", async () => {
    const f = (n: number) => finding({ line: n, title: `t${n}` });
    const table: Array<Record<string, unknown>> = [answerOf(false, 0.02), answerOf(true, 0.6), answerOf(true, 0.97)];
    const decide: Decide = async (_p, check) => table[(check as { finding: Finding }).finding.line - 1]!;
    const out = await confirmHelperFindings(deps(decide), [helper("review_iac", [f(1), f(2), f(3)])], []);
    expect(out.kept.map((k) => [k.finding.line, k.unsure])).toEqual([[2, true], [3, false]]);
    expect(out.verdicts).toEqual({ review_iac: { proceed: 2, flag: 1 } });
    // A repo that raises the flag bar turns the middling answer into an ask, which drops the finding.
    const strict = await confirmHelperFindings({ ...deps(decide), decisions: { finding_confirm: { real: { flag: 0.9 } } } as never }, [helper("review_iac", [f(2)])], []);
    expect(strict.kept).toEqual([]);
    expect(strict.verdicts).toEqual({ review_iac: { ask: 1 } });
    const skipped = await confirmHelperFindings(deps(null), [helper("review_iac", [f(1)])], []);
    expect(skipped.kept).toEqual([{ finding: f(1), unsure: false, pack: "review_iac" }]);
    expect(skipped.verdicts).toEqual({ review_iac: { skipped: 1 } });
    const failing = await confirmHelperFindings(deps(async () => { throw new Error("no key"); }), [helper("review_iac", [f(1)])], []);
    expect(failing.kept).toHaveLength(1);
    expect(failing.verdicts).toEqual({ review_iac: { skipped: 1 } });
  });

  it("does not ask about a finding the main reviewer also made, and keeps it out of the helper's kept list", async () => {
    let asked = 0;
    const decide: Decide = async () => (asked++, answerOf(true, 0.95));
    const same = finding({ line: 4, title: "idor" });
    const out = await confirmHelperFindings(deps(decide), [helper("review_security", [same, finding({ path: "c.ts", title: "other" })])], [finding()]);
    expect(asked).toBe(1);
    expect(out.kept.map((k) => k.finding.path)).toEqual(["c.ts"]);
    expect(out.duplicates).toEqual({ review_security: 1 });
    expect(out.agreed).toEqual([same]);
  });
});
