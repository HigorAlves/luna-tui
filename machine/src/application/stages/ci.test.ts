import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { Check } from "../github.ts";
import { fakeGitHub } from "../../test/github.ts";
import { type Learned, type TruthSink, tagged } from "../decision-truth.ts";
import type { Decide } from "./check-decide.ts";
import { ciWatchRunner } from "./ci.ts";
import type { StageContext, StageResult } from "../ports.ts";

const checks = (...states: Array<[string, string]>): Check[] =>
  states.map(([name, state]) => ({ name, state, link: `https://github.com/a/b/actions/runs/${name === "lint" ? 111 : 222}/job/1` }));
const finding = { path: "a.ts", line: 1, start_line: null, severity: "test", title: "red", body: "", suggestion_code: null, confidence: 1 };
const pack = (answer: Record<string, unknown>): StageResult => ({ outcome: "pass", detail: { answer } });

function setup(opts: { polls: Check[][]; pack?: StageResult; maxWaitMs?: number; parent?: { ref: string; checks: Check[] }; graceMs?: number; realSleepMs?: number; mergeable?: string[]; rebase?: { ok: true; onto: string } | { ok: false; error: string; conflicts: string[] }; classOf?: string | null; reruns?: number; autoRebase?: number; learn?: boolean; lastRed?: { recordId: string; job: string } | null; staleAfterRerun?: number; resolveConflicts?: unknown; defaultBranch?: string | null; defaultRebase?: boolean; exec?: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> }) {
  let poll = 0;
  let facts = 0;
  // A re-run's jobs get new ids, as on GitHub: after the n-th re-run a check's link ends in /job/<n+1> (after `staleAfterRerun` polls that
  // still show the old one).
  let reruns = 0;
  let sinceRerun = 0;
  const relinked = (list: Check[]): Check[] => {
    if (reruns === 0 || sinceRerun++ < (opts.staleAfterRerun ?? 0)) return list;
    return list.map((c) => ({ ...c, link: c.link?.replace(/\/job\/1$/, `/job/${reruns + 1}`) ?? null }));
  };
  const github = fakeGitHub({
    prChecks: async (_slug, ref) => (opts.parent && ref === opts.parent.ref ? opts.parent.checks : relinked(opts.polls[Math.min(poll++, opts.polls.length - 1)]!)),
    findPr: async () => ({ url: "https://github.com/a/b/pull/7", number: 7, isDraft: true }),
    failedRunLog: async (_slug, runId) => `log of run ${runId}\nFAIL src/a.test.ts > boom\n`,
    rerunFailedJobs: async () => {
      reruns++;
      sinceRerun = 0;
    },
    ...(opts.defaultBranch !== undefined ? { defaultBranch: async () => opts.defaultBranch ?? null } : {}),
    ...(opts.mergeable ? { prFacts: async () => ({ mergeable: opts.mergeable![Math.min(facts++, opts.mergeable!.length - 1)] }) as never } : {}),
  });
  const rebase = vi.fn(async () => opts.rebase ?? { ok: true as const, onto: "origin/main" });
  const exec = vi.fn(opts.exec ?? (async (..._args: unknown[]) => ({ code: 0, stdout: "", stderr: "" })));
  const runPack = vi.fn(async (_context: StageContext, _ci?: unknown) => opts.pack ?? pack({ verdict: "green" }));
  const sleeps: number[] = [];
  const decide = vi.fn<Decide>(async () => tagged({ answer: { class: { choice: opts.classOf ?? "real", confidence: 0.9 } }, recordId: "rec-ci" }));
  const learned: Learned[] = [];
  const truth: TruthSink = { learned: async (fact) => (learned.push(fact), true) };
  const run = ciWatchRunner({
    github,
    runPack,
    ...("classOf" in opts && opts.classOf === null ? {} : { decide }),
    ...(opts.learn ? { truth, lastRed: async () => opts.lastRed ?? null } : {}),
    policy: async () => ({ reruns: opts.reruns ?? 1, autoRebase: opts.autoRebase ?? 1 }),
    slugOf: async () => "a/b",
    pollMs: 10,
    maxWaitMs: opts.maxWaitMs ?? 1_000,
    parentRef: async () => opts.parent?.ref ?? null,
    graceMs: opts.graceMs,
    ...(opts.defaultRebase ? {} : { rebase }),
    ...(opts.resolveConflicts ? { resolveConflicts: opts.resolveConflicts as never } : {}),
    exec,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (opts.realSleepMs) await new Promise((resolve) => setTimeout(resolve, opts.realSleepMs));
    },
  });
  const context = {
    task: { id: "t1", branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo" } as unknown as TaskRow,
    stage: "ci_watch",
    attempt: 1,
    runId: "r1",
    approvals: [],
    signal: new AbortController().signal,
  } as StageContext;
  return { run, context, github, runPack, sleeps, rebase, exec, decide, learned };
}

