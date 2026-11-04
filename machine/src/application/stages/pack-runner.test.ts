import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageInput, type StageOutput } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CredentialWaitError, type Credentials, NoCredentialError, fixedCredentials } from "../../adapters/credentials/index.ts";
import type { TaskRow } from "../../domain/task.ts";
import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import { type AgentDeps, agentRunners, runAgent } from "./pack-runner.ts";
import type { StageContext } from "../ports.ts";
import type { Graph, GraphStamp } from "../graph.ts";
import { engineBudgetGate, gatedCredentials, runtimeKillSwitch } from "../engine-gates.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
  }).trim();

const output = (over: Partial<StageOutput> = {}): StageOutput => ({
  schema: 1,
  ok: true,
  outcome: "pass",
  summary: "did it",
  needsInput: null,
  requested: [],
  findings: [],
  artifacts: [],
  slices: { done: 0, total: 0 },
  commit: null,
  usage: { turns: 7, costUsd: 0.5, durationMs: 100, model: "m" },
  error: null,
  rateLimited: false,
  resetsAt: null,
  ...over,
});

let root: string;
let repo: string;
let stateDir: string;
let seen: SandboxRun | undefined;

/** A sandbox that does what the pack would: leaves files in /out and maybe in the worktree. */
function fakeSandbox(
  result: StageOutput | (() => StageOutput),
  act: (run: SandboxRun) => void = () => {},
  exitCode = 0,
): (run: SandboxRun) => Promise<SandboxResult> {
  return async (run) => {
    seen = run;
    const out = join(run.runDir, "out");
    mkdirSync(out, { recursive: true });
    act(run);
    writeFileSync(join(out, "result.json"), JSON.stringify(typeof result === "function" ? result() : result));
    writeFileSync(
      join(out, "events.jsonl"),
      `${JSON.stringify({ at: "2026-01-01T00:00:00Z", kind: "slice_committed", payload: { id: 1 } })}\n`,
    );
    return { exitCode, timedOut: false, aborted: false, transcriptPath: join(run.runDir, "t.log") };
  };
}

function deps(sandbox: (run: SandboxRun) => Promise<SandboxResult>): AgentDeps {
  return {
    image: "img",
    qaImage: "qa-img",
    videoImage: "video-img",
    credentials: fixedCredentials({ ANTHROPIC_API_KEY: "x" }),
    worktreesDir: join(root, "worktrees"),
    stateDir,
    watcher: { follow: vi.fn() } as never,
    sandbox,
  };
}

/** The mounts a run has besides the worktree's own `.git` file. */
const extraMounts = (run: SandboxRun) => (run.mounts ?? []).filter((m) => m.container !== "/work/.git");

const runners = (sandbox: (run: SandboxRun) => Promise<SandboxResult>) => agentRunners(deps(sandbox));

const context = (stage: StageContext["stage"]): StageContext => ({
  task: {
    id: "11111111-2222-3333-4444-555555555555",
    title: "Fix it",
    description: "",
    criteria: ["works"],
    repoPath: repo,
    source: null,
    branch: null,
    worktreePath: null,
  } as unknown as TaskRow,
  stage,
  attempt: 1,
  runId: "run-1",
  approvals: [],
  signal: new AbortController().signal,
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agents-")));
  repo = join(root, "repo");
  stateDir = join(root, "state");
  seen = undefined;
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
});

