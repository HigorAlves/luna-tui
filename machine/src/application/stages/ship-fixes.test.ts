import { tagged } from "../decision-truth.ts";
import type { EvidencePack } from "@hardness/contracts";
import { describe, expect, it, vi } from "vitest";

import type { GitExec } from "../../adapters/git/worktree.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SECTION_END, SECTION_START } from "../../domain/evidence-markdown.ts";
import { emptyCursor, saveCursor } from "../ship-cursor.ts";
import { at, configureMachineRepos, machineGitDir } from "../../adapters/git/machine-repo.ts";
import { exec as realExec } from "../../adapters/process/exec.ts";
import { type FixInput, fixRound, guardFix, postable } from "./ship-fixes.ts";

const B = "b".repeat(40);
const N = "e".repeat(40);
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

const pack = (): EvidencePack => ({ summary: "Adds the export.", format: "text", scenarios: [{ text: "exports a cart", result: "pass" }] as never, findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: B, media: [], at: "2026-11-04T00:00:00.000Z" });
const thread = { id: "T1", path: "src/export.ts", line: 12, comments: [{ author: "bo", body: "please rename x", at: "t" }] };

const answer = (replies: Array<{ threadId: string; body: string; resolve: boolean }> = [{ threadId: "T1", body: "Renamed.", resolve: true }]) => ({ kind: "done", summary: "renamed", replies });

/** A worktree whose head moves when the addressing pack "commits", and a git that records what it was asked. */
function setup(over: { addressed?: StageResult; commit?: boolean; checks?: StageResult; verifying?: StageResult; valid?: string | Error; pushFails?: boolean; remote?: string; moveDuringChecks?: boolean; noSave?: boolean; branchRef?: string; symbolicRef?: string; names?: string; fresh?: { back?: { ok: boolean; reason?: string } } } = {}) {
  let head = B;
  const git: string[][] = [];
  const gitIn: Array<[string, string]> = [];
  const exec: GitExec = async (_c, args) => {
    const a = args.slice(args.indexOf("-C") + 2).filter((a) => !a.startsWith("--git-dir=") && !a.startsWith("--work-tree="));
    gitIn.push([args[args.indexOf("-C") + 1]!, a[0]!]);
    git.push(a);
    if (a[0] === "symbolic-ref") return ok(over.symbolicRef ?? "refs/heads/hardness/t1");
    if (a[0] === "rev-parse" && String(a[1]).startsWith("refs/heads/")) return ok(over.branchRef ?? head);
    if (a[0] === "rev-parse") return ok(head);
    if (a[0] === "reset") {
      head = a[3]!;
      return ok();
    }
    if (a[0] === "merge-base") return ok();
    if (a[0] === "diff" && a.includes("--name-only")) return ok((over.names ?? "src/export.ts\nsrc/other.ts\n").split("\n").filter(Boolean).join("\0"));
    if (a[0] === "diff" && a.includes("--numstat")) return ok("");
    if (a[0] === "diff") return ok(" 2 files changed, 3 insertions(+)");
    if (a[0] === "push") return over.pushFails ? { code: 1, stdout: "", stderr: "rejected" } : ok();
    return ok();
  };
  const runPack = vi.fn(async (pack: string, _context: StageContext, _extra: unknown): Promise<StageResult> => {
    if (pack === "addressing") {
      if (over.commit !== false) head = N;
      return over.addressed ?? { outcome: "pass", detail: { answer: answer() } };
    }
    return over.verifying ?? { outcome: "pass", detail: {} };
  });
  const atChecks: string[][] = [];
  const checks = vi.fn(async (_context: StageContext, _since: string): Promise<StageResult> => {
    atChecks.push(git.filter((a) => a[0] === "reset").map((a) => a[3]!));
    if (over.moveDuringChecks) head = "c".repeat(40);
    return over.checks ?? { outcome: "pass", detail: {} };
  });
  const decide = vi.fn(async () => {
    if (over.valid instanceof Error) throw over.valid;
    return tagged({ answer: { validity: { choice: over.valid ?? "refresh_text", confidence: 0.9 } }, recordId: "rec-valid" });
  });
  const github = fakeGitHub({
    prFiles: async () => [{ path: "src/export.ts" }, { path: "src/other.ts" }] as never,
    prHeadSha: async () => over.remote ?? B,
    prFacts: async () => ({ number: 3, title: "t", body: null, url: "https://x/pull/3", baseRefName: "main", headRefName: "hardness/t1", author: { login: "me" } }) as never,
    threadResolved: async () => false,
    replyToThread: async () => {},
    resolveThread: async () => {},
  });
  const saved: EvidencePack[] = [];
  const publish = vi.fn(async ({ pack: p }: { pack: EvidencePack }) => ({ pack: p, comment: "updated" as const, assets: 0 }));
  const freshCalls = { made: [] as string[][], back: [] as string[][], removed: [] as string[] };
  const fresh = over.fresh
    ? {
        make: async (path: string, branch: string, runId: string) => (freshCalls.made.push([path, branch, runId]), { path: "/wt.fix", commit: B }),
        bringBack: async (path: string, freshPath: string, branch: string, from: string) => (freshCalls.back.push([path, freshPath, branch, from]), over.fresh!.back ?? { ok: true }),
        remove: async (path: string) => void freshCalls.removed.push(path),
      }
    : undefined;
  const deps = {
    github,
    loop: { decide, runPack, checks, exec, ...(fresh ? { fresh } : {}) },
    policies: { for: async () => ({ decisions: {} }) },
    evidence: over.noSave ? { load: async () => pack() } : { load: async () => pack(), save: async (_id: string, p: EvidencePack) => void saved.push(p), publish, store: { dirFor: (id: string, sha: string) => `/ev/${id}/${sha}` } },
  };
  const context = { task: { id: "t1", repoPath: "/repo", worktreePath: "/wt", branch: "hardness/t1" }, stage: "shipping", attempt: 1, runId: "run1", approvals: [], signal: new AbortController().signal } as unknown as StageContext;
  const input = (extra: Partial<FixInput> = {}): FixInput => ({ slug: "o/a", number: 3, threads: [thread], scope: "in_place", threadSummary: "rename x in the export", label: "1", postReplies: true, pack: pack(), ...extra });
  const pushed = () => git.filter((a) => a[0] === "push");
  const resets = () => git.filter((a) => a[0] === "reset").map((a) => a[3]);
  return { gitIn, freshCalls, atChecks, deps, context, input, runPack, checks, decide, github, saved, publish, pushed, resets, git, headNow: () => head };
}