describe("ci_watch on a card whose own PR already merged", () => {
  it("passes as shipped without watching a check, rebasing or pushing", async () => {
    const { run, context, github, rebase, exec } = setup({ polls: [checks(["lint", "FAILURE"])] });
    github.prMerged.mockResolvedValue({ merged: true, mergedSha: "m".repeat(40), state: "closed", mergedAt: "2026-11-10T00:36:48Z" });
    github.prFacts.mockResolvedValue({ baseRefName: "main" } as never);
    github.defaultBranch.mockResolvedValue("main");
    const result = await run({ ...context, recordedPrs: [214] });
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ alreadyMerged: true, number: 214, merged: { by: "person" } });
    expect(github.prChecks).not.toHaveBeenCalled();
    expect(rebase).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("ci_failure_class learns from what happened next", () => {
  const red = (...later: Check[][]) => [checks(["lint", "FAILURE"]), ...later];
  const taught = (learned: Learned[]) => learned.map((l) => [l.pack, l.recordId, l.label, l.source, l.kind, l.taskId]);

  it("a re-run that passed with no new commit says flake", async () => {
    const { run, context, learned } = setup({ polls: red(checks(["lint", "SUCCESS"])), classOf: "flake", learn: true });
    expect((await run(context)).outcome).toBe("pass");
    expect(taught(learned)).toEqual([["ci_failure_class", "rec-ci", { class: { choice: "flake" } }, "ci_rerun", "fact", "t1"]]);
  });

  it("a re-run still red rules the flake out: real, infra or drift", async () => {
    const { run, context, learned } = setup({ polls: red(checks(["lint", "FAILURE"])), classOf: "flake", learn: true });
    expect((await run(context)).outcome).toBe("escalated");
    expect(taught(learned)).toEqual([["ci_failure_class", "rec-ci", { class: { choice: ["real", "infra", "drift"] } }, "ci_rerun", "fact", "t1"]]);
  });

  it("a rebase with nothing else changed, after which it is green, says drift", async () => {
    const { run, context, learned } = setup({ polls: red(checks(["lint", "SUCCESS"]), checks(["lint", "SUCCESS"])), classOf: "drift", learn: true });
    expect((await run(context)).outcome).toBe("pass");
    expect(taught(learned)).toEqual([["ci_failure_class", "rec-ci", { class: { choice: "drift" } }, "ci_rebased", "fact", "t1"]]);
  });

  it("a Build fix after which the same job is green says real, from the red the last round named", async () => {
    const { run, context, learned } = setup({ polls: [checks(["lint", "SUCCESS"])], learn: true, lastRed: { recordId: "rec-before", job: "lint" } });
    expect((await run(context)).outcome).toBe("pass");
    expect(taught(learned)).toEqual([["ci_failure_class", "rec-before", { class: { choice: "real" } }, "ci_fixed", "fact", "t1"]]);
  });

  it("labels nothing when nothing was red before, and for an infrastructure escalation", async () => {
    const green = setup({ polls: [checks(["lint", "SUCCESS"])], learn: true });
    await green.run(green.context);
    const infra = setup({ polls: red(), classOf: "infra", learn: true });
    await infra.run(infra.context);
    expect([green.learned, infra.learned]).toEqual([[], []]);
  });

  it("puts the red job and its record in the result, so the next round can name them", async () => {
    const { run, context } = setup({ polls: red(), classOf: "real", pack: pack({ verdict: "fixable", summary: "s", findings: [finding] }), learn: true });
    expect(await run(context)).toMatchObject({ detail: { classRecord: "rec-ci", classJob: "lint" } });
  });
});

describe("ci_watch after a push", () => {
  const before = checks(["guard", "SUCCESS"], ["lint", "FAILURE"]);

  it("does not pass on the fast checks while the workflow run the parent had has not started", async () => {
    const { run, context, github } = setup({
      parent: { ref: "parent-sha", checks: before },
      polls: [checks(["guard", "SUCCESS"]), checks(["guard", "SUCCESS"]), checks(["guard", "SUCCESS"], ["lint", "PENDING"]), checks(["guard", "SUCCESS"], ["lint", "SUCCESS"])],
    });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { step: "checks" } });
    expect((result.detail?.checks as Check[]).map((c) => c.name).sort()).toEqual(["guard", "lint"]);
    expect(github.prChecks).toHaveBeenCalledWith("a/b", "hardness/t1");
  });

  it("stops waiting for a check that never comes once the grace is over", async () => {
    const { run, context } = setup({
      parent: { ref: "parent-sha", checks: before },
      polls: [checks(["guard", "SUCCESS"])],
      graceMs: 30,
      realSleepMs: 10,
    });
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect((result.detail?.checks as Check[]).map((c) => c.name)).toEqual(["guard"]);
  });
});