describe("agent stages through packs", () => {
  it("registers a runner for every pack dispatched unmodified; the rest are wrapped in bootstrap", () => {
    const r = runners(fakeSandbox(output()));
    expect(Object.keys(r).sort()).toEqual(["implementing", "triage"]);
  });

  it("sends a StageInput to a read-only sandbox and returns outcome, events, artifacts and usage", async () => {
    const run = runners(
      fakeSandbox(
        output({ artifacts: [{ kind: "report", path: "files/r.md", label: "r.md", sha256: "" }] }),
        (r) => {
          mkdirSync(join(r.runDir, "out", "files"), { recursive: true });
          writeFileSync(join(r.runDir, "out", "files", "r.md"), "hello");
        },
      ),
    );
    const result = await run.triage!(context("triage"));
    expect(StageInput.safeParse(seen?.input).success).toBe(true);
    expect(seen?.writable).toBe(false);
    expect(seen?.timeoutMs).toBe(600_000);
    expect(result.outcome).toBe("pass");
    expect(result.usage).toEqual({ turns: 7, costUsd: 0.5 });
    expect(result.events?.map((e) => e.kind)).toEqual(["slice_committed"]);
    expect(result.artifacts).toHaveLength(1);
    expect(existsSync(result.artifacts![0]!.path)).toBe(true);
    expect(result.detail).toMatchObject({ brief: "did it" });
  });

  it("hands the sandbox the run's trace context as extra env, and nothing when there is none", async () => {
    const d = deps(fakeSandbox(output()));
    await runAgent(d, { ...context("triage"), traceEnv: { LMNR_SPAN_CONTEXT: "ctx" } }, "triage");
    expect(seen?.extraEnv).toEqual({ LMNR_SPAN_CONTEXT: "ctx" });
    await runAgent(d, context("triage"), "triage");
    expect(seen?.extraEnv).toEqual({});
  });

  it("runs e2e in the QA image and every other pack in the base image", async () => {
    const d = deps(fakeSandbox(output()));
    await runAgent(d, context("e2e"), "e2e");
    expect(seen?.image).toBe("qa-img");
    await runAgent(d, context("evidence"), "evidence");
    expect(seen?.image).toBe("img");
    await runAgent(d, context("triage"), "triage");
    expect(seen?.image).toBe("img");
  });

  it("runs recording in the video image (the QA image when there is none) and the other video packs in the base image", async () => {
    const d = deps(fakeSandbox(output()));
    await runAgent(d, context("evidence"), "recording");
    expect(seen?.image).toBe("video-img");
    await runAgent({ ...d, videoImage: undefined }, context("evidence"), "recording");
    expect(seen?.image).toBe("qa-img");
    for (const pack of ["video_script", "video_fix", "video_qa"] as const) {
      await runAgent(d, context("evidence"), pack);
      expect(seen?.image, pack).toBe("img");
    }
  });

  it("hands the recorder only the target the film is recorded against, never the whole luna.yaml list", async () => {
    const d = deps(fakeSandbox(output({})));
    const target = { name: "staging", baseUrl: "https://staging.example", credential: null };
    const video = { scenarios: [], record: null, pack: { summary: "s", howToVerify: "h", risk: null }, steps: [], chapters: [], target, narration: null, timeline: null, report: null, transcript: null, sheets: [], fixCards: [] };
    await runAgent(d, context("evidence"), "recording", { video });
    expect((seen?.input as { context: { qaTargets?: unknown } }).context.qaTargets).toEqual([target]);
    await runAgent(d, context("evidence"), "recording", { video: { ...video, target: null } });
    expect((seen?.input as { context: { qaTargets?: unknown } }).context.qaTargets).toEqual([]);
  });

  it("hands a video pack its VideoContext and mounts what the caller asks for, after the worktree's own mounts", async () => {
    const d = deps(fakeSandbox(output()));
    const video = { scenarios: [], record: null, pack: { summary: "s", howToVerify: "h", risk: null }, steps: [], chapters: [], target: null, narration: null, timeline: null, report: null, transcript: null, sheets: ["/evidence/sheets/beats_sheet.jpg"], fixCards: [] };
    const mounts = [{ host: join(root, "state", "runs", "run-1-video", "files", "video"), container: "/evidence", readOnly: true }];
    await runAgent(d, context("evidence"), "video_qa", { video, mounts });
    expect((seen?.input as { context: { video?: unknown } }).context.video).toEqual(video);
    expect(extraMounts(seen!)).toContainEqual(mounts[0]);
    await runAgent(d, context("evidence"), "triage", { video, mounts });
    expect((seen?.input as { context: { video?: unknown } }).context.video).toBeUndefined();
  });

  it.each([
    ["an escalated outcome (schema 2)", { schema: 2 as const, outcome: "escalated" as const }],
    ["a pass whose answer escalated (schema 1, runners before the escalated outcome)", { outcome: "pass" as const }],
  ])("reports %s as escalated, with the agent's reason and options", async (_, over) => {
    const answer = { kind: "escalated", summary: "stopped", reason: "needs a new dependency", options: ["add it", "drop it"] };
    const run = runners(fakeSandbox(output({ ...over, summary: "stopped", answer })));
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ reason: "needs a new dependency", options: ["add it", "drop it"], escalation: "other" });
  });

  it("carries the agent's typed escalation reason, and reads one off the enum as other", async () => {
    const answer = { kind: "escalated", summary: "stopped", reason: "the plan names a module that does not exist", options: [], escalation: "plan_wrong" };
    const wrong = await runners(fakeSandbox(output({ schema: 2 as const, outcome: "escalated" as const, summary: "stopped", answer }))).implementing!(context("implementing"));
    expect(wrong.detail).toMatchObject({ escalation: "plan_wrong" });
    const off = await runners(fakeSandbox(output({ schema: 2 as const, outcome: "escalated" as const, summary: "stopped", answer: { ...answer, escalation: "gremlins" } }))).implementing!(context("implementing"));
    expect(off.detail).toMatchObject({ escalation: "other" });
  });

  it("refuses to write on a branch the pipeline does not own, whatever the task row says", async () => {
    const sandbox = vi.fn(fakeSandbox(output()));
    const tampered = { ...context("implementing"), task: { ...context("implementing").task, branch: "main", worktreePath: repo } };
    const result = await runners(sandbox).implementing!(tampered);
    expect(result).toMatchObject({ outcome: "fail", detail: { error: "refusing to run implementing on branch main: the pipeline only writes task/* branches (or the branch it named for a Jira-linked task)" } });
    expect(sandbox).not.toHaveBeenCalled();
    // A read-only pack on the same branch is fine: it changes nothing.
    await runners(fakeSandbox(output())).triage!({ ...tampered, stage: "triage" });
  });

  it("keeps a linked task on the branch it already works on, even after Jira renamed the issue type", async () => {
    // The first run named bug/PLAT-123; the issue is a Story now, so the pattern would say story/PLAT-123.
    const linked = {
      ...context("implementing"),
      task: {
        ...context("implementing").task,
        branch: "bug/PLAT-123",
        worktreePath: join(root, "worktrees", "repo", "bug-PLAT-123"),
        jira: { key: "PLAT-123", url: "u", issueType: "Story", status: null, priority: null, dueAt: null, syncedAt: null, blocked: null },
      },
    };
    const result = await runners(fakeSandbox(output())).implementing!(linked);
    expect(result.outcome).toBe("pass");
    expect(result.workspace).toEqual({ branch: "bug/PLAT-123", worktreePath: linked.task.worktreePath });
    expect(seen!.worktree).toBe(linked.task.worktreePath);
    expect(git(seen!.worktree, "branch", "--show-current")).toBe("bug/PLAT-123");
    // A persisted branch that is none of the pipeline's is still refused.
    const main = { ...linked, task: { ...linked.task, branch: "main", worktreePath: repo } };
    expect(await runners(fakeSandbox(output())).implementing!(main)).toMatchObject({ outcome: "fail", detail: { error: expect.stringContaining("refusing to run implementing on branch main") } });
  });

  describe("the code graph", () => {
    const stamp: GraphStamp = { schema: 1, commit: "c".repeat(40), builtAt: "2026-11-04T10:00:00Z", nodes: 3, edges: 2, communities: 1, graphify: "0.9.34" };
    const graphOf = (has: boolean, fresh = true): Graph => ({
      stampOf: async () => (has ? stamp : null),
      currentDir: () => (has ? "/state/graphs/repo/current" : null),
      build: async () => stamp,
      isFresh: async () => fresh,
      recordMisses: async () => {},
    });
    const withGraph = (graph: Graph, ensure?: (repo: string) => void) => agentRunners({ ...deps(fakeSandbox(output())), graph, ensureGraph: ensure });

    it("mounts the repo's current graph read-only at /graph, points LUNA_GRAPH at it and says how fresh it is", async () => {
      await withGraph(graphOf(true)).triage!(context("triage"));
      expect(extraMounts(seen!)).toEqual([{ host: "/state/graphs/repo/current", container: "/graph", readOnly: true }]);
      expect(seen!.extraEnv).toMatchObject({ LUNA_GRAPH: "/graph/graphify-out/graph.json" });
      expect((seen!.input as unknown as StageInput).context.graph).toEqual({ path: "/graph/graphify-out/graph.json", commit: stamp.commit, builtAt: stamp.builtAt, fresh: true });
    });

    it("marks a graph older than the base commit stale", async () => {
      await withGraph(graphOf(true, false)).triage!(context("triage"));
      expect((seen!.input as unknown as StageInput).context.graph).toMatchObject({ fresh: false });
    });

    it("mounts nothing and says so when the repo has no graph, and asks for a first build", async () => {
      const ensured: string[] = [];
      await withGraph(graphOf(false), (repo) => ensured.push(repo)).triage!(context("triage"));
      expect(extraMounts(seen!)).toEqual([]);
      expect(seen!.extraEnv?.LUNA_GRAPH).toBeUndefined();
      expect((seen!.input as unknown as StageInput).context.graph).toBeNull();
      expect(ensured).toEqual([repo]);
    });

    it("leaves the graph out when the repo's luna.yaml turns it off", async () => {
      writeFileSync(join(repo, "luna.yaml"), "policy:\n  graph: off\n");
      await withGraph(graphOf(true)).triage!(context("triage"));
      expect(extraMounts(seen!)).toEqual([]);
      expect((seen!.input as unknown as StageInput).context.graph).toBeNull();
    });
  });

  it("mounts the linked worktree's .git file read-only over /work/.git in every stage, and keeps the admin dir's pointers read-only in a writable one", async () => {
    await runners(fakeSandbox(output())).triage!(context("triage"));
    expect(seen!.mounts).toContainEqual({ host: join(seen!.worktree, ".git"), container: "/work/.git", readOnly: true });
    await runners(fakeSandbox(output())).implementing!(context("implementing"));
    expect(seen!.writable).toBe(true);
    expect(seen!.mounts).toContainEqual({ host: join(seen!.worktree, ".git"), container: "/work/.git", readOnly: true });
    const name = seen!.worktree.split("/").pop()!;
    expect(existsSync(join(seen!.gitDir!, "worktrees", name, "commondir"))).toBe(true);
    expect(seen!.gitReadOnly).toEqual(expect.arrayContaining(["hooks", "config", `worktrees/${name}/commondir`, `worktrees/${name}/gitdir`]));
  });

  it("gives the sandbox the repo's cache volume, so a retry or the next task of the repo installs warm", async () => {
    await runners(fakeSandbox(output())).triage!(context("triage"));
    expect(seen!.cacheVolume).toBe("hardness-cache-repo");
  });

  it("keeps triage's outcome, record and reply on the stage detail, and defaults the outcome to plan", async () => {
    const record = { kind: "question", goal: "answer how to run the board", size: "tiny", urgency: "normal", risk: "none", reason: "asks how, changes nothing" };
    const conversation = { kind: "brief", summary: "s", outcome: "conversation", record, reply: "Use `pnpm dev`." };
    const talked = await runners(fakeSandbox(output({ answer: conversation }))).triage!(context("triage"));
    expect(talked.detail).toMatchObject({ outcome: "conversation", record, reply: "Use `pnpm dev`.", brief: "s" });
    const archived = await runners(fakeSandbox(output({ answer: { kind: "brief", summary: "s", outcome: "archive", archiveReason: "duplicate" } }))).triage!(context("triage"));
    expect(archived.detail).toMatchObject({ outcome: "archive", archiveReason: "duplicate" });
    const bare = await runners(fakeSandbox(output({ answer: { kind: "brief", summary: "s", criteria: ["c"] } }))).triage!(context("triage"));
    expect(bare.detail).toMatchObject({ outcome: "plan", criteria: ["c"] });
    expect(bare.detail).not.toHaveProperty("assumptions");
    expect(bare.detail).not.toHaveProperty("confidence");
  });

  it("runs the plan pack in the test_design state: its own pack and limits in the input, its own container, the plan under review in context", async () => {
    const plan = { record: null, brief: "b", criteria: ["c"], assumptions: [], slices: [], round: 2, gaps: ["c"] };
    const answer = { kind: "done", summary: "s", brief: "the brief", criteria: ["c1"], assumptions: ["a1"], slices: [{ title: "s1", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }], rollback: "revert" };
    const result = await runAgent(deps(fakeSandbox(output({ answer }))), { ...context("test_design"), runId: "r1-plan" }, "plan", { plan });
    const input = seen!.input as unknown as StageInput;
    expect(input).toMatchObject({ stage: "test_design", pack: "plan", context: { plan }, plan: { brief: "b" } });
    expect(input.limits.maxTurns).toBe(30);
    expect(seen!.name).toMatch(/-plan-1$/);
    expect(seen!.runDir).toMatch(/runs\/r1-plan$/);
    expect(result.detail).toMatchObject({ brief: "the brief", criteria: ["c1"], assumptions: ["a1"], rollback: "revert", slices: [{ title: "s1" }] });
    expect(result.detail).not.toHaveProperty("outcome");
  });

  it("keeps the test cases test_design answered, for the test check", async () => {
    const cases = [{ title: "rejects a bad password", criterion: "works", approach: "run a.test.ts, confirm it rejects" }];
    const result = await runAgent(deps(fakeSandbox(output({ answer: { kind: "done", summary: "s", cases } }))), context("test_design"), "test_design");
    expect(result.detail).toMatchObject({ summary: "did it", cases });
    expect(result.detail).not.toHaveProperty("tests");
  });

  it("keeps test_design's cases away from implementing when the repo's PIPELINE.md holds them out", async () => {
    writeFileSync(join(repo, "PIPELINE.md"), "---\nholdout_cases: true\n---\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "policy");
    const cases = [{ title: "t", criterion: null, approach: "run a.test.ts" }];
    const approvals = [
      { kind: "awaiting_test_check", requested: { cases }, decision: "approved", reason: null, response: null },
    ] as never;
    const run = runners(fakeSandbox(output()));
    await run.implementing!({ ...context("implementing"), approvals });
    expect((seen!.input as unknown as StageInput).context.testCases).toEqual([]);
  });

  it("hands implementing the repo's checks from its luna.yaml", async () => {
    writeFileSync(join(repo, "luna.yaml"), "checks:\n  - name: board tests\n    run: cargo test\n    cwd: board\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "config");
    const run = runners(fakeSandbox(output()));
    await run.implementing!(context("implementing"));
    expect((seen!.input as unknown as StageInput).context.checks).toEqual([{ name: "board tests", run: "cargo test", cwd: "board" }]);
  });

  it("runs the repo's services from its luna.yaml beside the stage container", async () => {
    writeFileSync(join(repo, "luna.yaml"), "services:\n  postgres:\n    image: postgres:16\n    exports: { DATABASE_URL: x }\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "config");
    await runners(fakeSandbox(output())).implementing!(context("implementing"));
    expect(seen!.services).toEqual({ postgres: { image: "postgres:16", exports: { DATABASE_URL: "x" } } });
  });

  it("tells the pack where the branch forked, and hands ci_watch what the host fetched", async () => {
    const ci = { pr: null, checks: [{ name: "lint", state: "FAILURE", url: null }], logs: "boom" };
    await runAgent(deps(fakeSandbox(output())), context("ci_watch"), "ci_watch", { ci });
    const input = seen!.input as unknown as StageInput;
    expect(input.context.ci).toEqual(ci);
    expect(input.context.baseCommit).toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("lets the caller name the base commit a pack reads its diff against (a fix round's verifying: only the delta)", async () => {
    const before = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "later.txt"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "later");
    await runAgent(deps(fakeSandbox(output())), context("verifying"), "verifying", { baseCommit: before });
    expect((seen!.input as unknown as StageInput).context.baseCommit).toBe(before);
  });

  it("hands pr_reply the ship context the host built, and nothing for another pack", async () => {
    const ship = { kind: "comment" as const, comment: { thread: { id: "T1", path: null, line: null, comments: [] }, pack: { summary: "s", scenarios: [], howToVerify: "h" }, myReplies: 0 } };
    await runAgent(deps(fakeSandbox(output())), context("shipping"), "pr_reply", { ship });
    expect((seen!.input as unknown as StageInput).context.ship).toEqual(ship);
    await runAgent(deps(fakeSandbox(output())), context("ci_watch"), "ci_watch", { ship });
    expect((seen!.input as unknown as StageInput).context.ship).toBeUndefined();
  });

  it("keeps a finished answer that was also flagged rate-limited; only a run with no answer pauses", async () => {
    // The SDK's usage warning used to arrive with a complete brief; the answer is paid for.
    const finished = await runners(fakeSandbox(output({ rateLimited: true, resetsAt: "1793080800", answer: { kind: "brief", summary: "s" } }))).triage!(context("triage"));
    expect(finished.outcome).toBe("pass");
    expect(finished.rateLimited).toBeUndefined();
    expect(finished.detail).toMatchObject({ brief: "s", usageWindow: { resetsAt: "1793080800" } });

    const cut = await runners(fakeSandbox(output({ ok: false, outcome: "fail", rateLimited: true, resetsAt: "1793080800", error: "usage limit" }))).triage!(context("triage"));
    expect(cut).toMatchObject({ outcome: "fail", rateLimited: true });
  });

  it("maps needs_input to summary and questions", async () => {
    const questions = [{ question: "which db?", recommended: "pg" }];
    const run = runners(fakeSandbox(output({ outcome: "needs_input", needsInput: questions })));
    const result = await run.triage!(context("triage"));
    expect(result.outcome).toBe("needs_input");
    expect(result.detail).toEqual({ summary: "did it", questions });
  });

  it("records the commit the implementer made and does not commit itself", async () => {
    let made = "";
    const run = runners(
      fakeSandbox(
        () => output({ commit: made }),
        (r) => {
          writeFileSync(join(r.worktree, "b.txt"), "b\n");
          git(r.worktree, "add", "-A");
          git(r.worktree, "commit", "-q", "-m", "slice 1");
          made = git(r.worktree, "rev-parse", "HEAD");
        },
      ),
    );
    const result = await run.implementing!(context("implementing"));
    expect(seen?.writable).toBe(true);
    expect(result.outcome).toBe("pass");
    expect(result.run?.outputCommit).toBe(made);
    expect(git(seen!.worktree, "log", "--format=%s")).toBe("slice 1\ninit");
  });

  it("hands the latest verifying findings to implementing, keeping only confident ones", async () => {
    const f = (confidence: number, title: string) => ({
      path: "a.ts", line: 1, start_line: null, severity: "bug", title, body: "", suggestion_code: null, confidence,
    });
    const run = runners(fakeSandbox(output(), (r) => {
      writeFileSync(join(r.worktree, "b.txt"), "b\n");
      git(r.worktree, "add", "-A");
      git(r.worktree, "commit", "-q", "-m", "slice");
    }));
    await run.implementing!({ ...context("implementing"), priorFindings: [f(0.9, "keep"), f(0.5, "drop")] });
    expect((seen?.input as { priorFindings: Array<{ title: string }> }).priorFindings.map((x) => x.title)).toEqual(["keep"]);
  });

  describe("locked test files", () => {
    const seedTests = () => {
      mkdirSync(join(repo, "test"), { recursive: true });
      writeFileSync(join(repo, "test", "cart.test.js"), "old\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "tests");
    };
    const commitIn = (cwd: string, msg = "slice") => {
      git(cwd, "add", "-A");
      git(cwd, "commit", "-q", "-m", msg);
      return git(cwd, "rev-parse", "HEAD");
    };
    const expectLocked = async (act: (cwd: string) => void) => {
      seedTests();
      const before = git(repo, "rev-parse", "HEAD");
      const run = runners(fakeSandbox(output(), (r) => { act(r.worktree); commitIn(r.worktree); }));
      const result = await run.implementing!(context("implementing"));
      expect(result.outcome).toBe("fail");
      expect(git(seen!.worktree, "rev-parse", "HEAD")).toBe(before);
      expect(result.detail).toMatchObject({ lockedFiles: ["test/cart.test.js"] });
      expect(String((result.detail as { error: string }).error)).toContain("test/cart.test.js");
      expect(result.findings).toHaveLength(1);
      expect(result.findings![0]).toMatchObject({ path: "test/cart.test.js", line: 0, severity: "test", confidence: 1 });
    };

    it("fails and undoes a commit that modified an existing test", () =>
      expectLocked((cwd) => writeFileSync(join(cwd, "test", "cart.test.js"), "new\n")));
    it("fails and undoes a commit that deleted an existing test", () =>
      expectLocked((cwd) => git(cwd, "rm", "-q", "test/cart.test.js")));
    it("fails and undoes a commit that renamed an existing test", () =>
      expectLocked((cwd) => git(cwd, "mv", "test/cart.test.js", "src-moved.js")));

    // A test file that existed is allowed to change as long as the tests that were there
    // still pass against the new code: the machine puts the original file back, runs the
    // project's test command, then restores the agent's version.
    const withTestCommand = (argv: string[], sandbox: (run: SandboxRun) => Promise<SandboxResult>) =>
      agentRunners({ ...deps(sandbox), detect: async () => ({ manager: "npm" as const, test: argv }) });

    it("accepts a change to an existing test file when the tests that were there still pass", async () => {
      seedTests();
      let replayedWith: string | undefined;
      const run = withTestCommand(["sh", "-c", "cat test/cart.test.js > ../replayed.txt"], fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "cart.test.js"), "old\nplus a new case\n");
        writeFileSync(join(r.worktree, "a.txt"), "changed\n");
        commitIn(r.worktree);
      }));
      const result = await run.implementing!(context("implementing"));
      replayedWith = readFileSync(join(seen!.worktree, "..", "replayed.txt"), "utf8");
      expect(result.outcome).toBe("pass");
      // The original file was what ran, and the agent's version is back afterwards.
      expect(replayedWith).toBe("old\n");
      expect(readFileSync(join(seen!.worktree, "test", "cart.test.js"), "utf8")).toBe("old\nplus a new case\n");
      expect(git(seen!.worktree, "status", "--porcelain")).toBe("");
      expect(result.detail).toMatchObject({ lockedFiles: ["test/cart.test.js"], lockedTestsReplayed: true });
    });

    it("still fails and undoes the commit when the tests that were there no longer pass", async () => {
      seedTests();
      const before = git(repo, "rev-parse", "HEAD");
      const run = withTestCommand(["sh", "-c", "exit 1"], fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "cart.test.js"), "rewritten\n");
        commitIn(r.worktree);
      }));
      const result = await run.implementing!(context("implementing"));
      expect(result.outcome).toBe("fail");
      expect(git(seen!.worktree, "rev-parse", "HEAD")).toBe(before);
      expect(String((result.detail as { error: string }).error)).toMatch(/no longer pass/);
      expect(result.findings![0]).toMatchObject({ path: "test/cart.test.js" });
    });

    it("says what the replay saw, and tells a test command that could not run from tests that failed", async () => {
      seedTests();
      const run = withTestCommand(["sh", "-c", "echo 'sh: vitest: not found' >&2; exit 127"], fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "cart.test.js"), "old\nplus a case\n");
        commitIn(r.worktree);
      }));
      const result = await run.implementing!(context("implementing"));
      expect(result.outcome).toBe("fail");
      const error = String((result.detail as { error: string }).error);
      expect(error).toMatch(/test command could not run/);
      expect(error).toContain("sh: vitest: not found");
      expect(result.findings![0]!.body).toContain("sh: vitest: not found");
    });

    it("never accepts a deleted or renamed test file, even with a green test command", async () => {
      seedTests();
      const before = git(repo, "rev-parse", "HEAD");
      const run = withTestCommand(["sh", "-c", "exit 0"], fakeSandbox(output(), (r) => {
        git(r.worktree, "rm", "-q", "test/cart.test.js");
        commitIn(r.worktree);
      }));
      const result = await run.implementing!(context("implementing"));
      expect(result.outcome).toBe("fail");
      expect(git(seen!.worktree, "rev-parse", "HEAD")).toBe(before);
    });

    it("passes a commit that adds a new test and changes source", async () => {
      seedTests();
      const run = runners(fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "new.test.js"), "n\n");
        writeFileSync(join(r.worktree, "a.txt"), "changed\n");
        commitIn(r.worktree);
      }));
      const result = await run.implementing!(context("implementing"));
      expect(result.outcome).toBe("pass");
    });

    it("does not apply to a read-only pack", async () => {
      seedTests();
      const sandbox = fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "cart.test.js"), "new\n");
        commitIn(r.worktree);
      });
      const result = await runAgent(deps(sandbox), context("test_design"), "test_design");
      expect(result.outcome).toBe("pass");
    });

    it("applies to verifying too: touching a locked test fails", async () => {
      seedTests();
      const d = deps(fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "cart.test.js"), "changed\n");
        commitIn(r.worktree);
      }));
      const result = await runAgent(d, context("verifying"), "verifying");
      expect(result.outcome).toBe("fail");
      expect(result.detail?.lockedFiles).toEqual(["test/cart.test.js"]);
    });

    it("verifying can add a new test and commit cleanly", async () => {
      seedTests();
      const d = deps(fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "new.test.js"), "n\n");
        commitIn(r.worktree);
      }));
      const result = await runAgent(d, context("verifying"), "verifying");
      expect(result.outcome).toBe("pass");
    });
  });

  it("fails a run the sandbox stopped as stuck, with the detector's reason", async () => {
    const run = runners(async (r) => {
      seen = r;
      mkdirSync(join(r.runDir, "out"), { recursive: true });
      return { exitCode: 137, timedOut: false, aborted: false, stuck: "the same call 4 times in a row: Bash npm test", transcriptPath: "t" };
    });
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "stuck: the same call 4 times in a row: Bash npm test" });
  });

  it("hands the sandbox a line watcher that reads the transcript as it streams", async () => {
    const run = runners(fakeSandbox(output()));
    await run.implementing!(context("implementing"));
    expect(typeof seen!.onLine).toBe("function");
    expect(seen!.onLine!("→ Bash npm test")).toBeNull();
  });

  it("records the commit a writable pass ended on, and mounts a per-task session dir", async () => {
    const run = runners(fakeSandbox(output(), (r) => {
      writeFileSync(join(r.worktree, "a.txt"), "changed\n");
      git(r.worktree, "add", "-A");
      git(r.worktree, "commit", "-q", "-m", "slice");
    }));
    const ctx = context("implementing");
    const result = await run.implementing!(ctx);
    expect(result.outcome).toBe("pass");
    expect(result.run?.outputCommit).toBe(git(seen!.worktree, "rev-parse", "HEAD"));
    expect(result.run?.outputCommit).not.toBe(result.run?.inputCommit);
    expect(seen!.sessionMount).toBe(join(stateDir, "tasks", ctx.task.id, "session"));
    expect(existsSync(seen!.sessionMount!)).toBe(true);
  });

  it("gives the sandbox the time budget the stage input carries, not the pack's flat default", async () => {
    const run = runners(fakeSandbox(output()));
    const slice = { title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] };
    const planned = {
      ...context("implementing"),
      approvals: [
        { id: "ap1", kind: "awaiting_approval", decision: "approved", requested: { brief: "b", criteria: [], assumptions: [], slices: [slice, slice, slice] } } as unknown as StageContext["approvals"][number],
      ],
    };
    await run.implementing!(planned);
    const input = seen!.input as { limits: { timeoutMs: number } };
    expect(input.limits.timeoutMs).toBe(3 * 30 * 60_000);
    expect(seen!.timeoutMs).toBe(input.limits.timeoutMs);
  });

  it("labels the watch tab with the repo's name, so five repos' Build tabs read apart", async () => {
    const follow = vi.fn();
    const d = { ...deps(fakeSandbox(output(), (r) => r.onStarted?.("c1"))), watcher: { follow } as never };
    await runAgent(d, context("triage"), "triage");
    expect(follow).toHaveBeenCalledWith("11111111-2222-3333-4444-555555555555", expect.stringMatching(/^#11111111 repo · Fix it$/), expect.any(String), "c1");
  });

  it("fails a verifying pass that left uncommitted changes, resetting the worktree, same as implementing", async () => {
    const d = deps(fakeSandbox(output(), (r) => writeFileSync(join(r.worktree, "junk.txt"), "x")));
    const result = await runAgent(d, context("verifying"), "verifying");
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "verifying left uncommitted changes: ?? junk.txt" });
    expect(existsSync(join(seen!.worktree, "junk.txt"))).toBe(false);
  });

  it("fails a pass that left uncommitted changes, and resets the worktree", async () => {
    const run = runners(
      fakeSandbox(output(), (r) => writeFileSync(join(r.worktree, "junk.txt"), "x")),
    );
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "implementer left uncommitted changes: ?? junk.txt" });
    expect(existsSync(join(seen!.worktree, "junk.txt"))).toBe(false);
  });

  it("resets a dirty worktree after a failed run", async () => {
    const run = runners(
      fakeSandbox(output({ ok: false, outcome: "fail", error: "boom" }), (r) =>
        writeFileSync(join(r.worktree, "junk.txt"), "x"),
      ),
    );
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("fail");
    expect(existsSync(join(seen!.worktree, "junk.txt"))).toBe(false);
  });

  it("fails with the transcript hint when the container left no result", async () => {
    const run = runners(async (r) => {
      seen = r;
      return { exitCode: 137, timedOut: false, aborted: false, transcriptPath: "t" };
    });
    const result = await run.triage!(context("triage"));
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("exit code 137");
  });

  it("builds the triage approval from the pack answer", async () => {
    const run = runners(fakeSandbox(output({ answer: { kind: "brief", summary: "the brief", criteria: ["c1"] } })));
    const result = await run.triage!(context("triage"));
    expect(result.detail).toMatchObject({ brief: "the brief", criteria: ["c1"], outcome: "plan" });
    expect(result.detail).not.toHaveProperty("assumptions");
  });

  it("falls back to the summary and ticket criteria when triage has no answer", async () => {
    const run = runners(fakeSandbox(output()));
    const result = await run.triage!(context("triage"));
    expect(result.detail).toMatchObject({ brief: "did it", criteria: ["works"], outcome: "plan" });
  });

  it("prefers answer.questions on triage needs_input", async () => {
    const questions = [{ question: "q?", recommended: "r" }];
    const run = runners(
      fakeSandbox(output({ outcome: "needs_input", needsInput: [], answer: { kind: "questions", questions } })),
    );
    const result = await run.triage!(context("triage"));
    expect(result.detail).toEqual({ summary: "did it", questions, answer: { kind: "questions", questions } });
  });
});