// Built at run time: a literal of this shape blocks the push.
const TOKEN = "gh" + "p_" + "b".repeat(24);

describe("a fix round on the shipped PR: what the security pass found", () => {
  it("runs the checks on the committed head, with the dirty tree reset first", async () => {
    const s = setup();
    await fixRound(s.deps, s.context, s.input());
    expect(s.atChecks).toEqual([[N]]);
  });

  it("pushes only when the branch ref is the checked commit and HEAD is that branch", async () => {
    const moved = setup({ branchRef: "d".repeat(40) });
    expect(await fixRound(moved.deps, moved.context, moved.input())).toMatchObject({ ok: false, result: { detail: { reason: expect.stringContaining("the branch ref is not the checked commit") } } });
    expect(moved.pushed()).toEqual([]);
    expect(moved.resets()).toContain(B);
    const detached = setup({ symbolicRef: "refs/heads/other" });
    expect(await fixRound(detached.deps, detached.context, detached.input())).toMatchObject({ ok: false, result: { detail: { reason: expect.stringContaining("the branch ref is not the checked commit") } } });
    expect(detached.pushed()).toEqual([]);
  });

  it("flattens what a check or the pack says before it can reach a person's channel", async () => {
    const hostile = "<!channel> @team see #12 " + TOKEN;
    const red = setup({ checks: { outcome: "fail", detail: { error: hostile } } });
    const out = await fixRound(red.deps, red.context, red.input());
    const reason = String((out as unknown as { result: { detail: { reason: string } } }).result.detail.reason);
    expect(reason).not.toMatch(/<!channel>|@team|#12|ghp_/);
    expect(reason).toContain("[redacted]");

    const gaveUp = setup({ addressed: { outcome: "pass", detail: { answer: { kind: "escalated", summary: "s", replies: [], reason: hostile } } } });
    const second = await fixRound(gaveUp.deps, gaveUp.context, gaveUp.input());
    expect(String((second as unknown as { result: { detail: { reason: string } } }).result.detail.reason)).not.toMatch(/<!channel>|@team|#12|ghp_/);
  });

  it("does not post or push an answer that carried a secret-shaped token", async () => {
    const leaky = setup({ addressed: { outcome: "pass", detail: { answer: answer([{ threadId: "T1", body: `the key is ${TOKEN}`, resolve: true }]) } } });
    expect(await fixRound(leaky.deps, leaky.context, leaky.input())).toMatchObject({ ok: false, result: { detail: { reason: "the drafted answer carried a secret-shaped token" } } });
    expect(leaky.pushed()).toEqual([]);
    expect(leaky.github.replyToThread).not.toHaveBeenCalled();
    expect(leaky.resets()).toEqual([B]);
    const summary = setup({ addressed: { outcome: "pass", detail: { answer: { ...answer(), summary: `done, key ${TOKEN}` } } } });
    expect(await fixRound(summary.deps, summary.context, summary.input())).toMatchObject({ ok: false, result: { detail: { reason: "the drafted answer carried a secret-shaped token" } } });
  });
});

describe("a fix round on the shipped PR", () => {
  it("fixes in place: addressing on the worktree, checks over the delta, a plain push, the reply and resolve, the pack re-stamped and republished", async () => {
    const s = setup();
    const out = await fixRound(s.deps, s.context, s.input());
    expect(out).toMatchObject({ ok: true, head: N, changed: true, replied: 1, resolved: 1, repliedTo: ["T1"] });
    expect(s.runPack.mock.calls[0]![0]).toBe("addressing");
    expect(s.runPack.mock.calls[0]![1].runId).toBe("run1-address-1");
    expect(s.runPack.mock.calls[0]![2]).toMatchObject({ threads: { pr: { number: 3, headRef: "hardness/t1" }, threads: [{ id: "T1", comments: [{ body: "please rename x" }] }] } });
    expect(s.checks).toHaveBeenCalledWith(expect.objectContaining({ runId: "run1-checks-1" }), B);
    expect(s.pushed()).toEqual([["push", "-u", "origin", "hardness/t1"]]);
    expect(s.github.replyToThread.mock.calls).toEqual([["T1", "Renamed."]]);
    expect(s.github.resolveThread.mock.calls).toEqual([["T1"]]);
    expect(s.decide).toHaveBeenCalledWith("evidence_valid", { kind: "fix", fix: expect.objectContaining({ changed: ["src/export.ts", "src/other.ts"], threadSummary: "rename x in the export" }) }, "/repo");
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0]).toMatchObject({ commitSha: N, fixes: [{ sha: N, scope: "in_place", summary: "rename x in the export" }] });
    expect(s.publish).toHaveBeenCalledWith(expect.objectContaining({ slug: "o/a", number: 3, localDir: `/ev/t1/${B}` }));
    expect(s.resets()).toEqual([N]);
  });

  it("resets the worktree to the head it started from and escalates with the findings when a check goes red; nothing is pushed or posted", async () => {
    const findings = [{ path: "", line: 0, severity: "test", title: "test failed", body: "boom", confidence: 1 }];
    const s = setup({ checks: { outcome: "fail", detail: { error: "`pnpm test` failed: boom", findings } } });
    const out = await fixRound(s.deps, s.context, s.input());
    expect(out).toMatchObject({ ok: false, result: { outcome: "escalated", detail: { reason: expect.stringContaining("boom"), findings } } });
    expect(s.resets()).toEqual([N, B]);
    expect(s.headNow()).toBe(B);
    expect(s.pushed()).toEqual([]);
    expect(s.github.replyToThread).not.toHaveBeenCalled();
    expect(s.saved).toEqual([]);
  });

  it("re-verifies the delta on a re_verify_partial scope, with the head before the fix as the base, and resets when the review fails", async () => {
    const good = setup();
    expect((await fixRound(good.deps, good.context, good.input({ scope: "re_verify_partial" }))).ok).toBe(true);
    const verify = good.runPack.mock.calls.find((c) => c[0] === "verifying")!;
    expect(verify[2]).toEqual({ baseCommit: B });
    expect(verify[1].runId).toBe("run1-verify-1");

    const bad = setup({ verifying: { outcome: "fail", detail: { summary: "a bug in the rename" } } });
    const out = await fixRound(bad.deps, bad.context, bad.input({ scope: "re_verify_partial" }));
    expect(out).toMatchObject({ ok: false, result: { detail: { reason: expect.stringContaining("a bug in the rename") } } });
    expect(bad.resets()).toEqual([N, B]);
    expect(bad.pushed()).toEqual([]);
  });

  it("does not push when the head moved after the checks ran, or the PR's head moved under it", async () => {
    const moved = setup({ moveDuringChecks: true });
    expect(await fixRound(moved.deps, moved.context, moved.input())).toMatchObject({ ok: false, result: { detail: { reason: expect.stringContaining("changed while the fix was being checked") } } });
    expect(moved.pushed()).toEqual([]);
    expect(moved.resets()).toEqual([N, B]);

    const someoneElse = setup({ remote: "d".repeat(40) });
    expect(await fixRound(someoneElse.deps, someoneElse.context, someoneElse.input())).toMatchObject({ ok: false, result: { detail: { escalation: "head_moved" } } });
    expect(someoneElse.runPack).not.toHaveBeenCalled();
  });

  it("escalates a refused push and an addressing run that failed or gave up, resetting each time", async () => {
    const push = setup({ pushFails: true });
    expect(await fixRound(push.deps, push.context, push.input())).toMatchObject({ ok: false, result: { detail: { reason: expect.stringContaining("git push failed") } } });
    expect(push.resets()).toEqual([N, B]);

    const failed = setup({ addressed: { outcome: "fail", detail: { error: "ran out of turns" } } });
    expect(await fixRound(failed.deps, failed.context, failed.input())).toMatchObject({ ok: false, result: { detail: { reason: expect.stringContaining("ran out of turns") } } });
    expect(failed.resets()).toEqual([B]);

    const gaveUp = setup({ addressed: { outcome: "pass", detail: { answer: { kind: "escalated", summary: "s", replies: [], escalation: "plan_wrong", reason: "the plan is wrong" } } } });
    expect(await fixRound(gaveUp.deps, gaveUp.context, gaveUp.input())).toMatchObject({ ok: false, result: { detail: { escalation: "plan_wrong", reason: "the plan is wrong" } } });
  });

  it("valid re-stamps the commit only: the text is not touched", async () => {
    const s = setup({ valid: "valid" });
    await fixRound(s.deps, s.context, s.input());
    expect(s.saved[0]).toMatchObject({ commitSha: N, summary: "Adds the export." });
    expect(s.saved[0]!.fixes).toBeUndefined();
  });

  it("refresh_text writes the pack's text again (the fix recorded, no appended sentence) and publishes it through publishAndReady", async () => {
    const s = setup({ valid: "refresh_text" });
    const out = await fixRound(s.deps, s.context, s.input());
    expect(out).toMatchObject({ ok: true });
    expect(s.saved[0]).toMatchObject({ commitSha: N, revision: 2, fixes: [{ sha: N, scope: "in_place" }] });
    expect(s.saved[0]!.summary).not.toContain("Fixed after review");
    expect(s.publish).toHaveBeenCalledTimes(1);
  });

  it("reads refresh_media as refresh_text when no scenario is affected and no rendered surface changed, and says so", async () => {
    const s = setup({ valid: "refresh_media" });
    const out = await fixRound(s.deps, s.context, s.input());
    expect(out).toMatchObject({ ok: true, textNote: expect.stringContaining("refresh_text") });
    expect(s.saved[0]).toMatchObject({ commitSha: N });
  });

  it("hands the evidence_valid record and the pack's scenario results back with a refresh_media, for the repeated run to be compared with", async () => {
    const s = setup({ valid: "refresh_media", names: "src/export.ts\nsrc/App.tsx\n" });
    s.github.prFiles.mockImplementation((async () => [{ path: "src/export.ts" }, { path: "src/App.tsx" }]) as never);
    expect(await fixRound(s.deps, s.context, s.input())).toMatchObject({ ok: false, validity: { recordId: "rec-valid", before: { s1: "pass" } } });
  });

  it("honours refresh_media when a rendered surface changed: head_moved with refresh: media", async () => {
    const s = setup({ valid: "refresh_media", names: "src/export.ts\nsrc/App.tsx\n" });
    s.github.prFiles.mockImplementation((async () => [{ path: "src/export.ts" }, { path: "src/App.tsx" }]) as never);
    expect(await fixRound(s.deps, s.context, s.input())).toMatchObject({ ok: false, result: { detail: { escalation: "head_moved", refresh: "media" } } });
    expect(s.saved).toEqual([]);
  });

  it("honours refresh_media when the reader named an affected scenario", async () => {
    const s = setup({ valid: "refresh_media" });
    expect(await fixRound(s.deps, s.context, s.input({ named: ["s1"] }))).toMatchObject({ ok: false, result: { detail: { escalation: "head_moved", refresh: "media" } } });
  });

  it("points a changed test file to its scenario through buildTests", async () => {
    const s = setup({ valid: "refresh_media", names: "src/export.ts\ntest/export.test.ts\n" });
    (s.deps as { buildTests?: unknown }).buildTests = async () => [{ scenario: "exports a cart", file: "test/export.test.ts" }];
    expect(await fixRound(s.deps, s.context, s.input())).toMatchObject({ ok: false, result: { detail: { refresh: "media" } } });
    expect((s.decide.mock.calls.at(-1) as unknown as unknown[])[1]).toMatchObject({ fix: { affected: [{ id: "s1", text: "exports a cart" }] } });
  });

  it("sends the task back to Evidence when the decision cannot tell, or the pack cannot be re-published; the push stays", async () => {
    const media = setup({ valid: "refresh_media", names: "src/App.tsx\n" });
    media.github.prFiles.mockImplementation((async () => [{ path: "src/App.tsx" }]) as never);
    expect(await fixRound(media.deps, media.context, media.input())).toMatchObject({ ok: false, result: { detail: { escalation: "head_moved" } } });
    expect(media.pushed()).toHaveLength(1);
    expect(media.resets()).toEqual([N]);
    expect(media.saved).toEqual([]);

    const unsure = setup({ valid: new Error("no model") });
    expect(await fixRound(unsure.deps, unsure.context, unsure.input())).toMatchObject({ ok: false, result: { detail: { escalation: "head_moved" } } });

    const nowhere = setup({ noSave: true });
    expect(await fixRound(nowhere.deps, nowhere.context, nowhere.input())).toMatchObject({ ok: false, result: { detail: { escalation: "head_moved" } } });
  });

  it("posts only the model's text flattened, and only to threads it was given", async () => {
    const hostile = [
      { threadId: "T1", body: "Thanks @bob, fixes #12.\n\n<script>x</script>", resolve: false },
      { threadId: "T9", body: "not a thread I was given", resolve: true },
    ];
    const s = setup({ addressed: { outcome: "pass", detail: { answer: answer(hostile) } } });
    await fixRound(s.deps, s.context, s.input());
    const [thread1, body] = s.github.replyToThread.mock.calls[0]!;
    expect(thread1).toBe("T1");
    expect(body).not.toMatch(/@bob|#12|<script>|\n/);
    expect(s.github.replyToThread).toHaveBeenCalledTimes(1);
    expect(postable("x".repeat(5000)).length).toBe(1500);
  });

  it("answers with only a reply, and no push, when the pack changed nothing; a CI fix with no change is no fix", async () => {
    const reply = setup({ commit: false });
    expect(await fixRound(reply.deps, reply.context, reply.input())).toMatchObject({ ok: true, changed: false, replied: 1 });
    expect(reply.pushed()).toEqual([]);
    expect(reply.checks).not.toHaveBeenCalled();

    const ci = setup({ commit: false });
    expect(await fixRound(ci.deps, ci.context, ci.input({ postReplies: false }))).toMatchObject({ ok: false, result: { detail: { reason: expect.stringContaining("no change") } } });
  });
});

describe("a fix round on a fresh clone at the PR's head", () => {
  it("runs the addressing pack, the checks and every git read on the fresh clone, and the push from the card's clone after the commits came back", async () => {
    const s = setup({ fresh: {} });
    const out = await fixRound(s.deps, s.context, s.input());
    expect(out).toMatchObject({ ok: true, changed: true });
    expect(s.freshCalls.made).toEqual([["/wt", "hardness/t1", "run1-fix-1"]]);
    const paths = (pack: string) => (s.runPack.mock.calls.find((c) => c[0] === pack)![1] as StageContext).task.worktreePath;
    expect(paths("addressing")).toBe("/wt.fix");
    expect((s.checks.mock.calls[0]![0] as StageContext).task.worktreePath).toBe("/wt.fix");
    expect(s.gitIn.filter(([, verb]) => verb === "reset").every(([path]) => path === "/wt.fix")).toBe(true);
    expect(s.freshCalls.back).toEqual([["/wt", "/wt.fix", "hardness/t1", B]]);
    expect(s.gitIn.filter(([, verb]) => verb === "push").map(([path]) => path)).toEqual(["/wt"]);
    expect(s.freshCalls.removed).toEqual(["/wt.fix"]);
  });

  it("pushes nothing when the commits cannot come back as a fast-forward", async () => {
    const s = setup({ fresh: { back: { ok: false, reason: "not a fast-forward" } } });
    const out = await fixRound(s.deps, s.context, s.input());
    expect(out).toMatchObject({ ok: false, result: { outcome: "escalated", detail: { reason: expect.stringContaining("not a fast-forward") } } });
    expect(s.pushed()).toEqual([]);
  });

  it("stops with head_moved, before cloning, when the PR's head moved on the remote", async () => {
    const s = setup({ fresh: {}, remote: "e".repeat(40) });
    expect(await fixRound(s.deps, s.context, s.input())).toMatchObject({ ok: false, result: { detail: { escalation: "head_moved" } } });
    expect(s.freshCalls.made).toEqual([]);
  });
});

describe("a re-stamp after a fix goes through the one publisher", () => {
  const section = (text: string) => `${SECTION_START}\n${text}\n${SECTION_END}`;
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");

  it("checks and repairs the pack first: a media file gone from disk is dropped, the repair noted, before anything is published", async () => {
    const s = setup({ valid: "valid" });
    const gone = { ...pack(), media: [{ kind: "screenshot", label: "cart", url: "/nowhere/cart.png" }] } as unknown as EvidencePack;
    const out = await fixRound(s.deps, s.context, s.input({ pack: gone }));
    expect(out).toMatchObject({ ok: true });
    expect(s.publish).toHaveBeenCalledWith(expect.objectContaining({ pack: expect.objectContaining({ media: [], note: expect.stringContaining("repaired") }) }));
  });

  it("publishes with no preview approval, records a person's edit of the section and says so through evidence.edited", async () => {
    const s = setup({ valid: "valid" });
    const stateDir = await mkdtemp(join(tmpdir(), "fix-restamp-"));
    await saveCursor(stateDir, "t1", { ...emptyCursor({ slug: "o/a", number: 3 }), publishedSection: hash(section("what the machine wrote")) });
    s.github.prFacts.mockImplementation((async () => ({ number: 3, title: "t", body: section("what a person wrote"), url: "https://x/pull/3", baseRefName: "main", headRefName: "hardness/t1", author: { login: "me" } })) as never);
    const emitted: Array<[string, unknown]> = [];
    const context = { ...s.context, emit: async (kind: string, payload: unknown) => void emitted.push([kind, payload]) } as unknown as StageContext;
    (s.deps as { stateDir?: string }).stateDir = stateDir;
    const out = await fixRound(s.deps, context, s.input());
    expect(out).toMatchObject({ ok: true });
    expect(s.publish).toHaveBeenCalledWith(expect.objectContaining({ approved: false }));
    expect(emitted).toEqual([["evidence.edited", expect.objectContaining({ sha: N.slice(0, 7) })]]);
    expect(await readdir(join(stateDir, "ground-truth", "evidence"))).toHaveLength(1);
  });
});

describe("the fix guard against a real repository, through the pinned host git", () => {
  const sh = (args: string[], env: Record<string, string> = {}) => execFileSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env } });
  const body = Array.from({ length: 40 }, (_, i) => `line ${i} of a file that stays mostly the same`).join("\n") + "\n";

  /** A workspace with the machine's repository for it; `files` are committed as the PR's head, `change` then makes the fix and commits it. */
  async function world(files: Record<string, string | Buffer>, change: (dir: string) => void) {
    configureMachineRepos(await mkdtemp(join(tmpdir(), "guard-m-")));
    const work = await mkdtemp(join(tmpdir(), "guard-w-"));
    sh(["init", "--bare", "-q", machineGitDir(work)]);
    const g = (...args: string[]) => sh([...at(work), ...args]);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    g("add", "-A");
    g("-c", "commit.gpgsign=false", "commit", "-q", "-m", "head");
    const before = g("rev-parse", "HEAD").trim();
    change(work);
    g("add", "-A");
    g("-c", "commit.gpgsign=false", "commit", "-q", "-m", "fix");
    return { work, before, after: g("rev-parse", "HEAD").trim() };
  }
  const guard = (w: { work: string; before: string; after: string }, prFiles: string[]) => guardFix(realExec, w.work, w.before, w.after, { scope: "in_place", prFiles });
  const g = (work: string, ...args: string[]) => sh([...at(work), ...args]);

  it("refuses a workflow file moved to a test file name with most of its content kept", async () => {
    const w = await world({ ".github/workflows/ci.yml": body, "src/a.ts": "x\n" }, (dir) => {
      g(dir, "mv", ".github/workflows/ci.yml", "src/ci.test.ts");
      writeFileSync(join(dir, "src/ci.test.ts"), body + "// moved\n");
    });
    expect(await guard(w, ["src/a.ts"])).toMatchObject({ ok: false, paths: expect.arrayContaining([".github/workflows/ci.yml"]) });
  });

  it("refuses a CODEOWNERS deletion made as a rename", async () => {
    const w = await world({ ".github/CODEOWNERS": "* @owner\n".repeat(20), "src/a.ts": "x\n" }, (dir) => {
      g(dir, "mv", ".github/CODEOWNERS", "src/notes.test.ts");
    });
    expect(await guard(w, ["src/a.ts"])).toMatchObject({ ok: false, paths: expect.arrayContaining([".github/CODEOWNERS"]) });
  });

  it("counts a binary file as over the size cap", async () => {
    const w = await world({ "src/a.test.ts": Buffer.from([0, 1, 2, 3, 0, 255]) }, (dir) => {
      writeFileSync(join(dir, "src/a.test.ts"), Buffer.from([0, 9, 8, 7, 0, 254, 0, 0]));
    });
    expect(await guard(w, ["src/a.test.ts"])).toMatchObject({ ok: false, reason: expect.stringMatching(/binary/) });
  });

  it("reads a path with a non-ASCII name as it is, so a PR's own file passes", async () => {
    const w = await world({ "src/café.ts": "a\n" }, (dir) => writeFileSync(join(dir, "src/café.ts"), "b\n"));
    expect(await guard(w, ["src/café.ts"])).toEqual({ ok: true });
    expect(await guard(w, ["src/other.ts"])).toMatchObject({ ok: false, paths: ["src/café.ts"] });
  });

  it("fails closed when the diff cannot be read", async () => {
    const w = await world({ "src/a.ts": "a\n" }, (dir) => writeFileSync(join(dir, "src/a.ts"), "b\n"));
    expect(await guardFix(realExec, w.work, "f".repeat(40), w.after, { scope: "in_place", prFiles: ["src/a.ts"] })).toMatchObject({ ok: false });
  });
});