describe("ci_watch classifies a red run by a typed decision", () => {
  const red = (...more: Check[][]) => [checks(["lint", "FAILURE"]), ...more];

  it("asks ci_failure_class with the failing job and its log flattened and capped, as data", async () => {
    const { run, context, decide } = setup({ polls: red(), pack: pack({ verdict: "fixable", summary: "s", findings: [finding] }) });
    await run(context);
    const [name, check] = decide.mock.calls[0]!;
    expect(name).toBe("ci_failure_class");
    expect(check).toMatchObject({ kind: "ci", ci: { job: "lint" } });
    expect(check.ci!.log).toContain("FAIL src/a.test.ts &gt; boom");
    expect(check.ci!.log).not.toContain("\n");
    expect(check.ci!.log.length).toBeLessThanOrEqual(4000);
  });

  it("asks the investigator for the fix only when the class is a real failure, and fails with its findings", async () => {
    const { run, context, runPack } = setup({ polls: red(), classOf: "real", pack: pack({ verdict: "flake", summary: "s", findings: [finding] }) });
    const result = await run(context);
    expect(runPack).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "fail", detail: { verdict: "fixable", class: "real" }, findings: [finding] });
  });

  it("re-runs a flake once (verify.ci_flaky_reruns) and passes when it goes green, never asking the investigator", async () => {
    const { run, context, github, runPack } = setup({ polls: red(checks(["lint", "SUCCESS"])), classOf: "flake" });
    const result = await run(context);
    expect(runPack).not.toHaveBeenCalled();
    expect(github.rerunFailedJobs).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("pass");
  });

  it("sends a flake that is still red after its re-runs to a person, not to Build", async () => {
    const { run, context, github } = setup({ polls: red(checks(["lint", "FAILURE"]), checks(["lint", "FAILURE"])), classOf: "flake", reruns: 2 });
    const result = await run(context);
    expect(github.rerunFailedJobs).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ outcome: "escalated", detail: { class: "flake", escalation: "flaky_tests" } });
  });

  it("escalates a flake at once when the repository allows no re-run", async () => {
    const { run, context, github } = setup({ polls: red(), classOf: "flake", reruns: 0 });
    expect((await run(context)).outcome).toBe("escalated");
    expect(github.rerunFailedJobs).not.toHaveBeenCalled();
  });

  it("re-runs an infrastructure failure once and passes when it goes green, teaching nothing", async () => {
    // The site card's PR #216 (2026-11-08): fresh-clone hit a 504 downloading Python; a person had to re-run it.
    const { run, context, runPack, github, learned } = setup({ polls: red(checks(["lint", "SUCCESS"])), classOf: "infra", learn: true });
    const result = await run(context);
    expect(github.rerunFailedJobs).toHaveBeenCalledTimes(1);
    expect(runPack).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "pass", detail: { class: "infra", note: "infrastructure failure, re-run passed" } });
    expect(learned).toEqual([]);
  });

  it("does not read a re-run as green while GitHub lists only the other checks, nor as red while it still shows the old job", async () => {
    // PR #216 (2026-11-08): right after the re-run the list held only Vercel and GitGuardian; "nothing red" passed while fresh-clone was queued.
    const gap = setup({ polls: red([{ name: "vercel", state: "SUCCESS", link: "https://vercel.com/x" }], checks(["lint", "FAILURE"])), classOf: "infra" });
    expect(await gap.run(gap.context)).toMatchObject({ outcome: "escalated", detail: { escalation: "env_broken" } });
    const stale = setup({ polls: red(checks(["lint", "FAILURE"]), checks(["lint", "SUCCESS"])), classOf: "flake", staleAfterRerun: 1 });
    // The first poll after the re-run still shows the old red job: that is not the re-run's answer, so the green one after it is.
    expect(await stale.run(stale.context)).toMatchObject({ outcome: "pass", detail: { note: "flake, re-run passed" } });
  });

  it("sends an infrastructure failure to a person when it stays red after the re-run, or when no re-run is allowed", async () => {
    const red2 = setup({ polls: red(checks(["lint", "FAILURE"])), classOf: "infra" });
    const result = await red2.run(red2.context);
    expect(red2.github.rerunFailedJobs).toHaveBeenCalledTimes(1);
    expect(red2.runPack).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "escalated", detail: { class: "infra", escalation: "env_broken" } });
    expect((result.detail as { reason: string }).reason).toContain("stayed red after 1 re-run");
    const none = setup({ polls: red(), classOf: "infra", reruns: 0 });
    expect(await none.run(none.context)).toMatchObject({ outcome: "escalated", detail: { escalation: "env_broken" } });
    expect(none.github.rerunFailedJobs).not.toHaveBeenCalled();
  });

  it("rebases on a drift when verify.auto_rebase allows, and watches again; otherwise a person decides", async () => {
    const on = setup({ polls: red(checks(["lint", "SUCCESS"]), checks(["lint", "SUCCESS"])), classOf: "drift" });
    const result = await on.run(on.context);
    expect(on.rebase).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "pass", detail: { rebased: true } });
    const off = setup({ polls: red(), classOf: "drift", autoRebase: 0 });
    expect((await off.run(off.context)).outcome).toBe("escalated");
    expect(off.rebase).not.toHaveBeenCalled();
  });

  it("falls back to the investigator's own verdict when the decision cannot be had", async () => {
    const { run, context, runPack } = setup({ polls: red(), classOf: null, pack: pack({ verdict: "fixable", summary: "s", findings: [finding] }) });
    expect((await run(context)).outcome).toBe("fail");
    expect(runPack).toHaveBeenCalledTimes(1);
  });
});