describe("the engine a stage runs on", () => {
  /** Credentials that record what was prepared and released; `missing` engines are not configured. */
  function recordingCredentials(missing: string[] = []) {
    const log: string[] = [];
    const credentials: Credentials = {
      check: async (engine) => (missing.includes(engine) ? { available: false, reason: `no ${engine} here` } : { available: true }),
      prepare: async (engine) => {
        if (missing.includes(engine)) throw new NoCredentialError(`no ${engine} here`);
        log.push(`prepare ${engine}`);
        return { env: { [`KEY_FOR_${engine.replace(/\W/g, "_").toUpperCase()}`]: "v" }, mounts: [], release: async () => void log.push(`release ${engine}`) };
      },
    };
    return { credentials, log };
  }

  it("runs the pack's default, names it in the stage input, gives the sandbox only that engine's credential and releases it after", async () => {
    const { credentials, log } = recordingCredentials();
    const started = vi.fn(async () => {});
    const sandbox = fakeSandbox(output(), () => log.push("sandbox"));
    const result = await runAgent({ ...deps(sandbox), credentials }, { ...context("triage"), started }, "triage");
    expect((seen!.input as unknown as StageInput).engine).toBe("claude:opus");
    expect(seen!.credential).toEqual({ env: { KEY_FOR_CLAUDE_OPUS: "v" }, mounts: [] });
    expect(log).toEqual(["prepare claude:opus", "sandbox", "release claude:opus"]);
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ engine: "claude:opus" }));
    expect(result.events?.map((e) => e.kind)).toEqual(["slice_committed"]);
  });

  it("never runs an engine the pack does not allow: the task's override is passed over and the reason logged", async () => {
    const { credentials, log } = recordingCredentials();
    const task = { ...context("triage").task, stages: { triage: "openai:sol" } } as TaskRow;
    const result = await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), task }, "triage");
    expect((seen!.input as unknown as StageInput).engine).toBe("claude:opus");
    expect(log).toEqual(["prepare claude:opus", "release claude:opus"]);
    expect(result.events?.find((e) => e.kind === "engine")?.payload).toEqual({
      pack: "triage",
      engine: "claude:opus",
      reason: expect.stringMatching(/^the task's openai:sol is not allowed for triage/),
    });
  });

  it("runs the engine a re-attached run started on, whatever the task or luna.yaml say now", async () => {
    const { credentials } = recordingCredentials();
    const resume = { container: "hardness-x", inputCommit: null, engine: "claude:opus" as const };
    await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), resume }, "triage");
    expect((seen!.input as unknown as StageInput).engine).toBe("claude:opus");
  });

  it("runs the fallback engine the machine hands it, over the task's pick, and gives the sandbox that engine's credential", async () => {
    const { credentials, log } = recordingCredentials();
    const started = vi.fn(async () => {});
    const task = { ...context("triage").task, stages: { triage: "codex:sol" } } as TaskRow;
    const result = await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), task, started, engine: "claude:opus" }, "triage");
    expect((seen!.input as unknown as StageInput).engine).toBe("claude:opus");
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ engine: "claude:opus" }));
    expect(log).toContain("prepare claude:opus");
    // The machine logs the fallback itself; the runner adds no engine event of its own.
    expect(result.events?.find((e) => e.kind === "engine")).toBeUndefined();
  });

  it("says on the task's activity when the engine asked for gave way to the default for want of its credential", async () => {
    const { credentials, log } = recordingCredentials(["codex:sol"]);
    const note = vi.fn(async () => {});
    const task = { ...context("triage").task, stages: { triage: "codex:sol" } } as TaskRow;
    const result = await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), task, note }, "triage");
    expect(log).toEqual(["prepare claude:opus", "release claude:opus"]);
    expect(note).toHaveBeenCalledWith("triage ran on claude:opus: codex:sol has no Codex login on this machine");
    expect(result.events?.find((e) => e.kind === "engine")?.payload).toMatchObject({ engine: "claude:opus", reason: expect.stringMatching(/^codex:sol has no credential/) });
  });

  it("runs the default and says so on the task when the engine asked for is on a runtime MACHINE_DISABLE_RUNTIMES turned off", async () => {
    const { credentials: inner, log } = recordingCredentials();
    const credentials = gatedCredentials(inner, [runtimeKillSwitch(["eve"])]);
    const note = vi.fn(async () => {});
    const task = { ...context("triage").task, stages: { triage: "codex:sol" } } as TaskRow;
    const result = await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), task, note }, "triage");
    expect(log).toEqual(["prepare claude:opus", "release claude:opus"]);
    expect(note).toHaveBeenCalledWith("triage ran on claude:opus: codex:sol is disabled by MACHINE_DISABLE_RUNTIMES");
    expect(result.events?.find((e) => e.kind === "engine")?.payload).toMatchObject({ engine: "claude:opus", reason: "codex:sol is disabled by MACHINE_DISABLE_RUNTIMES; ran claude:opus, the pack's default" });
  });

  it("runs the default and says so on the task when the engine asked for is at its monthly cap in the task's repo", async () => {
    const { credentials: inner, log } = recordingCredentials();
    const spend = { engineSpendSinceUsd: async (_since: Date, repo?: string) => new Map(repo ? [["codex:sol", 11]] : []) };
    const credentials = gatedCredentials(inner, [engineBudgetGate({ budgets: {}, repoBudgets: async () => ({ codex: 10 }), spend })]);
    const note = vi.fn(async () => {});
    const task = { ...context("triage").task, stages: { triage: "codex:sol" } } as TaskRow;
    await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), task, note }, "triage");
    expect(log).toEqual(["prepare claude:opus", "release claude:opus"]);
    expect(note).toHaveBeenCalledWith(expect.stringMatching(/^triage ran on claude:opus: codex:sol is over its monthly budget \(\$11\.00 of \$10\.00 on codex in .+\)$/));
  });

  it("puts no note on the task when the engine asked for runs, or a disallowed one is passed over", async () => {
    const { credentials } = recordingCredentials();
    const note = vi.fn(async () => {});
    for (const engine of ["codex:sol", "openai:sol"]) {
      const task = { ...context("triage").task, stages: { triage: engine } } as TaskRow;
      await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), task, note }, "triage");
    }
    expect(note).not.toHaveBeenCalled();
  });

  it("fails the stage with the reason when this machine has no credential for its engine, and starts no container", async () => {
    const { credentials } = recordingCredentials(["claude:opus"]);
    const result = await runAgent({ ...deps(fakeSandbox(output())), credentials }, context("triage"), "triage");
    expect(seen).toBeUndefined();
    expect(result).toMatchObject({ outcome: "fail", detail: { error: "no claude:opus here" } });
  });

  it("waits for a credential another run holds within the stage's own timeout, and says so on the task", async () => {
    const waits: unknown[] = [];
    const credentials: Credentials = {
      check: async () => ({ available: true }),
      prepare: async (_engine, _runDir, wait) => {
        waits.push({ timeoutMs: wait?.timeoutMs, signal: wait?.signal });
        wait?.onWait?.("waiting for the Codex login: another Codex run on this machine is using it");
        return { env: {}, mounts: [], release: async () => {} };
      },
    };
    const note = vi.fn(async () => {});
    const ctx = { ...context("triage"), note };
    await runAgent({ ...deps(fakeSandbox(output())), credentials }, ctx, "triage");
    expect(waits).toEqual([{ timeoutMs: (seen!.input as unknown as StageInput).limits.timeoutMs, signal: ctx.signal }]);
    expect(note).toHaveBeenCalledWith("waiting for the Codex login: another Codex run on this machine is using it");
  });

  it("fails the stage with the reason when it could not get the credential in time, and starts no container", async () => {
    const credentials: Credentials = {
      check: async () => ({ available: true }),
      prepare: async () => {
        throw new CredentialWaitError("waited 60 min for the Codex login, which another Codex run on this machine held past this stage's timeout");
      },
    };
    const result = await runAgent({ ...deps(fakeSandbox(output())), credentials }, context("triage"), "triage");
    expect(seen).toBeUndefined();
    expect(result).toMatchObject({ outcome: "fail", detail: { error: expect.stringMatching(/^waited 60 min for the Codex login/) } });
  });

  it("gives a verifying stage the Codex login its second opinion needs beside its own engine's, and releases both", async () => {
    const { credentials, log } = recordingCredentials();
    await runAgent({ ...deps(fakeSandbox(output(), () => log.push("sandbox"))), credentials }, context("verifying"), "verifying");
    expect(seen!.credential).toEqual({ env: { KEY_FOR_CLAUDE_OPUS: "v", KEY_FOR_CODEX_SOL: "v" }, mounts: [] });
    expect(log).toEqual(["prepare claude:opus", "prepare codex:sol", "sandbox", "release claude:opus", "release codex:sol"]);
  });

  it("releases the credential when the sandbox throws", async () => {
    const { credentials, log } = recordingCredentials();
    const broken = async () => {
      throw new Error("docker: not running");
    };
    await expect(runAgent({ ...deps(broken), credentials }, context("triage"), "triage")).rejects.toThrow(/docker/);
    expect(log).toEqual(["prepare claude:opus", "release claude:opus"]);
  });

  describe("scope after the run", () => {
    const slice = { title: "s", est_loc: 5, touchpoints: ["b.txt"], acceptance: ["ok"] };
    const planned = (): StageContext => ({
      ...context("implementing"),
      approvals: [{ id: "ap1", kind: "awaiting_approval", decision: "approved", requested: { brief: "b", criteria: [], assumptions: [], slices: [slice] } } as unknown as StageContext["approvals"][number]],
    });
    const commitFiles = (...names: string[]) => (r: SandboxRun) => {
      for (const name of names) writeFileSync(join(r.worktree, name), "x\n");
      git(r.worktree, "add", "-A");
      git(r.worktree, "commit", "-q", "-m", "slice");
    };
    const graphWith = (misses: unknown[]): Graph => ({
      stampOf: async () => null,
      currentDir: () => null,
      build: async () => ({}) as GraphStamp,
      isFresh: async () => true,
      recordMisses: async (_repo, miss) => void misses.push(miss),
    });

    it("fails the stage on a changed file the plan does not name and the answer does not declare, one finding per file", async () => {
      const result = await runners(fakeSandbox(output(), commitFiles("b.txt", "extra.txt"))).implementing!(planned());
      expect(result.outcome).toBe("fail");
      expect(result.detail).toMatchObject({ error: expect.stringContaining("extra.txt"), scope: { facts: { undeclared: ["extra.txt"] } } });
      expect(result.findings).toEqual([expect.objectContaining({ path: "extra.txt", severity: "scope", confidence: 1 })]);
    });

    it("passes when the file is declared, records it as a graph miss, and reports the scope", async () => {
      const misses: unknown[] = [];
      const answer = { kind: "done", summary: "x", outOfMap: [{ path: "extra.txt", reason: "shared helper" }] };
      const d = { ...deps(fakeSandbox(output({ answer } as Partial<StageOutput>), commitFiles("b.txt", "extra.txt"))), graph: graphWith(misses) };
      const result = await agentRunners(d).implementing!(planned());
      expect(result.outcome).toBe("pass");
      expect(result.detail).toMatchObject({ scope: { facts: { undeclared: [] }, verdict: "skipped" } });
      expect(misses).toEqual([{ task: "11111111-2222-3333-4444-555555555555", at: expect.any(String), files: ["extra.txt"] }]);
    });

    it("does not judge a task with no plan (a PR task): nothing is undeclared", async () => {
      const result = await runners(fakeSandbox(output(), commitFiles("extra.txt"))).implementing!(context("implementing"));
      expect(result.outcome).toBe("pass");
    });
  });

  describe("build watch", () => {
    const ledgerJson = JSON.stringify({ schema: 1, slices: [{ id: 1, title: "one", status: "committed", commit: "abc" }] });
    const killed = (run: SandboxRun) => {
      mkdirSync(join(run.runDir, "out"), { recursive: true });
      writeFileSync(join(run.runDir, "out", "ledger.json"), ledgerJson);
    };
    const aborting = (run: SandboxRun): Promise<SandboxResult> => {
      killed(run);
      return Promise.resolve({ exitCode: 137, timedOut: false, aborted: true, transcriptPath: join(run.runDir, "t.log") });
    };

    it("keeps the ledger of an aborted run and has pushed the committed slice once", async () => {
      const calls: string[][] = [];
      const pushOptions: Array<{ timeoutMs?: number; signal?: AbortSignal } | undefined> = [];
      const hostExec = vi.fn(async (cmd: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number }) => {
        calls.push([cmd, ...args]);
        if (args.includes("push")) pushOptions.push(options);
        return { code: 0, stdout: "", stderr: "" };
      });
      const result = await runAgent({ ...deps(aborting), hostExec, watchEvery: 5 }, context("implementing"), "implementing");
      expect((result.detail as { ledger: { slices: Array<{ status: string }> } }).ledger.slices[0]!.status).toBe("committed");
      const pushes = calls.filter((c) => c.includes("push"));
      expect(pushes).toHaveLength(1);
      expect(pushes[0]!.slice(0, 4)).toEqual(["git", "-c", "core.hooksPath=/dev/null", "-C"]);
      // A checkpoint goes to a ref that triggers no CI and is nobody's PR head; Deliver updates the branch itself.
      expect(pushes[0]!.slice(5)).toEqual(["push", "--force", "origin", expect.stringMatching(/^HEAD:refs\/luna\/wip\/task\//)]);
      expect(pushOptions[0]?.timeoutMs).toBeGreaterThan(0);
      expect(pushOptions[0]?.signal).toBeInstanceOf(AbortSignal);
    });

    it("pushes once per tip: two slices committed on the same HEAD make one push", async () => {
      const pushed: string[][] = [];
      const hostExec = vi.fn(async (_cmd: string, args: string[]) => {
        if (args.includes("push")) pushed.push(args);
        return { code: 0, stdout: "", stderr: "" };
      });
      const twoOnOneTip = (run: SandboxRun) => {
        mkdirSync(join(run.runDir, "out"), { recursive: true });
        writeFileSync(join(run.runDir, "out", "ledger.json"), JSON.stringify({ schema: 1, slices: [1, 2].map((id) => ({ id, title: `s${id}`, status: "committed", commit: "same" })) }));
      };
      const result = await runAgent({ ...deps(fakeSandbox(output(), twoOnOneTip)), hostExec, watchEvery: 5 }, context("implementing"), "implementing");
      expect(result.outcome).toBe("pass");
      expect(pushed).toHaveLength(1);
    });

    it("never fails the stage on a failed push, and counts it", async () => {
      const hostExec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "no remote" }));
      const sandbox = fakeSandbox(output(), killed);
      const result = await runAgent({ ...deps(sandbox), hostExec, watchEvery: 5 }, context("implementing"), "implementing");
      expect(result.outcome).toBe("pass");
      expect((result.detail as { pushes: unknown }).pushes).toEqual({ attempted: 1, ok: 0 });
    });
  });
});