describe("ci_watch", () => {
  it("passes when every check is green", async () => {
    const { run, context, runPack } = setup({ polls: [checks(["lint", "SUCCESS"], ["test", "SUCCESS"])] });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { step: "checks" } });
    expect(runPack).not.toHaveBeenCalled();
  });

  it("passes with a note when no checks are configured", async () => {
    const { run, context } = setup({ polls: [[]] });
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(String(result.detail?.note)).toContain("no CI checks");
  });

  it("polls while checks are pending", async () => {
    const { run, context, github, sleeps } = setup({
      polls: [checks(["lint", "PENDING"]), checks(["lint", "IN_PROGRESS"]), checks(["lint", "SUCCESS"])],
    });
    expect((await run(context)).outcome).toBe("pass");
    expect(github.prChecks).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 10]);
  });

  it("fails fixable with the pack's findings", async () => {
    const { run, context, runPack } = setup({
      polls: [checks(["lint", "FAILURE"])],
      pack: pack({ verdict: "fixable", summary: "lint broke", findings: [finding] }),
    });
    const result = await run(context);
    expect(runPack).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "fail", detail: { verdict: "fixable", findings: [finding] }, findings: [finding] });
  });

  it("re-runs a flake once and passes when it goes green", async () => {
    const { run, context, github } = setup({
      polls: [checks(["lint", "FAILURE"]), checks(["lint", "SUCCESS"])],
      pack: pack({ verdict: "flake", summary: "network" }),
    });
    const result = await run(context);
    expect(github.rerunFailedJobs).toHaveBeenCalledWith("a/b", "111");
    expect(result.outcome).toBe("pass");
    expect(String(result.detail?.note)).toContain("flake, re-run passed");
  });

  it("treats a flake that stays red as fixable", async () => {
    const { run, context } = setup({
      polls: [checks(["lint", "FAILURE"]), checks(["lint", "FAILURE"])],
      pack: pack({ verdict: "flake", summary: "network", findings: [finding] }),
    });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "fail", detail: { verdict: "fixable" } });
  });

  it("hands the pack the PR, the checks and the failed run's log, fetched on the host", async () => {
    const { run, context, runPack, github } = setup({
      polls: [checks(["lint", "FAILURE"], ["unit", "SUCCESS"])],
      pack: pack({ verdict: "fixable", summary: "lint broke", findings: [finding] }),
    });
    await run(context);
    expect(github.failedRunLog).toHaveBeenCalledWith("a/b", "111");
    expect(runPack).toHaveBeenCalledWith(context, {
      pr: { number: 7, url: "https://github.com/a/b/pull/7" },
      checks: [
        { name: "lint", state: "FAILURE", url: "https://github.com/a/b/actions/runs/111/job/1" },
        { name: "unit", state: "SUCCESS", url: "https://github.com/a/b/actions/runs/222/job/1" },
      ],
      logs: "log of run 111\nFAIL src/a.test.ts > boom\n",
    });
  });

  it("escalates infra and needs_debug with the pack's reason and options", async () => {
    for (const verdict of ["infra", "needs_debug"]) {
      const { run, context } = setup({
        polls: [checks(["lint", "FAILURE"])],
        pack: pack({ kind: "escalated", verdict, summary: "runner down", reason: "runner out of disk", options: ["clean the runner"] }),
      });
      const result = await run(context);
      expect(result).toMatchObject({ outcome: "escalated", detail: { verdict, reason: "runner out of disk", options: ["clean the runner"] } });
    }
  });

  it("passes an escalated pack result straight through", async () => {
    const { run, context } = setup({
      polls: [checks(["lint", "FAILURE"])],
      pack: { outcome: "escalated", detail: { reason: "gh has no credential here", options: ["add a token"] } },
    });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "escalated", detail: { reason: "gh has no credential here", step: "triage" } });
  });

  it("fails when CI does not settle in time", async () => {
    const { run, context } = setup({ polls: [checks(["lint", "PENDING"])], maxWaitMs: 0 });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toBe("CI did not settle in 45m");
  });
});

describe("ci_watch on a conflicting PR", () => {
  const green = checks(["lint", "SUCCESS"]);

  it("rebases once, pushes with a lease and watches the checks again", async () => {
    const { run, context, rebase, exec } = setup({ polls: [green], mergeable: ["CONFLICTING", "MERGEABLE"] });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { step: "checks", rebased: true } });
    expect(rebase).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("git", expect.arrayContaining(["push", "--force-with-lease", "origin", "hardness/t1"]));
  });

  it("puts the branch back where it was when the forced push after the rebase fails, and pins the lease to that head", async () => {
    const BEFORE = "e".repeat(40);
    const { run, context, exec } = setup({
      polls: [green],
      mergeable: ["CONFLICTING"],
      exec: async (_command, args) => (args.includes("rev-parse") ? { code: 0, stdout: `${BEFORE}\n`, stderr: "" } : args.some((a) => a.startsWith("--force-with-lease")) ? { code: 1, stdout: "", stderr: "could not read Username" } : { code: 0, stdout: "", stderr: "" }),
    });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("could not read Username");
    expect(exec).toHaveBeenCalledWith("git", expect.arrayContaining(["push", `--force-with-lease=refs/heads/hardness/t1:${BEFORE}`, "origin", "hardness/t1"]));
    expect(exec).toHaveBeenCalledWith("git", expect.arrayContaining(["reset", "--hard", "--quiet", BEFORE]));
  });

  describe("when the rebase stops on a real conflict", () => {
    const TIP = "c".repeat(40);
    const stops = { ok: false as const, error: "stopped", conflicts: ["a.ts"] };
    const tipExec = async (_command: string, args: string[]) => ({ code: 0, stdout: args.some((a) => a.startsWith("refs/remotes/origin/")) ? `${TIP}\n` : "", stderr: "" });
    const merged = () => vi.fn(async () => ({ ok: true as const, head: "d".repeat(40), resolved: ["a.ts"], result: { outcome: "escalated" as const, detail: {} } }));

    it("hands it to the merge round against GitHub's default branch, and watches the checks again without a forced push", async () => {
      const resolveConflicts = merged();
      const { run, context, exec } = setup({ polls: [green], mergeable: ["CONFLICTING", "MERGEABLE"], rebase: stops, exec: tipExec, resolveConflicts, defaultBranch: "main" });
      const result = await run(context);
      expect(result).toMatchObject({ outcome: "pass", detail: { step: "checks", rebased: true } });
      expect(resolveConflicts).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ id: "t1" }) }), { slug: "a/b", number: 7, base: { sha: TIP, name: "main" }, label: "ci", pack: null });
      expect(exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["--force-with-lease"]));
    });

    it("escalates with the files and the merge round's reason when it did not land", async () => {
      const resolveConflicts = vi.fn(async () => ({ ok: false as const, result: { outcome: "escalated" as const, detail: { reason: "the checks failed after merging main" } } }));
      const { run, context } = setup({ polls: [green], mergeable: ["CONFLICTING"], rebase: stops, exec: tipExec, resolveConflicts, defaultBranch: "main" });
      const result = await run(context);
      expect(result.outcome).toBe("escalated");
      expect(result.detail).toMatchObject({ verdict: "conflict_unresolvable", reason: expect.stringMatching(/stops on: a\.ts.*merging instead did not resolve it: the checks failed after merging main/) });
    });

    it("escalates as before when no merge round is wired", async () => {
      const { run, context } = setup({ polls: [green], mergeable: ["CONFLICTING"], rebase: stops, defaultBranch: "main" });
      expect((await run(context)).detail).toMatchObject({ verdict: "conflict_unresolvable", reason: expect.stringContaining("a.ts") });
    });
  });

  it("rebases onto the default branch GitHub names, not the one the user's checkout is on", async () => {
    const { run, context, exec } = setup({ polls: [green], mergeable: ["CONFLICTING", "MERGEABLE"], defaultRebase: true, defaultBranch: "trunk" });
    expect(await run(context)).toMatchObject({ outcome: "pass", detail: { rebased: true } });
    expect(exec).toHaveBeenCalledWith("git", expect.arrayContaining(["fetch", "--quiet", "--end-of-options", "origin", "trunk"]), expect.anything());
    expect(exec).toHaveBeenCalledWith("git", expect.arrayContaining(["rebase", "--empty=drop", "origin/trunk"]));
  });

  it("goes to a person, with no rebase and no push, when verify.auto_rebase is 0", async () => {
    const { run, context, rebase, exec } = setup({ polls: [green], mergeable: ["CONFLICTING"], autoRebase: 0 });
    const result = await run(context);
    expect(result.outcome).toBe("escalated");
    expect(rebase).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("escalates as conflict_unresolvable when the PR still conflicts after the rebase", async () => {
    const { run, context, rebase } = setup({ polls: [green], mergeable: ["CONFLICTING", "CONFLICTING"] });
    const result = await run(context);
    expect(rebase).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ step: "conflict", verdict: "conflict_unresolvable", escalation: "other" });
    expect((result.detail as { options: string[] }).options).toHaveLength(2);
  });

  it("escalates when the rebase stops, naming the files", async () => {
    const { run, context } = setup({ polls: [green], mergeable: ["CONFLICTING"], rebase: { ok: false, error: "stopped", conflicts: ["a.ts", "b.ts"] } });
    const result = await run(context);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ verdict: "conflict_unresolvable", reason: expect.stringContaining("a.ts, b.ts") });
  });

  it("escalates like infra when the pack traces a red run to a conflict", async () => {
    const { run, context } = setup({
      polls: [checks(["lint", "FAILURE"])],
      pack: pack({ verdict: "conflict_unresolvable", classification: "conflict", summary: "merge conflict", reason: "main moved", options: ["rebase by hand"], findings: [] }),
    });
    const result = await run(context);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ verdict: "conflict_unresolvable", reason: "main moved", options: ["rebase by hand"] });
  });

  it("leaves a PR whose facts cannot be read alone", async () => {
    const { run, context, rebase } = setup({ polls: [green] });
    expect((await run(context)).outcome).toBe("pass");
    expect(rebase).not.toHaveBeenCalled();
  });
});
